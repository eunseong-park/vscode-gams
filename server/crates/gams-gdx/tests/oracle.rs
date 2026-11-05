// SPDX-License-Identifier: GPL-3.0-or-later
//! Oracle test (feature `capi-oracle`): the public API on the pure Rust backend must return
//! exactly what the previous C API backend (`gams_gdx::capi`, GAMS library from GAMS_SYSDIR)
//! returns, for every GDX file of the GAMS installation and of the repository; plus write
//! round trips in both directions.
//! `GAMS_SYSDIR=... cargo test -p gams-gdx --features capi-oracle --release --test oracle`
#![cfg(feature = "capi-oracle")]
use gams_gdx::write::{write_file, WriteSymbol};
use gams_gdx::*;
use std::path::{Path, PathBuf};

fn sysdir() -> Option<PathBuf> {
    let d = PathBuf::from(std::env::var("GAMS_SYSDIR").unwrap_or_default());
    if d.join("libgdxcclib64.so").exists() || d.join("gdxcclib64.dll").exists() || d.join("libgdxcclib64.dylib").exists() {
        Some(d)
    } else {
        eprintln!("SKIP: no GDX library in '{}' (set GAMS_SYSDIR)", d.display());
        None
    }
}

fn find_gdx(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut v: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    v.sort();
    for p in v {
        let n = p.file_name().unwrap().to_string_lossy().to_string();
        if p.is_dir() {
            if !matches!(n.as_str(), "node_modules" | "target" | ".git" | ".vscode-test") {
                find_gdx(&p, out);
            }
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("gdx")) {
            out.push(p);
        }
    }
}

fn bits(r: &Record) -> (Vec<String>, Vec<u64>) {
    let v = r
        .values
        .iter()
        .map(|v| match v {
            Value::Num(x) | Value::Acronym(x) => x.to_bits(),
            Value::Undf => 1,
            Value::Na => 2,
            Value::PInf => 3,
            Value::MInf => 4,
            Value::Eps => 5,
        })
        .collect();
    (r.keys.clone(), v)
}

/// (symbols, records) compared.
fn compare(sd: &Path, p: &Path) -> (usize, usize) {
    let c = capi::GdxFile::open(sd, p);
    let r = GdxFile::open_file(p);
    let (mut c, mut r) = match (c, r) {
        (Ok(c), Ok(r)) => (c, r),
        (Err(_), Err(_)) => return (0, 0),
        (c, r) => panic!("{}: C {:?} / Rust {:?}", p.display(), c.err(), r.err()),
    };
    let ctx = p.display().to_string();
    assert_eq!((r.symbol_count(), r.uel_count()), (c.symbol_count(), c.uel_count()), "{ctx}");
    let syms = r.symbols();
    assert_eq!(syms, c.symbols(), "{ctx} symbols");
    for u in -1..=r.uel_count() as i32 + 1 {
        let l = c.uel(u);
        assert_eq!(r.uel(u), l, "{ctx} uel {u}");
        assert_eq!(r.find_uel(&l), c.find_uel(&l), "{ctx} find_uel {l}");
    }
    for t in -1..2000 {
        assert_eq!(r.element_text(t), c.element_text(t), "{ctx} text {t}");
    }
    for v in [0.0, 5.0, SV_ACR, SV_ACR * 2.0, SV_ACR * 17.0] {
        assert_eq!(r.acronym_name(v), c.acronym_name(v), "{ctx}");
    }
    let mut nrec = 0;
    for s in &syms {
        assert_eq!(r.find_symbol(&s.name), c.find_symbol(&s.name), "{ctx}");
        if s.kind == SymbolKind::Alias {
            continue;
        }
        let a = r.records(s.index, 0, usize::MAX).unwrap();
        let b = c.records(s.index, 0, usize::MAX).unwrap();
        assert_eq!(a.len(), b.len(), "{ctx} {}", s.name);
        for (i, (x, y)) in a.iter().zip(&b).enumerate() {
            assert_eq!(bits(x), bits(y), "{ctx} {} record {i}", s.name);
            for v in &x.values {
                if let Value::Acronym(z) = v {
                    assert_eq!(r.acronym_name(*z), c.acronym_name(*z));
                }
            }
            if s.kind == SymbolKind::Set {
                if let Value::Num(t) = x.values[0] {
                    assert_eq!(r.element_text(t as i32), c.element_text(t as i32));
                }
            }
        }
        nrec += a.len();
        // paging
        if s.records > 3 {
            let o = s.records / 3;
            assert_eq!(r.records(s.index, o, 2).unwrap(), c.records(s.index, o, 2).unwrap());
        }
        let (ta, tb) = (r.read_all(s.index).unwrap(), c.read_all(s.index).unwrap());
        assert_eq!((ta.dim, ta.stride, ta.is_set, &ta.keys), (tb.dim, tb.stride, tb.is_set, &tb.keys), "{ctx}");
        assert_eq!(ta.vals.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), tb.vals.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
        let (mut ka, mut kb) = (Vec::new(), Vec::new());
        r.scan_keys(s.index, |k| {
            ka.extend_from_slice(k);
            true
        })
        .unwrap();
        c.scan_keys(s.index, |k| {
            kb.extend_from_slice(k);
            true
        })
        .unwrap();
        assert_eq!(ka, kb);
    }
    (syms.len(), nrec)
}

#[test]
fn rust_backend_matches_c_backend_on_all_files() {
    let Some(sd) = sysdir() else { return };
    let mut files = Vec::new();
    find_gdx(&sd, &mut files);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    find_gdx(&root.join("server"), &mut files);
    find_gdx(&root.join("client/test"), &mut files);
    let (mut ns, mut nr) = (0, 0);
    for f in &files {
        let (a, b) = compare(&sd, f);
        ns += a;
        nr += b;
    }
    eprintln!("gams-gdx oracle: {} files, {ns} symbols, {nr} records identical", files.len());
    assert!(files.len() > 50);
}

#[test]
fn write_round_trips_both_ways() {
    let Some(sd) = sysdir() else { return };
    let dir = std::env::temp_dir().join(format!("gams-gdx-oracle-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut syms = vec![
        WriteSymbol::set("s", 1, &[&["b"], &["a"], &["c d"]]),
        WriteSymbol::parameter("p", 2, &[(&["b", "x"], 2.0), (&["a", "y"], SV_NA), (&["a", "x"], SV_EPS), (&["c d", "x"], -0.0), (&["b", "y"], SV_ACR * 3.0)]),
        WriteSymbol::parameter("sc", 0, &[(&[], 3.5)]),
        WriteSymbol::var_or_equ("v", 1, false, 3, &[(&["a"], [1.0, 2.0, 0.0, SV_PINF, 1.0])]),
        WriteSymbol::var_or_equ("e", 1, true, 2, &[(&["b"], [1.0, 2.0, SV_MINF, 0.0, 1.0])]),
    ];
    syms[0].text = "a set".into();
    let pr = dir.join("rust.gdx");
    let pc = dir.join("c.gdx");
    write_file(&pr, &syms).unwrap();
    capi::write_gdx(&sd, &pc, &syms).unwrap();
    compare(&sd, &pr);
    compare(&sd, &pc);
    // both files have the same content
    let (mut a, mut b) = (GdxFile::open_file(&pr).unwrap(), GdxFile::open_file(&pc).unwrap());
    assert_eq!(a.symbols(), b.symbols());
    for s in a.symbols() {
        assert_eq!(a.records(s.index, 0, 100).unwrap(), b.records(s.index, 0, 100).unwrap());
    }
    std::fs::remove_dir_all(&dir).ok();
}
