// SPDX-License-Identifier: GPL-3.0-or-later
//! Loaded `.ref` files (M3). A reference is attached to the main `.gms` it was produced for.
use gams_ref::{file_name_key, paths_equal, is_windows_style, normalize_path, Reference, SymbolType};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub struct RefEntry {
    pub gms: PathBuf,
    pub ref_path: PathBuf,
    pub reference: Reference,
    /// A source file of this reference was edited after the `.ref` was loaded (data from the last run).
    pub stale: bool,
}

pub fn type_name(t: SymbolType) -> &'static str {
    match t {
        SymbolType::Unknown => "Unknown",
        SymbolType::Funct => "Function",
        SymbolType::Set => "Set",
        SymbolType::Acronym => "Acronym",
        SymbolType::Parameter => "Parameter",
        SymbolType::Variable => "Variable",
        SymbolType::Equation => "Equation",
        SymbolType::Model => "Model",
        SymbolType::File => "File",
        SymbolType::Macro => "Macro",
    }
}

/// Load and parse a `.ref`, then fix up the file paths of its records.
///
/// Records carry absolute native paths of the machine GAMS ran on (`C:\x\m.gms` on Windows).
/// Windows-style paths are normalised (`c:/x/m.gms`, like VS Code's URIs) so they compare equal
/// to the client's paths. A path that does not exist here but has the file name of the main
/// `.gms` (compared case-insensitively for Windows-style paths) is mapped to `gms` (this also
/// lets fixtures recorded in another directory work, e.g. `/work/mini.gms`).
pub fn load(gms: &Path, ref_path: &Path) -> Result<RefEntry, String> {
    let bytes = std::fs::read(ref_path).map_err(|e| format!("{}: {e}", ref_path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut reference = Reference::parse(&text).map_err(|e| format!("{}: {e}", ref_path.display()))?;
    remap(&mut reference, gms);
    Ok(RefEntry { gms: gms.to_path_buf(), ref_path: ref_path.to_path_buf(), reference, stale: false })
}

/// Was any document covered by `e` (the main `.gms` or a files-used entry) edited after `since`?
pub fn edited_since(e: &RefEntry, edited: &HashMap<PathBuf, std::time::SystemTime>, since: std::time::SystemTime) -> bool {
    edited.iter().any(|(p, t)| {
        *t > since && {
            let f = p.to_string_lossy();
            crate::text::same_path(&e.gms, p) || e.reference.files_used.iter().any(|u| paths_equal(u, &f))
        }
    })
}

pub(crate) fn remap(r: &mut Reference, gms: &Path) {
    let gms_s = gms.to_string_lossy().into_owned();
    let gms_name = file_name_key(&gms_s);
    let mut cache: HashMap<String, String> = HashMap::new();
    let mut map = |f: &str| -> String {
        if let Some(v) = cache.get(f) {
            return v.clone();
        }
        let v = if !Path::new(f).exists() && file_name_key(f) == gms_name {
            gms_s.clone()
        } else if is_windows_style(f) {
            normalize_path(f)
        } else {
            f.to_string()
        };
        cache.insert(f.to_string(), v.clone());
        v
    };
    for s in &mut r.symbols {
        for list in [
            &mut s.declare,
            &mut s.define,
            &mut s.assign,
            &mut s.implicit_assign,
            &mut s.reference,
            &mut s.control,
            &mut s.index,
        ] {
            for l in list.iter_mut() {
                l.file = map(&l.file);
            }
        }
    }
    for f in &mut r.files_used {
        *f = map(f);
    }
    for f in &mut r.file_tree {
        f.location = map(&f.location);
    }
}

/// Cached summary of one `.ref` for [`find_for_include`]: modification time, the `INPUT` file and
/// every location of the files-used tree (section 3).
type ScanCache = HashMap<PathBuf, (std::time::SystemTime, Option<String>, Vec<String>)>;

#[derive(Default)]
pub struct IncludeScan {
    cache: ScanCache,
}

/// Section 3 of a `.ref` without parsing the rest: records are read from the end of the file
/// up to the `0 M` header that opens the section.
fn scan_file_tree(text: &str) -> (Option<String>, Vec<String>) {
    let mut locs = Vec::new();
    let mut input = None;
    for line in text.lines().rev() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.first() == Some(&"0") {
            break; // header of section 3 (`0 M`)
        }
        // `id global TYPE parent local location...`
        if t.len() < 6 || !t[0].bytes().all(|b| b.is_ascii_digit()) || !t[2].bytes().all(|b| b.is_ascii_uppercase()) {
            continue;
        }
        let loc = t[5..].join(" ");
        if t[2] == "INPUT" {
            input = Some(loc.clone());
        }
        locs.push(loc);
    }
    (input, locs)
}

/// A `.ref` that lists `file` in its files-used tree, for a file opened without its main file:
/// the `.ref` files in the directory of `file` and its parents (up to the workspace root `roots`
/// that contains it, at most 8 levels without one), nearest directory first and newest first
/// within a directory. Only `.ref` files at least as new as `file` count. Returns `(main .gms, .ref)`.
pub fn find_for_include(scan: &mut IncludeScan, file: &Path, roots: &[PathBuf]) -> Option<(PathBuf, PathBuf)> {
    let mt = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let file_mt = mt(file)?;
    let root = roots.iter().filter(|r| file.starts_with(r)).max_by_key(|r| r.components().count());
    let name = file.to_string_lossy().into_owned();
    for (depth, dir) in file.ancestors().skip(1).enumerate() {
        if dir.as_os_str().is_empty() || (root.is_none() && depth >= 8) {
            break;
        }
        let mut cands: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("ref")))
            .filter_map(|p| Some((mt(&p)?, p)))
            .filter(|(t, _)| *t >= file_mt)
            .collect();
        cands.sort_by_key(|c| std::cmp::Reverse(c.0));
        cands.truncate(100);
        for (t, rp) in cands {
            let stale = scan.cache.get(&rp).is_none_or(|(ct, _, _)| *ct != t);
            if stale {
                let Ok(bytes) = std::fs::read(&rp) else { continue };
                let (input, locs) = scan_file_tree(&String::from_utf8_lossy(&bytes));
                scan.cache.insert(rp.clone(), (t, input, locs));
            }
            let (_, input, locs) = &scan.cache[&rp];
            if locs.iter().any(|l| paths_equal(l, &name)) {
                let sibling = rp.with_extension("gms");
                let gms = input
                    .as_deref()
                    .map(PathBuf::from)
                    .filter(|p| p.is_file())
                    .or_else(|| sibling.is_file().then_some(sibling))
                    .or_else(|| input.as_deref().map(PathBuf::from));
                if let Some(g) = gms {
                    return Some((g, rp));
                }
            }
        }
        if root.is_some_and(|r| r.as_path() == dir) {
            break;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const REF: &str = "1 1 a SETS declared 22 22 5 0 1 C:\\Work\\Inc\\Sub.gms\n\
                       2 1 a SETS ref 30 30 9 0 1 C:\\Work\\Main.GMS\n\
                       0 1 t\n1 a SETS 0 0 0 0\n\
                       0 2 t\n1 1 INPUT 0 1 C:\\Work\\Main.GMS\n2 22 INCLUDE 1 22 C:\\Work\\Inc\\Sub.gms\n";

    #[test]
    fn windows_ref_paths_match_client_paths() {
        let mut r = Reference::parse(REF).unwrap();
        // main file as VS Code reports it; the include does not exist on this host
        remap(&mut r, Path::new("c:/work/main.gms"));
        let a = r.symbol("a").unwrap();
        assert_eq!(a.reference[0].file, "c:/work/main.gms"); // mapped to the client's spelling
        assert_eq!(a.declare[0].file, "c:/Work/Inc/Sub.gms"); // normalised
        assert_eq!(r.files_used, ["c:/Work/Inc/Sub.gms", "c:/work/main.gms"]);
        assert_eq!(r.file_tree[1].location, "c:/Work/Inc/Sub.gms");
        // includes are found regardless of drive-letter / segment case and separators
        assert_eq!(r.references_at("C:\\WORK\\inc\\sub.gms", 22, 4).len(), 1);
        assert_eq!(r.references_at("c:/work/main.gms", 30, 8).len(), 1);
    }

    #[test]
    fn scans_files_used_from_the_end() {
        let (input, locs) = scan_file_tree(REF);
        assert_eq!(input.as_deref(), Some("C:\\Work\\Main.GMS"));
        assert_eq!(locs, ["C:\\Work\\Inc\\Sub.gms", "C:\\Work\\Main.GMS"]);
    }

    #[test]
    fn stale_when_covered_doc_edited_after_start() {
        use std::time::{Duration, SystemTime};
        let mut r = Reference::parse(REF).unwrap();
        remap(&mut r, Path::new("c:/work/main.gms"));
        let e = RefEntry { gms: "c:/work/main.gms".into(), ref_path: "/tmp/x.ref".into(), reference: r, stale: false };
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let mut ed = HashMap::new();
        assert!(!edited_since(&e, &ed, t0));
        ed.insert(PathBuf::from("/unrelated.gms"), t0 + Duration::from_secs(5));
        assert!(!edited_since(&e, &ed, t0));
        ed.insert(PathBuf::from("c:/work/main.gms"), t0 - Duration::from_secs(5));
        assert!(!edited_since(&e, &ed, t0));
        ed.insert(PathBuf::from("c:/Work/Inc/Sub.gms"), t0 + Duration::from_secs(5));
        assert!(edited_since(&e, &ed, t0));
    }
}
