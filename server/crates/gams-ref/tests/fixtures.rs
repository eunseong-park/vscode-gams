// SPDX-License-Identifier: GPL-3.0-or-later
use gams_ref::*;

const REF: &str = include_str!("../../../tests/fixtures/mini.ref");
const GMS: &str = include_str!("../../../tests/fixtures/mini.gms");
const F: &str = "/work/mini.gms";

fn locs(r: &Reference, n: &str, k: RefKind) -> Vec<(i32, i32)> {
    r.symbol(n).unwrap().locations(k).iter().map(|l| (l.line, l.col)).collect()
}

#[test]
fn mini_symbols() {
    let r = Reference::parse(REF).unwrap();
    assert!(r.is_complete(), "{:?}", r.error_line);
    assert_eq!(r.symbols.len(), 11);
    let ty = |n: &str| r.symbol(n).unwrap().ty;
    for n in ["d", "s"] {
        assert_eq!(ty(n), SymbolType::Set);
    }
    for n in ["stock", "need", "fee"] {
        assert_eq!(ty(n), SymbolType::Parameter);
    }
    for n in ["flow", "total"] {
        assert_eq!(ty(n), SymbolType::Variable);
    }
    for n in ["obj", "cap", "dem"] {
        assert_eq!(ty(n), SymbolType::Equation);
    }
    assert_eq!(ty("ship"), SymbolType::Model);
    assert_eq!(r.symbol("SHIP").unwrap().id, 148);

    let fee = r.symbol("fee").unwrap();
    assert_eq!((fee.dim, fee.num_elements), (2, 4));
    assert_eq!(r.domain_names(fee), ["d", "s"]);
    assert_eq!(fee.text, "cost per unit");
    assert_eq!(r.symbol("total").unwrap().dim, 0);
    assert_eq!(r.symbol("ship").unwrap().text, "");
    assert_eq!(r.domain_names(r.symbol("cap").unwrap()), ["d"]);

    assert_eq!(locs(&r, "d", RefKind::Declare), [(6, 5)]);
    assert_eq!(locs(&r, "obj", RefKind::Define), [(28, 14)]);
    assert_eq!(locs(&r, "flow", RefKind::ImplicitAssign), [(33, 38)]);
    assert_eq!(r.symbol("d").unwrap().control.len(), 3);
    assert_eq!(r.symbol("d").unwrap().reference.len(), 9);
    assert_eq!(r.symbol("flow").unwrap().reference.len(), 5);
    // files
    assert_eq!(r.files_used, [F]);
    assert_eq!(r.file_tree.len(), 1);
    assert_eq!(r.file_tree[0].ref_type, "INPUT");
    assert!(r.file_tree[0].first_entry);
    assert_eq!(r.file_children(0).count(), 1);
    assert_eq!(r.unused().count(), 0);
}

/// Real `$include` / `$batinclude` references: global line numbers differ from the local ones,
/// the file tree has children, and symbols are declared in the included file.
#[test]
fn include_files_and_locations() {
    for (ref_text, n_files) in [(include_str!("../../../tests/fixtures/mini_inc.ref"), 2usize), (include_str!("../../../tests/fixtures/mini_bat.ref"), 3)] {
        let r = Reference::parse(ref_text).unwrap();
        assert!(r.is_complete(), "{:?}", r.error_line);
        assert_eq!(r.file_tree.len(), n_files);
        assert_eq!(r.file_tree[1].ref_type, "INCLUDE");
        assert_eq!(r.file_tree[1].location, "/work/mini_data.inc");
        assert_eq!(r.file_children(1).count(), n_files - 1);
        // stock is declared at local line 3 of mini_data.inc (global line 8)
        let stock = r.symbol("stock").unwrap();
        assert_eq!(stock.declare[0].file, "/work/mini_data.inc");
        assert_eq!(r.references_at("/work/mini_data.inc", stock.declare[0].line, stock.declare[0].col - 1).len(), 1);
    }
    let r = Reference::parse(include_str!("../../../tests/fixtures/mini_bat.ref")).unwrap();
    assert_eq!(r.file_tree[2].ref_type, "BATINCLUDE");
    let rep = r.symbol("rep_depot").unwrap();
    assert_eq!(rep.declare[0].file, "/work/mini_rep.inc");
    assert_eq!(rep.assign.len(), 1);
    assert_eq!(rep.assign[0].file, "/work/mini_rep.inc");
}

#[test]
fn declarations_match_gms() {
    let r = Reference::parse(REF).unwrap();
    let lines: Vec<&str> = GMS.lines().collect();
    for s in &r.symbols {
        for k in RefKind::ALL {
            for l in s.locations(k) {
                assert_eq!(l.file, F);
                let text = lines[l.line as usize - 1];
                if k == RefKind::Declare {
                    let a = l.col as usize - 1 - s.name.len();
                    assert!(text[a..].to_lowercase().starts_with(&s.name), "{} {:?} {}", s.name, k, text);
                }
                if matches!(k, RefKind::Control | RefKind::Assign) {
                    assert!(locate_in_line(&s.name, l.col, text).is_some(), "{} {}", s.name, text);
                }
            }
        }
    }
}

#[test]
fn references_at_works() {
    let r = Reference::parse(REF).unwrap();
    // `   d 'depots' ...` d at col 4 (0-based)
    let h = r.references_at(F, 6, 4);
    assert!(h.iter().any(|h| h.symbol.name == "d" && h.kind == RefKind::Declare));
    assert!(r.references_at(F, 6, 5).is_empty());
    // cap(d).. : cursor on `cap` (col 1) is a define record with a misleading column
    let lines: Vec<&str> = GMS.lines().collect();
    let h = r.references_at_in_text(F, 29, 3, lines[28]);
    assert!(h.iter().any(|h| h.symbol.name == "cap" && h.kind == RefKind::Define));
    let h = r.references_at_in_text(F, 29, 5, lines[28]);
    assert!(h.iter().any(|h| h.symbol.name == "d" && h.kind == RefKind::Control));
    assert!(r.references_at("/other", 6, 4).is_empty());
}

#[test]
fn truncation_is_lenient() {
    assert_eq!(Reference::parse("  \n").unwrap_err(), Error::Empty);
    let lines: Vec<&str> = REF.lines().collect();
    // cut in section 1
    let r = Reference::parse(&lines[..10].join("\n")).unwrap();
    assert!(r.error_line.is_some());
    assert!(r.symbol("d").is_some());
    // cut in section 2
    let r = Reference::parse(&lines[..65 + 1 + 140].join("\n")).unwrap();
    assert!(r.error_line.is_some());
    assert_eq!(r.symbol("stock").unwrap().dim, 1);
    // missing section 3
    let r = Reference::parse(&lines[..65 + 1 + 148].join("\n")).unwrap();
    assert!(r.error_line.is_some());
    assert_eq!(r.file_tree.len(), 1);
    assert_eq!(r.symbol("fee").unwrap().text, "cost per unit");
    // paths with spaces
    let r = Reference::parse("1 5 a SETS declared 1 1 5 0 1 /my dir/x.gms\n0 0 t\n").unwrap();
    assert_eq!(r.symbol("a").unwrap().declare[0].file, "/my dir/x.gms");
}

#[test]
fn references_at_matches_windows_paths() {
    // GAMS writes `C:\x\m.gms`, VS Code asks with `c:/x/m.gms`
    let ref_text = "1 1 a SETS declared 22 22 5 0 1 C:\\x\\m.gms\n0 1 t\n1 a SETS 0 0 0 0\n0 1 t\n0 INPUT 0 0 C:\\x\\m.gms\n";
    let r = Reference::parse(ref_text).unwrap();
    assert_eq!(r.files_used, ["C:\\x\\m.gms"]);
    assert_eq!(r.references_at("c:/x/m.gms", 22, 4).len(), 1);
    assert_eq!(r.references_at("C:\\X\\M.GMS", 22, 4).len(), 1);
    assert!(r.references_at("c:/x/other.gms", 22, 4).is_empty());
}
