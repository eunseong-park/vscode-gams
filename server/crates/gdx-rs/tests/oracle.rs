// SPDX-License-Identifier: GPL-3.0-or-later
//! Oracle tests: `gdx-rs` against the official GDX C library of the GAMS installation
//! (`GAMS_SYSDIR`). Run with
//! `cargo test -p gdx-rs --features capi-oracle --release -- --nocapture`.
#![cfg(feature = "capi-oracle")]
mod common;
use common::*;
use gdx_rs::oracle::CGdx;
use gdx_rs::*;
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

#[derive(Default, Debug)]
struct Stats {
    files: usize,
    symbols: usize,
    records: u64,
    uels: u64,
    texts: u64,
}

fn s(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// Compare every C API result the reader offers for one file. Panics on a difference.
fn compare_file(sd: &Path, p: &Path, st: &mut Stats, str_limit: i32) {
    let c = CGdx::open_read(sd, p);
    let r = GdxReader::open(p);
    let (c, mut r) = match (c, r) {
        (Ok(c), Ok(r)) => (c, r),
        (Err(e), Err(_)) => {
            eprintln!("both fail: {} ({e:?})", p.display());
            return;
        }
        (c, r) => panic!("{}: C ok={} Rust={:?}", p.display(), c.is_ok(), r.err()),
    };
    let ctx = p.display().to_string();
    st.files += 1;
    let (ns, nu) = c.system_info();
    assert_eq!(r.system_info(), (ns as usize, nu as usize), "{ctx} system_info");
    let (fv, prod) = c.file_version();
    assert_eq!(r.file_version(), (fv.as_slice(), prod.as_slice()), "{ctx} file_version");
    let (ver, comp) = c.file_info();
    assert_eq!(r.file_info(), (ver, comp), "{ctx} file_info");
    assert_eq!(c.uel_info(), (nu, 0), "{ctx} uel_info");
    assert_eq!(r.uel_max_length() as i32, c.uel_max_length(), "{ctx} uel_max_length");
    assert_eq!(r.symb_max_length() as i32, c.symb_max_length(), "{ctx} symb_max_length");
    let sv = c.special_values();
    let rv = r.special_values();
    for k in [0, 1, 2, 3, 4, 6] {
        assert_eq!(sv[k].to_bits(), rv[k].to_bits(), "{ctx} special value {k}");
    }
    // UEL table incl. out of range numbers
    for n in -1..=nu + 1 {
        let (ok, l, map) = c.uel(n);
        assert_eq!(map, -1, "{ctx}");
        match r.uel(n) {
            Some(x) => assert!(ok && x == l.as_slice(), "{ctx} uel {n}: C {:?} R {:?}", s(&l), s(x)),
            None => assert!(!ok && l == format!("?L__{n}").as_bytes(), "{ctx} uel {n}"),
        }
        if ok && n % 7 == 0 || n < 50 {
            for q in [l.clone(), l.to_ascii_uppercase(), [l.as_slice(), b"  "].concat()] {
                assert_eq!(r.find_uel(&q), c.find_uel(&q), "{ctx} find_uel {:?}", s(&q));
            }
        }
    }
    st.uels += nu as u64;
    assert_eq!(r.find_uel(b"no such label \x01"), c.find_uel(b"no such label \x01"));
    // element texts
    let mut n = 0;
    loop {
        let (ok, t, node) = c.elem_text(n);
        assert_eq!(node, 0);
        match r.elem_text(n) {
            Some(x) => assert!(ok && x == t.as_slice(), "{ctx} text {n}: C {:?} R {:?}", s(&t), s(x)),
            None => {
                assert!(!ok && t == format!("?Str__{n}").as_bytes(), "{ctx} text {n}");
                break;
            }
        }
        n += 1;
    }
    assert!(!c.elem_text(-1).0 && r.elem_text(-1).is_none());
    st.texts += n as u64;
    // acronyms
    assert_eq!(r.acronym_count() as i32, c.acronym_count(), "{ctx} acronym count");
    for (i, a) in r.acronyms().iter().enumerate() {
        let (name, text, map) = c.acronym_info(i as i32 + 1).expect("acronym");
        assert_eq!((a.name.as_slice(), a.text.as_slice(), a.map), (name.as_slice(), text.as_slice(), map), "{ctx} acronym {i}");
        let v = SV_ACR * map as f64;
        assert_eq!(r.acronym_name(v), c.acronym_name(v), "{ctx} acronym name");
    }
    for v in [0.0, 1.0, SV_ACR, SV_ACR * 3.0, SV_ACR * 2.4, SV_ACR * 1e6] {
        assert_eq!(r.acronym_name(v), c.acronym_name(v), "{ctx} acronym name {v}");
    }
    // symbols (0 = universe, ns + 1 = invalid)
    for nr in 0..=ns + 1 {
        assert_eq!(r.symbol_dim(nr as usize), c.symbol_dim(nr), "{ctx} dim {nr}");
        let ci = c.symbol(nr);
        let info = r.symbol_info(nr as usize);
        let Some(ci) = ci else {
            assert!(info.is_none(), "{ctx} symbol {nr}");
            continue;
        };
        st.symbols += 1;
        let (name, dim, typ) = info.expect("symbol");
        assert_eq!((name, dim as i32, typ), (ci.name.as_slice(), ci.dim, ci.typ), "{ctx} info {nr}");
        let (rc, ui, text) = r.symbol_info_x(nr as usize).unwrap();
        assert_eq!((rc, ui, text), (ci.rec_cnt, ci.user_info, ci.text.as_slice()), "{ctx} infoX {nr}");
        assert_eq!(r.set_has_text(nr as usize), ci.has_text, "{ctx} has_text {nr}");
        if nr > 0 {
            assert_eq!(r.symbol_get_domain(nr as usize).unwrap(), ci.domain, "{ctx} domain {nr}");
            let dx = r.symbol_get_domain_x(nr as usize).unwrap();
            assert_eq!((dx.kind, &dx.ids), (ci.domain_x_kind, &ci.domain_x), "{ctx} domainX {nr}");
            let com: Vec<&[u8]> = (1..).map_while(|k| r.symbol_get_comment(nr as usize, k)).collect();
            let cc: Vec<&[u8]> = ci.comments.iter().map(|v| v.as_slice()).collect();
            assert_eq!(com, cc, "{ctx} comments {nr}");
            assert_eq!(r.find_symbol(&ci.name).map(|x| x as i32), c.find_symbol(&ci.name), "{ctx} find {nr}");
            assert_eq!(r.find_symbol(&ci.name.to_ascii_uppercase()).map(|x| x as i32), c.find_symbol(&ci.name.to_ascii_uppercase()), "{ctx} find {nr}");
        }
        // records, raw
        let mut crecs: Vec<(Vec<i32>, [u64; 5], i32)> = Vec::new();
        let cn = c.read_raw(nr, |k, v, f| crecs.push((k.to_vec(), v.map(f64::to_bits), f)));
        let rn = r.data_read_raw_start(nr as usize);
        match (cn, &rn) {
            (Some(cn), Ok(rn)) => assert_eq!(cn, *rn, "{ctx} nrecs {nr}"),
            (None, Err(_)) => continue,
            _ => panic!("{ctx} read start {nr}: C {cn:?} R {rn:?}"),
        }
        let mut keys = [0i32; 20];
        let dim = r.current_dim();
        let mut i = 0;
        loop {
            let mut vals = [0.0f64; 5];
            let Some(f) = r.data_read_raw(&mut keys, &mut vals).unwrap_or_else(|e| panic!("{ctx} {nr}: {e}")) else { break };
            let (ck, cv, cf) = crecs.get(i).unwrap_or_else(|| panic!("{ctx} {nr}: extra record {i}"));
            assert!(
                ck.as_slice() == &keys[..dim] && *cv == vals.map(f64::to_bits) && *cf == f,
                "{ctx} sym {nr} rec {i}: C {ck:?} {:?} {cf} R {:?} {vals:?} {f}",
                cv.map(f64::from_bits),
                &keys[..dim]
            );
            for v in vals {
                if v >= SV_ACR {
                    assert_eq!(r.acronym_name(v), c.acronym_name(v), "{ctx} acronym value {v}");
                }
            }
            i += 1;
        }
        assert_eq!(i, crecs.len(), "{ctx} sym {nr} record count");
        st.records += i as u64;
        // reading after the end is a mode error in both
        assert!(r.data_read_raw(&mut keys, &mut [0.0; 5]).is_err());
        // records, str (keys as labels)
        if (crecs.len() as i32) <= str_limit {
            let mut cs = Vec::new();
            c.read_str(nr, |k, v, f| cs.push((k.to_vec(), v.map(f64::to_bits), f)));
            r.data_read_str_start(nr as usize).unwrap();
            let mut kb = vec![Vec::new(); 20];
            let mut j = 0;
            loop {
                let mut vals = [0.0f64; 5];
                let Some(f) = r.data_read_str(&mut kb, &mut vals).unwrap() else { break };
                assert_eq!((&kb[..dim], vals.map(f64::to_bits), f), (cs[j].0.as_slice(), cs[j].1, cs[j].2), "{ctx} str {nr} rec {j}");
                j += 1;
            }
            assert_eq!(j, cs.len());
            let (cm, cl) = c.symb_indx_max_length(nr);
            let (rm, rl) = r.symb_indx_max_length(nr as usize).unwrap();
            assert_eq!(rm as i32, cm, "{ctx} indxmax {nr}");
            assert_eq!(rl.iter().map(|&x| x as i32).collect::<Vec<_>>(), cl[..rl.len()].to_vec(), "{ctx} indxmax {nr}");
        }
    }
}

#[test]
fn all_installed_and_fixture_gdx_files_match_c_library() {
    let Some(sd) = sysdir() else { return };
    let mut files = Vec::new();
    find_gdx(&sd, &mut files);
    let n_sys = files.len();
    files.extend(repo_fixtures());
    assert!(n_sys > 50, "expected the GDX files of the GAMS installation");
    let mut st = Stats::default();
    for f in &files {
        compare_file(&sd, f, &mut st, 200_000);
    }
    eprintln!("ORACLE installed+fixtures: {} files ({n_sys} from sysdir), {} symbols, {} records, {} UELs, {} texts", st.files, st.symbols, st.records, st.uels, st.texts);
    assert_eq!(st.files, files.len());
}

// ------------------------------------------------------------------ synthetic files (C writer)

/// Write a large file with the C library: sets with element texts, parameters with special
/// values / acronyms / -0.0, variables and equations of all types, aliases, regular and
/// relaxed domains, comments, scalars without records, dims 0..=20.
fn c_write_synthetic(sd: &Path, p: &Path, records: usize, compress: bool) {
    let mut g = CGdx::open_write(sd, p, "gdx-rs oracle", compress).unwrap();
    let nlab = (2.0 * records as f64).sqrt().ceil() as usize + 10;
    let labels: Vec<String> = (1..=nlab.max(300)).map(|i| if i % 50 == 0 { format!("Lab {i}") } else { format!("l{i}") }).collect();
    let lr: Vec<&str> = labels.iter().map(|s| s.as_str()).collect();
    g.register_raw(&lr).unwrap();
    let t1 = g.add_set_text("first text");
    let t2 = g.add_set_text("it's \"quoted\"");
    let t3 = g.add_set_text("first text");
    assert_eq!(t1, t3);
    g.acronym_add("acroA", "acronym a", 3);
    // 1: i(*) with texts, 2: j(*)
    g.write_raw_start("i", "set i", 1, DT_SET, 0).unwrap();
    for k in 1..=200 {
        g.write_raw(&[k], &[if k % 3 == 0 { t2 as f64 } else if k % 3 == 1 { t1 as f64 } else { 0.0 }, 0.0, 0.0, 0.0, 0.0]);
    }
    g.write_done().unwrap();
    g.add_comment(1, "a comment on i").unwrap();
    g.write_raw_start("j", "set j", 1, DT_SET, 0).unwrap();
    for k in 1..=nlab as i32 {
        g.write_raw(&[k], &[0.0; 5]);
    }
    g.write_done().unwrap();
    g.add_alias("i", "ii").unwrap();
    g.add_alias("*", "uu").unwrap();
    g.add_alias("ii", "iii").unwrap();
    // big parameter p(i, j) with domain, odometer keys
    g.write_raw_start("p", "big parameter", 2, DT_PAR, 0).unwrap();
    g.set_domain(&["j", "j"]).unwrap();
    let specials = [SV_UNDEF, SV_NA, SV_PINF, SV_MINF, SV_EPS, 0.0, 1.0, -1.0, 0.5, 2.0, -0.0, SV_ACR * 3.0, SV_ACR * 7.0, 1e-300, -123.456];
    let (mut a, mut b) = (1, 1);
    for r in 0..records {
        let v = if r % 5 == 0 { specials[(r / 5) % specials.len()] } else { r as f64 * 0.37 + 1e-3 };
        g.write_raw(&[a, b], &[v, 0.0, 0.0, 0.0, 0.0]);
        b += 1 + (r % 3 == 0) as i32; // gaps: exercises relative and absolute key encodings
        if b > nlab as i32 {
            b = 1;
            a += 1;
        }
    }
    g.write_done().unwrap();
    g.set_domain_x(6, &["i", "relaxedJ"]).unwrap();
    // variables of every type, scalar ones without records
    for vt in 0..10 {
        g.write_raw_start(&format!("v{vt}"), "variable", 1, DT_VAR, vt).unwrap();
        for k in 1..=30 {
            g.write_raw(&[k], &[k as f64, if k % 2 == 0 { SV_EPS } else { 0.0 }, SV_MINF, SV_PINF, 1.0]);
        }
        g.write_done().unwrap();
        g.write_raw_start(&format!("vs{vt}"), "scalar variable without record", 0, DT_VAR, vt).unwrap();
        g.write_done().unwrap();
    }
    for et in 0..8 {
        g.write_raw_start(&format!("e{et}"), "equation", 1, DT_EQU, EQU_USERINFO_BASE + et).unwrap();
        g.write_raw(&[2], &[1.0, 2.0, 3.0, 4.0, 5.0]);
        g.write_done().unwrap();
        g.write_raw_start(&format!("es{et}"), "", 0, DT_EQU, EQU_USERINFO_BASE + et).unwrap();
        g.write_done().unwrap();
    }
    g.write_raw_start("scal", "scalar with value", 0, DT_PAR, 0).unwrap();
    g.write_raw(&[], &[42.0, 0.0, 0.0, 0.0, 0.0]);
    g.write_done().unwrap();
    g.write_raw_start("scal0", "scalar without record", 0, DT_PAR, 0).unwrap();
    g.write_done().unwrap();
    // 20-dimensional parameter
    g.write_raw_start("p20", "", 20, DT_PAR, 0).unwrap();
    for r in 0..500 {
        let mut k = [1i32; 20];
        k[19] = 1 + r % 300;
        k[18] = 1 + r / 300;
        k[0] = 2;
        g.write_raw(&k, &[r as f64, 0.0, 0.0, 0.0, 0.0]);
    }
    g.write_done().unwrap();
    // str writes with new labels
    g.write_str_start("ps", "str-written", 2, DT_PAR, 0).unwrap();
    for r in 0..1000 {
        let a = format!("s{}", r % 37);
        let b = format!("t{}", r / 37);
        g.write_str(&[&a, &b], &[r as f64, 0.0, 0.0, 0.0, 0.0]);
    }
    g.write_done().unwrap();
    assert_eq!(g.close(), 0);
}

#[test]
fn large_synthetic_files_written_by_c_match() {
    let Some(sd) = sysdir() else { return };
    let dir = scratch("oracle-large");
    let n: usize = std::env::var("GDX_ORACLE_RECORDS").ok().and_then(|v| v.parse().ok()).unwrap_or(1_200_000);
    let mut st = Stats::default();
    for compress in [false, true] {
        let p = dir.join(format!("big_{compress}.gdx"));
        c_write_synthetic(&sd, &p, n, compress);
        let r = GdxReader::open(&p).unwrap();
        assert_eq!(r.file_info().1, compress as i32);
        compare_file(&sd, &p, &mut st, 5000);
    }
    eprintln!("ORACLE synthetic: {} files, {} symbols, {} records", st.files, st.symbols, st.records);
    assert!(st.records >= 2 * n as u64);
    std::fs::remove_dir_all(&dir).ok();
}

// ------------------------------------------------------------------ Rust writer -> C reader

fn rust_write_sample(p: &Path, compress: bool, n: usize) {
    let mut w = GdxWriter::create(p, "gdx-rs test", compress).unwrap();
    w.uel_register_raw_start().unwrap();
    let labels: Vec<String> = (1..=400).map(|i| format!("u{i}")).collect();
    for l in &labels {
        w.uel_register_raw(l).unwrap();
    }
    w.uel_register_done().unwrap();
    let t1 = w.add_set_text("text one");
    let t2 = w.add_set_text("it's");
    assert_eq!(w.add_set_text("text one"), t1);
    w.acronym_add("acr", "an acronym", 4).unwrap();
    w.data_write_raw_start("i", "set i", 1, DT_SET, 0).unwrap();
    for k in 1..=300 {
        w.data_write_raw(&[k], &[if k % 2 == 0 { t1 as f64 } else { t2 as f64 }]).unwrap();
    }
    w.data_write_done().unwrap();
    w.symbol_add_comment(1, "comment 1").unwrap();
    w.symbol_add_comment(1, "comment 2").unwrap();
    w.add_alias("i", "ia").unwrap();
    w.add_alias("uni", "*").unwrap();
    w.data_write_raw_start("p", "parameter p(i,*)", 2, DT_PAR, 0).unwrap();
    w.symbol_set_domain(&["i", "*"]).unwrap();
    let specials = [SV_UNDEF, SV_NA, SV_PINF, SV_MINF, SV_EPS, 0.0, -0.0, 1.0, -1.0, 0.5, 2.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, SV_ACR * 4.0, SV_ACR * 9.0, 3.25];
    let mut r = 0usize;
    'o: for a in 1..=300 {
        for b in (1..=400).step_by(1 + a as usize % 4) {
            if r >= n {
                break 'o;
            }
            let v = if r.is_multiple_of(3) { specials[r / 3 % specials.len()] } else { r as f64 / 7.0 };
            w.data_write_raw(&[a, b], &[v]).unwrap();
            r += 1;
        }
    }
    // unsorted / duplicate raw records are rejected
    assert!(w.data_write_raw(&[1, 1], &[1.0]).is_err());
    w.data_write_done().unwrap();
    w.symbol_set_domain_x(4, &["i", "relaxed"]).unwrap();
    w.data_write_raw_start("x", "variable", 1, DT_VAR, VARTYPE_POSITIVE).unwrap();
    w.symbol_set_domain(&["ia"]).unwrap();
    w.data_write_raw(&[2], &[1.0, 2.0, 0.0, SV_PINF, 1.0]).unwrap();
    assert!(w.data_write_raw(&[350], &[1.0, 2.0, 0.0, SV_PINF, 1.0]).is_err(), "domain violation");
    w.data_write_raw(&[5], &[1.0, SV_EPS, 0.0, SV_PINF, 1.0]).unwrap();
    w.data_write_done().unwrap();
    w.data_write_raw_start("e", "equation", 0, DT_EQU, EQU_USERINFO_BASE + EQUTYPE_L).unwrap();
    w.data_write_done().unwrap();
    w.data_write_str_start("q", "str written, unsorted", 2, DT_PAR, 0).unwrap();
    for k in (0..500).rev() {
        let a = format!("NEW{}", k % 10);
        let b = format!("u{}", 1 + k % 25);
        w.data_write_str(&[&a, &b], &[k as f64]).unwrap();
    }
    assert!(w.data_write_done().is_err(), "duplicates are reported");
    w.uel_register_str_start().unwrap();
    let m1 = w.uel_register_str("u7").unwrap();
    let m2 = w.uel_register_str("brand new").unwrap();
    w.uel_register_done().unwrap();
    w.data_write_map_start("m", "map written", 1, DT_SET, 0).unwrap();
    w.data_write_map(&[m2], &[0.0]).unwrap();
    w.data_write_map(&[m1], &[t1 as f64]).unwrap();
    w.data_write_done().unwrap();
    w.close().unwrap();
}

#[test]
fn rust_written_files_read_identically_by_c_library() {
    let Some(sd) = sysdir() else { return };
    let dir = scratch("oracle-write");
    let mut st = Stats::default();
    for compress in [false, true] {
        let p = dir.join(format!("rust_{compress}.gdx"));
        rust_write_sample(&p, compress, 100_000);
        compare_file(&sd, &p, &mut st, i32::MAX);
        let c = CGdx::open_read(&sd, &p).unwrap();
        assert_eq!(c.file_info(), (7, compress as i32));
        assert_eq!(c.system_info().0, 8);
        let x = c.symbol(5).unwrap();
        assert_eq!((x.rec_cnt, x.domain_x_kind, x.domain_x.clone()), (2, 3, vec![b"ia".to_vec()]));
        let pi = c.symbol(4).unwrap();
        assert_eq!(pi.domain_x, vec![b"i".to_vec(), b"relaxed".to_vec()]);
        let q = c.symbol(7).unwrap();
        assert_eq!(q.rec_cnt, 50, "duplicates dropped");
    }
    // same content written by C and by Rust: gdxdump output must be identical
    let gdxdump = sd.join("gdxdump");
    if gdxdump.exists() {
        let pc = dir.join("c.gdx");
        let pr = dir.join("r.gdx");
        let mut c = CGdx::open_write(&sd, &pc, "x", false).unwrap();
        c.register_raw(&["a", "b", "c d"]).unwrap();
        let t = c.add_set_text("hello");
        c.acronym_add("ac", "txt", 2);
        c.write_raw_start("s", "set", 1, DT_SET, 0).unwrap();
        c.write_raw(&[1], &[t as f64, 0.0, 0.0, 0.0, 0.0]);
        c.write_raw(&[3], &[0.0; 5]);
        c.write_done().unwrap();
        c.write_raw_start("p", "par", 2, DT_PAR, 0).unwrap();
        c.set_domain(&["s", "*"]).unwrap();
        for (k, v) in [([1, 2], SV_EPS), ([1, 3], SV_NA), ([3, 1], 1.5), ([3, 3], SV_ACR * 2.0)] {
            c.write_raw(&k, &[v, 0.0, 0.0, 0.0, 0.0]);
        }
        c.write_done().unwrap();
        c.write_raw_start("v", "var", 1, DT_VAR, VARTYPE_FREE).unwrap();
        c.write_raw(&[2], &[1.0, 0.0, SV_MINF, SV_PINF, 1.0]);
        c.write_done().unwrap();
        c.add_alias("s", "s2").unwrap();
        c.close();
        let mut w = GdxWriter::create(&pr, "x", false).unwrap();
        w.uel_register_raw_start().unwrap();
        for l in ["a", "b", "c d"] {
            w.uel_register_raw(l).unwrap();
        }
        w.uel_register_done().unwrap();
        let t = w.add_set_text("hello");
        w.acronym_add("ac", "txt", 2).unwrap();
        w.data_write_raw_start("s", "set", 1, DT_SET, 0).unwrap();
        w.data_write_raw(&[1], &[t as f64]).unwrap();
        w.data_write_raw(&[3], &[0.0]).unwrap();
        w.data_write_done().unwrap();
        w.data_write_raw_start("p", "par", 2, DT_PAR, 0).unwrap();
        w.symbol_set_domain(&["s", "*"]).unwrap();
        for (k, v) in [([1, 2], SV_EPS), ([1, 3], SV_NA), ([3, 1], 1.5), ([3, 3], SV_ACR * 2.0)] {
            w.data_write_raw(&k, &[v]).unwrap();
        }
        w.data_write_done().unwrap();
        w.data_write_raw_start("v", "var", 1, DT_VAR, VARTYPE_FREE).unwrap();
        w.data_write_raw(&[2], &[1.0, 0.0, SV_MINF, SV_PINF, 1.0]).unwrap();
        w.data_write_done().unwrap();
        w.add_alias("s", "s2").unwrap();
        w.close().unwrap();
        let dump = |p: &Path| {
            let o = std::process::Command::new(&gdxdump).arg(p).env("LD_LIBRARY_PATH", &sd).output().unwrap();
            assert!(o.status.success(), "gdxdump failed: {}", String::from_utf8_lossy(&o.stderr));
            // the first lines name the file
            String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.contains(".gdx")).collect::<Vec<_>>().join("\n")
        };
        let (dc, dr) = (dump(&pc), dump(&pr));
        assert_eq!(dc, dr);
        assert!(dr.contains("hello") && dr.contains("ac"), "{dr}");
        eprintln!("gdxdump of C- and Rust-written file identical ({} lines)", dr.lines().count());
    }
    eprintln!("ORACLE rust-written: {} files, {} symbols, {} records", st.files, st.symbols, st.records);
    std::fs::remove_dir_all(&dir).ok();
}
