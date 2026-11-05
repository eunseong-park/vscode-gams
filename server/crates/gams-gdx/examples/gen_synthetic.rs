// SPDX-License-Identifier: GPL-3.0-or-later
//! Writes a synthetic GDX file for load-testing the viewer (no GAMS installation needed):
//! `cargo run -p gams-gdx --release --example gen_synthetic -- <out.gdx> <records> [dim=2] [compress=0]`
//! Contains the set `s` (`records` elements, dim 1, capped at 2M), the parameter `p(*,..)` and the
//! variable `v(*,..)` (both `records` records over `dim` dimensions; labels `u1..un`). Written
//! with `gdx-rs` (gdxOpenWrite, gdxUELRegisterRaw*, gdxDataWriteRaw*).
use gdx_rs::{GdxWriter, DT_PAR, DT_SET, DT_VAR, SV_MINF, SV_PINF};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("usage: gen_synthetic <out.gdx> <records> [dim] [compress]");
        std::process::exit(2);
    }
    let records: usize = a[2].parse().expect("records");
    let dim: usize = a.get(3).map(|d| d.parse().expect("dim")).unwrap_or(2).clamp(1, 6);
    let compress = a.get(4).is_some_and(|c| c != "0");
    let n = (records as f64).powf(1.0 / dim as f64).ceil().max(1.0) as usize;
    let nuel = n.max(records.min(2_000_000));
    let mut w = GdxWriter::create(&a[1], "gen_synthetic", compress).expect("create");
    w.uel_register_raw_start().unwrap();
    // zero-padded labels so that lexical order == numeric order (raw write needs ascending UELs)
    let wd = nuel.to_string().len();
    for i in 1..=nuel {
        w.uel_register_raw(&format!("u{i:0wd$}")).unwrap();
    }
    w.uel_register_done().unwrap();
    // set s(*) with element text number 0 (no text)
    w.data_write_raw_start("s", "synthetic set", 1, DT_SET, 0).unwrap();
    for i in 1..=records.min(2_000_000) {
        w.data_write_raw(&[i as i32], &[0.0]).unwrap();
    }
    w.data_write_done().unwrap();
    for (name, typ, text) in [("p", DT_PAR, "synthetic parameter"), ("v", DT_VAR, "synthetic free variable")] {
        w.data_write_raw_start(name, text, dim, typ, if typ == DT_VAR { 5 } else { 0 }).unwrap();
        let mut idx = vec![1i32; dim];
        for r in 0..records {
            let x = (r as f64) * 0.37 + 0.001;
            let vals = [x, if r % 7 == 0 { 0.5 } else { 0.0 }, SV_MINF, SV_PINF, 1.0];
            w.data_write_raw(&idx, &vals).unwrap();
            // advance odometer
            let mut d = dim;
            while d > 0 {
                d -= 1;
                idx[d] += 1;
                if idx[d] as usize <= n {
                    break;
                }
                idx[d] = 1;
            }
        }
        w.data_write_done().unwrap();
    }
    w.close().expect("close");
    println!("wrote {} ({records} records, dim {dim}, {n} labels per dimension)", a[1]);
}
