// SPDX-License-Identifier: GPL-3.0-or-later
//! Generates `syntaxes/gams.tmLanguage.json` (scope `source.gams`) from the keyword
//! tables of `gams_syntax::generated::syntaxdata` (GAMS `syntaxdata.h`).
//!
//! This grammar is only a coarse base layer; the LSP semantic tokens (the port of the
//! Studio highlighter) refine it.
//!
//! EXTENSION: MPSGE blocks (`$onText` ... `$offText` starting with `$MODEL:`) get their own
//! sub-scopes (`mpsge-block`, nested in `comment-block`; TextMate matches line by line and
//! cannot look ahead to the first non-comment line of the block, so the rule starts at a
//! `$MODEL:` line inside an `$onText` block).
//!
//! Usage: `cargo run -p gams-syntax --bin gen_tmlanguage [-- <out.json>]`

use std::fmt::Write as _;
use std::path::PathBuf;

use gams_syntax::generated::syntaxdata as d;

fn esc_json(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(o, "\\u{:04x}", c as u32);
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn esc_re(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        if "\\^$.|?*+()[]{}".contains(c) {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

/// Regex alternation of the keywords, longest first.
fn alt<'a>(names: impl IntoIterator<Item = &'a str>) -> String {
    let mut v: Vec<String> = names.into_iter().map(esc_re).collect();
    v.sort_by(|a, b| {
        b.len()
            .cmp(&a.len())
            .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
    });
    v.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    v.join("|")
}

fn keys(t: &[(&'static str, &'static str)]) -> Vec<&'static str> {
    t.iter().map(|(k, _)| *k).collect()
}

/// Minimal JSON value builder.
enum J {
    S(String),
    A(Vec<J>),
    O(Vec<(String, J)>),
}

fn s(x: impl Into<String>) -> J {
    J::S(x.into())
}

fn o(pairs: Vec<(&str, J)>) -> J {
    J::O(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn inc(name: &str) -> J {
    o(vec![("include", s(name))])
}

fn m(name: &str, re: &str) -> J {
    o(vec![("name", s(name)), ("match", s(re))])
}

fn caps(list: &[(&str, &str)]) -> J {
    J::O(
        list.iter()
            .map(|(n, name)| (n.to_string(), o(vec![("name", s(*name))])))
            .collect(),
    )
}

/// Copy of `j` with every `{"include": name}` replaced by `f(name)` (dropped for `None`).
fn map_includes(j: &J, f: &dyn Fn(&str) -> Option<String>) -> Option<J> {
    Some(match j {
        J::S(x) => J::S(x.clone()),
        J::A(v) => J::A(v.iter().filter_map(|e| map_includes(e, f)).collect()),
        J::O(v) => match &v[..] {
            [(k, J::S(name))] if k == "include" => inc(&f(name)?),
            _ => J::O(v.iter().filter_map(|(k, e)| Some((k.clone(), map_includes(e, f)?))).collect()),
        },
    })
}

/// Copy of `j` with the strings rewritten by `f`.
fn map_strings(j: &J, f: &dyn Fn(&str) -> String) -> J {
    match j {
        J::S(x) => J::S(f(x)),
        J::A(v) => J::A(v.iter().map(|e| map_strings(e, f)).collect()),
        J::O(v) => J::O(v.iter().map(|(k, e)| (k.clone(), map_strings(e, f))).collect()),
    }
}

/// The rules of the embedded code blocks (`embedded-dollar`, `embedded-exec`) exist for Python
/// (`source.python`); GAMS Connect blocks (`Connect:`) get the same rules embedding `source.yaml`.
fn with_connect_yaml(rule: J) -> J {
    let J::O(mut items) = rule else { unreachable!("rule is an object") };
    let J::A(pats) = &mut items[0].1 else { unreachable!("patterns") };
    let yaml = map_strings(&pats[0], &|x| {
        x.replace("(?i:python)", "(?i:connect)").replace("meta.embedded.block.python", "meta.embedded.block.yaml").replace("source.python", "source.yaml")
    });
    pats.insert(1, yaml);
    J::O(items)
}

/// Rules that include `#eol-comment`: GAMS end-of-line comments are off by default
/// (`UG_DollarControlOptions.html`, `$onEolCom`), so these rules exist twice: without the eol
/// comment (`name`), and as `name-eol` inside `eol-region`, which starts at the first
/// `$onEolCom` / `$eolCom` line and lasts to the end of the file (like the server's highlighter,
/// which keeps the eol comment active once it was switched on).
const EOL_RULES: [&str; 4] = ["directive", "solve", "option", "common"];

fn eol_name(name: &str) -> String {
    match name.strip_prefix('#') {
        Some(n) if EOL_RULES.contains(&n) => format!("#{n}-eol"),
        _ => name.to_string(),
    }
}

/// Splits the `EOL_RULES` of the repository into the two variants (see [`EOL_RULES`]).
fn with_eol_variants(repo: J) -> J {
    let J::O(items) = repo else { unreachable!("repository is an object") };
    let mut out = Vec::new();
    for (k, v) in items {
        if EOL_RULES.contains(&k.as_str()) {
            let plain = map_includes(&v, &|n| (n != "#eol-comment").then(|| n.to_string())).expect("rule kept");
            let eol = map_includes(&v, &|n| Some(eol_name(n))).expect("rule kept");
            out.push((k.clone(), plain));
            out.push((format!("{k}-eol"), eol));
        } else {
            out.push((k, v));
        }
    }
    J::O(out)
}

fn write_json(j: &J, indent: usize, out: &mut String) {
    let pad = "  ".repeat(indent);
    let pad1 = "  ".repeat(indent + 1);
    match j {
        J::S(x) => out.push_str(&esc_json(x)),
        J::A(v) => {
            if v.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (i, e) in v.iter().enumerate() {
                out.push_str(&pad1);
                write_json(e, indent + 1, out);
                if i + 1 < v.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad);
            out.push(']');
        }
        J::O(v) => {
            out.push_str("{\n");
            for (i, (k, e)) in v.iter().enumerate() {
                out.push_str(&pad1);
                out.push_str(&esc_json(k));
                out.push_str(": ");
                write_json(e, indent + 1, out);
                if i + 1 < v.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad);
            out.push('}');
        }
    }
}

fn main() {
    let out_path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../syntaxes/gams.tmLanguage.json")
        });

    let directives = alt(keys(d::DIRECTIVES));
    let declarations = alt(keys(d::DECLARATION));
    let decl_prefix = alt(keys(d::DECLARATION4_SET)
        .into_iter()
        .chain(keys(d::DECLARATION4_VAR)));
    let model_types = alt(keys(d::MODEL_TYPES));
    let options = alt(keys(d::OPTIONS));
    let extendable = alt(keys(d::EXTENDABLE_KEY));
    let put = alt(keys(d::KEY_PUT));
    let execute_keys = alt(keys(d::EXECUTE));
    let embedded = alt(keys(d::EMBEDDED));
    let embedded_end = alt(keys(d::EMBEDDED_END));
    let system_data = alt(keys(d::SYSTEM_DATA));
    let system_attr = alt(keys(d::SYSTEM_ATTRIBUTES)
        .into_iter()
        .chain(keys(d::MODEL_TYPES)));
    let ct_groups = alt(keys(d::SYSTEM_CT_CONST_TEXT));
    // Studio: Reserved = reserved() without its first entry ("abort"), which is the
    // Abort keyword; keyExecute/keyOption/keySolve are separate keyword syntaxes.
    let mut reserved_v: Vec<&str> = keys(d::RESERVED);
    reserved_v.extend(keys(d::KEY_EXECUTE));
    reserved_v.push("executeTool");
    let reserved = alt(reserved_v);
    let key_option = alt(keys(d::KEY_OPTION));
    let key_solve = alt(keys(d::KEY_SOLVE));

    // MPSGE: section keywords and run-time switches of the MPSGE documentation
    // (`gams_syntax::mpsge::SectionKind`; `consumer` is accepted as in the shipped model vonthmge).
    let mpsge_sections = alt(gams_syntax::mpsge::SectionKind::all().map(|k| k.keyword()).chain(["CONSUMER"]));

    let python_lookahead = r"(?=.*\b(?i:python)\b)";

    let repository = o(vec![
        ("comment-line", m("comment.line.asterisk.gams", r"^\*.*$")),
        (
            "comment-block",
            o(vec![
                ("name", s("comment.block.gams")),
                ("begin", s(r"(?i)^(\$)\s*(onText)\b")),
                ("patterns", J::A(vec![inc("#mpsge-block")])),
                (
                    "beginCaptures",
                    caps(&[
                        ("1", "punctuation.definition.directive.gams"),
                        ("2", "keyword.control.directive.gams"),
                    ]),
                ),
                ("end", s(r"(?i)^(\$)\s*(offText)\b")),
                (
                    "endCaptures",
                    caps(&[
                        ("1", "punctuation.definition.directive.gams"),
                        ("2", "keyword.control.directive.gams"),
                    ]),
                ),
            ]),
        ),
        (
            "mpsge-block",
            o(vec![
                ("name", s("meta.embedded.block.mpsge.gams")),
                ("begin", s(r"(?i)^(\$model:)[ \t]*([^\s!]*)")),
                (
                    "beginCaptures",
                    caps(&[
                        ("1", "storage.type.section.mpsge.gams"),
                        ("2", "variable.other.declaration.gams"),
                    ]),
                ),
                ("end", s(r"(?i)(?=^(\$)\s*offText\b)")),
                (
                    "patterns",
                    J::A(vec![
                        inc("#mpsge-comment-line"),
                        inc("#mpsge-section"),
                        inc("#mpsge-description"),
                        inc("#mpsge-field"),
                        inc("#mpsge-string"),
                        inc("#mpsge-number"),
                        inc("#mpsge-identifier"),
                        inc("#mpsge-punctuation"),
                    ]),
                ),
            ]),
        ),
        ("mpsge-comment-line", m("comment.line.asterisk.mpsge.gams", r"^\*.*$")),
        (
            "mpsge-section",
            m(
                "storage.type.section.mpsge.gams",
                &format!(r"(?i)^\$(?:{mpsge_sections}):"),
            ),
        ),
        ("mpsge-description", m("comment.line.exclamation.mpsge.gams", r"!.*$")),
        (
            "mpsge-field",
            m(
                "keyword.other.field.mpsge.gams",
                r"(?<![\w.$])(?:[A-Za-z]\w{0,3}(?:\.[A-Za-z]+)?(?:\([^)]*\))?|(?i:demand)):",
            ),
        ),
        ("mpsge-string", m("variable.other.enummember.gams", r#""[^"]*"|'[^']*'"#)),
        (
            "mpsge-number",
            m("constant.numeric.gams", r"(?<![\w.])(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?"),
        ),
        (
            "mpsge-identifier",
            m(
                "variable.other.declaration.gams",
                &format!(r"\b(?!(?i:{reserved})\b)[A-Za-z_]\w*"),
            ),
        ),
        ("mpsge-punctuation", m("keyword.operator.mpsge.gams", r"[()\[\],=*/+\-^<>$#.:;&|]+")),
        (
            "echo-block",
            o(vec![
                ("name", s("meta.block.echo.gams")),
                ("begin", s(r"(?i)^(\$)\s*(onEcho[SV]?|onPut[SV]?)\b(.*)$")),
                (
                    "beginCaptures",
                    caps(&[
                        ("1", "punctuation.definition.directive.gams"),
                        ("2", "keyword.control.directive.gams"),
                        ("3", "string.unquoted.argument.gams"),
                    ]),
                ),
                ("end", s(r"(?i)^(\$)\s*(offEcho|offPut)\b")),
                (
                    "endCaptures",
                    caps(&[
                        ("1", "punctuation.definition.directive.gams"),
                        ("2", "keyword.control.directive.gams"),
                    ]),
                ),
                ("contentName", s("string.unquoted.heredoc.gams")),
            ]),
        ),
        (
            "embedded-dollar",
            o(vec![(
                "patterns",
                J::A(vec![
                    o(vec![
                        (
                            "begin",
                            s(format!(
                                r"(?i)^(\$)\s*(onEmbeddedCode[SV]?)\b{python_lookahead}(.*)$"
                            )),
                        ),
                        (
                            "beginCaptures",
                            caps(&[
                                ("1", "punctuation.definition.directive.gams"),
                                ("2", "keyword.control.directive.gams"),
                                ("3", "string.unquoted.argument.gams"),
                            ]),
                        ),
                        ("end", s(r"(?i)^(\$)\s*(offEmbeddedCode[SV]?)\b")),
                        (
                            "endCaptures",
                            caps(&[
                                ("1", "punctuation.definition.directive.gams"),
                                ("2", "keyword.control.directive.gams"),
                            ]),
                        ),
                        ("contentName", s("meta.embedded.block.python")),
                        ("patterns", J::A(vec![inc("source.python")])),
                    ]),
                    o(vec![
                        ("begin", s(r"(?i)^(\$)\s*(onEmbeddedCode[SV]?)\b(.*)$")),
                        (
                            "beginCaptures",
                            caps(&[
                                ("1", "punctuation.definition.directive.gams"),
                                ("2", "keyword.control.directive.gams"),
                                ("3", "string.unquoted.argument.gams"),
                            ]),
                        ),
                        ("end", s(r"(?i)^(\$)\s*(offEmbeddedCode[SV]?)\b")),
                        (
                            "endCaptures",
                            caps(&[
                                ("1", "punctuation.definition.directive.gams"),
                                ("2", "keyword.control.directive.gams"),
                            ]),
                        ),
                        ("contentName", s("meta.embedded.block.gams")),
                    ]),
                ]),
            )]),
        ),
        (
            "embedded-exec",
            o(vec![(
                "patterns",
                J::A(vec![
                    o(vec![
                        (
                            "begin",
                            s(format!(r"(?i)^\s*({embedded})\b{python_lookahead}(.*)$")),
                        ),
                        (
                            "beginCaptures",
                            caps(&[
                                ("1", "keyword.control.embedded.gams"),
                                ("2", "string.unquoted.argument.gams"),
                            ]),
                        ),
                        ("end", s(format!(r"(?i)^\s*({embedded_end})\b"))),
                        (
                            "endCaptures",
                            caps(&[("1", "keyword.control.embedded.gams")]),
                        ),
                        ("contentName", s("meta.embedded.block.python")),
                        ("patterns", J::A(vec![inc("source.python")])),
                    ]),
                    o(vec![
                        ("begin", s(format!(r"(?i)^\s*({embedded})\b(.*)$"))),
                        (
                            "beginCaptures",
                            caps(&[
                                ("1", "keyword.control.embedded.gams"),
                                ("2", "string.unquoted.argument.gams"),
                            ]),
                        ),
                        ("end", s(format!(r"(?i)^\s*({embedded_end})\b"))),
                        (
                            "endCaptures",
                            caps(&[("1", "keyword.control.embedded.gams")]),
                        ),
                        ("contentName", s("meta.embedded.block.gams")),
                    ]),
                ]),
            )]),
        ),
        (
            "title",
            o(vec![
                ("match", s(r"(?i)(^\$|\$\$)\s*(s?title)\b\s*(.*)$")),
                (
                    "captures",
                    caps(&[
                        ("1", "punctuation.definition.directive.gams"),
                        ("2", "keyword.control.directive.gams"),
                        ("3", "string.unquoted.title.gams"),
                    ]),
                ),
            ]),
        ),
        (
            "directive",
            o(vec![
                (
                    "begin",
                    s(format!(r"(?i)(^\$|\$\$)\s*(?:({directives})|(\w+))\b")),
                ),
                (
                    "beginCaptures",
                    caps(&[
                        ("1", "punctuation.definition.directive.gams"),
                        ("2", "keyword.control.directive.gams"),
                        ("3", "invalid.illegal.directive.gams"),
                    ]),
                ),
                ("end", s("$")),
                ("contentName", s("string.unquoted.argument.gams")),
                (
                    "patterns",
                    J::A(vec![
                        inc("#eol-comment"),
                        inc("#compile-vars"),
                        inc("#strings"),
                    ]),
                ),
            ]),
        ),
        (
            "eol-comment",
            m("comment.line.double-exclamation.gams", r"!!.*$"),
        ),
        (
            "strings",
            o(vec![(
                "patterns",
                J::A(vec![
                    o(vec![
                        ("name", s("string.quoted.single.gams")),
                        ("begin", s("'")),
                        ("end", s("'|$")),
                        ("patterns", J::A(vec![inc("#compile-vars")])),
                    ]),
                    o(vec![
                        ("name", s("string.quoted.double.gams")),
                        ("begin", s("\"")),
                        ("end", s("\"|$")),
                        ("patterns", J::A(vec![inc("#compile-vars")])),
                    ]),
                ]),
            )]),
        ),
        (
            "compile-vars",
            o(vec![(
                "patterns",
                J::A(vec![
                    m(
                        "support.variable.system.compile-time.gams",
                        &format!(r"(?i)%(?:emp\.info|system\.(?:{system_attr}))%"),
                    ),
                    m(
                        "support.constant.system.compile-time.gams",
                        &format!(r"(?i)%(?:{ct_groups})\.[A-Za-z0-9_ ()\-]+%"),
                    ),
                    m(
                        "variable.other.compile-time.gams",
                        r"%[A-Za-z][A-Za-z0-9_]*%",
                    ),
                ]),
            )]),
        ),
        (
            "system",
            o(vec![(
                "patterns",
                J::A(vec![
                    m(
                        "support.constant.system-data.gams",
                        &format!(r"(?i)\bsystem\.(?:{system_data})\b"),
                    ),
                    m(
                        "support.variable.system.gams",
                        &format!(r"(?i)\bsystem\.(?:{system_attr})\b"),
                    ),
                ]),
            )]),
        ),
        (
            "declaration",
            o(vec![(
                "patterns",
                J::A(vec![
                    // Studio paints Positive/Free/Binary/... (DeclarationVariableType,
                    // DeclarationSetType) with the same Syntax_declaration slot as the
                    // declaration keyword itself, so both get the same scope.
                    m(
                        "storage.type.declaration.gams",
                        &format!(r"(?i)\b(?:{decl_prefix})\b"),
                    ),
                    m(
                        "storage.type.declaration.gams",
                        &format!(r"(?i)\b(?:{declarations})\b"),
                    ),
                ]),
            )]),
        ),
        (
            "solve",
            o(vec![
                ("begin", s(format!(r"(?i)\b({key_solve})\b"))),
                (
                    "beginCaptures",
                    caps(&[("1", "keyword.control.solve.gams")]),
                ),
                ("end", s("(?=;)")),
                (
                    "patterns",
                    J::A(vec![
                        inc("#comment-line"),
                        inc("#eol-comment"),
                        m(
                            "support.type.model.gams",
                            &format!(r"(?i)\b(?:{model_types})\b"),
                        ),
                        m(
                            "keyword.other.solve.gams",
                            &format!(r"(?i)\b(?:{extendable})[A-Za-z0-9_]*"),
                        ),
                        inc("#common"),
                    ]),
                ),
            ]),
        ),
        (
            "option",
            o(vec![
                ("begin", s(format!(r"(?i)\b({key_option})\b"))),
                (
                    "beginCaptures",
                    caps(&[("1", "keyword.control.option.gams")]),
                ),
                ("end", s("(?=;)")),
                (
                    "patterns",
                    J::A(vec![
                        inc("#comment-line"),
                        inc("#eol-comment"),
                        m(
                            "support.type.model.gams",
                            &format!(r"(?i)\b(?:{model_types})\b"),
                        ),
                        m(
                            "variable.parameter.option.gams",
                            &format!(r"(?i)\b(?:{options})\b"),
                        ),
                        inc("#common"),
                    ]),
                ),
            ]),
        ),
        (
            "keywords",
            o(vec![(
                "patterns",
                J::A(vec![
                    m("keyword.other.put.gams", &format!(r"(?i)\b(?:{put})\b")),
                    m(
                        "keyword.other.execute.gams",
                        &format!(r"(?i)(?<=\.)(?:{execute_keys})\b"),
                    ),
                    m(
                        "keyword.other.reserved.gams",
                        &format!(r"(?i)\b(?:{reserved})\b"),
                    ),
                ]),
            )]),
        ),
        (
            "operators",
            o(vec![(
                "patterns",
                J::A(vec![
                    m("keyword.operator.relation.gams", r"(?i)=[eglnxcb]="),
                    m("keyword.operator.definition.gams", r"\.\."),
                ]),
            )]),
        ),
        (
            "numbers",
            m(
                "constant.numeric.gams",
                r"(?<![\w.])(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\b",
            ),
        ),
        (
            "common",
            o(vec![(
                "patterns",
                J::A(vec![
                    inc("#eol-comment"),
                    inc("#strings"),
                    inc("#compile-vars"),
                    inc("#system"),
                    inc("#embedded-exec"),
                    inc("#declaration"),
                    inc("#keywords"),
                    inc("#operators"),
                    inc("#numbers"),
                ]),
            )]),
        ),
    ]);

    let repository = with_eol_variants(repository);
    let J::O(repository) = repository else { unreachable!() };
    let repository = J::O(
        repository
            .into_iter()
            .map(|(k, v)| if k == "embedded-dollar" || k == "embedded-exec" { (k, with_connect_yaml(v)) } else { (k, v) })
            .collect(),
    );
    let J::O(mut repository) = repository else { unreachable!() };
    let top: Vec<&str> =
        vec!["#comment-line", "#comment-block", "#echo-block", "#embedded-dollar", "#title", "#directive", "#solve", "#option", "#common"];
    repository.push((
        "eol-region".into(),
        o(vec![
            ("begin", s(r"(?i)^(?=\$\s*(?:onEolCom|eolCom)\b)")),
            // never ends: the region lasts to the end of the document
            ("end", s(r"(?!)")),
            (
                "patterns",
                J::A(
                    top.iter()
                        .flat_map(|n| if *n == "#directive" { vec![inc("#directive-eol"), inc("#eol-comment")] } else { vec![inc(&eol_name(n))] })
                        .collect(),
                ),
            ),
        ]),
    ));
    let repository = J::O(repository);
    let mut top_patterns: Vec<J> = top.iter().map(|n| inc(n)).collect();
    top_patterns.insert(5, inc("#eol-region")); // before `#directive`, which would take the line

    let grammar = o(vec![
        ("$comment", s("Generated by `cargo run -p gams-syntax --bin gen_tmlanguage` from GAMS syntaxdata.h (GAMS Studio keyword tables, GPL-3.0). Do not edit.")),
        ("name", s("GAMS")),
        ("scopeName", s("source.gams")),
        ("fileTypes", J::A(vec![s("gms"), s("inc"), s("dmp")])),
        ("patterns", J::A(top_patterns)),
        ("repository", repository),
    ]);

    let mut out = String::new();
    write_json(&grammar, 0, &mut out);
    out.push('\n');
    if let Some(p) = out_path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    std::fs::write(&out_path, out)
        .unwrap_or_else(|e| panic!("cannot write {}: {e}", out_path.display()));
    eprintln!("wrote {}", out_path.display());
}
