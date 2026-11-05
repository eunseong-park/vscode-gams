// SPDX-License-Identifier: GPL-3.0-or-later
use gams_capi::opt::*;
use gams_capi::optfile::*;

#[test]
fn optgams_definition() {
    let Some(dir) = gams_capi::testing::sysdir_or_skip("optgams_definition") else { return };
    let d = load_definition(&dir, "optgams.def").unwrap();
    assert!(d.options.len() > 100);
    let reslim = d.find("ResLim").unwrap();
    assert_eq!(reslim.opt_type, OPT_TYPE_DOUBLE);
    assert!(!reslim.description.is_empty());
    // synonym resolution (RF -> Reference)
    assert!(d.find("rf").unwrap().name.eq_ignore_ascii_case("reference"));
    let lo = d.find("logoption").unwrap();
    assert_eq!(lo.opt_type, OPT_TYPE_ENUM_INT);
    assert!(lo.enums.iter().any(|e| e.value == "3"));
    assert!(d.groups.len() > 3);
    assert!(d.options.iter().any(|o| o.deprecated) || d.synonyms.iter().any(|s| s.deprecated));
}

#[test]
fn optcplex_definition() {
    let Some(dir) = gams_capi::testing::sysdir_or_skip("optcplex_definition") else { return };
    let d = load_definition(&dir, "optcplex.def").unwrap();
    let lp = d.find("lpmethod").unwrap();
    assert_eq!(lp.opt_type, OPT_TYPE_ENUM_INT);
    assert!(lp.enums.len() >= 7);
    assert_eq!(lp.default, "0");
    let gap = d.find("epgap").unwrap();
    assert_eq!(gap.opt_type, OPT_TYPE_DOUBLE);
    assert_eq!(gap.lower.as_deref(), Some("0"));
    assert_eq!(gap.upper.as_deref(), Some("1"));
    assert_eq!(d.eol_chars, "!");
    assert!(d.find("nope").is_none());
}

#[test]
fn check_lines_valid_and_invalid() {
    let Some(dir) = gams_capi::testing::sysdir_or_skip("check_lines_valid_and_invalid") else { return };
    let r = check_lines(
        &dir,
        "optcplex.def",
        &["lpmethod 4", "lpmethod 99", "bogus 1", "reslim abc", "epgap 0.5 ! comment", "* comment", "", "lpmethod"],
    )
    .unwrap();
    assert!(r[0].is_empty());
    assert!(r[1][0].text.contains("Unknown value"));
    assert!(r[2][0].text.contains("Unknown option"));
    assert!(r[3][0].text.contains("Double expected"));
    assert!(r[4].is_empty());
    assert!(r[5].is_empty() && r[6].is_empty());
    assert!(r[7][0].text.contains("Value expected"));
}
