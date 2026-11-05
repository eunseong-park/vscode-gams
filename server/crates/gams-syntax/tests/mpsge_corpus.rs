// SPDX-License-Identifier: GPL-3.0-or-later
//! Smoke test over the model libraries shipped with GAMS (`$GAMS_SYSDIR/*_ml`,
//! read-only): MPSGE blocks are recognized, no panics, no MPSGE tokens outside blocks,
//! ordinary `$onText` comments are unaffected. Skipped when the directory is missing.
use gams_syntax::mpsge;
use gams_syntax::*;
use std::path::PathBuf;

fn libs() -> Vec<PathBuf> {
    let sysdir = std::env::var("GAMS_SYSDIR")
        .unwrap_or_default();
    let Ok(rd) = std::fs::read_dir(&sysdir) else {
        return vec![];
    };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .is_some_and(|n| n.to_string_lossy().ends_with("_ml"))
        })
        .collect();
    dirs.sort();
    dirs
}

/// Independent block finder: `$onText`/`$offText` pairs (case-insensitive) whose first
/// line that is not blank and not a `*` comment starts with `$MODEL:`.
fn naive_models(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    let mut decided = false;
    for l in text.lines() {
        let low = l.trim_start().to_ascii_lowercase();
        if !inside {
            if low.starts_with("$ontext") {
                inside = true;
                decided = false;
            }
        } else if low.starts_with("$offtext") {
            inside = false;
        } else if !decided && !l.trim().is_empty() && !l.starts_with('*') {
            decided = true;
            if l.to_ascii_lowercase().starts_with("$model:") {
                out.push(l[7..].split_whitespace().next().unwrap_or("").to_string());
            }
        }
    }
    out
}

#[test]
fn shipped_models_have_all_blocks_recognized() {
    let dirs = libs();
    if dirs.is_empty() {
        eprintln!("GAMS model libraries not found, skipping");
        return;
    }
    let (mut files, mut blocks_total, mut docs_with_blocks) = (0, 0, 0);
    let mut sections_seen = std::collections::HashSet::new();
    for dir in dirs {
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            let Ok(bytes) = std::fs::read(&p) else {
                continue;
            };
            if bytes.contains(&0) || bytes.len() > 512 * 1024 {
                continue; // binary, or a huge data file (keeps the debug-build test fast)
            }
            let text = String::from_utf8_lossy(&bytes);
            let lines = split_lines(&text);
            let infos = highlight_document_info(&text);
            let blocks = mpsge::find_blocks(&lines, &infos);
            let names: Vec<String> = blocks.iter().map(|b| b.name.clone()).collect();
            let expected = naive_models(&text);
            // the highlighter is authoritative for `$onText` (it knows `$onEcho` etc.):
            // every block it finds must be one the naive scan found, and vice versa
            assert_eq!(names, expected, "{}", p.display());
            if !blocks.is_empty() {
                docs_with_blocks += 1;
                blocks_total += blocks.len();
            }
            // tokens: inside the line, ordered, only in block lines
            let sem = semantic_line_tokens(&lines, &infos);
            for (ln, ts) in sem.iter().enumerate() {
                let n = lines[ln].encode_utf16().count() as u32;
                let in_block = blocks.iter().any(|b| b.contains(ln as u32));
                let mut prev = 0;
                for t in ts {
                    assert!(
                        t.len > 0 && t.start >= prev && t.start + t.len <= n,
                        "{}:{ln}: {t:?}",
                        p.display()
                    );
                    prev = t.start + t.len;
                    if t.ty >= 12 {
                        assert!(
                            in_block,
                            "{}:{ln}: MPSGE token outside a block",
                            p.display()
                        );
                    }
                }
                if !in_block {
                    // identical to the plain Studio tokens
                    let plain: Vec<SemToken> = infos[ln]
                        .tokens
                        .iter()
                        .filter_map(|t| {
                            semantic_token_type(t.kind).map(|(ty, mods)| SemToken {
                                start: t.start,
                                len: t.len,
                                ty,
                                mods,
                            })
                        })
                        .collect();
                    // (`semantic_line_tokens` trims the tokens to their non-blank part)
                    assert_eq!(
                        encode_sem_tokens(std::slice::from_ref(ts), &[lines[ln]]),
                        encode_sem_tokens(&[plain], &[lines[ln]]),
                        "{}:{ln}",
                        p.display()
                    );
                }
            }
            // the whole-document helpers (they highlight again) on a sample plus all MPSGE files
            let sample = files % 8 == 0 || !blocks.is_empty();
            if sample {
                assert_eq!(semantic_tokens(&text).len() % 5, 0);
                let _ = build_outline(&lines, &infos, &declarations_from(&lines, &infos));
                let _ = section_folds(&lines, &infos);
            }
            for b in &blocks {
                assert!(!b.sections.is_empty() && b.sections[0].kind == mpsge::SectionKind::Model);
                for s in &b.sections {
                    sections_seen.insert(s.kind);
                    assert!(s.end_line >= s.line && s.end_line <= b.last_line);
                }
                // every line of the block can be hovered/completed without panics
                for ln in b.model_line..=b.last_line {
                    let width = lines[ln as usize].encode_utf16().count() as u32;
                    for col in [0, 1, width / 2, width] {
                        let _ = mpsge::hover(&lines, &blocks, ln, col);
                        let _ = mpsge::completions(&lines, &blocks, ln, col);
                    }
                }
                let _ = mpsge::outline_node(&lines, b);
            }
            files += 1;
        }
    }
    eprintln!("{files} files, {docs_with_blocks} with MPSGE blocks ({blocks_total} blocks), sections: {sections_seen:?}");
    assert!(files > 300);
    // 28+ shipped models (gamslib_ml *mge, testlib_ml mpsge*, gft, exchange.inc ...)
    assert!(blocks_total >= 28, "{blocks_total}");
    for k in [
        mpsge::SectionKind::Sectors,
        mpsge::SectionKind::Commodities,
        mpsge::SectionKind::Consumers,
        mpsge::SectionKind::Prod,
        mpsge::SectionKind::Demand,
        mpsge::SectionKind::Constraint,
        mpsge::SectionKind::Report,
        mpsge::SectionKind::Auxiliary,
    ] {
        assert!(sections_seen.contains(&k), "{k:?}");
    }
}
