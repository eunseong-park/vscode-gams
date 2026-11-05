// SPDX-License-Identifier: GPL-3.0-or-later
//! Experiment helper: GDX pair covering special values / default values for studying gdxdiff semantics.
//! `cargo run -p gams-gdx --example write_specials -- <a.gdx> <b.gdx>`
use gams_gdx::write::{write_file, WriteSymbol};
use std::path::Path;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (pa, pb) = (Path::new(&a[1]), Path::new(&a[2]));
    let (e, na, pi, mi, un) = (gams_gdx::SV_EPS, gams_gdx::SV_NA, gams_gdx::SV_PINF, gams_gdx::SV_MINF, gams_gdx::SV_UNDEF);
    let sa = vec![WriteSymbol::parameter("p", 1, &[
        (&["zero_vs_absent"], 0.0), (&["eps_vs_absent"], e), (&["eps_vs_zero"], e), (&["na_na"], na), (&["inf_inf"], pi),
        (&["na_undf"], na), (&["close"], 1.0), (&["close_rel"], 1000.0), (&["minf_pinf"], mi), (&["undf_undf"], un), (&["zero_zero"], 0.0), (&["eps_eps"], e),
        (&["eps_small"], e), (&["na_num"], na), (&["pinf_num"], pi),
    ]),
    WriteSymbol::var_or_equ("v", 1, false, 5, &[(&["a"], [1.0, 2.0, 0.0, 0.0, 1.0]), (&["b"], [1.0, 0.0, 0.0, 0.0, 1.0])]),
    ];
    let sb = vec![WriteSymbol::parameter("p", 1, &[
        (&["zero_vs_absent"], 0.0 + f64::NAN * 0.0), (&["eps_vs_zero"], 0.0), (&["na_na"], na), (&["inf_inf"], pi),
        (&["na_undf"], un), (&["close"], 1.0 + 1e-6), (&["close_rel"], 1000.5), (&["minf_pinf"], pi), (&["undf_undf"], un), (&["zero_zero"], 0.0), (&["eps_eps"], e),
        (&["eps_small"], 1e-12), (&["na_num"], 5.0), (&["pinf_num"], 5.0),
    ]),
    WriteSymbol::var_or_equ("v", 1, false, 5, &[(&["a"], [1.0, 3.0, 0.0, 0.0, 1.0]), (&["b"], [1.0, 0.0, 0.0, 0.0, 1.0])]),
    ];
    let mut sb = sb;
    sb[0].records.remove(0); // zero_vs_absent absent in B
    write_file(pa, &sa).unwrap();
    write_file(pb, &sb).unwrap();
}
