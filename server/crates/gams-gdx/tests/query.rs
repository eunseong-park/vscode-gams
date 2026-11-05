// SPDX-License-Identifier: GPL-3.0-or-later
//! Whole-symbol sort / filter / labels / pivot on the self-written mini.gdx and (at runtime) sysdir samples.
use gams_gdx::query::*;
use gams_gdx::*;
use std::collections::HashSet;
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
fn open() -> GdxFile {
    GdxFile::open(&sysdir(), &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mini.gdx")).expect("open")
}
fn run(g: &mut GdxFile, t: &RawTable, q: &Query) -> Vec<u32> {
    let g = std::cell::RefCell::new(g);
    apply(t, q, &mut |u| g.borrow_mut().uel(u), &mut |n| g.borrow().element_text(n))
}
fn labels(g: &mut GdxFile, t: &RawTable, order: &[u32], d: usize) -> Vec<String> {
    order.iter().map(|&r| g.uel(t.key(r as usize, d))).collect()
}
fn set(v: &[&str]) -> HashSet<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn sort_filter_distance_parameter() {
    if !have_sysdir("sort_filter_distance_parameter") {
        return;
    }
    let mut g = open();
    let d = g.find_symbol("fee").unwrap();
    let t = g.read_all(d).unwrap();
    assert_eq!((t.len(), t.dim, t.stride), (4, 2, 1));
    // fee(d,s): north.east 2.5, north.west 1.75, south.east 1.9, south.west 2.6
    let desc = Query { sort: Some(Sort { column: 2, ascending: false }), ..Default::default() };
    let o = run(&mut g, &t, &desc);
    let vals: Vec<f64> = o.iter().map(|&r| t.val(r as usize, 0)).collect();
    assert!(vals.windows(2).all(|w| w[0] >= w[1]), "{vals:?}");
    assert_eq!(vals, [2.6, 2.5, 1.9, 1.75]);
    // key sort on first dim ascending, case-insensitive: north before south
    let ks = Query { sort: Some(Sort { column: 0, ascending: true }), ..Default::default() };
    let o = run(&mut g, &t, &ks);
    let l = labels(&mut g, &t, &o, 0);
    assert_eq!(&l[..2], ["north"; 2]);
    assert_eq!(&l[2..], ["south"; 2]);
    // include filter on dim 1
    let f = LabelFilter { column: 1, mode: FilterMode::Include, labels: set(&["west"]), regex: None };
    let o = run(&mut g, &t, &Query { label_filters: vec![f], ..Default::default() });
    assert_eq!(o.len(), 2);
    assert!(labels(&mut g, &t, &o, 1).iter().all(|x| x == "west"));
    // exclude + regex + value filter combined
    let f = LabelFilter { column: 0, mode: FilterMode::Exclude, labels: set(&[]), regex: regex::Regex::new("^nor").ok() };
    let mut vf = ValueFilter::new(2);
    vf.min = 1.8;
    vf.max = 2.0;
    let q = Query { label_filters: vec![f], value_filters: vec![vf], sort: Some(Sort { column: 2, ascending: true }) };
    let o = run(&mut g, &t, &q);
    let v: Vec<f64> = o.iter().map(|&r| t.val(r as usize, 0)).collect();
    assert_eq!(v, [1.9]); // south only, value in [1.8, 2.0]
}

#[test]
fn unique_labels_first_seen() {
    if !have_sysdir("unique_labels_first_seen") {
        return;
    }
    let mut g = open();
    let d = g.find_symbol("fee").unwrap();
    let t = g.read_all(d).unwrap();
    let l: Vec<String> = unique_uels(&t, 0).into_iter().map(|u| g.uel(u)).collect();
    assert_eq!(l, ["north", "south"]);
    let l: Vec<String> = unique_uels(&t, 1).into_iter().map(|u| g.uel(u)).collect();
    assert_eq!(l, ["east", "west"]);
    assert!(unique_uels(&t, 5).is_empty());
}

#[test]
fn variable_value_sort_and_pivot() {
    if !have_sysdir("variable_value_sort_and_pivot") {
        return;
    }
    let mut g = open();
    let x = g.find_symbol("flow").unwrap();
    let t = g.read_all(x).unwrap();
    assert_eq!((t.dim, t.stride, t.len()), (2, 5, 4));
    let all: Vec<u32> = (0..t.len() as u32).collect();
    let pv = pivot(&t, &all, &[0], &[1]);
    assert_eq!((pv.rows.len(), pv.cols.len()), (2, 2));
    // rows / columns are in UEL-number order (registration order), cells match records
    let rl: Vec<String> = pv.rows.iter().map(|h| g.uel(h[0])).collect();
    assert_eq!(rl, ["north", "south"]);
    for (&(r, c), &rec) in &pv.cells {
        assert_eq!(pv.rows[r as usize][0], t.key(rec as usize, 0));
        assert_eq!(pv.cols[c as usize][0], t.key(rec as usize, 1));
    }
    assert_eq!(pv.cells.len(), 4);
    // transposed
    let tp = pivot(&t, &all, &[1], &[0]);
    assert_eq!((tp.rows.len(), tp.cols.len()), (2, 2));
    // sort by marginal column (dim + 1) ascending
    let q = Query { sort: Some(Sort { column: 3, ascending: true }), ..Default::default() };
    let o = run(&mut g, &t, &q);
    let m: Vec<f64> = o.iter().map(|&r| t.val(r as usize, 1)).collect();
    assert!(m.windows(2).all(|w| w[0] <= w[1]));
    // all dims as rows -> one dummy column
    let flat = pivot(&t, &all, &[0, 1], &[]);
    assert_eq!((flat.rows.len(), flat.cols.len()), (4, 1));
}

#[test]
fn set_text_sort_and_scalar_pivot() {
    if !have_sysdir("set_text_sort_and_scalar_pivot") {
        return;
    }
    let mut g = open();
    let i = g.find_symbol("d").unwrap();
    let t = g.read_all(i).unwrap();
    assert!(t.is_set && t.len() == 2);
    let q = Query { sort: Some(Sort { column: 1, ascending: true }), ..Default::default() };
    let o = run(&mut g, &t, &q);
    assert_eq!(o.len(), 2);
    let z = g.find_symbol("total").unwrap();
    let tz = g.read_all(z).unwrap();
    let pv = pivot(&tz, &[0], &[], &[]);
    assert_eq!((pv.rows.len(), pv.cols.len(), pv.cells.len()), (1, 1, 1));
}

#[test]
fn acronym_names_come_from_gdx() {
    let g = GdxFile::open_file(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/feat.gdx")).unwrap();
    assert_eq!(g.acronym_name(2.0 * SV_ACR), "unit_a");
    assert_eq!(g.acronym_name(12.5), "");
}

#[test]
fn shipped_samples_query_everything() {
    if !have_sysdir("shipped_samples_query_everything") {
        return;
    }
    // run an unfiltered sort on every symbol of a few small shipped files; keys must stay a permutation
    for f in ["datalib_ml/Trnsport.gdx", "datalib_ml/Test2.gdx", "datalib_ml/DemandData.gdx"] {
        let p = sysdir().join(f);
        if !p.exists() {
            continue;
        }
        let mut g = GdxFile::open(&sysdir(), &p).unwrap();
        for s in g.symbols() {
            if s.kind == SymbolKind::Alias || s.records > 50_000 {
                continue;
            }
            let t = g.read_all(s.index).unwrap();
            assert_eq!(t.len(), s.records, "{f} {}", s.name);
            let col = if s.dim > 0 { 0 } else { s.dim };
            let q = Query { sort: Some(Sort { column: col, ascending: false }), ..Default::default() };
            let mut o = run(&mut g, &t, &q);
            o.sort_unstable();
            assert_eq!(o, (0..t.len() as u32).collect::<Vec<_>>());
        }
    }
}
