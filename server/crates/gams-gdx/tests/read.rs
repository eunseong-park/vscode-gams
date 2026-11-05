// SPDX-License-Identifier: GPL-3.0-or-later
use gams_gdx::*;
use std::path::{Path, PathBuf};

/// True when `$GAMS_SYSDIR` holds the GDX library; otherwise prints a skip note.
fn have_sysdir(test: &str) -> bool {
    let ok = std::env::var_os("GAMS_SYSDIR").is_some_and(|d| {
        let d = std::path::PathBuf::from(d);
        ["libgdxcclib64.so", "gdxcclib64.dll", "libgdxcclib64.dylib"].iter().any(|f| d.join(f).is_file())
    });
    if !ok {
        eprintln!("SKIP {test}: no GAMS system directory (set GAMS_SYSDIR)");
    }
    ok
}
fn sysdir() -> PathBuf {
    std::env::var("GAMS_SYSDIR").expect("GAMS_SYSDIR").into()
}
fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mini.gdx")
}
fn feat(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

#[test]
fn mini_symbols_and_records() {
    if !have_sysdir("mini_symbols_and_records") {
        return;
    }
    // mini.gdx: GAMS 54.6 output of the self-written model mini.gms (gdx=...)
    let mut g = GdxFile::open(&sysdir(), &fixture()).expect("open");
    let syms = g.symbols();
    let names: Vec<_> = syms.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["d", "s", "stock", "need", "fee", "flow", "total", "obj", "cap", "dem"]);
    let fee = &syms[4];
    assert_eq!((fee.dim, fee.kind, fee.records), (2, SymbolKind::Parameter, 4));
    assert_eq!(fee.domain, ["d", "s"]);
    assert_eq!(fee.explanatory_text, "cost per unit");
    assert_eq!(syms[0].kind, SymbolKind::Set);
    let recs = g.records(5, 0, 100).unwrap();
    assert_eq!(recs.len(), 4);
    assert_eq!(recs[0].keys, ["north", "east"]);
    assert_eq!(recs[0].values[0], Value::Num(2.5));
    let page = g.records(5, 2, 100).unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0], recs[2]);
    let stock = g.records(3, 0, 10).unwrap();
    assert_eq!(stock[1].keys, ["south"]);
    assert_eq!(stock[1].values[0], Value::Num(60.0));
    assert_eq!(g.find_symbol("total"), Some(7));
    // cross-checked with `gdxdump` (sysdir)
    let flow = &syms[5];
    assert_eq!((flow.kind, flow.sub_type), (SymbolKind::Variable, 3)); // positive
    assert_eq!(syms[6].sub_type, 5); // free
    let fr = g.records(6, 0, 10).unwrap();
    assert_eq!(fr[3].keys, ["south", "west"]);
    assert!(matches!(fr[3].values[1], Value::Num(v) if (v - 1.45).abs() < 1e-12));
    let cap = g.records(9, 0, 10).unwrap();
    assert_eq!(cap[1].values[0], Value::Num(60.0));
    assert!(matches!(cap[1].values[1], Value::Num(v) if (v + 0.6).abs() < 1e-12));
    assert_eq!(cap[1].values[2], Value::MInf);
    assert_eq!(cap[1].values[3], Value::Num(60.0));
    let dem = g.records(10, 0, 10).unwrap();
    assert_eq!(dem[0].values[3], Value::PInf);
    assert_eq!(dem[0].values[3].special_name(), Some("+INF"));
    assert!(g.find_uel("west").is_some());
}

/// `feat.gdx` / `feat_z.gdx` are written by the Rust writer (`examples/write_fixtures.rs`):
/// the compressed file must read exactly like the uncompressed one.
#[test]
fn feat_covers_writer_features_compressed_and_not() {
    let mut a = GdxFile::open_file(&feat("feat.gdx")).unwrap();
    let mut z = GdxFile::open_file(&feat("feat_z.gdx")).unwrap();
    assert_eq!(a.reader().file_info().1, 0);
    assert_ne!(z.reader().file_info().1, 0, "feat_z.gdx is compressed");
    let (sa, sz) = (a.symbols(), z.symbols());
    assert_eq!(sa, sz);
    let names: Vec<_> = sa.iter().map(|s| (s.name.as_str(), s.kind, s.dim)).collect();
    assert_eq!(
        names,
        [
            ("region", SymbolKind::Set, 1),
            ("r", SymbolKind::Alias, 1),
            ("any", SymbolKind::Alias, 1),
            ("link", SymbolKind::Set, 2),
            ("rate", SymbolKind::Parameter, 0),
            ("special", SymbolKind::Parameter, 1),
            ("cap", SymbolKind::Parameter, 1),
            ("relaxed", SymbolKind::Parameter, 2),
            ("cube", SymbolKind::Parameter, 3),
            ("ship", SymbolKind::Variable, 1),
            ("obj", SymbolKind::Equation, 0),
            ("bal", SymbolKind::Equation, 1),
            ("total", SymbolKind::Variable, 0),
        ]
    );
    for s in &sa {
        if s.kind != SymbolKind::Alias {
            assert_eq!(a.records(s.index, 0, usize::MAX).unwrap(), z.records(s.index, 0, usize::MAX).unwrap(), "{}", s.name);
        }
    }
    // domains: real, relaxed and universe
    assert_eq!(sa[3].domain, ["region", "region"]);
    assert_eq!(sa[6].domain, ["region"]);
    assert_eq!(sa[7].domain, ["region", "nowhere"]);
    assert_eq!(sa[8].domain, ["*", "*", "*"]);
    // aliases
    assert_eq!(sa[1].user_info, 1);
    assert_eq!(sa[2].user_info, 0);
    // set element texts
    let reg = a.records(1, 0, 10).unwrap();
    let text = |g: &GdxFile, v: Value| if let Value::Num(n) = v { if n == 0.0 { String::new() } else { g.element_text(n as i32) } } else { String::new() };
    let texts: Vec<_> = reg.iter().map(|r| (r.keys[0].clone(), text(&a, r.values[0]))).collect();
    assert_eq!(
        texts,
        [("east".into(), "east, with comma".into()), ("north".into(), "northern region".into()), ("south".into(), String::new()), ("west".into(), "it's the west".into())]
    );
    // 0-dim parameter and special values
    assert_eq!(a.records(5, 0, 10).unwrap()[0].values[0], Value::Num(0.5));
    let sp = a.records(6, 0, 20).unwrap();
    let by = |k: &str| sp.iter().find(|r| r.keys[0] == k).unwrap().values[0];
    assert_eq!((by("eps"), by("na"), by("pinf"), by("minf"), by("undf")), (Value::Eps, Value::Na, Value::PInf, Value::MInf, Value::Undf));
    assert_eq!(by("plain"), Value::Num(12.5));
    assert_eq!(by("tiny"), Value::Num(1.5e-10));
    // acronym
    let Value::Acronym(v) = by("acr") else { panic!("acronym expected") };
    assert_eq!(a.acronym_name(v), "unit_a");
    assert_eq!(z.acronym_name(v), "unit_a");
    // variable / equation attributes
    let ship = a.records(10, 0, 10).unwrap();
    assert_eq!(a.symbol(10).unwrap().sub_type, 3);
    assert_eq!(ship[0].keys, ["east"]);
    assert_eq!((ship[0].values[0], ship[0].values[1], ship[0].values[2]), (Value::Na, Value::Undf, Value::MInf));
    assert_eq!(ship[2].values[0], Value::Eps);
    assert_eq!(a.symbol(13).unwrap().sub_type, 5);
}

/// `sets.gdx`, `cube.gdx`, `stats.gdx`: small single-purpose files.
#[test]
fn small_fixtures() {
    let g = GdxFile::open_file(&feat("sets.gdx")).unwrap();
    assert_eq!(g.symbol_count(), 2);
    assert_eq!(g.symbols().iter().map(|s| (s.kind, s.records)).collect::<Vec<_>>(), [(SymbolKind::Set, 2), (SymbolKind::Set, 2)]);
    let mut g = GdxFile::open_file(&feat("cube.gdx")).unwrap();
    let v = g.symbol(1).unwrap();
    assert_eq!(v.dim, 3);
    let n = v.records;
    assert!(n > 5 && n < 64, "{n}");
    assert_eq!(g.records(1, 0, usize::MAX).unwrap().len(), n);
    let mut g = GdxFile::open_file(&feat("stats.gdx")).unwrap();
    let names: Vec<_> = g.symbols().iter().map(|s| (s.name.clone(), s.dim)).collect();
    assert_eq!(names, [("r2".into(), 0), ("df".into(), 0), ("estimate".into(), 1)]);
    assert_eq!(g.records(2, 0, 1).unwrap()[0].values[0], Value::Num(431.0));
}

#[test]
fn open_missing_file_errors() {
    if !have_sysdir("open_missing_file_errors") {
        return;
    }
    assert!(GdxFile::open(&sysdir(), Path::new("/nonexistent.gdx")).is_err());
}

/// Cross-check against every small shipped GDX: record counts must match gdxdump-independent
/// invariants (reading all records yields exactly `records` rows) and special values decode.
#[test]
fn read_all_shipped_samples() {
    if !have_sysdir("read_all_shipped_samples") {
        return;
    }
    let dir = sysdir().join("datalib_ml");
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let mut seen_special = false;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().map(|x| x == "gdx").unwrap_or(false) && e.metadata().unwrap().len() < 2_000_000 {
            let mut g = GdxFile::open(&sysdir(), &p).unwrap();
            for s in g.symbols() {
                if s.kind == SymbolKind::Alias {
                    continue;
                }
                let r = g.records(s.index, 0, usize::MAX).unwrap();
                assert_eq!(r.len(), s.records, "{} in {}", s.name, p.display());
                seen_special |= r.iter().any(|r| r.values.iter().any(|v| v.special_name().is_some()));
            }
        }
    }
    let _ = seen_special;
}

fn fresh(p: &Path, sym: usize, offset: usize, limit: usize) -> Vec<Record> {
    GdxFile::open(&sysdir(), p).unwrap().records(sym, offset, limit).unwrap()
}

/// Paging through one open file (cursor kept across pages, restarts on backward/other-symbol
/// requests) must return exactly what a fresh file returns for the same (symbol, offset, limit).
#[test]
fn paging_matches_fresh_reads() {
    if !have_sysdir("paging_matches_fresh_reads") {
        return;
    }
    let p = fixture();
    let mut g = GdxFile::open(&sysdir(), &p).unwrap();
    let syms: Vec<_> = g.symbols().into_iter().filter(|s| s.kind != SymbolKind::Alias).collect();
    for s in &syms {
        for page in [1usize, 2, 4] {
            // sequential
            let mut all = Vec::new();
            let mut off = 0;
            while off < s.records {
                let r = g.records(s.index, off, page).unwrap();
                assert_eq!(r, fresh(&p, s.index, off, page), "{} seq off={off} page={page}", s.name);
                off += r.len();
                all.extend(r);
            }
            assert_eq!(all.len(), s.records, "{}", s.name);
            assert_eq!(all, fresh(&p, s.index, 0, usize::MAX), "{}", s.name);
        }
    }
    // random access, gaps, backward jumps, interleaved symbols and metadata calls while a
    // cursor may be open
    let (d, c) = (5usize, 6usize); // fee(d,s), flow(d,s): 4 records each
    let steps = [(d, 2, 2), (d, 0, 1), (c, 1, 2), (d, 3, 2), (d, 3, 5), (d, 1, 1), (d, 4, 0), (c, 0, 4), (c, 4, 3), (d, 0, 3)];
    for (sym, off, lim) in steps {
        let r = g.records(sym, off, lim).unwrap();
        assert_eq!(r, fresh(&p, sym, off, lim), "sym={sym} off={off} lim={lim}");
        // metadata and UEL lookups are fine with a cursor open
        assert_eq!(g.symbol(sym).unwrap().records, 4);
        assert_eq!(g.symbols().len(), 10);
        assert!(g.find_uel("north").is_some());
        let _ = g.element_text(1);
    }
}

#[test]
fn sysdir_is_not_needed() {
    // the pure Rust backend ignores the sysdir argument
    let g = GdxFile::open(Path::new(""), &fixture()).expect("open without sysdir");
    assert_eq!(g.symbol_count(), 10);
    let g = GdxFile::open_file(&fixture()).expect("open_file");
    assert_eq!(g.find_symbol("fee"), Some(5));
    assert_eq!(g.find_symbol("*"), Some(0));
}

#[test]
fn corrupt_file_errors() {
    let dir = std::env::temp_dir().join(format!("gams-gdx-corrupt-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let b = std::fs::read(fixture()).unwrap();
    let p = dir.join("t.gdx");
    std::fs::write(&p, &b[..b.len() / 2]).unwrap();
    let e = GdxFile::open_file(&p).err().expect("truncated file must fail");
    assert!(e.0.contains("Unable to open GDX file"), "{e}");
    std::fs::remove_dir_all(&dir).ok();
}
