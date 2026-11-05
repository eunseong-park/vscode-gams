// SPDX-License-Identifier: GPL-3.0-or-later
//! Comment section headers (`* Data ----------`) in the outline and folding (extension).
use gams_syntax::*;

fn tree(text: &str) -> Vec<OutlineNode> {
    let lines = split_lines(text);
    let infos = highlight_document_info(text);
    build_outline(&lines, &infos, &declarations_from(&lines, &infos))
}

fn names(nodes: &[OutlineNode]) -> Vec<String> {
    nodes.iter().map(|n| n.name.clone()).collect()
}

fn sections(text: &str) -> Vec<(u32, String, u32)> {
    let lines = split_lines(text);
    let infos = highlight_document_info(text);
    comment_sections(&lines, &infos)
        .into_iter()
        .map(|s| (s.level, s.name, s.line))
        .collect()
}

#[test]
fn header_syntax() {
    let t = "\
* Data ----------
** Subsection ---
*** Deep  name   ----- trailing text
* no dashes here
* ab--
* -------------
*---------------
*Tight -----
* two --- words ---
* a - b --- c
$onText
* Not a section ---------
$offText
 * indented ---------
";
    assert_eq!(
        sections(t),
        vec![
            (1, "Data".into(), 0),
            (2, "Subsection".into(), 1),
            (3, "Deep  name".into(), 2),
            (1, "Tight".into(), 7),
            (1, "two".into(), 8),
            (1, "a - b".into(), 9),
        ]
    );
}

#[test]
fn header_name_range_is_the_name() {
    let t = "**  Data ----\nSet i;";
    let lines = split_lines(t);
    let s = &comment_sections(&lines, &highlight_document_info(t))[0];
    assert_eq!((s.start, s.len), (4, 4));
    // UTF-16 columns with non-BMP characters before the name
    let t = "* \u{1F600}x y ----\n";
    let lines = split_lines(t);
    let s = &comment_sections(&lines, &highlight_document_info(t))[0];
    assert_eq!((s.start, s.len), (2, 5));
}

#[test]
fn declarations_nest_under_sections() {
    let t = "\
Set pre;
* Data ----------
Set i / a /;
Parameter p(i);
** Sub ---
Scalar s;

* Solve ----------
Variable x;
";
    let r = tree(t);
    assert_eq!(names(&r), ["pre", "Data", "Solve"]);
    assert_eq!(names(&r[1].children), ["i", "p", "Sub"]);
    assert_eq!(names(&r[1].children[2].children), ["s"]);
    assert_eq!(names(&r[2].children), ["x"]);
    assert_eq!(r[1].kind, NodeKind::Section);
    // ranges: section 'Data' ends at the last non-blank line before 'Solve'; header selection is the name
    assert_eq!((r[1].line, r[1].end_line), (1, 5));
    assert_eq!((r[1].start, r[1].len), (2, 4));
    assert_eq!((r[1].children[2].line, r[1].children[2].end_line), (4, 5));
    assert_eq!(r[2].end_line, 8);
    assert!(matches!(&r[1].children[0].kind, NodeKind::Declaration(k) if k == "Set"));
}

#[test]
fn level_jumps_and_closing() {
    let t = "*** Deep ---\nSet a;\n* Top ---\nSet b;\n** Mid ---\nSet c;\n*** Deep2 ---\nSet d;\n** Mid2 ---\nSet e;\n";
    let r = tree(t);
    assert_eq!(names(&r), ["Deep", "Top"]);
    assert_eq!(names(&r[0].children), ["a"]);
    assert_eq!(names(&r[1].children), ["b", "Mid", "Mid2"]);
    assert_eq!(names(&r[1].children[1].children), ["c", "Deep2"]);
    assert_eq!(names(&r[1].children[2].children), ["e"]);
}

#[test]
fn without_sections_the_outline_is_the_flat_declaration_list() {
    let t = "Set i / a /;\n* just a comment\nParameter p(i) 'text';\n* ---- \n";
    let r = tree(t);
    assert_eq!(names(&r), ["i", "p"]);
    assert!(r.iter().all(|n| n.children.is_empty()));
    let lines = split_lines(t);
    let infos = highlight_document_info(t);
    let decls = declarations_from(&lines, &infos);
    assert_eq!(decls.len(), 2);
    assert_eq!(
        (r[1].line, r[1].start, r[1].len, r[1].end_line),
        (decls[1].line, decls[1].start, decls[1].len, decls[1].line)
    );
    assert_eq!(r[1].detail.as_deref(), Some("Parameter - text"));
    assert!(section_folds(&lines, &infos).is_empty());
}

#[test]
fn folds_per_section() {
    let t = "* A ---\nSet i;\n\n** B ---\nSet j;\n\n* C ---\nSet k;\n";
    let lines = split_lines(t);
    let mut f = section_folds(&lines, &highlight_document_info(t));
    f.sort();
    // A spans to its last non-blank line (B included), B to its own last line, C to the end
    assert_eq!(f, vec![(0, 4), (3, 4), (6, 7)]);
}

#[test]
fn section_header_inside_declarations_is_still_a_comment_line() {
    // `*` comment lines inside a Table/Set statement are comments for the highlighter too
    let t = "Set i /\n* Elements ----\n a, b /;\nParameter p(i);\n";
    let r = tree(t);
    assert_eq!(names(&r), ["i", "Elements"]);
}

#[test]
fn mpsge_model_in_section() {
    let t = "* Model ----\n$onText\n$MODEL:m\n$SECTORS:\n  y\n$offText\n";
    let r = tree(t);
    assert_eq!(names(&r[0].children), ["m"]);
    assert_eq!(r[0].children[0].kind, NodeKind::MpsgeModel);
    assert_eq!(names(&r[0].children[0].children), ["$SECTORS:"]);
}

fn decl_list(t: &str) -> Vec<(String, String, Option<String>, u32, u32)> {
    let lines = split_lines(t);
    let infos = highlight_document_info(t);
    declarations_from(&lines, &infos)
        .into_iter()
        .map(|d| (d.keyword, d.name, d.type_prefix, d.line, d.start))
        .collect()
}

#[test]
fn alias_names_are_declared() {
    let t = "Set i, j;\nAlias (i,ii),(j,jj);\nAlias(ii, iii);\nalias (k, kk, kkk);\n";
    let d = decl_list(t);
    let names: Vec<(&str, &str, u32, u32)> = d.iter().map(|x| (x.0.as_str(), x.1.as_str(), x.3, x.4)).collect();
    assert_eq!(
        names,
        [("Set", "i", 0, 4), ("Set", "j", 0, 7), ("Alias", "ii", 1, 9), ("Alias", "jj", 1, 16), ("Alias", "iii", 2, 10), ("Alias", "kk", 3, 10), ("Alias", "kkk", 3, 14)]
    );
    let lines = split_lines(t);
    let decls = declarations_from(&lines, &highlight_document_info(t));
    assert_eq!(decls[2].description.as_deref(), Some("alias of i"));
    assert_eq!(decls[4].description.as_deref(), Some("alias of ii"));
}

#[test]
fn declarations_after_if_conditions() {
    let t = "$if set x Set k / a /;\n$if not exist 'a b.gdx' Parameter p(k) 'pp';\n$ifI %mode%==lp Scalar s;\n$if a == b Set\n   k3 / a /\n   k4;\n$if set x $include y\nSet z;\n$ifE (1+ 2)>1 Variable v;\n";
    let d = decl_list(t);
    let names: Vec<(&str, u32, u32)> = d.iter().map(|x| (x.1.as_str(), x.3, x.4)).collect();
    assert_eq!(names, [("k", 0, 14), ("p", 1, 34), ("s", 2, 23), ("k3", 4, 3), ("k4", 5, 3), ("z", 7, 4), ("v", 8, 23)]);
}

#[test]
fn redeclared_variable_is_listed_once() {
    let t = "Variable x 'flow', y;\nPositive Variable x;\nPositive Variable y;\n";
    let lines = split_lines(t);
    let decls = declarations_from(&lines, &highlight_document_info(t));
    assert_eq!(decls.len(), 2, "{decls:?}");
    assert_eq!((decls[0].name.as_str(), decls[0].line, decls[0].type_prefix.as_deref()), ("x", 0, Some("Positive")));
    assert_eq!(decls[0].description.as_deref(), Some("flow"));
    assert_eq!(names(&tree(t)), ["x", "y"]);
}

#[test]
fn framed_section_header_name() {
    // camshape.gms:112
    let t = "*------------------------- Numerical Experiments ---------------------\nSet i;\n*---- Data ----\n";
    let lines = split_lines(t);
    let s = comment_sections(&lines, &highlight_document_info(t));
    assert_eq!(s.iter().map(|s| (s.name.as_str(), s.start, s.len)).collect::<Vec<_>>(), [("Numerical Experiments", 27, 21), ("Data", 6, 4)]);
}
