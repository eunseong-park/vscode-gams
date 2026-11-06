// SPDX-License-Identifier: GPL-3.0-or-later
use gams_syntax::*;

fn dump(text: &str) -> String {
    let mut out = String::new();
    let mut st = LineState::default();
    for l in split_lines(text) {
        let info = highlight_line_info(&st, l);
        out.push_str(&format!("{l}\n"));
        let u: Vec<u16> = l.encode_utf16().collect();
        for t in &info.tokens {
            let s = String::from_utf16_lossy(&u[t.start as usize..(t.start + t.len) as usize]);
            out.push_str(&format!(
                "   {:>3}+{:<3} {:?}{} {:?}\n",
                t.start,
                t.len,
                t.kind,
                if t.error { "!ERR" } else { "" },
                s
            ));
        }
        out.push_str(&format!(
            "   => {:?} fl={}\n",
            info.state.kinds(),
            info.state.top_flavor()
        ));
        st = info.state;
    }
    out
}

#[test]
#[ignore]
fn dump_env() {
    let p = std::env::var("GAMS_DUMP").expect("GAMS_DUMP");
    let t = std::fs::read_to_string(p).unwrap();
    println!("{}", dump(&t));
}

/// `(trimmed text, kind, error)` of all tokens of each line.
fn toks(text: &str) -> Vec<Vec<(String, SyntaxKind, bool)>> {
    let lines = split_lines(text);
    highlight_document(text)
        .into_iter()
        .zip(lines)
        .map(|(ts, l)| {
            let u: Vec<u16> = l.encode_utf16().collect();
            ts.iter()
                .map(|t| {
                    let s =
                        String::from_utf16_lossy(&u[t.start as usize..(t.start + t.len) as usize]);
                    (s.trim().to_string(), t.kind, t.error)
                })
                .collect()
        })
        .collect()
}

fn has(line: &[(String, SyntaxKind, bool)], text: &str, kind: SyntaxKind) -> bool {
    line.iter().any(|(s, k, e)| s == text && *k == kind && !e)
}

fn final_state(text: &str) -> LineState {
    let mut st = LineState::default();
    for l in split_lines(text) {
        st = highlight_line(&st, l).1;
    }
    st
}

use SyntaxKind as K;

#[test]
fn set_declaration_with_description_and_data() {
    let t = toks("Set i 'canning plants' / seattle, san-diego /;");
    let l = &t[0];
    assert!(has(l, "Set", K::Declaration));
    assert!(has(l, "i", K::Identifier));
    assert!(has(l, "'canning plants'", K::IdentifierDescription));
    assert!(has(l, "/", K::IdentifierAssignment));
    assert!(has(l, "seattle", K::AssignmentLabel));
    assert!(has(l, "san-diego", K::AssignmentLabel));
    assert!(has(l, "/", K::IdentifierAssignmentEnd));
    assert!(has(l, ";", K::Semicolon));
}

#[test]
fn multi_line_parameter_data_keeps_state() {
    let src = "Parameter\n   a(i) 'capacity'\n        / seattle    350\n          san-diego  600 /;\nx = 1;";
    let t = toks(src);
    assert!(has(&t[0], "Parameter", K::Declaration));
    assert!(has(&t[1], "a", K::Identifier));
    assert!(has(&t[1], "(i", K::IdentifierDim));
    assert!(has(&t[1], ")", K::IdentifierDimEnd));
    assert!(has(&t[1], "'capacity'", K::IdentifierDescription));
    assert!(has(&t[2], "seattle", K::AssignmentLabel));
    assert!(has(&t[2], "350", K::AssignmentValue));
    assert!(has(&t[3], "san-diego", K::AssignmentLabel));
    assert!(has(&t[3], "600", K::AssignmentValue));
    assert!(has(&t[3], ";", K::Semicolon));
    assert!(has(&t[4], "x = 1", K::Formula));
    assert_eq!(final_state(src).kinds(), vec![K::Standard]);
}

#[test]
fn model_with_label_list_and_dotted_labels() {
    let t = toks("Model m / eq1, eq2 /;\nSet ij / a.b, c.(d,e) /;");
    assert!(has(&t[0], "Model", K::Declaration));
    assert!(has(&t[0], "m", K::Identifier));
    assert!(has(&t[0], "eq1", K::AssignmentLabel));
    assert!(has(&t[0], "eq2", K::AssignmentLabel));
    // "a." binds to the next label (flavorBindLabel); adjacent blocks of the same
    // kind merge into one token
    assert!(has(&t[1], "a.b", K::AssignmentLabel));
    assert!(has(&t[1], "c.(d,e)", K::AssignmentLabel));
}

#[test]
fn table_statement_headers_and_rows() {
    let src = "Table d(i,j) 'distance'\n              new-york  chicago\n   seattle         2.5      1.7\n   san-diego       2.5      1.8;";
    let t = toks(src);
    assert!(has(&t[0], "Table", K::Declaration));
    assert!(has(&t[0], "d", K::Identifier));
    assert!(has(
        &t[1],
        "new-york  chicago",
        K::IdentifierTableAssignmentColHead
    ));
    assert!(has(&t[2], "seattle", K::IdentifierTableAssignmentRowHead));
    assert!(has(&t[2], "2.5      1.7", K::IdentifierTableAssignmentRow));
    assert!(has(&t[3], "san-diego", K::IdentifierTableAssignmentRowHead));
    assert!(has(&t[3], ";", K::Semicolon));
    assert_eq!(final_state(src).kinds(), vec![K::Standard]);
}

#[test]
fn table_continuation_with_plus() {
    let src = "Table t(i,j)\n        a    b\n   x    1    2\n   +    c\n   x    3;";
    let t = toks(src);
    assert!(has(&t[3], "+    c", K::IdentifierTableAssignmentColHead));
    assert!(has(&t[4], "x", K::IdentifierTableAssignmentRowHead));
}

#[test]
fn ontext_block_comment() {
    let src = "$onText\nThis is a comment; Set x\n$offText\nSet y;";
    let mut st = LineState::default();
    let lines = split_lines(src);
    let (t0, s0) = highlight_line(&st, lines[0]);
    assert_eq!(t0.len(), 1);
    assert_eq!(t0[0].kind, K::Dco);
    assert_eq!(s0.top_kind(), K::CommentBlock);
    st = s0;
    let (t1, s1) = highlight_line(&st, lines[1]);
    assert_eq!(
        t1,
        vec![Token {
            start: 0,
            len: 24,
            kind: K::CommentBlock,
            error: false
        }]
    );
    let (t2, s2) = highlight_line(&s1, lines[2]);
    assert_eq!(t2[0].kind, K::Dco);
    assert_eq!(s2.kinds(), vec![K::Standard]);
    let t = toks(src);
    assert!(has(&t[3], "Set", K::Declaration));
    // block markers for folding
    let infos = highlight_document_info(src);
    assert_eq!(infos[0].nesting.parentheses[0].ch, 'T');
    assert_eq!(infos[2].nesting.parentheses[0].ch, 't');
}

#[test]
fn comment_lines_and_case_insensitive_dco() {
    let t = toks("* a comment\n$ONTEXT\n  text\n$OffText");
    assert!(has(&t[0], "* a comment", K::CommentLine));
    assert!(has(&t[1], "$ONTEXT", K::Dco));
    assert!(has(&t[2], "text", K::CommentBlock));
    assert!(has(&t[3], "$OffText", K::Dco));
    // '*' only counts in column 1
    let t = toks(" * no comment;");
    assert!(!t[0].iter().any(|(_, k, _)| *k == K::CommentLine));
}

#[test]
fn include_and_other_dcos() {
    let t = toks("$include \"data.inc\"\n$set x 1\n$ifThen %x%==1\n$endIf\n$foo bar");
    assert!(has(&t[0], "$include", K::Dco));
    assert!(has(&t[0], "\"data.inc\"", K::DcoBody));
    assert!(has(&t[1], "$set", K::Dco));
    assert!(has(&t[1], "x 1", K::DcoBody));
    assert!(has(&t[2], "%x%", K::UserCompileAttrib));
    assert!(has(&t[3], "$endIf", K::Dco));
    // unknown DCO is marked as error
    assert!(t[4]
        .iter()
        .any(|(s, k, e)| s == "$foo" && *k == K::Dco && *e));
    let infos = highlight_document_info("$ifThen 1==1\n$endIf");
    assert_eq!(infos[0].nesting.parentheses[0].ch, 'F');
    assert!(infos[0].nesting.parentheses[0].opener);
    assert_eq!(infos[1].nesting.parentheses[0].ch, 'f');
}

#[test]
fn solve_statement() {
    let t = toks("solve transport using lp minimizing z;");
    let l = &t[0];
    assert!(has(l, "solve", K::Solve));
    assert!(has(l, "transport", K::SolveBody));
    assert!(has(l, "using", K::SolveKey));
    assert!(has(l, "lp", K::SolveKey));
    assert!(has(l, "minimizing", K::SolveKey));
    assert!(has(l, ";", K::Semicolon));
    // "lpx" is not a model type
    let t = toks("solve m us lpx maximizing z;\nsolve m us nlp max z;");
    assert!(!has(&t[0], "lpx", K::SolveKey));
    assert!(has(&t[0], "maximizing", K::SolveKey));
    // the function "max" (Reserved) is tested before SolveKey and wins the tie
    assert!(has(&t[1], "nlp", K::SolveKey));
    assert!(has(&t[1], "max", K::Reserved));
}

#[test]
fn option_and_execute_statements() {
    let t =
        toks("option limrow = 0, lp = cplex;\nexecute.checkErrorLevel 'ls';\nabort.noError \"x\";");
    assert!(has(&t[0], "option", K::Option));
    assert!(has(&t[0], "limrow", K::OptionKey));
    assert!(has(&t[0], "lp", K::OptionKey));
    assert!(has(&t[1], "execute.", K::Execute));
    assert!(has(&t[1], "checkErrorLevel", K::ExecuteKey));
    assert!(has(&t[1], "'ls'", K::String));
    assert!(has(&t[2], "abort.", K::Abort));
    assert!(has(&t[2], "noError", K::AbortKey));
}

#[test]
fn put_statements() {
    let t = toks("file fx /out.txt/;\nput fx 'Hello ' system.Title /;\nputclose fx;");
    assert!(has(&t[0], "file", K::Declaration));
    assert!(has(&t[0], "fx", K::Identifier));
    assert!(has(&t[1], "put", K::Put));
    assert!(has(&t[1], "'Hello '", K::String));
    assert!(has(&t[1], "system.Title", K::SystemRunAttrib));
    assert!(has(&t[1], ";", K::Semicolon));
    assert!(has(&t[2], "putclose", K::Put));
}

#[test]
fn embedded_code_compile_time() {
    let src = "$onEmbeddedCode Python:\nx = [1, 2]  # python; Set i\n$offEmbeddedCode i\nSet j;";
    let t = toks(src);
    assert!(has(&t[0], "$onEmbeddedCode", K::Dco));
    assert!(has(&t[0], "Python:", K::EmbeddedBody));
    assert!(has(&t[1], "x = [1, 2]  # python; Set i", K::EmbeddedBody));
    assert!(has(&t[2], "$offEmbeddedCode", K::Dco));
    assert!(has(&t[3], "Set", K::Declaration));
    let infos = highlight_document_info(src);
    assert_eq!(infos[1].state.top_kind(), K::EmbeddedBody);
    assert_eq!(infos[0].nesting.parentheses[0].ch, 'M');
    assert_eq!(infos[2].nesting.parentheses[0].ch, 'm');
}

#[test]
fn embedded_code_with_suffix_name_must_match() {
    let src = "$onEmbeddedCode.a Python:\n$offEmbeddedCode.b\n$offEmbeddedCode.a\nSet j;";
    let infos = highlight_document_info(src);
    assert_eq!(infos[0].state.suffix_name().as_deref(), Some("ma"));
    assert_eq!(
        infos[1].state.top_kind(),
        K::EmbeddedBody,
        "wrong suffix does not end the block"
    );
    assert_eq!(infos[2].state.kinds(), vec![K::Standard]);
}

#[test]
fn embedded_code_execution_time() {
    let src = "embeddedCode Python:\npass\nendEmbeddedCode\ndisplay x;";
    let t = toks(src);
    assert!(has(&t[0], "embeddedCode", K::Embedded));
    assert!(has(&t[1], "pass", K::EmbeddedBody));
    assert!(has(&t[2], "endEmbeddedCode", K::EmbeddedEnd));
    assert!(has(&t[3], "display", K::Reserved));
}

#[test]
fn echo_and_put_blocks() {
    let src = "$onEcho > a.txt\nline $offEcho\n$offEcho\n$onPut\ntext\n$offPut\nSet s;";
    let t = toks(src);
    assert!(has(&t[0], "$onEcho", K::Dco));
    assert!(has(&t[0], "> a.txt", K::IgnoredHead));
    assert!(has(&t[1], "line $offEcho", K::IgnoredBlock));
    assert!(has(&t[2], "$offEcho", K::Dco));
    assert!(has(&t[4], "text", K::IgnoredBlock));
    assert!(has(&t[5], "$offPut", K::Dco));
    assert!(has(&t[6], "Set", K::Declaration));
}

#[test]
fn end_of_line_comments() {
    // Studio: "!!" after code is only a comment once $onEolCom/$eolCom made '!' special
    let t = toks("x = 1; !! not yet\n$onEolCom\ny = 2; !! comment\n$eolCom //\nz = 3; // other");
    assert!(!t[0].iter().any(|(_, k, _)| *k == K::CommentEndline));
    assert!(has(&t[2], "!! comment", K::CommentEndline));
    assert!(has(&t[4], "// other", K::CommentEndline));
    let st = final_state("$eolCom #\n");
    assert_eq!(st.eol_comment(), "#");
}

#[test]
fn end_of_line_comment_after_declaration() {
    // DEVIATION from Studio, which reads the `//` as an empty data block `/ /` and the rest as code
    let t = toks("$eolCom //\nParameter p(i) // text (z)\n;\nParameter q(i) / a 1 /  // (w)\n;");
    assert!(has(&t[1], "// text (z)", K::CommentEndline));
    assert!(!t[1].iter().any(|(_, k, _)| *k == K::IdentifierAssignment));
    assert!(has(&t[3], "// (w)", K::CommentEndline));
    // without `$eolCom //`, `//` stays an empty data block
    let t = toks("Parameter p(i) // text;");
    assert!(t[0].iter().any(|(_, k, _)| *k == K::IdentifierAssignment));
}

#[test]
fn compile_time_variables() {
    let t =
        toks("display '%system.date%', %myVar%;\nx = %modelStat.Optimal%;\n* %myVar% in comment");
    assert!(has(&t[0], "%system.date%", K::SystemCompileAttrib));
    assert!(has(&t[0], "%myVar%", K::UserCompileAttrib));
    assert!(has(&t[1], "%modelStat.Optimal%", K::SystemCompileAttribR));
    assert!(!t[2].iter().any(|(_, k, _)| *k == K::UserCompileAttrib));
}

#[test]
fn variable_types_and_system_data() {
    let t = toks("Positive Variable x, y;\nSingleton Set s / a /;\nSet k / system.empty /;");
    assert!(has(&t[0], "Positive", K::DeclarationVariableType));
    assert!(has(&t[0], "Variable", K::Declaration));
    assert!(has(&t[0], "x", K::Identifier));
    assert!(has(&t[0], "y", K::Identifier));
    assert!(has(&t[1], "Singleton", K::DeclarationSetType));
    assert!(has(&t[2], "system.empty", K::AssignmentSystemData));
}

#[test]
fn equation_definition_operators() {
    let t = toks("cost.. z =e= sum((i,j), c(i,j)*x(i,j));");
    assert!(has(&t[0], "..", K::Assignment));
    assert!(has(&t[0], "sum", K::Reserved));
    // Studio quirk: '=' only becomes a formula break character after $onEolCom/$eolCom
    // (`SyntaxFormula::setSpecialDynamicChars`), before that "=e=" stays Formula
    assert!(!has(&t[0], "=e=", K::Assignment));
    let t = toks("$onEolCom\ncost.. z =e= 1;\nbad.. z =q= 1;");
    assert!(has(&t[1], "=e=", K::Assignment));
    assert!(t[2]
        .iter()
        .any(|(s, k, e)| s == "=q=" && *k == K::Assignment && *e));
}

#[test]
fn keyword_docs_for_hover() {
    let info = highlight_line_info(&LineState::default(), "solve m using lp min z;");
    let d = keyword_doc_at(&info, 1).expect("doc");
    assert_eq!(d.keyword, "solve");
    assert!(!d.description.is_empty());
    let d = keyword_doc_at(&info, 15).expect("doc for lp");
    assert_eq!(d.keyword, "LP");
    let info = highlight_line_info(&LineState::default(), "$onText");
    assert_eq!(keyword_doc_at(&info, 2).unwrap().keyword, "$onText");
}

#[test]
fn utf16_positions() {
    // 'ä' and the emoji (2 UTF-16 units) shift the columns like in QString/LSP
    let (t, _) = highlight_line(&LineState::default(), "Set i 'äx😀' / a /;");
    let desc = t
        .iter()
        .find(|t| t.kind == K::IdentifierDescription)
        .unwrap();
    assert_eq!((desc.start, desc.len), (6, 6));
}

#[test]
fn crlf_and_cr_line_splitting() {
    assert_eq!(split_lines("a\r\nb\rc\nd"), vec!["a", "b", "c", "d"]);
    assert_eq!(split_lines("a\n"), vec!["a", ""]);
}

#[test]
fn semantic_token_encoding() {
    let (types, _) = semantic_token_legend();
    let ty = |n: &str| types.iter().position(|t| *t == n).unwrap() as u32;
    let data = semantic_tokens("Set i / a /;\n* c");
    let decl = ty("gamsDeclaration");
    let ident = ty("gamsIdentifier");
    let label = ty("gamsAssignLabel");
    let cm = ty("gamsComment");
    // Every emitted token type follows Studio's color slot of its kind.
    let kinds: Vec<u32> = data.chunks(5).map(|c| c[3]).collect();
    assert_eq!(kinds.first(), Some(&decl));
    assert_eq!(kinds.get(1), Some(&ident));
    assert!(kinds.contains(&label));
    assert_eq!(kinds.last(), Some(&cm));
}

#[test]
fn semantic_tokens_follow_studio_slots() {
    // Studio: `Positive` (DeclarationVariableType) and `Variable` (Declaration) share
    // Syntax_declaration; descriptions use Syntax_description.
    let (types, _) = semantic_token_legend();
    let ty = |n: &str| types.iter().position(|t| *t == n).unwrap() as u32;
    let src = "Positive Variable x 'shipment quantities';";
    let data = semantic_tokens(src);
    let toks: Vec<(u32, u32, u32)> = {
        let (mut line, mut col) = (0u32, 0u32);
        data.chunks(5)
            .map(|c| {
                if c[0] > 0 { line += c[0]; col = c[1]; } else { col += c[1]; }
                let _ = line;
                (col, c[2], c[3])
            })
            .collect()
    };
    let at = |start: u32| toks.iter().find(|t| t.0 == start).map(|t| t.2);
    assert_eq!(at(0), Some(ty("gamsDeclaration")), "{toks:?}");
    assert_eq!(at(9), Some(ty("gamsDeclaration")), "{toks:?}");
    assert_eq!(at(18), Some(ty("gamsIdentifier")), "{toks:?}");
    let desc = toks.iter().find(|t| t.0 >= 20 && t.0 <= 21).map(|t| t.2);
    assert_eq!(desc, Some(ty("gamsDescription")), "{toks:?}");
}

#[test]
fn semantic_tokens_leave_embedded_code_to_textmate() {
    // DEVIATION: no token for the embedded body (TextMate embeds Python / Connect YAML there)
    let (types, _) = semantic_token_legend();
    let src = "$onEmbeddedCode Python:\nx = [1, 2]  # (c)\n$offEmbeddedCode\nembeddedCode Connect:\n- GAMSReader:\nendEmbeddedCode\nSet j;";
    let data = semantic_tokens(src);
    let mut line = 0;
    let mut lines_with_tokens = Vec::new();
    for c in data.chunks(5) {
        line += c[0];
        assert_ne!(types[c[3] as usize], "gamsEmbedded", "line {line}");
        lines_with_tokens.push(line);
    }
    assert!(!lines_with_tokens.contains(&1) && !lines_with_tokens.contains(&4), "{lines_with_tokens:?}");
    // the brackets stay listed (Studio's parenthesis matching)
    let infos = highlight_document_info(src);
    assert_eq!(infos[1].nesting.parentheses.iter().map(|p| p.ch).collect::<String>(), "[]()");
}

#[test]
fn outline_declarations() {
    let src = "Set\n   i 'plants' / a, b /\n   j 'markets';\nPositive Variable x(i,j) 'ship';\nScalar f / 90 /;\nModel transport / all /;";
    let d = declarations(src);
    let names: Vec<(&str, &str)> = d
        .iter()
        .map(|s| (s.keyword.as_str(), s.name.as_str()))
        .collect();
    assert_eq!(
        names,
        vec![
            ("Set", "i"),
            ("Set", "j"),
            ("Variable", "x"),
            ("Scalar", "f"),
            ("Model", "transport")
        ]
    );
    assert_eq!(d[0].description.as_deref(), Some("plants"));
    assert_eq!(d[2].type_prefix.as_deref(), Some("Positive"));
    assert_eq!((d[0].line, d[0].start, d[0].len), (1, 3, 1));
}

#[test]
fn trnsport_outline() {
    let Some(sysdir) = std::env::var_os("GAMS_SYSDIR") else {
        eprintln!("SKIP trnsport_outline: set GAMS_SYSDIR");
        return;
    };
    let p = std::path::Path::new(&sysdir).join("gamslib_ml/trnsport.1");
    let Ok(src) = std::fs::read_to_string(p) else {
        return;
    };
    let names: Vec<String> = declarations(&src).into_iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        [
            "i",
            "j",
            "a",
            "b",
            "d",
            "f",
            "c",
            "x",
            "z",
            // `Positive Variable x;` re-declares x: listed once
            "cost",
            "supply",
            "demand",
            "transport"
        ]
    );
}

#[test]
fn semantic_tokens_delta_edit() {
    let old = semantic_tokens("Set i / a /;\nx = 1;\n* c\nScalar s;");
    let new = semantic_tokens("Set i / a /;\nx = 1; y = 2;\n* c\nScalar t;");
    let (start, del, ins) = semantic_tokens_edit(&old, &new);
    assert_eq!(start % 5, 0);
    let mut applied = old.clone();
    applied.splice(start..start + del, ins.iter().copied());
    assert_eq!(applied, new);
    assert_eq!(semantic_tokens_edit(&new, &new), (new.len(), 0, &[][..]));
}
