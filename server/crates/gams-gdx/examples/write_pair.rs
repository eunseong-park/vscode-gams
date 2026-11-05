// SPDX-License-Identifier: GPL-3.0-or-later
//! Writes two small GDX files that differ in a few records (fixtures for gdxdiff / compare tests):
//! `cargo run -p gams-gdx --example write_pair -- <a.gdx> <b.gdx>`
use gams_gdx::write::{write_file, WriteSymbol};
use std::path::Path;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("usage: write_pair <a.gdx> <b.gdx>");
        std::process::exit(2);
    }
    let (pa, pb) = (Path::new(&a[1]), Path::new(&a[2]));
    let (e, na, pi, mi) = (gams_gdx::SV_EPS, gams_gdx::SV_NA, gams_gdx::SV_PINF, gams_gdx::SV_MINF);
    let mut sa = vec![
        WriteSymbol::set("i", 1, &[&["north"], &["south"], &["hub_a"]]),
        WriteSymbol::parameter("d", 2, &[(&["north", "east"], 2.5), (&["north", "west"], 1.7), (&["south", "east"], 2.5), (&["south", "west"], na)]),
        WriteSymbol::parameter("onlya", 1, &[(&["x"], 1.0)]),
        WriteSymbol::parameter("same", 1, &[(&["x"], 1.0), (&["y"], e)]),
        WriteSymbol::var_or_equ("x", 2, false, 3, &[(&["north", "east"], [50.0, 0.0, 0.0, pi, 1.0]), (&["north", "west"], [300.0, 0.0, 0.0, pi, 1.0])]),
        WriteSymbol::var_or_equ("eq", 1, true, 2, &[(&["s"], [1.0, 2.0, mi, 4.0, 1.0])]),
    ];
    let mut sb = vec![
        WriteSymbol::set("i", 1, &[&["north"], &["south"], &["hub_b"]]),
        WriteSymbol::parameter("d", 2, &[(&["north", "east"], 2.5), (&["north", "west"], 1.8), (&["south", "east"], 2.5), (&["hub_b", "east"], 9.0), (&["south", "west"], 3.0)]),
        WriteSymbol::parameter("onlyb", 1, &[(&["x"], 1.0)]),
        WriteSymbol::parameter("same", 1, &[(&["x"], 1.0), (&["y"], e)]),
        WriteSymbol::var_or_equ("x", 2, false, 3, &[(&["north", "east"], [50.0, 0.5, 0.0, pi, 1.0]), (&["north", "west"], [301.0, 0.0, 0.0, pi, 1.0])]),
        WriteSymbol::var_or_equ("eq", 1, true, 2, &[(&["s"], [1.0, 2.0, mi, 4.0, 1.0])]),
    ];
    sa[0].text = "depots".into();
    sb[0].text = "depots".into();
    write_file(pa, &sa).expect("write a");
    write_file(pb, &sb).expect("write b");
}
