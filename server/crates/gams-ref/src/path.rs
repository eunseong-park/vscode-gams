// SPDX-License-Identifier: GPL-3.0-or-later
//! Path normalisation for comparing file names across producers.
//!
//! GAMS writes native paths into `.ref` files (`C:\x\m.gms` on Windows) whereas VS Code hands
//! out URIs that decode to `c:/x/m.gms`. Raw string equality therefore never matches on
//! Windows. All file comparisons go through [`path_key`] / [`paths_equal`].
//!
//! The functions are pure string functions so Windows-style paths can be handled (and tested)
//! on any host. A path is *Windows-style* when it starts with a drive letter (`c:`) or is a
//! UNC path (`\\server\share`, `//server/share`); only those compare case-insensitively
//! (NTFS semantics), POSIX paths stay case-sensitive.

fn is_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// `c:\x`, `C:/x`, `\\srv\share`, `//srv/share` (not `/c:/x`; strip that before).
pub fn is_windows_style(s: &str) -> bool {
    is_drive(s) || s.starts_with("\\\\") || s.starts_with("//")
}

/// Normalised display form: `\` -> `/` for Windows-style paths, lowercase drive letter,
/// empty and `.` segments removed, `..` resolved lexically, no trailing slash. Case of the
/// rest is kept. POSIX paths are only cleaned of `.`/empty segments (a backslash is a valid
/// file name character there).
pub fn normalize_path(s: &str) -> String {
    let win = is_windows_style(s);
    let s: std::borrow::Cow<str> = if win { s.replace('\\', "/").into() } else { s.into() };
    let (prefix, rest) = if is_drive(&s) {
        let (d, r) = s.split_at(2);
        (format!("{}{}", d.to_ascii_lowercase(), if r.starts_with('/') { "/" } else { "" }), r.trim_start_matches('/'))
    } else if win && s.starts_with("//") {
        ("//".to_string(), s.trim_start_matches('/'))
    } else if s.starts_with('/') {
        ("/".to_string(), s.trim_start_matches('/'))
    } else {
        (String::new(), &*s)
    };
    let rooted = prefix.ends_with('/');
    let mut segs: Vec<&str> = Vec::new();
    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => match segs.last() {
                Some(&l) if l != ".." => {
                    segs.pop();
                }
                _ if rooted => {}
                _ => segs.push(".."),
            },
            _ => segs.push(seg),
        }
    }
    format!("{prefix}{}", segs.join("/"))
}

/// Comparison key: [`normalize_path`], lowercased for Windows-style paths.
pub fn path_key(s: &str) -> String {
    let n = normalize_path(s);
    if is_windows_style(&n) {
        n.to_lowercase()
    } else {
        n
    }
}

/// Same file by name (see module docs). Cheap exact match first.
pub fn paths_equal(a: &str, b: &str) -> bool {
    a == b || path_key(a) == path_key(b)
}

/// Last path component of a [`path_key`] (for matching a recorded file by its name).
pub fn file_name_key(s: &str) -> String {
    let k = path_key(s);
    k.rsplit('/').next().unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_paths() {
        assert_eq!(normalize_path(r"C:\x\m.gms"), "c:/x/m.gms");
        assert_eq!(normalize_path("c:/x/m.gms"), "c:/x/m.gms");
        assert_eq!(normalize_path(r"C:\x\.\sub\..\m.gms"), "c:/x/m.gms");
        assert_eq!(normalize_path(r"C:\x\\m.gms"), "c:/x/m.gms");
        assert_eq!(normalize_path(r"C:\"), "c:/");
        assert_eq!(normalize_path(r"\\srv\share\a.gms"), "//srv/share/a.gms");
        assert_eq!(normalize_path("/work/mini.gms"), "/work/mini.gms");
        assert_eq!(normalize_path("/a/./b//c/../d"), "/a/b/d");
        assert_eq!(normalize_path(r"/a\b"), r"/a\b"); // POSIX: backslash is a name character
    }

    #[test]
    fn windows_paths_compare_case_insensitively() {
        assert!(paths_equal(r"C:\x\m.gms", "c:/x/m.gms"));
        assert!(paths_equal(r"C:\Users\Me\Model.GMS", "c:/users/me/model.gms"));
        assert!(paths_equal(r"\\SRV\Share\a.gms", "//srv/share/a.gms"));
        assert!(!paths_equal(r"C:\x\m.gms", "c:/x/n.gms"));
        assert!(!paths_equal(r"C:\x\m.gms", "d:/x/m.gms"));
        // POSIX stays case-sensitive
        assert!(!paths_equal("/Work/m.gms", "/work/m.gms"));
        assert!(paths_equal("/work/m.gms", "/work//m.gms"));
    }

    #[test]
    fn file_names() {
        assert_eq!(file_name_key(r"C:\X\Mini.GMS"), "mini.gms");
        assert_eq!(file_name_key("/work/mini.gms"), "mini.gms");
    }
}
