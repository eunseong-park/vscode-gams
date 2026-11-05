// SPDX-License-Identifier: GPL-3.0-or-later
//! `.lst` support (M2): outline from the sibling `.lxi` and links from the echoed
//! compilation listing back to the `.gms`.
use crate::text::{path_to_uri_frag, utf16_len};
use gams_lst::{flat_entries, lxi_path_for_lst, parse_lxi};
use gams_syntax::split_lines;
use lsp_types::*;
use std::path::{Path, PathBuf};

/// DocumentSymbols from `<lst stem>.lxi` (`LxiParser` tree: B entries on top level, other
/// codes grouped). Each entry spans from its `.lst` line to the line before the next entry.
pub fn document_symbols(lst: &Path, text: &str) -> Vec<DocumentSymbol> {
    let Ok(lxi) = std::fs::read(lxi_path_for_lst(&lst.to_string_lossy())) else { return vec![] };
    let nodes = parse_lxi(&String::from_utf8_lossy(&lxi));
    let lines = split_lines(text);
    if lines.is_empty() {
        return vec![];
    }
    let last = lines.len() as u32 - 1;
    let len_of = |l: u32| utf16_len(lines.get(l as usize).copied().unwrap_or(""));
    // start lines (0-based) of all real entries, in file order
    let starts: Vec<u32> = flat_entries(&nodes).iter().filter(|n| n.lst_line > 0).map(|n| (n.lst_line as u32 - 1).min(last)).collect();
    let end_of = |start: u32| -> u32 {
        starts.iter().copied().filter(|&s| s > start).min().map_or(last, |s| s - 1).max(start)
    };
    let range = |a: u32, b: u32| Range::new(Position::new(a, 0), Position::new(b, len_of(b)));
    let leaf = |label: &str, kind: SymbolKind, line: i32| -> Option<DocumentSymbol> {
        if line <= 0 {
            return None;
        }
        let s = (line as u32 - 1).min(last);
        #[allow(deprecated)]
        Some(DocumentSymbol {
            name: if label.trim().is_empty() { "(unnamed)".into() } else { label.trim().to_string() },
            detail: None,
            kind,
            tags: None,
            deprecated: None,
            range: range(s, end_of(s)),
            selection_range: range(s, s),
            children: None,
        })
    };
    let mut out = Vec::new();
    for n in &nodes {
        if n.is_group() {
            let kids: Vec<DocumentSymbol> = n.children.iter().filter_map(|c| leaf(&c.label, SymbolKind::FIELD, c.lst_line)).collect();
            let (Some(f), Some(l)) = (kids.first(), kids.last()) else { continue };
            let r = Range::new(f.range.start, l.range.end);
            #[allow(deprecated)]
            out.push(DocumentSymbol {
                name: n.label.clone(),
                detail: None,
                kind: SymbolKind::NAMESPACE,
                tags: None,
                deprecated: None,
                range: r,
                selection_range: Range::new(r.start, r.start),
                children: Some(kids),
            });
        } else if let Some(s) = leaf(&n.label, SymbolKind::MODULE, n.lst_line) {
            out.push(s);
        }
    }
    out
}

/// Links from the echo lines of the compilation listing (`  22  Set i ...`) to the line of the
/// sibling `<stem>.gms`. The listing numbers are the compiler's global line counter, which equals
/// the `.gms` line only without include files. When the echo contains `$include`-style directives,
/// the global numbers are mapped to (file, local line) with the files-used section of the sibling
/// `<stem>.ref` (see [`gams_ref::Reference::map_global_line`]); without a usable `.ref` (missing,
/// older than the `.gms`, no INPUT record, unreadable include) nothing is linked.
pub fn document_links(lst: &Path, text: &str) -> Vec<DocumentLink> {
    let gms = lst.with_extension("gms");
    if !gms.is_file() {
        return vec![];
    }
    let lines = split_lines(text);
    let Some(first) = lines.iter().position(|l| l.trim_start().starts_with("C o m p i l a t i o n")) else { return vec![] };
    // The compilation listing ends at COMPILATION TIME; the "Include File Summary" table in front of
    // it has rows of the same shape (`SEQ GLOBAL TYPE ...`) whose numbers are no echo line numbers.
    let end = lines[first..]
        .iter()
        .position(|l| l.starts_with("COMPILATION TIME") || l.trim() == "Include File Summary")
        .map_or(lines.len(), |i| first + i);
    let mut found = Vec::new();
    let mut has_include = false;
    for (i, l) in lines.iter().enumerate().take(end).skip(first + 1) {
        let b = l.as_bytes();
        let s = b.iter().take_while(|c| **c == b' ').count();
        let d = b[s..].iter().take_while(|c| c.is_ascii_digit()).count();
        if d == 0 || d > 7 || !b.get(s + d).is_some_and(|c| *c == b' ') {
            continue;
        }
        let n: u32 = l[s..s + d].parse().unwrap_or(0);
        let rest = l[s + d..].trim_start().to_ascii_lowercase();
        if ["$include", "$batinclude", "$libinclude", "$sysinclude"].iter().any(|k| rest.starts_with(k)) {
            has_include = true;
        }
        if n > 0 {
            found.push((i as u32, s as u32, (s + d) as u32, n));
        }
    }
    // Include lines may be hidden from the echo ($offInclude), so the .ref decides as well.
    let reference = include_reference(&gms);
    let has_include = has_include || reference.is_some();
    if has_include && reference.is_none() {
        return vec![];
    }
    let read = |f: &str| std::fs::read(f).ok().map(|b| String::from_utf8_lossy(&b).lines().count() as u32);
    let mapper = match &reference {
        Some(r) => match r.line_mapper(&read) {
            Some(m) => Some(m),
            None => return vec![],
        },
        None => None,
    };
    found
        .into_iter()
        .filter_map(|(line, a, b, n)| {
            let (file, n) = match &mapper {
                Some(m) => {
                    let (f, l) = m.map(n)?;
                    (PathBuf::from(f), l)
                }
                None => (gms.clone(), n),
            };
            Some(DocumentLink {
                range: Range::new(Position::new(line, a), Position::new(line, b)),
                target: Some(path_to_uri_frag(&file, Some(&format!("L{n}")))),
                tooltip: Some(format!("{}:{n}", file.file_name().map(|f| f.to_string_lossy()).unwrap_or_default())),
                data: None,
            })
        })
        .collect()
}

/// The `.ref` next to `gms`, if it is at least as new as the `.gms` and has a files-used tree.
fn include_reference(gms: &Path) -> Option<gams_ref::Reference> {
    let ref_path = gms.with_extension("ref");
    let mt = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    if mt(&ref_path)? < mt(gms)? {
        return None;
    }
    let entry = crate::refs::load(gms, &ref_path).ok()?;
    let t = &entry.reference.file_tree;
    let inc = |f: &gams_ref::FileUsed| f.ref_type.ends_with("INCLUDE");
    (t.iter().any(|f| f.ref_type == "INPUT") && t.iter().any(inc)).then_some(entry.reference)
}
