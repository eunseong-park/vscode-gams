// SPDX-License-Identifier: GPL-3.0-or-later
//! Code completion (port of Studio `src/editors/codecompleter.cpp`) with the real
//! highlighter. `|` marks the cursor in the snippets.

use gams_syntax::completion::{
    blank_completions, completions, completions_with, Candidate, Casing, Category, Options, SymbolCategory, UserSymbol,
};
use std::path::PathBuf;

fn at(doc: &str) -> Vec<Candidate> {
    at_with(doc, &Options::default())
}

fn at_with(doc: &str, opts: &Options) -> Vec<Candidate> {
    let (before, _) = doc.split_once('|').expect("cursor marker");
    let line = before.matches('\n').count() as u32;
    let col = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
    completions_with(&doc.replacen('|', "", 1), line, col, opts)
}

fn labels(c: &[Candidate]) -> Vec<&str> {
    c.iter().map(|c| c.label.as_str()).collect()
}

#[test]
fn dollar_at_line_start_offers_dcos() {
    let c = at("$|");
    assert!(c.len() > 200);
    assert!(c.iter().all(|c| c.label.starts_with('$')), "{:?}", labels(&c));
    let on_text = c.iter().find(|c| c.label == "$onText").unwrap();
    assert_eq!(on_text.kind_category, Category::Dco);
    assert_eq!(on_text.replace_range, 0..1);
    assert!(!on_text.detail.is_empty());
    // sub DCOs
    assert!(c.iter().any(|c| c.label == "$call.async"));
    // sorted case-insensitively, first entry preselected
    assert_eq!(c[0].label, "$abort");
    assert!(c[0].preselect);
    // filtering by prefix, case-insensitive
    let c = at("$ONTE|");
    assert_eq!(labels(&c), ["$onText"]);
}

#[test]
fn dollar_not_at_line_start_offers_no_dcos() {
    // DCOs are only offered at the line start (dCount check of updateFilterFromSyntax)
    let c = at("x = 1; $|");
    assert!(c.iter().all(|c| !c.label.starts_with('$')), "{:?}", labels(&c));
}

#[test]
fn empty_line_offers_group_rows_and_keywords() {
    let c = at("|");
    let dollar = c.iter().find(|c| c.label == "$...").unwrap();
    assert_eq!(dollar.kind_category, Category::Group);
    assert_eq!(dollar.insert_text, "$");
    assert!(c.iter().any(|c| c.label == "%..."));
    assert!(c.iter().any(|c| c.label == "Set"));
    assert!(c.iter().any(|c| c.label == "Positive Variables"));
    // no `$xxx` / `%xxx%` entries without filter text
    assert!(!c.iter().any(|c| c.label == "$onText" || c.label == "%system.Date%"));
}

#[test]
fn on_text_block_offers_matching_ender_first() {
    let c = at("$onText\n|");
    assert_eq!(c[0].label, "$offText");
    assert_eq!(c[0].kind_category, Category::DcoEnd);
    // only the ender of the open block
    assert!(!c.iter().any(|c| c.label == "$offEcho" && c.kind_category == Category::DcoEnd));
    let c = at("$onText\nsome text\n$of|");
    assert_eq!(c[0].label, "$offText");
    assert!(c[0].preselect);
    assert_eq!(c.iter().filter(|c| c.kind_category == Category::DcoEnd).count(), 1);
    // indented: DCOs only at column 0
    let c = at("$onText\n  $of|");
    assert!(c.is_empty() || c.iter().all(|c| c.kind_category != Category::DcoEnd));
}

#[test]
fn echo_and_put_blocks_offer_their_ender() {
    let c = at("$onEcho > x.txt\n|");
    assert_eq!(c[0].label, "$offEcho");
    let c = at("file f; put f;\n$onPut\n|");
    assert_eq!(c[0].label, "$offPut");
    // named block: `$offEcho.name` (setActiveNameSuffix) comes first
    let c = at("$onEcho.foo > x.txt\n$off|");
    assert_eq!(c[0].label, "$offEcho.foo");
    assert_eq!(c[0].kind_category, Category::SuffixName);
    assert!(c[0].detail.ends_with("(name: foo)"));
    assert_eq!(c[1].label, "$offEcho");
}

#[test]
fn embedded_code_offers_end() {
    let c = at("embeddedCode Python:\n|");
    assert!(c.iter().any(|c| c.label == "endEmbeddedCode" && c.kind_category == Category::EmbeddedEnd));
    let c = at("$onEmbeddedCode Python:\n$off|");
    assert!(c.iter().any(|c| c.label == "$offEmbeddedCode"));
}

#[test]
fn variable_type_offers_variable_keywords() {
    let c = at("Positive |");
    assert_eq!(labels(&c), ["Variable", "Variable Table", "Variables"]);
    assert!(c.iter().all(|c| c.kind_category == Category::Declaration));
    let c = at("Positive v|");
    assert_eq!(labels(&c), ["Variable", "Variable Table", "Variables"]);
    assert_eq!(c[0].replace_range, 9..10);
    // at statement start the combined declarations are offered
    let c = at("Posi|");
    assert!(labels(&c).contains(&"Positive Variables"));
}

#[test]
fn solve_statement_offers_solve_keys_and_model_types() {
    let c = at("Model m /all/;\nsolve m us|");
    assert!(labels(&c).contains(&"using"), "{:?}", labels(&c));
    assert!(labels(&c).contains(&"us "));
    let c = at("Model m /all/;\nsolve m using |");
    for t in ["LP", "MIP", "NLP", "minimize", "maximize"] {
        assert!(labels(&c).contains(&t), "{t}: {:?}", labels(&c));
    }
    let lp = c.iter().find(|c| c.label == "LP").unwrap();
    assert_eq!(lp.kind_category, Category::ModelType);
    assert_eq!(lp.detail, "Linear Programming - default solver");
    let c = at("Model m /all/;\nsolve m using lp max|");
    assert!(labels(&c).contains(&"maximize"));
}

#[test]
fn option_statement_offers_options() {
    let c = at("option |");
    assert!(labels(&c).contains(&"LimRow"));
    assert!(c.iter().all(|c| matches!(c.kind_category, Category::Option | Category::ModelType)));
    let c = at("option li|");
    assert_eq!(labels(&c), ["LimCol", "LimRow"]);
    assert_eq!(c[0].replace_range, 7..9);
}

#[test]
fn system_attributes_and_compile_time_constants() {
    let c = at("$set x %system.|");
    assert!(c.iter().all(|c| c.label.starts_with("%system.")), "{:?}", labels(&c));
    let d = c.iter().find(|c| c.label == "%system.Date%").unwrap();
    assert_eq!(d.replace_range, 7..15);
    assert_eq!(d.detail, "Job date");
    let c = at("scalar a; a = %modelstat.opt|");
    assert_eq!(labels(&c), ["%modelStat.optimal%"]);
    assert_eq!(c[0].kind_category, Category::CompileConstant);
    // run-time system attributes in formulas
    let c = at("put system.da|");
    assert!(labels(&c).contains(&"system.Date"));
    // after a closing `%` nothing more of %...%
    let c = at("$set x %system.Date%|");
    assert!(c.iter().all(|c| !c.label.starts_with('%')));
    // system data in data statements
    let c = at("Set s / system.|");
    assert!(labels(&c).contains(&"system.empty"));
}

#[test]
fn execute_and_abort_suffixes() {
    let c = at("execute.|");
    assert!(labels(&c).contains(&"execute.async"));
    let c = at("abort.|");
    assert_eq!(labels(&c), ["abort.noError"]);
    let c = at("$call.|");
    assert!(labels(&c).contains(&"$call.async"));
}

#[test]
fn replace_range_covers_matching_following_text() {
    // insertCurrent: the following characters that match are overwritten
    let c = at("$onTe|xt");
    let t = c.iter().find(|c| c.label == "$onText").unwrap();
    assert_eq!(t.replace_range, 0..7);
}

#[test]
fn hidden_when_only_entry_equals_filter_text() {
    assert!(at("option LimRow|").is_empty());
}

#[test]
fn casing() {
    let c = at_with("posi|", &Options { casing: Casing::Upper, ..Default::default() });
    assert!(labels(&c).contains(&"POSITIVE VARIABLES"));
    let c = at_with("posi|", &Options { casing: Casing::Lower, ..Default::default() });
    assert!(labels(&c).contains(&"positive variables"));
    // dynamic: case-sensitive filter first
    let c = at_with("posi|", &Options { casing: Casing::Dynamic, ..Default::default() });
    assert!(labels(&c).contains(&"positive variables"));
    assert!(!labels(&c).contains(&"Positive Variables"));
    let c = at_with("pOsi|", &Options { casing: Casing::Dynamic, ..Default::default() });
    assert!(labels(&c).contains(&"Positive Variables"));
}

#[test]
fn comments_offer_nothing() {
    assert!(at("* a comment $|").is_empty());
    assert!(at("* comment sys|").is_empty());
    assert!(at("Variable x;\n* comment x.|").is_empty());
    assert!(at("$onEolCom\nx = 1; !! comment sys|").is_empty());
}

#[test]
fn utf16_columns() {
    let c = at("put 'äöü𝄞' system.da|");
    let d = c.iter().find(|c| c.label == "system.Date").unwrap();
    let start = "put 'äöü𝄞' ".encode_utf16().count() as u32;
    assert_eq!(d.replace_range, start..start + 9);
}

// ---------------------------------------------------------------- extensions

#[test]
fn document_symbols_are_offered() {
    let doc = "Set i 'plants' / a, b /;\nParameter dem(i) 'demand';\nPositive Variable x(i);\ndisplay d|";
    let c = at(doc);
    let d = c.iter().find(|c| c.label == "dem").expect("dem");
    assert_eq!(d.kind_category, Category::Symbol(SymbolCategory::Parameter));
    assert_eq!(d.detail, "Parameter dem");
    assert_eq!(d.documentation.as_deref(), Some("demand"));
    let c = at("Set i 'plants' / a, b /;\nParameter dem(i);\ndem(|");
    let i = c.iter().find(|c| c.label == "i").expect("i");
    assert_eq!(i.kind_category, Category::Symbol(SymbolCategory::Set));
    // not in comments or declarations of new names
    assert!(!at("Set i;\n* i|").iter().any(|c| c.label == "i"));
}

#[test]
fn variable_attributes_after_dot() {
    let c = at("Variable x;\nx.|");
    for a in ["l", "m", "lo", "up", "fx", "scale", "prior", "stage", "range", "slack", "infeas"] {
        assert!(labels(&c).contains(&a), "{a}");
    }
    assert!(c.iter().all(|c| c.kind_category == Category::VariableAttribute));
    let c = at("Positive Variable x(i);\ny = x.l|o(i);");
    assert_eq!(labels(&c), ["lo", "l"]);
    assert_eq!(c[0].replace_range, 6..8);
    let c = at("Equation e;\ne.|");
    assert!(labels(&c).contains(&"m"));
    assert!(!labels(&c).contains(&"prior"));
    let c = at("Model m /all/;\ndisplay m.modelS|");
    assert_eq!(labels(&c), ["modelStat"]);
    assert_eq!(c[0].kind_category, Category::ModelAttribute);
    // unknown symbol: the union, marked as uncertain (see unknown_symbol_before_dot_*)
    assert!(at("y.|").iter().all(|c| c.detail.contains("not known yet")));
}

#[test]
fn reference_symbols_take_precedence() {
    let syms = [UserSymbol {
        name: "supply".into(),
        category: SymbolCategory::Equation,
        detail: "Equation supply(i)".into(),
        documentation: Some("observe supply limit".into()),
    }];
    let opts = Options { symbols: &syms, ..Default::default() };
    let c = at_with("x = sup|", &opts);
    let s = c.iter().find(|c| c.label == "supply").unwrap();
    assert_eq!(s.detail, "Equation supply(i)");
    let c = at_with("supply.|", &opts);
    assert!(c.iter().all(|c| c.kind_category == Category::EquationAttribute));
}

// ---------------------------------------------------------------- smoke

fn gamslib() -> Option<PathBuf> {
    let sysdir = std::env::var("GAMS_SYSDIR").unwrap_or_default();
    let p = PathBuf::from(sysdir).join("gamslib_ml");
    p.is_dir().then_some(p)
}

#[test]
fn gamslib_models_complete_without_panic() {
    use gams_syntax::completion::{completions_in_line, document_symbols};
    use gams_syntax::{declarations, highlight_document_info, split_lines, LineState};
    let Some(dir) = gamslib() else {
        eprintln!("gamslib_ml not found, skipping");
        return;
    };
    let started = std::time::Instant::now();
    let (mut files, mut calls) = (0, 0usize);
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        let Ok(bytes) = std::fs::read(&p) else { continue };
        if bytes.contains(&0) {
            continue; // binary (gdx, xlsx, ...)
        }
        let text = String::from_utf8_lossy(&bytes);
        let infos = highlight_document_info(&text);
        let lines = split_lines(&text);
        let syms = document_symbols(&declarations(&text));
        for (ln, l) in lines.iter().enumerate() {
            let n = l.encode_utf16().count() as u32;
            let prev = if ln == 0 { LineState::default() } else { infos[ln - 1].state.clone() };
            // every 150th line at all columns (up to 100), every 7th line at its end and middle
            let cols: Vec<u32> = if ln % 150 == 0 {
                (0..=n.min(100)).collect()
            } else if ln % 7 == 0 {
                vec![n / 2, n]
            } else {
                continue;
            };
            for col in cols {
                for c in completions_in_line(&prev, l, col, &syms, Casing::Camel) {
                    assert!(
                        c.replace_range.start <= col && col <= c.replace_range.end && c.replace_range.end <= n,
                        "{}:{}:{col}: bad range {c:?} in {l:?}",
                        p.display(),
                        ln + 1
                    );
                }
                calls += 1;
            }
        }
        if files % 50 == 0 {
            let _ = completions(&text, (lines.len() / 2) as u32, 0);
        }
        files += 1;
    }
    eprintln!("{calls} completion requests in {files} files in {:?}", started.elapsed());
    assert!(files > 100);
}

fn blank(doc: &str) -> Option<Vec<Candidate>> {
    let (before, _) = doc.split_once('|').expect("cursor marker");
    let text = doc.replacen('|', "", 1);
    let line = before.matches('\n').count();
    let col = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
    let mut state = gams_syntax::LineState::default();
    let lines = gams_syntax::split_lines(&text);
    for l in &lines[..line] {
        state = gams_syntax::highlight_line_info(&state, l).state;
    }
    blank_completions(&state, lines[line], col, Casing::Camel)
}

#[test]
fn blank_offers_only_constrained_words() {
    let c = blank("Positive |").unwrap();
    assert!(labels(&c).contains(&"Variable"));
    assert!(c.iter().all(|c| c.kind_category == Category::Declaration));
    let c = blank("Model m /all/;\nsolve m |").unwrap();
    assert!(labels(&c).contains(&"using"), "{:?}", labels(&c));
    assert!(c.iter().all(|c| c.kind_category == Category::SolveKey));
    let c = blank("Model m /all/;\nsolve m using |").unwrap();
    assert!(labels(&c).contains(&"LP") && c.iter().all(|c| c.kind_category == Category::ModelType));
    let c = blank("Model m /all/;\nsolve m using lp |").unwrap();
    assert!(labels(&c).contains(&"minimize") && labels(&c).contains(&"maximize"));
    assert!(!labels(&c).contains(&"using"));
    let c = blank("option |").unwrap();
    assert!(labels(&c).contains(&"LimRow") && c.iter().all(|c| c.kind_category == Category::Option));
    // elsewhere: nothing
    assert!(blank("display |").is_none());
    assert!(blank("Set i |").is_none());
    assert!(blank("x(i) = |").is_none());
    assert!(blank("* option |").is_none());
    assert!(blank("option lp |").is_none());
}

#[test]
fn solve_invoke_ranks_solve_keywords_first() {
    let c = at("Model m /all/;\nsolve m |");
    let first_other = c.iter().position(|c| !matches!(c.kind_category, Category::SolveKey | Category::ModelType)).unwrap();
    assert!(first_other > 0);
    assert!(c[..first_other].iter().any(|c| c.label == "using"));
    assert!(c[first_other..].iter().all(|c| !matches!(c.kind_category, Category::SolveKey | Category::ModelType)));
    assert!(c.len() > first_other);
}

#[test]
fn unknown_symbol_before_dot_offers_both_attribute_sets() {
    let c = at("display foo.|");
    let l = labels(&c);
    assert!(l.contains(&"l") && l.contains(&"prior") && l.contains(&"lo"), "{l:?}");
    assert!(c.iter().all(|c| c.detail.contains("not known yet")));
    assert_eq!(l.iter().filter(|x| **x == "l").count(), 1);
    let no_attr = |c: Vec<Candidate>| c.iter().all(|c| !matches!(c.kind_category, Category::VariableAttribute | Category::EquationAttribute));
    // not after numbers / in data labels / strings
    assert!(no_attr(at("display 1.|")));
    assert!(no_attr(at("Set i / a.|")));
    assert!(no_attr(at("Parameter p / a.b 1 /;\np('a.|')=1;")));
    assert!(no_attr(at("Table t(i,j)\n  a.|")));
    // known symbols unchanged
    assert!(at("Set i / a /;\ndisplay i.|").is_empty());
    assert!(at("Variable x;\ndisplay x.|").iter().all(|c| c.detail.contains("variable attribute")));
}
