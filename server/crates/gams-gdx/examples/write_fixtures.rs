// SPDX-License-Identifier: GPL-3.0-or-later
//! Generates the self-written GDX test fixtures (no GAMS needed), all with the pure Rust writer:
//! `cargo run -p gams-gdx --example write_fixtures -- server/crates/gams-gdx/tests/fixtures`
//!
//! - `feat.gdx` / `feat_z.gdx`: same content, uncompressed / compressed. Sets with element texts,
//!   a 2-dim set, aliases (`*` too), a relaxed domain, scalars, special values (EPS, NA, +INF,
//!   -INF, UNDF), an acronym, variables and equations of several types, a 3-dim parameter.
//! - `sets.gdx`: two plain sets (no data). `cube.gdx`: one 4x4x4 parameter. `stats.gdx`: scalars
//!   and `*`-indexed parameters.
use gams_gdx::write::{write_file_with, WriteSymbol};
use gams_gdx::{SV_EPS, SV_MINF, SV_NA, SV_PINF, SV_UNDEF};
use std::path::Path;

fn feat() -> Vec<WriteSymbol> {
    let (n, s, e, w): (&[&str], &[&str], &[&str], &[&str]) = (&["north"], &["south"], &["east"], &["west"]);
    let acr = 2.0 * gams_gdx::SV_ACR;
    let mut region = WriteSymbol::set_with_text("region", 1, &[(n, "northern region"), (s, ""), (e, "east, with comma"), (w, "it's the west")]);
    region.text = "regions".into();
    let mut link = WriteSymbol::set("link", 2, &[&["north", "east"], &["north", "west"], &["south", "east"]]);
    link.text = "allowed links".into();
    link.real_domain = true;
    link.domain = vec!["region".into(), "region".into()];
    let mut rate = WriteSymbol::parameter("rate", 0, &[(&[], 0.5)]);
    rate.text = "a scalar".into();
    let mut p = WriteSymbol::parameter(
        "special",
        1,
        &[(&["plain"], 12.5), (&["eps"], SV_EPS), (&["na"], SV_NA), (&["pinf"], SV_PINF), (&["minf"], SV_MINF), (&["undf"], SV_UNDEF), (&["acr"], acr), (&["tiny"], 1.5e-10)],
    );
    p.text = "special values".into();
    let mut cap = WriteSymbol::parameter("cap", 1, &[(&["north"], 90.0), (&["south"], 60.0)]);
    cap.text = "capacity".into();
    cap.real_domain = true;
    cap.domain = vec!["region".into()];
    // relaxed domain: `nowhere` is not a set in the file
    let mut rel = WriteSymbol::parameter("relaxed", 2, &[(&["north", "a"], 1.0), (&["south", "b"], 2.0)]);
    rel.text = "relaxed domain".into();
    rel.domain = vec!["region".into(), "nowhere".into()];
    let mut cube = WriteSymbol::parameter("cube", 3, &[(&["north", "east", "t1"], 1.0), (&["north", "west", "t2"], 2.0), (&["south", "east", "t1"], 3.0), (&["south", "west", "t3"], 4.0)]);
    cube.text = "3-dim parameter".into();
    let mut v = WriteSymbol::var_or_equ(
        "ship",
        1,
        false,
        3,
        &[(&["north"], [10.0, 0.0, 0.0, SV_PINF, 1.0]), (&["south"], [SV_EPS, 1.45, 0.0, SV_PINF, 1.0]), (&["east"], [SV_NA, SV_UNDEF, SV_MINF, 5.0, 1.0])],
    );
    v.text = "positive variable".into();
    v.real_domain = true;
    v.domain = vec!["region".into()];
    let mut obj = WriteSymbol::var_or_equ("obj", 0, true, 0, &[(&[], [0.0, 1.0, 0.0, 0.0, 1.0])]);
    obj.text = "an =e= equation".into();
    let mut bal = WriteSymbol::var_or_equ("bal", 1, true, 2, &[(&["north"], [60.0, 0.0, SV_MINF, 90.0, 1.0]), (&["south"], [60.0, -0.6, SV_MINF, 60.0, 1.0])]);
    bal.text = "an =l= equation".into();
    bal.real_domain = true;
    bal.domain = vec!["region".into()];
    let tot = WriteSymbol::var_or_equ("total", 0, false, 5, &[(&[], [226.5, 0.0, SV_MINF, SV_PINF, 1.0])]);
    vec![region, WriteSymbol::alias("r", "region"), WriteSymbol::alias("any", "*"), link, rate, p, cap, rel, cube, v, obj, bal, tot]
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 2 {
        eprintln!("usage: write_fixtures <out-dir>");
        std::process::exit(2);
    }
    let d = Path::new(&a[1]);
    let acro = [("unit_a", "first acronym", 2)];
    write_file_with(&d.join("feat.gdx"), &feat(), Some(false), &acro).expect("feat");
    write_file_with(&d.join("feat_z.gdx"), &feat(), Some(true), &acro).expect("feat_z");
    let sets = vec![
        WriteSymbol::set_with_text("depot", 1, &[(&["north"], "northern"), (&["south"], "southern")]),
        WriteSymbol::set("shop", 1, &[&["east"], &["west"]]),
    ];
    write_file_with(&d.join("sets.gdx"), &sets, Some(false), &[]).expect("sets");
    // 4x4x4 pseudo random values (deterministic LCG), about 40% density
    let mut x: u64 = 12345;
    let mut next = || {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (x >> 33) as f64 / (1u64 << 31) as f64
    };
    let lab = |p: &str, i: usize| format!("{p}{i}");
    let mut recs: Vec<(Vec<String>, f64)> = Vec::new();
    for i in 1..=4 {
        for j in 1..=4 {
            for k in 1..=4 {
                if next() < 0.4 {
                    recs.push((vec![lab("a", i), lab("b", j), lab("c", k)], (next() * 1e6).round() / 1e6));
                }
            }
        }
    }
    let rr: Vec<(Vec<&str>, f64)> = recs.iter().map(|(k, v)| (k.iter().map(String::as_str).collect(), *v)).collect();
    let rr: Vec<(&[&str], f64)> = rr.iter().map(|(k, v)| (k.as_slice(), *v)).collect();
    let mut cube = WriteSymbol::parameter("v", 3, &rr);
    cube.text = "random cube".into();
    write_file_with(&d.join("cube.gdx"), &[cube], Some(false), &[]).expect("cube");
    let mut est = WriteSymbol::parameter("estimate", 1, &[(&["b0"], 152.1334), (&["b1"], -10.0122), (&["b2"], -239.8191)]);
    est.text = "Estimated coefficients".into();
    let mut r2 = WriteSymbol::parameter("r2", 0, &[(&[], 0.517749)]);
    r2.text = "R Squared".into();
    let mut df = WriteSymbol::parameter("df", 0, &[(&[], 431.0)]);
    df.text = "Degrees of freedom".into();
    write_file_with(&d.join("stats.gdx"), &[r2, df, est], Some(false), &[]).expect("stats");
}
