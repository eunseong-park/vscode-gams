// SPDX-License-Identifier: GPL-3.0-or-later

#[test]
fn list_optgams_def() {
    let Some(dir) = gams_capi::testing::sysdir_or_skip("list_optgams_def") else { return };
    let opts = gams_capi::optdef::list_options(&dir, "optgams.def").expect("load");
    assert!(opts.len() > 100, "got {}", opts.len());
    let lp = opts.iter().find(|o| o.name.eq_ignore_ascii_case("lp")).expect("LP");
    assert!(lp.description.contains("Linear Programming"), "{:?}", lp);
    assert!(opts.iter().any(|o| o.name.eq_ignore_ascii_case("reslim")));
}

#[test]
fn missing_def_is_error() {
    let Some(dir) = gams_capi::testing::sysdir_or_skip("missing_def_is_error") else { return };
    assert!(gams_capi::optdef::list_options(&dir, "nope.def").is_err());
}
