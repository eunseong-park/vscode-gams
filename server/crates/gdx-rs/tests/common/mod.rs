// SPDX-License-Identifier: GPL-3.0-or-later
#![allow(dead_code)]
use std::path::{Path, PathBuf};

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
}

/// `.gdx` files below `dir` (skipping node_modules, target, .git).
pub fn find_gdx(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut ents: Vec<_> = rd.flatten().collect();
    ents.sort_by_key(|e| e.path());
    for e in ents {
        let p = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if !matches!(name.as_ref(), "node_modules" | "target" | ".git" | ".vscode-test") {
                find_gdx(&p, out);
            }
        } else if ft.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("gdx")) {
            out.push(p);
        }
    }
}

/// Repository fixtures (GDX files committed to the repo).
pub fn repo_fixtures() -> Vec<PathBuf> {
    let root = repo_root();
    let mut v = Vec::new();
    for d in ["server", "client/test"] {
        find_gdx(&root.join(d), &mut v);
    }
    v
}

pub fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("gdx-rs-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}
