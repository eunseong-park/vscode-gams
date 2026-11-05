// SPDX-License-Identifier: GPL-3.0-or-later
use gams_gdx::write::{write_gdx, WriteSymbol};
use gams_gdx::*;
use std::path::PathBuf;

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

#[test]
fn writer_round_trips_symbols_and_records() {
    if !have_sysdir("writer_round_trips_symbols_and_records") {
        return;
    }
    let dir = std::env::temp_dir().join(format!("gams-gdx-write-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("w.gdx");
    let syms = vec![
        WriteSymbol::set("s", 1, &[&["b"], &["a"]]),
        WriteSymbol::parameter("p", 2, &[(&["b", "x"], 2.0), (&["a", "y"], 1.0), (&["a", "x"], f64::from_bits(5.0e300f64.to_bits()))]),
        WriteSymbol::var_or_equ("v", 1, false, 3, &[(&["a"], [1.0, 2.0, 0.0, 3.0e300, 1.0])]),
    ];
    write_gdx(&sysdir(), &f, &syms).unwrap();
    let mut g = GdxFile::open(&sysdir(), &f).unwrap();
    let names: Vec<_> = g.symbols().iter().map(|s| (s.name.clone(), s.dim, s.kind)).collect();
    assert_eq!(names, [("s".into(), 1, SymbolKind::Set), ("p".into(), 2, SymbolKind::Parameter), ("v".into(), 1, SymbolKind::Variable)]);
    let p = g.records(2, 0, 10).unwrap();
    assert_eq!(p[0].keys, ["a", "x"]);
    assert_eq!(p[0].values[0], Value::Eps);
    assert_eq!(p[2].keys, ["b", "x"]);
    assert_eq!(g.symbol(3).unwrap().sub_type, 3);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn writer_writes_aliases_domains_and_element_texts() {
    if !have_sysdir("writer_writes_aliases_domains_and_element_texts") {
        return;
    }
    let dir = std::env::temp_dir().join(format!("gams-gdx-write2-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("w2.gdx");
    let (x, y): (&[&str], &[&str]) = (&["x"], &["y"]);
    let mut p = WriteSymbol::parameter("p", 1, &[(x, 1.0)]);
    p.domain = vec!["i".into()];
    let syms = vec![
        WriteSymbol::set_with_text("i", 1, &[(x, ""), (y, "why")]),
        WriteSymbol::alias("a", "i"),
        WriteSymbol::alias("u", "*"),
        p,
    ];
    write_gdx(&sysdir(), &f, &syms).unwrap();
    let mut g = GdxFile::open(&sysdir(), &f).unwrap();
    let kinds: Vec<_> = g.symbols().iter().map(|s| (s.name.clone(), s.kind, s.user_info)).collect();
    assert_eq!(kinds, [("i".into(), SymbolKind::Set, 0), ("a".into(), SymbolKind::Alias, 1), ("u".into(), SymbolKind::Alias, 0), ("p".into(), SymbolKind::Parameter, 0)]);
    assert_eq!(g.symbol(4).unwrap().domain, ["i"]);
    let recs = g.records(1, 0, 10).unwrap();
    let text_nr = |v: Value| if let Value::Num(n) = v { n as i32 } else { -1 };
    assert_eq!(text_nr(recs[0].values[0]), 0); // x: no text
    assert_eq!(g.element_text(text_nr(recs[1].values[0])), "why");
    // the universe as a set: one record per UEL
    let u = g.read_universe();
    assert_eq!((u.dim, u.len()), (1, 2));
    std::fs::remove_dir_all(&dir).ok();
}
