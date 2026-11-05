// SPDX-License-Identifier: GPL-3.0-or-later
use gams_lst::*;

const LXI: &str = include_str!("../../../tests/fixtures/mini.lxi");
const LST: &str = include_str!("../../../tests/fixtures/mini.lst");
const INC_LXI: &str = include_str!("../../../tests/fixtures/mini_inc.lxi");
const BAT_LXI: &str = include_str!("../../../tests/fixtures/mini_bat.lxi");
const MINI_BAT_LST: &str = include_str!("../../../tests/fixtures/mini_bat.lst");
const ERR_LXI: &str = include_str!("../../../tests/fixtures/mini_err.lxi");
const ERR_LST: &str = include_str!("../../../tests/fixtures/mini_err.lst");

fn n(k: &str, l: &str, line: i32) -> LxiNode {
    LxiNode { kind: k.into(), label: l.into(), lst_line: line, children: vec![] }
}
fn g(prev: &str, l: &str, ch: Vec<LxiNode>) -> LxiNode {
    LxiNode { kind: prev.into(), label: l.into(), lst_line: -1, children: ch }
}

#[test]
fn mini_outline() {
    let t = parse_lxi(LXI);
    let exp = vec![
        n("B", "C o m p i l a t i o n", 8),
        n("B", "Equation Listing    SOLVE ship Using LP From line 33", 47),
        g("B", "Equation", vec![n("D", "obj", 50), n("D", "cap", 55), n("D", "dem", 62)]),
        n("B", "Column Listing      SOLVE ship Using LP From line 33", 70),
        g("B", "Column", vec![n("E", "flow", 73), n("E", "total", 95)]),
        n("B", "Range Statistics    SOLVE ship Using LP From line 33", 103),
        n("B", "Model Statistics    SOLVE ship Using LP From line 33", 114),
        n("B", "Solution Report     SOLVE ship Using LP From line 33", 127),
        g("B", "SolEQU", vec![n("F", "obj", 145), n("F", "cap", 149), n("F", "dem", 156)]),
        g("F", "SolVAR", vec![n("G", "flow", 163), n("G", "total", 174)]),
        n("B", "E x e c u t i o n", 184),
        g("B", "Display", vec![n("I", "flow", 184), n("I", "total", 194)]),
    ];
    assert_eq!(t, exp);
    // every entry points at a real line of the lst
    let lines: Vec<&str> = LST.lines().collect();
    for e in flat_entries(&t) {
        assert!(e.lst_line >= 1 && (e.lst_line as usize) <= lines.len());
    }
    assert!(lines[46].starts_with("Equation Listing"));
    assert!(lines[49].contains("obj"), "{}", lines[49]);
}

/// The real include fixtures: `$include` adds an "Include File Summary" section at the end of
/// the compilation listing; `$batinclude` (with a nested `Display`) adds one more display entry.
#[test]
fn include_outlines() {
    let inc = parse_lxi(INC_LXI);
    assert_eq!(inc[0], n("B", "C o m p i l a t i o n", 8));
    assert_eq!(inc[1], n("B", "Include File Summary", 39));
    assert_eq!(inc[2], n("B", "Equation Listing    SOLVE ship Using LP From line 26", 51));
    assert_eq!(inc.last().unwrap().children.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["flow", "total"]);
    let bat = parse_lxi(BAT_LXI);
    assert_eq!(bat[1], n("B", "Include File Summary", 44));
    let disp = bat.last().unwrap();
    assert_eq!(disp.label, "Display");
    assert_eq!(disp.children.iter().map(|c| (c.label.as_str(), c.lst_line)).collect::<Vec<_>>(), [("rep_depot", 194), ("flow", 200), ("total", 209)]);
    // the summary is in the listing at that line
    assert_eq!(MINI_BAT_LST.lines().nth(43).unwrap().trim(), "Include File Summary");
}

#[test]
fn cursor_lookup() {
    let t = parse_lxi(LXI);
    let flat = flat_entries(&t);
    assert_eq!(entry_index_for_line(&t, 0), Some(0));
    let i = entry_index_for_line(&t, 56).unwrap(); // 0-based 56 = line 57 -> "cap" (55)
    assert_eq!(flat[i].label, "cap");
    assert_eq!(flat[entry_index_for_line(&t, 5000).unwrap()].lst_line, 194);
}

#[test]
fn err_and_misc() {
    let t = parse_lxi(ERR_LXI);
    assert_eq!(t, vec![n("B", "C o m p i l a t i o n", 8), n("B", "Include File Summary", 47)]);
    assert!(parse_lxi("").is_empty());
    assert!(parse_lxi("\n\nB\n").is_empty());
    assert_eq!(lxi_path_for_lst("/a.b/x.y.lst"), "/a.b/x.y.lxi");
    let m = scan_lst_markers(ERR_LST);
    assert_eq!(m.iter().filter(|m| m.kind == MarkerKind::ErrorMarker).count(), 5);
    let codes: Vec<u32> = m.iter().filter(|m| m.kind == MarkerKind::ErrorText).flat_map(|m| m.codes.clone()).collect();
    assert_eq!(codes, [170, 140, 140, 257, 282]);
    assert!(m.iter().any(|m| m.text.contains("5 ERROR(S)") && m.kind == MarkerKind::Other));
    // the first marker sits on the line after the echoed include line 2 of the .inc
    let first = m.iter().find(|m| m.kind == MarkerKind::ErrorMarker).unwrap();
    assert!(ERR_LST.lines().nth(first.line - 2).unwrap().contains("nowhere"));
}
