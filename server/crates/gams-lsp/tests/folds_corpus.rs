// SPDX-License-Identifier: GPL-3.0-or-later
//! Folding over the shipped model libraries: the outermost bracket fold of every start line
//! survives, ranges are nested or disjoint and there is one range per start line.
use gams_syntax::{highlight_document_info, section_folds, split_lines};
use std::collections::HashMap;

#[test]
fn shipped_models_keep_outer_folds() {
    let sysdir = std::env::var("GAMS_SYSDIR").unwrap_or_default();
    let Ok(rd) = std::fs::read_dir(&sysdir) else {
        eprintln!("GAMS system directory not found, skipping");
        return;
    };
    let (mut files, mut lost, mut bad) = (0, Vec::new(), Vec::new());
    for d in rd.flatten().map(|e| e.path()).filter(|d| d.file_name().is_some_and(|n| n.to_string_lossy().ends_with("_ml"))) {
        for f in std::fs::read_dir(&d).into_iter().flatten().flatten().map(|e| e.path()) {
            let ext = f.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            let model = ext == "gms" || ext == "inc" || (!ext.is_empty() && ext.bytes().all(|b| b.is_ascii_digit()));
            if !model || std::fs::metadata(&f).is_ok_and(|m| m.len() > 3_000_000) {
                continue;
            }
            files += 1;
            let text = String::from_utf8_lossy(&std::fs::read(&f).unwrap()).into_owned();
            let infos = highlight_document_info(&text);
            let lines = split_lines(&text);
            let brackets = gams_lsp::folding_ranges(&infos);
            let mut outer: HashMap<u32, u32> = HashMap::new();
            for r in &brackets {
                let e = outer.entry(r.start_line).or_insert(r.end_line);
                *e = (*e).max(r.end_line);
            }
            let merged = gams_lsp::merge_folds(brackets, section_folds(&lines, &infos));
            let got: HashMap<u32, u32> = merged.iter().map(|r| (r.start_line, r.end_line)).collect();
            if got.len() != merged.len() {
                bad.push(format!("{}: duplicate start", f.display()));
            }
            for (s, e) in &outer {
                if got.get(s).is_none_or(|g| g < e) {
                    lost.push(format!("{}:{}", f.display(), s + 1));
                }
            }
            for (i, a) in merged.iter().enumerate() {
                for b in &merged[i + 1..] {
                    let (a, b) = ((a.start_line, a.end_line), (b.start_line, b.end_line));
                    if (a.0 < b.0 && b.0 <= a.1 && b.1 > a.1) || (b.0 < a.0 && a.0 <= b.1 && a.1 > b.1) {
                        bad.push(format!("{}: crossing {a:?} {b:?}", f.display()));
                    }
                }
            }
        }
    }
    eprintln!("{files} files, {} lost outer folds, {} structure errors", lost.len(), bad.len());
    assert!(lost.is_empty(), "lost outer folds: {:?}", &lost[..lost.len().min(5)]);
    assert!(bad.is_empty(), "{:?}", &bad[..bad.len().min(5)]);
}
