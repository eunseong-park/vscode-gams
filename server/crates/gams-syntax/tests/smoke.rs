// SPDX-License-Identifier: GPL-3.0-or-later
//! Smoke test: highlight every text model of the GAMS model library
//! (`$GAMS_SYSDIR/gamslib_ml`, read-only). Skipped when the directory is missing.

use std::path::PathBuf;

fn gamslib() -> Option<PathBuf> {
    let sysdir = std::env::var("GAMS_SYSDIR")
        .unwrap_or_default();
    let p = PathBuf::from(sysdir).join("gamslib_ml");
    p.is_dir().then_some(p)
}

#[test]
fn gamslib_models_do_not_panic() {
    let Some(dir) = gamslib() else {
        eprintln!("gamslib_ml not found, skipping");
        return;
    };
    let mut files = 0;
    let mut lines = 0;
    let started = std::time::Instant::now();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        let Ok(bytes) = std::fs::read(&p) else {
            continue;
        };
        if bytes.contains(&0) {
            continue; // binary (gdx, xlsx, ...)
        }
        let text = String::from_utf8_lossy(&bytes);
        let infos = gams_syntax::highlight_document_info(&text);
        let src_lines = gams_syntax::split_lines(&text);
        assert_eq!(infos.len(), src_lines.len());
        for (info, l) in infos.iter().zip(&src_lines) {
            let n = l.encode_utf16().count() as u32;
            let mut prev_end = 0;
            for t in &info.tokens {
                assert!(
                    t.len > 0 && t.start >= prev_end && t.start + t.len <= n,
                    "{}: bad token {t:?} in {l:?}",
                    p.display()
                );
                prev_end = t.start + t.len;
            }
        }
        let toks: Vec<Vec<gams_syntax::Token>> = infos.iter().map(|i| i.tokens.clone()).collect();
        let data = gams_syntax::encode_semantic_tokens(&toks, &src_lines);
        assert_eq!(data.len() % 5, 0);
        if files % 10 == 0 {
            let _ = gams_syntax::declarations(&text);
        }
        files += 1;
        lines += infos.len();
    }
    eprintln!(
        "highlighted {files} files / {lines} lines in {:?}",
        started.elapsed()
    );
    assert!(files > 100);
}
