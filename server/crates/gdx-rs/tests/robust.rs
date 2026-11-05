// SPDX-License-Identifier: GPL-3.0-or-later
//! Robustness: truncated and corrupted GDX files must produce errors, never panics.
//! Runs without GAMS on the repository fixtures plus files written by the Rust writer.
mod common;
use common::*;
use gdx_rs::*;
use std::io::Cursor;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Open and read everything; `Err` if any step reported an error.
fn traverse(bytes: &[u8]) -> Result<u64> {
    let mut r = GdxReader::from_reader(Cursor::new(bytes))?;
    let (ns, nu) = r.system_info();
    let mut n = 0u64;
    for u in 0..=nu as i32 + 1 {
        if let Some(l) = r.uel(u) {
            let l = l.to_vec();
            let _ = r.find_uel(&l);
        }
    }
    for t in 0..r.elem_text_count() as i32 + 1 {
        let _ = r.elem_text(t);
    }
    let _ = r.acronym_name(SV_ACR * 2.0);
    let mut keys = [0i32; MAX_INDEX_DIM];
    let mut err = None;
    for nr in 0..=ns + 1 {
        let _ = r.symbol_info(nr);
        let _ = r.symbol_info_x(nr);
        let _ = r.symbol_get_domain(nr);
        let _ = r.symbol_get_domain_x(nr);
        let _ = r.symbol_get_comment(nr, 1);
        let name = r.symbol_info(nr).map(|s| s.0.to_vec());
        if let Some(name) = name {
            let _ = r.find_symbol(&name);
        }
        match r.data_read_raw_start(nr) {
            Ok(_) => loop {
                let mut vals = [0.0; VAL_MAX];
                match r.data_read_raw(&mut keys, &mut vals) {
                    Ok(Some(_)) => n += 1,
                    Ok(None) => break,
                    Err(e) => {
                        err.get_or_insert(e);
                        break;
                    }
                }
            },
            Err(e) if nr >= 1 && nr <= ns => {
                err.get_or_insert(e);
            }
            Err(_) => {}
        }
    }
    match err {
        Some(e) => Err(e),
        None => Ok(n),
    }
}

fn no_panic(bytes: &[u8], what: &str) -> Result<u64> {
    match catch_unwind(AssertUnwindSafe(|| traverse(bytes))) {
        Ok(r) => r,
        Err(_) => panic!("panic for {what}"),
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn samples() -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<(String, Vec<u8>)> = repo_fixtures().into_iter().map(|p| (p.display().to_string(), std::fs::read(&p).unwrap())).collect();
    // small files of a GAMS installation if present (format versions 5-7, compressed ones)
    let sd = std::path::PathBuf::from(std::env::var("GAMS_SYSDIR").unwrap_or_default());
    let mut sys = Vec::new();
    find_gdx(&sd, &mut sys);
    let mut seen = std::collections::HashSet::new();
    for p in sys {
        let Ok(b) = std::fs::read(&p) else { continue };
        // one file per (version, compression) header and size class
        let key = (b.get(24..32).map(|x| x.to_vec()), b.len() / 20_000);
        if b.len() < 120_000 && seen.insert(key) {
            v.push((p.display().to_string(), b));
        }
    }
    // Rust-written files (compressed and not) with all features
    for compress in [false, true] {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = GdxWriter::new(&mut buf, "robust", compress);
            w.uel_register_raw_start().unwrap();
            for i in 1..=300 {
                w.uel_register_raw(&format!("e{i}")).unwrap();
            }
            w.uel_register_done().unwrap();
            let t = w.add_set_text("txt");
            w.acronym_add("ac", "", 2).unwrap();
            w.data_write_raw_start("s", "set", 1, DT_SET, 0).unwrap();
            for k in 1..=300 {
                w.data_write_raw(&[k], &[if k % 2 == 0 { t as f64 } else { 0.0 }]).unwrap();
            }
            w.data_write_done().unwrap();
            w.add_alias("s", "a").unwrap();
            w.data_write_raw_start("p", "par", 3, DT_PAR, 0).unwrap();
            w.symbol_set_domain(&["s", "a", "*"]).unwrap();
            for k in 1..=3000 {
                w.data_write_raw(&[1 + k / 100, 1 + (k / 10) % 10, 1 + k % 10 * 29], &[k as f64 * 0.5 + if k % 7 == 0 { SV_ACR * 2.0 } else { 0.0 }]).unwrap();
            }
            w.data_write_done().unwrap();
            w.symbol_set_domain_x(3, &["s", "a", "free"]).unwrap();
            w.data_write_raw_start("v", "var", 1, DT_VAR, VARTYPE_FREE).unwrap();
            w.data_write_raw(&[3], &[1.0, SV_EPS, SV_MINF, SV_PINF, 1.0]).unwrap();
            w.data_write_done().unwrap();
            w.data_write_raw_start("sc", "", 0, DT_EQU, EQU_USERINFO_BASE).unwrap();
            w.data_write_done().unwrap();
            w.symbol_add_comment(1, "c").unwrap();
            w.close().unwrap();
        }
        v.push((format!("rust-written compress={compress}"), buf.into_inner()));
    }
    v
}

#[test]
fn intact_samples_read_fully() {
    for (name, b) in samples() {
        let n = traverse(&b).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(n > 0, "{name}");
    }
}

#[test]
fn truncated_files_error() {
    for (name, b) in samples() {
        let step = (b.len() / 800).max(1);
        let mut cut = 0;
        while cut < b.len() {
            let r = no_panic(&b[..cut], &format!("{name} truncated to {cut}"));
            assert!(r.is_err(), "{name} truncated to {cut} of {} bytes read without error", b.len());
            cut += step;
        }
    }
}

#[test]
fn corrupted_files_never_panic() {
    let mut rng = Rng(0x9e3779b97f4a7c15);
    let iters: usize = std::env::var("GDX_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    let mut errs = 0;
    let mut total = 0;
    for (name, b) in samples() {
        for i in 0..iters {
            let mut m = b.clone();
            let k = 1 + rng.below(4);
            for _ in 0..k {
                let pos = rng.below(m.len());
                m[pos] = match rng.below(4) {
                    0 => 0,
                    1 => 0xff,
                    2 => m[pos] ^ (1 << rng.below(8)),
                    _ => rng.next() as u8,
                };
            }
            if no_panic(&m, &format!("{name} mutation {i}")).is_err() {
                errs += 1;
            }
            total += 1;
        }
    }
    eprintln!("corrupted files: {total} mutations, {errs} reported errors, none panicked");
}
