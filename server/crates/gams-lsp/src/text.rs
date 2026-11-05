// SPDX-License-Identifier: GPL-3.0-or-later
//! URI <-> path and UTF-16 position helpers.
use lsp_types::{Position, Range, Uri};
use std::path::{Path, PathBuf};
use std::str::FromStr;

fn hex(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// Same file by name: separators, drive-letter case and (Windows-style paths) case are ignored.
/// See [`gams_ref::paths_equal`].
pub fn same_path(a: &Path, b: &Path) -> bool {
    gams_ref::paths_equal(&a.to_string_lossy(), &b.to_string_lossy())
}

/// `file:///a%20b/c.gms` -> `/a b/c.gms` (a `/C:/x` drive path loses its leading slash;
/// `file://server/share/x` becomes the UNC path `//server/share/x`).
pub fn uri_to_path(uri: &Uri) -> Option<PathBuf> {
    let rest = uri.as_str().strip_prefix("file://")?;
    let rest = rest.split(['#', '?']).next().unwrap_or(rest);
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let b = rest.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    let mut s = String::from_utf8_lossy(&out).into_owned();
    let bs = s.as_bytes();
    if bs.len() >= 3 && bs[0] == b'/' && bs[1].is_ascii_alphabetic() && bs[2] == b':' {
        s.remove(0);
    } else if !s.is_empty() && !s.starts_with('/') {
        s.insert_str(0, "//"); // authority = UNC host
    }
    Some(PathBuf::from(s))
}

/// Inverse of [`uri_to_path`]; `fragment` is appended verbatim (e.g. `L22`).
pub fn path_to_uri_frag(path: &Path, fragment: Option<&str>) -> Uri {
    // Windows verbatim paths (`\\?\C:\x`, `\\?\UNC\host\share`) from canonicalize() → plain form
    let raw = path.to_string_lossy();
    let raw = if let Some(r) = raw.strip_prefix(r"\\?\UNC\") { format!(r"\\{r}") } else { raw.strip_prefix(r"\\?\").map(str::to_string).unwrap_or_else(|| raw.to_string()) };
    let p = raw.replace('\\', "/");
    let mut s = String::from("file://");
    if !p.starts_with('/') {
        s.push('/');
    }
    for &c in p.as_bytes() {
        if c.is_ascii_alphanumeric() || b"/-_.~:@!$&'()*+,;=".contains(&c) {
            s.push(c as char);
        } else {
            s.push_str(&format!("%{c:02X}"));
        }
    }
    if let Some(f) = fragment {
        s.push('#');
        s.push_str(f);
    }
    Uri::from_str(&s).expect("valid file uri")
}

pub fn path_to_uri(path: &Path) -> Uri {
    path_to_uri_frag(path, None)
}

/// Byte offsets of the starts of all lines (LSP line breaks: `\r\n`, `\n`, `\r`).
pub fn line_starts(text: &str) -> Vec<usize> {
    let b = text.as_bytes();
    let mut v = vec![0];
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\n' => v.push(i + 1),
            b'\r' => {
                if i + 1 < b.len() && b[i + 1] == b'\n' {
                    i += 1;
                }
                v.push(i + 1);
            }
            _ => {}
        }
        i += 1;
    }
    v
}

/// Byte offset of an LSP position (UTF-16 columns), clamped to the line / text.
pub fn offset_of(text: &str, starts: &[usize], pos: Position) -> usize {
    let Some(&ls) = starts.get(pos.line as usize) else {
        return text.len();
    };
    let mut le = starts.get(pos.line as usize + 1).copied().unwrap_or(text.len());
    // exclude the line terminator
    let bytes = text.as_bytes();
    while le > ls && matches!(bytes[le - 1], b'\n' | b'\r') {
        le -= 1;
    }
    let mut u = 0u32;
    for (i, ch) in text[ls..le].char_indices() {
        if u >= pos.character {
            return ls + i;
        }
        u += ch.len_utf16() as u32;
    }
    le
}

pub fn apply_change(text: &mut String, range: Range, new: &str) {
    let starts = line_starts(text);
    let s = offset_of(text, &starts, range.start);
    let e = offset_of(text, &starts, range.end).max(s);
    text.replace_range(s..e, new);
}

/// UTF-16 column -> char index within `line`.
pub fn utf16_to_char(line: &str, col: u32) -> usize {
    let mut u = 0;
    for (i, ch) in line.chars().enumerate() {
        if u >= col {
            return i;
        }
        u += ch.len_utf16() as u32;
    }
    line.chars().count()
}

/// Char index -> UTF-16 column.
pub fn char_to_utf16(line: &str, idx: usize) -> u32 {
    line.chars().take(idx).map(|c| c.len_utf16() as u32).sum()
}

pub fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Identifier under (or directly before) a UTF-16 column: `(start16, end16, word)`.
pub fn word_at(line: &str, col: u32) -> Option<(u32, u32, String)> {
    let chars: Vec<char> = line.chars().collect();
    let ci = utf16_to_char(line, col);
    let mut s = ci;
    let mut e = ci;
    while e < chars.len() && is_ident(chars[e]) {
        e += 1;
    }
    while s > 0 && is_ident(chars[s - 1]) {
        s -= 1;
    }
    if s == e {
        return None;
    }
    let w: String = chars[s..e].iter().collect();
    Some((char_to_utf16(line, s), char_to_utf16(line, e), w))
}

/// Next identifier at or after UTF-16 column `from`: `(start16, end16, word)`.
pub fn next_word(line: &str, from: u32) -> Option<(u32, u32, String)> {
    let mut col = 0u32;
    let mut start: Option<(u32, String)> = None;
    for ch in line.chars() {
        let w = ch.len_utf16() as u32;
        if is_ident(ch) && (start.is_some() || col >= from) {
            start.get_or_insert_with(|| (col, String::new())).1.push(ch);
        } else if let Some((a, word)) = start.take() {
            return Some((a, col, word));
        }
        col += w;
    }
    start.map(|(a, word)| (a, col, word))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_word_walks_identifiers() {
        let l = "a1 = b_2 + \u{e4}x;";
        let mut col = 0;
        let mut v = vec![];
        while let Some((a, b, w)) = next_word(l, col) {
            v.push((a, b, w));
            col = b;
        }
        assert_eq!(v, [(0, 2, "a1".into()), (5, 8, "b_2".into()), (11, 13, "\u{e4}x".into())]);
    }

    #[test]
    fn windows_uris_and_paths() {
        let u = Uri::from_str("file:///c%3A/Work/m.gms").unwrap();
        assert_eq!(uri_to_path(&u).unwrap(), PathBuf::from("c:/Work/m.gms"));
        let u = Uri::from_str("file://srv/share/m.gms").unwrap();
        assert_eq!(uri_to_path(&u).unwrap(), PathBuf::from("//srv/share/m.gms"));
        assert!(same_path(Path::new("c:/Work/m.gms"), Path::new(r"C:\work\M.GMS")));
        assert!(!same_path(Path::new("/a/m.gms"), Path::new("/A/m.gms")));
    }
}
