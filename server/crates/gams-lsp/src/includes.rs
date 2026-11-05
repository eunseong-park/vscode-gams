// SPDX-License-Identifier: GPL-3.0-or-later
//! `$include`-style file links in `.gms` documents (Studio: `CodeEdit::getIncludeFile`,
//! `CodeEdit::checkLinks`, `PExProjectNode::resolveHRef`).
use crate::text::{char_to_utf16, utf16_len};
use gams_syntax::{LineInfo, SyntaxKind};
use std::path::{Path, PathBuf};

/// Which search path an include command uses (the code of Studio's `INC `/`SYS `/`LIB ` href).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IncKind {
    /// `$include`, `$batInclude`, Connect `yamlFile=`: working directory (and `InputDir`)
    Inc,
    /// `$sysInclude`: GAMS system directory
    Sys,
    /// `$libInclude`: `inclib` of the GAMS standard locations
    Lib,
}

/// A file name found in a line; `start`/`end` are UTF-16 columns of the name (quotes excluded).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Include {
    pub start: u32,
    pub end: u32,
    pub kind: IncKind,
    pub name: String,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `(^\$|\$\$)\s*(\w+)(\s*)` (Studio `mRexIncDcoFile`): the command (upper case) and the end of the match.
fn dco_command(c: &[char]) -> Option<(String, usize)> {
    for p in 0..c.len() {
        if c[p] != '$' {
            continue;
        }
        let starts = [(p == 0).then_some(p + 1), (c.get(p + 1) == Some(&'$')).then_some(p + 2)];
        for mut q in starts.into_iter().flatten() {
            while q < c.len() && c[q].is_whitespace() {
                q += 1;
            }
            let w = q;
            while q < c.len() && is_word(c[q]) {
                q += 1;
            }
            if q > w {
                let cmd: String = c[w..q].iter().collect::<String>().to_uppercase();
                while q < c.len() && c[q].is_whitespace() {
                    q += 1;
                }
                return Some((cmd, q));
            }
        }
    }
    None
}

/// `(.*)(embeddedcode(|v|s))(\s*)connect:\s*` (case-insensitive, Studio `mRexEmbedConnectFile`): end of the match.
fn embedded_connect_end(c: &[char]) -> Option<usize> {
    let lower: Vec<char> = c.iter().map(|x| x.to_ascii_lowercase()).collect();
    let find = |from: usize, pat: &str| -> bool { pat.chars().enumerate().all(|(i, p)| lower.get(from + i) == Some(&p)) };
    let mut best = None;
    for p in 0..lower.len() {
        if !find(p, "embeddedcode") {
            continue;
        }
        let base = p + "embeddedcode".len();
        let suffixes = if matches!(lower.get(base), Some('v' | 's')) { vec![1, 0] } else { vec![0] };
        for sfx in suffixes {
            let mut q = base + sfx;
            while q < lower.len() && lower[q].is_whitespace() {
                q += 1;
            }
            if find(q, "connect:") {
                let mut e = q + "connect:".len();
                while e < lower.len() && lower[e].is_whitespace() {
                    e += 1;
                }
                best = Some(e);
                break;
            }
        }
    }
    best
}

/// End (char index, exclusive) of the last char of kind `k` in the line, if any.
fn last_end_of(info: &LineInfo, line: &str, k: SyntaxKind) -> Option<usize> {
    let end16 = info.tokens.iter().filter(|t| t.kind == k).map(|t| t.start + t.len).max()?;
    Some(crate::text::utf16_to_char(line, end16))
}

/// Strip an enclosing quote pair / cut at the first blank like Studio does after the command:
/// returns `(offset in chars, name)`.
fn unquote(rest: &[char], default_end: Option<char>) -> (usize, String) {
    let Some(&first) = rest.first() else { return (0, String::new()) };
    let end_char = match first {
        '"' => Some('"'),
        '\'' => Some('\''),
        _ => default_end,
    };
    let all: String = rest.iter().collect();
    match end_char {
        Some(' ') => {
            // first blank-delimited word
            let n = rest.iter().skip(1).position(|c| c.is_whitespace()).map_or(rest.len(), |i| i + 1);
            (0, rest[..n].iter().collect())
        }
        Some(q) => match rest.iter().skip(1).position(|c| *c == q) {
            Some(i) => (1, rest[1..=i].iter().collect()),
            None => (0, all), // no closing quote: left as is
        },
        None => (0, all),
    }
}

/// The file names in one line (Studio shows one link per line for `$include` and one per `yamlFile=`).
pub fn includes_in_line(line: &str, info: &LineInfo) -> Vec<Include> {
    let c: Vec<char> = line.chars().collect();
    let mk = |from: usize, off: usize, name: String, kind: IncKind| -> Option<Include> {
        if name.is_empty() {
            return None;
        }
        let a = from + off;
        Some(Include { start: char_to_utf16(line, a), end: char_to_utf16(line, a) + utf16_len(&name), kind, name })
    };
    let (cmd, file_start) = match dco_command(&c) {
        Some(m) => m,
        None => match embedded_connect_end(&c) {
            Some(e) => ("EMBEDDEDCODE".to_string(), e),
            None => return vec![],
        },
    };
    if file_start >= c.len() {
        return vec![];
    }
    let mut out = Vec::new();
    if cmd == "INCLUDE" {
        // the file name ends with the last DCO body char (a trailing comment is not part of it)
        let end = last_end_of(info, line, SyntaxKind::DcoBody).filter(|e| *e > file_start).unwrap_or(c.len()).min(c.len());
        let rest: String = c[file_start..end].iter().collect();
        let rest: Vec<char> = rest.trim().chars().collect();
        let (off, name) = unquote(&rest, None);
        out.extend(mk(file_start, off, name, IncKind::Inc));
    } else if let Some(kind) = match cmd.as_str() {
        "BATINCLUDE" => Some(IncKind::Inc),
        "SYSINCLUDE" => Some(IncKind::Sys),
        "LIBINCLUDE" => Some(IncKind::Lib),
        _ => None,
    } {
        let rest: String = c[file_start..].iter().collect();
        let rest: Vec<char> = rest.trim().chars().collect();
        let (off, name) = unquote(&rest, Some(' '));
        out.extend(mk(file_start, off, name, kind));
    } else if cmd.starts_with("ONEMBEDDEDCODE") || cmd.starts_with("EMBEDDEDCODE") {
        let Some(par_end) = last_end_of(info, line, SyntaxKind::EmbeddedBody) else { return out };
        let lower: Vec<char> = c.iter().map(|x| x.to_ascii_lowercase()).collect();
        let mut p = file_start;
        while p < par_end {
            // yamlfile(end|)=("[^"]*"|'[^']*'|[^\s"']*)
            let hit = "yamlfile".chars().enumerate().all(|(i, k)| lower.get(p + i) == Some(&k));
            if !hit {
                p += 1;
                continue;
            }
            let mut q = p + "yamlfile".len();
            if "end".chars().enumerate().all(|(i, k)| lower.get(q + i) == Some(&k)) {
                q += 3;
            }
            if c.get(q) != Some(&'=') {
                p += 1;
                continue;
            }
            q += 1;
            let (vs, ve, quoted) = match c.get(q) {
                Some(&qc @ ('"' | '\'')) => match c[q + 1..].iter().position(|x| *x == qc) {
                    Some(i) => (q + 1, q + 1 + i, true),
                    None => (q, q, false),
                },
                _ => {
                    let mut e = q;
                    while e < c.len() && !c[e].is_whitespace() && c[e] != '"' && c[e] != '\'' {
                        e += 1;
                    }
                    (q, e, false)
                }
            };
            let name: String = c[vs..ve].iter().collect();
            out.extend(mk(vs, 0, name, IncKind::Inc));
            p = if quoted { ve + 1 } else { ve.max(p + 1) };
        }
    }
    out
}

/// Where relative names are looked for. Studio: the project's working directory plus `InputDir`
/// for `INC`, the system directory for `SYS` and `inclib` in the GAMS data locations for `LIB`.
#[derive(Default)]
pub struct SearchPaths {
    /// working directories (the main file's directory, then the document's)
    pub work_dirs: Vec<PathBuf>,
    pub sysdir: Option<PathBuf>,
}

fn file_in(dir: Option<&Path>, name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    let base = if p.is_absolute() {
        p.to_path_buf()
    } else {
        dir?.join(p)
    };
    if base.is_file() {
        return Some(base);
    }
    // GAMS tries the default input extension when the name does not exist as written
    let mut with_ext = base.into_os_string();
    with_ext.push(".gms");
    let with_ext = PathBuf::from(with_ext);
    with_ext.is_file().then_some(with_ext)
}

/// Resolve an include like Studio's `resolveHRef`: the first location holding `name` or `name.gms`.
pub fn resolve(inc: &Include, sp: &SearchPaths) -> Option<PathBuf> {
    if inc.name.contains('%') {
        return None; // contains a compile-time variable
    }
    match inc.kind {
        IncKind::Inc => sp.work_dirs.iter().find_map(|d| file_in(Some(d), &inc.name)),
        IncKind::Sys => file_in(sp.sysdir.as_deref(), &inc.name),
        IncKind::Lib => file_in(sp.sysdir.as_ref().map(|s| s.join("inclib")).as_deref(), &inc.name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gams_syntax::highlight_document_info;

    fn find(line: &str) -> Vec<(u32, u32, IncKind, String)> {
        let infos = highlight_document_info(line);
        includes_in_line(line, &infos[0]).into_iter().map(|i| (i.start, i.end, i.kind, i.name)).collect()
    }

    #[test]
    fn dco_forms() {
        assert_eq!(find("$include foo.inc"), [(9, 16, IncKind::Inc, "foo.inc".into())]);
        assert_eq!(find("$include \"my file.inc\""), [(10, 21, IncKind::Inc, "my file.inc".into())]);
        assert_eq!(find("$include foo bar.inc"), [(9, 20, IncKind::Inc, "foo bar.inc".into())]);
        assert_eq!(find("$batInclude 'a.inc' arg1"), [(13, 18, IncKind::Inc, "a.inc".into())]);
        assert_eq!(find("$batInclude a.inc arg1 arg2"), [(12, 17, IncKind::Inc, "a.inc".into())]);
        assert_eq!(find("$sysInclude mpsgeset KAMIYA"), [(12, 20, IncKind::Sys, "mpsgeset".into())]);
        assert_eq!(find("$libInclude abc x y"), [(12, 15, IncKind::Lib, "abc".into())]);
        assert_eq!(find("x = 1; $$include inner"), [(17, 22, IncKind::Inc, "inner".into())]);
        assert!(find("$set x y").is_empty());
        assert!(find("$onInclude").is_empty());
        assert!(find("$include").is_empty());
        assert!(find("set i / a /;").is_empty());
    }

    #[test]
    fn connect_yaml_files() {
        let t = "$onEmbeddedCode Connect: yamlFile=in1.yaml yamlFileEnd=\"x y.yaml\"\n- GAMSReader:\n$offEmbeddedCode\n";
        let infos = highlight_document_info(t);
        let l0 = t.lines().next().unwrap();
        let names: Vec<_> = includes_in_line(l0, &infos[0]).into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["in1.yaml", "x y.yaml"]);
        let t = "embeddedCode Connect: yamlFile=z.yaml\nendEmbeddedCode\n";
        let infos = highlight_document_info(t);
        let r = includes_in_line(t.lines().next().unwrap(), &infos[0]);
        assert_eq!(r.len(), 1, "{r:?}");
        assert_eq!((r[0].start, r[0].end, r[0].name.as_str()), (31, 37, "z.yaml"));
    }

    #[test]
    fn resolves_with_default_extension() {
        let dir = std::env::temp_dir().join("gams_lsp_inc_resolve");
        std::fs::create_dir_all(dir.join("inclib")).unwrap();
        std::fs::write(dir.join("a.gms"), "").unwrap();
        std::fs::write(dir.join("b.inc"), "").unwrap();
        std::fs::write(dir.join("inclib/lib1.gms"), "").unwrap();
        let sp = SearchPaths { work_dirs: vec![PathBuf::from("/nonexistent"), dir.clone()], sysdir: Some(dir.clone()) };
        let inc = |kind, name: &str| Include { start: 0, end: 0, kind, name: name.into() };
        assert_eq!(resolve(&inc(IncKind::Inc, "a"), &sp), Some(dir.join("a.gms")));
        assert_eq!(resolve(&inc(IncKind::Inc, "b.inc"), &sp), Some(dir.join("b.inc")));
        assert_eq!(resolve(&inc(IncKind::Inc, "b"), &sp), None);
        assert_eq!(resolve(&inc(IncKind::Sys, "a"), &sp), Some(dir.join("a.gms")));
        assert_eq!(resolve(&inc(IncKind::Lib, "lib1"), &sp), Some(dir.join("inclib/lib1.gms")));
        assert_eq!(resolve(&inc(IncKind::Inc, &dir.join("b.inc").to_string_lossy()), &sp), Some(dir.join("b.inc")));
        assert_eq!(resolve(&inc(IncKind::Inc, "%x%/b.inc"), &sp), None);
    }
}
