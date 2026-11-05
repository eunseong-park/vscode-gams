// SPDX-License-Identifier: GPL-3.0-or-later
//! MPSGE blocks (extension): detection, tokens, completion, hover, semantic overlay.
//! Snippets are from the MPSGE documentation (`UG_MPSGE_Models.html`, `UG_MPSGE_Intro.html`).
use gams_syntax::mpsge::{self, MKind, SectionKind};
use gams_syntax::*;

const HARBERGER: &str = "\
*       SECTION (ii)    MPSGE MODEL DECLARATION

$ONTEXT

$MODEL:HARBERGER

$SECTORS:
      AL(S)

$COMMODITIES:
      P(G)  W(F)  PT

$CONSUMERS:
      RA(H) GOVT

$PROD:AL(S)  s:0  a:ELAS(S)
      O:P(S)      Q:A(S)
      I:P(G)      Q:B(G,S)
      I:W(F)      Q:FD(F,S)   P:PF(F,S)   A:GOVT   T:TF(F,S)  a:

$DEMAND:RA(H)  s:1  a:ESUB(H)
      D:P(G)      Q:C(G,H)   a:
      D:W(F)      Q:D(F,H)
      E:W(F)      Q:E(F,H)
      E:PT        Q:TRN(H)

$DEMAND:GOVT
      D:PT        Q:GREV

$REPORT:
        V:CD(G,H)       D:P(G)          DEMAND:RA(H)
        V:DF(F,H)       D:W(F)          DEMAND:RA(H)
        V:EMPLOY(S)     I:W(\"L\")        PROD:AL(S)
        V:WLF(H)        W:RA(H)

$OFFTEXT

$SYSINCLUDE mpsgeset HARBERGER
HARBERGER.ITERLIM = 0;
";

fn analyze(text: &str) -> (Vec<String>, Vec<LineInfo>, Vec<mpsge::Block>) {
    let lines: Vec<String> = split_lines(text).iter().map(|s| s.to_string()).collect();
    let infos = highlight_document_info(text);
    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let blocks = mpsge::find_blocks(&refs, &infos);
    (lines, infos, blocks)
}

/// `(text, kind)` of the tokens of a line.
fn toks(lines: &[String], b: &mpsge::Block, line: u32) -> Vec<(String, MKind)> {
    let u: Vec<u16> = lines[line as usize].encode_utf16().collect();
    b.line_tokens(line)
        .iter()
        .map(|t| {
            (
                String::from_utf16_lossy(&u[t.start as usize..(t.start + t.len) as usize]),
                t.kind,
            )
        })
        .collect()
}

fn line_of(lines: &[String], needle: &str) -> u32 {
    lines
        .iter()
        .position(|l| l.contains(needle))
        .unwrap_or_else(|| panic!("{needle}")) as u32
}

#[test]
fn block_and_sections() {
    let (lines, _, blocks) = analyze(HARBERGER);
    assert_eq!(blocks.len(), 1);
    let b = &blocks[0];
    assert_eq!(b.name, "HARBERGER");
    assert_eq!(b.on_line, 2);
    assert_eq!(b.model_line, 4);
    assert_eq!(b.end_line, Some(line_of(&lines, "$OFFTEXT")));
    let kinds: Vec<SectionKind> = b.sections.iter().map(|s| s.kind).collect();
    use SectionKind as S;
    assert_eq!(
        kinds,
        [
            S::Model,
            S::Sectors,
            S::Commodities,
            S::Consumers,
            S::Prod,
            S::Demand,
            S::Demand,
            S::Report
        ]
    );
    let prod = &b.sections[4];
    assert_eq!(prod.name.as_ref().unwrap().0, "AL(S)");
    assert_eq!(prod.end_line, line_of(&lines, "A:GOVT"));
    // declared variables with domains
    let names: Vec<(String, String, SectionKind)> = b
        .vars
        .iter()
        .map(|v| (v.name.clone(), v.domain.clone(), v.kind))
        .collect();
    assert_eq!(names[0], ("AL".into(), "S".into(), S::Sectors));
    assert!(names.contains(&("PT".into(), String::new(), S::Commodities)));
    assert!(names.contains(&("GOVT".into(), String::new(), S::Consumers)));
}

#[test]
fn record_tokens() {
    let (lines, _, blocks) = analyze(HARBERGER);
    let b = &blocks[0];
    let l = line_of(&lines, "$PROD:AL(S)");
    use MKind::*;
    let t = toks(&lines, b, l);
    assert_eq!(
        t,
        vec![
            ("$PROD:".into(), Section),
            ("AL".into(), Identifier),
            ("S".into(), Identifier),
            ("s:".into(), Field),
            ("0".into(), Value),
            ("a:".into(), Field),
            ("ELAS".into(), Identifier),
            ("S".into(), Identifier),
        ]
    );
    let l = line_of(&lines, "A:GOVT");
    let t = toks(&lines, b, l);
    let fields: Vec<&str> = t
        .iter()
        .filter(|(_, k)| *k == Field)
        .map(|(s, _)| s.as_str())
        .collect();
    assert_eq!(fields, ["I:", "Q:", "P:", "A:", "T:", "a:"]);
    // the trailing nest assignment has no value
    let ft: Vec<bool> = b
        .line_tokens(l)
        .iter()
        .filter(|t| t.kind == Field)
        .map(|t| t.value)
        .collect();
    assert_eq!(ft, [true, true, true, true, true, false]);
    // report: quoted label, PROD:/DEMAND: labels
    let t = toks(&lines, b, line_of(&lines, "EMPLOY"));
    assert!(t.contains(&("\"L\"".into(), Label)));
    assert!(t.contains(&("PROD:".into(), Field)));
    assert!(toks(&lines, b, line_of(&lines, "V:CD")).contains(&("DEMAND:".into(), Field)));
}

#[test]
fn comments_descriptors_and_conditions() {
    let src = "\
$onText
$MODEL:cameroon
* functions are scaled
$SECTORS:
   xd(i)           ! domestic and export supply
   m(i)$it(i)      ! imports
   X Y(R)$Y0(R) Z  ! Descriptor for Z
   X(R,T)$(X0(R) GT 0)
$PROD:xd(i) t:etrn(i) a:1
* comment
   o:pd(i)    q:xxd0(i)   a:govt    t:itax(i)  ! trailing
   i:pl(lc)   q:(wa0(lc)*xle(i,lc))  p:pl0(i,lc) a: a:hh t:(wdist(i,lc)-1)
   i:PM#(i)   q: 1.5e-3  i.tl(m):esub(i)
+  i.tl:
$CONSTRAINT:e(i)$it(i)
   e(i) =e= (pfx/pe(i))**eta(i);
$offText
x = 1;
";
    let (lines, _, blocks) = analyze(src);
    let b = &blocks[0];
    use MKind::*;
    let l = line_of(&lines, "xd(i)           !");
    assert_eq!(
        toks(&lines, b, l),
        vec![
            ("xd".into(), Identifier),
            ("i".into(), Identifier),
            ("! domestic and export supply".into(), Description)
        ]
    );
    assert_eq!(
        b.vars
            .iter()
            .find(|v| v.name == "xd")
            .unwrap()
            .description
            .as_deref(),
        Some("domestic and export supply")
    );
    assert_eq!(
        b.vars
            .iter()
            .find(|v| v.name == "Z")
            .unwrap()
            .description
            .as_deref(),
        Some("Descriptor for Z")
    );
    assert!(b
        .vars
        .iter()
        .find(|v| v.name == "X")
        .unwrap()
        .description
        .is_none());
    let t = toks(&lines, b, line_of(&lines, "m(i)$it(i)"));
    assert_eq!(
        t.iter()
            .filter(|(s, k)| s == "it" && *k == Identifier)
            .count(),
        1
    );
    assert_eq!(
        toks(&lines, b, line_of(&lines, "* functions")),
        vec![("* functions are scaled".into(), Comment)]
    );
    assert_eq!(
        toks(&lines, b, line_of(&lines, "* comment")),
        vec![("* comment".into(), Comment)]
    );
    assert!(toks(&lines, b, line_of(&lines, "o:pd(i)")).contains(&("! trailing".into(), Comment)));
    // spaced value `q: 1.5e-3`, spanning operator, nest labor operator, continuation
    let t = toks(&lines, b, line_of(&lines, "PM#"));
    assert!(t.contains(&("1.5e-3".into(), Value)));
    assert!(t.contains(&("i.tl(m):".into(), Field)));
    assert!(t.contains(&("PM".into(), Identifier)));
    let t = toks(&lines, b, line_of(&lines, "+  i.tl:"));
    assert_eq!(t, vec![("i.tl:".into(), Field)]);
    // empty `a:` followed by `a:hh` is a nest assignment, then a tax agent
    let l = line_of(&lines, "i:pl(lc)");
    let v: Vec<bool> = b
        .line_tokens(l)
        .iter()
        .filter(|t| t.kind == Field)
        .map(|t| t.value)
        .collect();
    assert_eq!(v, [true, true, true, false, true, true]);
    // constraint body: GAMS equation
    let t = toks(&lines, b, line_of(&lines, "e(i) =e="));
    assert!(t.contains(&("pfx".into(), Identifier)));
    // reserved words of GAMS are not identifiers
    let src2 = "$onText\n$MODEL:m\n$CONSTRAINT:c\n  c =g= sum(i, x(i));\n$offText";
    let (lines2, _, b2) = analyze(src2);
    assert!(!toks(&lines2, &b2[0], 3).iter().any(|(s, _)| s == "sum"));
}

#[test]
fn switches_and_case() {
    let src = "$ONTEXT\n$model: scarf\n$Sectors:\n  y\n$Consumer:\n  ra\n$PEPS: 1.0E-6\n$FUNLOG:.TRUE.\n$OFFTEXT";
    let (lines, _, blocks) = analyze(src);
    let b = &blocks[0];
    assert_eq!(b.name, "scarf");
    use SectionKind as S;
    assert_eq!(
        b.sections.iter().map(|s| s.kind).collect::<Vec<_>>(),
        [S::Model, S::Sectors, S::Consumers, S::Peps, S::Funlog]
    );
    assert_eq!(
        toks(&lines, b, 6),
        vec![
            ("$PEPS:".into(), MKind::Section),
            ("1.0E-6".into(), MKind::Value)
        ]
    );
    assert_eq!(
        toks(&lines, b, 7),
        vec![
            ("$FUNLOG:".into(), MKind::Section),
            (".TRUE.".into(), MKind::Value)
        ]
    );
}

#[test]
fn only_blocks_starting_with_model_are_mpsge() {
    // prose before $MODEL: is an ordinary comment
    let src = "$onText\nsome text\n$MODEL:x\n$SECTORS:\n  a\n$offText\n$onText\n* c\n\n$MODEL:y\n$offText\n$onText\n$SECTORS:\n$offText\n";
    let (_, _, blocks) = analyze(src);
    assert_eq!(
        blocks.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(),
        ["y"]
    );
    // `$MODEL:` in code (e.g. a put statement) is not a block
    let (_, _, blocks) = analyze("put f '$MODEL:GTAP8'/;\n$MODEL:z\n");
    assert!(blocks.is_empty());
    // an unterminated block extends to the end
    let (_, _, blocks) = analyze("$onText\n$MODEL:u\n$SECTORS:\n  a");
    assert_eq!(blocks[0].end_line, None);
    assert_eq!(blocks[0].last_line, 3);
}

#[test]
fn studio_highlighter_is_unchanged() {
    // the base highlighter still treats the block as a comment
    let infos = highlight_document_info(HARBERGER);
    let l = HARBERGER
        .lines()
        .position(|l| l.starts_with("$PROD:AL"))
        .unwrap();
    assert!(infos[l]
        .tokens
        .iter()
        .all(|t| t.kind == SyntaxKind::CommentBlock));
    // text without MPSGE blocks gives the same semantic tokens as the plain encoding
    let plain =
        "Set i / a, b /;\n$onText\nsome $SECTORS: comment\n$offText\nParameter p(i);\n* c\n";
    let lines = split_lines(plain);
    let infos = highlight_document(plain);
    assert_eq!(
        semantic_tokens(plain),
        encode_semantic_tokens(&infos, &lines)
    );
}

#[test]
fn semantic_overlay() {
    let data = semantic_tokens(HARBERGER);
    let (types, _) = semantic_token_legend();
    let lines = split_lines(HARBERGER);
    let mut decoded: Vec<(usize, usize, usize, &str)> = Vec::new();
    let (mut l, mut c) = (0usize, 0usize);
    for ch in data.chunks(5) {
        l += ch[0] as usize;
        c = if ch[0] > 0 {
            ch[1] as usize
        } else {
            c + ch[1] as usize
        };
        decoded.push((l, c, ch[2] as usize, types[ch[3] as usize]));
    }
    let on = lines.iter().position(|x| x.starts_with("$ONTEXT")).unwrap();
    let off = lines
        .iter()
        .position(|x| x.starts_with("$OFFTEXT"))
        .unwrap();
    let text = |t: &(usize, usize, usize, &str)| &lines[t.0][t.1..t.1 + t.2];
    // $ONTEXT / $OFFTEXT stay directives
    assert!(decoded.iter().any(|t| t.0 == on && t.3 == "gamsDco"));
    assert!(decoded.iter().any(|t| t.0 == off && t.3 == "gamsDco"));
    let in_block: Vec<_> = decoded.iter().filter(|t| t.0 > on && t.0 < off).collect();
    assert!(in_block
        .iter()
        .any(|t| t.3 == "gamsMpsgeSection" && text(t) == "$SECTORS:"));
    assert!(in_block
        .iter()
        .any(|t| t.3 == "gamsMpsgeField" && text(t) == "Q:"));
    assert!(in_block
        .iter()
        .any(|t| t.3 == "gamsIdentifier" && text(t) == "ELAS"));
    assert!(in_block
        .iter()
        .any(|t| t.3 == "gamsAssignValue" && text(t) == "0"));
    assert!(!in_block.iter().any(|t| t.3 == "gamsDco"));
    // no MPSGE token outside the block
    assert!(decoded
        .iter()
        .filter(|t| t.3.starts_with("gamsMpsge"))
        .all(|t| t.0 > on && t.0 < off));
    // legend names agree with the hard-coded indices
    assert_eq!(types[12], "gamsMpsgeSection");
    assert_eq!(types[13], "gamsMpsgeField");
    assert_eq!(types[9], "gamsIdentifier");
    assert_eq!(types[6], "gamsAssignValue");
    assert_eq!(types[5], "gamsAssignLabel");
    assert_eq!(types[2], "gamsComment");
    assert_eq!(types[10], "gamsDescription");
}

#[test]
fn hover_docs() {
    let (lines, _, blocks) = analyze(HARBERGER);
    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let l = line_of(&lines, "$PROD:AL(S)");
    let h = mpsge::hover(&refs, &blocks, l, 2).unwrap();
    assert!(
        h.markdown.contains("$PROD:sector") && h.markdown.contains("Production function"),
        "{}",
        h.markdown
    );
    assert_eq!((h.start, h.end), (0, 6));
    // header labels: s: and a:
    let c = lines[l as usize].find("s:0").unwrap() as u32;
    assert!(mpsge::hover(&refs, &blocks, l, c)
        .unwrap()
        .markdown
        .contains("Top-level substitution elasticity (inputs)"));
    let c = lines[l as usize].find("a:ELAS").unwrap() as u32;
    assert!(mpsge::hover(&refs, &blocks, l, c)
        .unwrap()
        .markdown
        .contains("Substitution elasticity of the input nest"));
    // record labels
    let l = line_of(&lines, "A:GOVT");
    let at = |s: &str| lines[l as usize].find(s).unwrap() as u32;
    assert!(mpsge::hover(&refs, &blocks, l, at("Q:"))
        .unwrap()
        .markdown
        .contains("Reference quantity (default 1)"));
    assert!(mpsge::hover(&refs, &blocks, l, at("A:"))
        .unwrap()
        .markdown
        .contains("Consumer receiving the tax revenue"));
    assert!(mpsge::hover(&refs, &blocks, l, at("T:"))
        .unwrap()
        .markdown
        .contains("ad valorem"));
    let last_a = lines[l as usize].rfind("a:").unwrap() as u32;
    assert!(mpsge::hover(&refs, &blocks, l, last_a)
        .unwrap()
        .markdown
        .contains("Assigns the entry to nest"));
    // declared variable
    let l = line_of(&lines, "I:P(G)      Q:B");
    let c = lines[l as usize].find("P(G)").unwrap() as u32;
    let h = mpsge::hover(&refs, &blocks, l, c).unwrap();
    assert!(h.markdown.contains("commodity P(G)"), "{}", h.markdown);
    // outside a block
    assert!(mpsge::hover(&refs, &blocks, 0, 3).is_none());
    assert!(mpsge::hover(&refs, &blocks, line_of(&lines, "HARBERGER.ITERLIM"), 3).is_none());
}

#[test]
fn completion_sections_and_fields() {
    let src = "$onText\n$MODEL:m\n$SECTORS:\n  y\n$PROD:y s:1\n  \n  O:p  \n  I:q  Q:1 \n$DEMAND:ra\n  \n$REPORT:\n  V:a \n  V:a I:p \n$\n$offText\n";
    let (lines, _, blocks) = analyze(src);
    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let labels = |line: u32, col: u32| -> Vec<String> {
        mpsge::completions(&refs, &blocks, line, col)
            .unwrap()
            .into_iter()
            .map(|c| c.label)
            .collect()
    };
    // sections after `$` in column 1
    let all = labels(13, 1);
    for k in [
        "$MODEL:",
        "$SECTORS:",
        "$COMMODITIES:",
        "$CONSUMERS:",
        "$AUXILIARY:",
        "$PROD:",
        "$DEMAND:",
        "$CONSTRAINT:",
        "$REPORT:",
        "$ECHOP:",
        "$PEPS:",
        "$EULCHK:",
        "$WALCHK:",
        "$FUNLOG:",
        "$DATECH:",
    ] {
        assert!(all.contains(&k.to_string()), "{k}");
    }
    let c = &mpsge::completions(&refs, &blocks, 13, 1).unwrap()[0];
    assert!(c.section && c.start == 0 && !c.doc.is_empty() && !c.detail.is_empty());
    // field labels
    assert_eq!(labels(5, 2), ["O:", "I:"]); // record start in $PROD
    assert_eq!(labels(6, 7), ["Q:", "P:", "A:", "T:", "N:", "M:"]); // after O:p
    assert_eq!(labels(4, 9), ["s:", "t:"]); // header after the sector name
    assert!(labels(4, 6).is_empty()); // on the sector name
    assert_eq!(labels(9, 2), ["D:", "E:"]);
    assert_eq!(labels(11, 2), ["V:"]);
    assert_eq!(labels(12, 10), ["PROD:"].map(String::from));
    // no fields in values, comments, declarations
    assert!(labels(7, 10).is_empty());
    assert!(labels(3, 3).is_empty());
    // outside blocks
    assert!(mpsge::completions(&refs, &blocks, 0, 3).is_none());
    // prefix replaced
    let c = mpsge::completions(&refs, &blocks, 5, 2).unwrap();
    assert_eq!((c[0].start, c[0].end), (2, 2));
}

#[test]
fn outline_of_block() {
    let (lines, infos, blocks) = analyze(HARBERGER);
    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let n = mpsge::outline_node(&refs, &blocks[0]);
    assert_eq!(n.name, "HARBERGER");
    assert_eq!(n.kind, NodeKind::MpsgeModel);
    let names: Vec<&str> = n.children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "$SECTORS:",
            "$COMMODITIES:",
            "$CONSUMERS:",
            "$PROD:AL(S)",
            "$DEMAND:RA(H)",
            "$DEMAND:GOVT",
            "$REPORT:"
        ]
    );
    let kids: Vec<&str> = n.children[1]
        .children
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(kids, ["P(G)", "W(F)", "PT"]);
    let _ = infos;
    // folding ranges of the sections
    let folds = mpsge::fold_ranges(&blocks[0]);
    let prod = line_of(&lines, "$PROD:AL(S)");
    assert!(folds.contains(&(prod, prod + 3)));
}

/// Debug helper: `GAMS_DUMP=file.gms cargo test -p gams-syntax --test mpsge dump_env -- --ignored --nocapture`
#[test]
#[ignore]
fn dump_env() {
    let p = std::env::var("GAMS_DUMP").expect("GAMS_DUMP");
    let text = std::fs::read_to_string(p).unwrap();
    let (lines, _, blocks) = analyze(&text);
    for b in &blocks {
        println!("== {} lines {}..={}", b.name, b.model_line, b.last_line);
        for ln in b.model_line..=b.last_line {
            let t = toks(&lines, b, ln);
            println!("{}", lines[ln as usize]);
            println!(
                "      {}",
                t.iter()
                    .map(|(s, k)| format!("{s}[{k:?}]"))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
        }
    }
}
