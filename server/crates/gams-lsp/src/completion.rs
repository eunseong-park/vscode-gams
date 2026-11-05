// SPDX-License-Identifier: GPL-3.0-or-later
//! `textDocument/completion` for `.gms` documents: the port of Studio's code completer
//! (`gams_syntax::completion`) plus the symbols of a loaded `.ref` (extension).
use crate::{ok, refs, Res, Server};
use gams_ref::{Reference, SymbolType};
use gams_syntax::completion::{blank_completions, completions_in_line, document_symbols, Candidate, Casing, Category, SymbolCategory, UserSymbol};
use gams_syntax::{split_lines, LineState};
use lsp_types::*;
use serde_json::Value;

/// Trigger characters of `.gms` completion (Studio opens its completer right after `$`
/// and `%`, `codeedit.cpp` `checkCompleterAutoOpen`; `.` for suffixes and attributes).
/// The typed blank (`" "`, extension) is handled separately: only where the next word is constrained.
pub const GMS_TRIGGERS: [&str; 3] = ["$", ".", "%"];

fn category_of(t: SymbolType) -> SymbolCategory {
    match t {
        SymbolType::Set => SymbolCategory::Set,
        SymbolType::Parameter => SymbolCategory::Parameter,
        SymbolType::Acronym => SymbolCategory::Acronym,
        SymbolType::Variable => SymbolCategory::Variable,
        SymbolType::Equation => SymbolCategory::Equation,
        SymbolType::Model => SymbolCategory::Model,
        SymbolType::File => SymbolCategory::File,
        SymbolType::Funct => SymbolCategory::Function,
        SymbolType::Macro => SymbolCategory::Macro,
        SymbolType::Unknown => SymbolCategory::Unknown,
    }
}

/// All symbols of a reference: type, dimension, domain and text (extension).
pub fn ref_symbols(r: &Reference, stale: bool) -> Vec<UserSymbol> {
    r.symbols
        .iter()
        .filter(|s| !s.name.is_empty())
        .map(|s| {
            let dom = r.domain_names(s);
            let sig = if s.dim > 0 { format!("{}({})", s.name, dom.join(",")) } else { s.name.clone() };
            let mut doc = String::new();
            if !s.text.is_empty() {
                doc.push_str(&s.text);
            }
            if s.dim > 0 {
                if !doc.is_empty() {
                    doc.push_str("\n\n");
                }
                doc.push_str(&format!("dimension {}", s.dim));
            }
            if s.ty != SymbolType::Model && s.num_elements > 0 {
                doc.push_str(&format!("{}{} element(s)", if doc.is_empty() { "" } else { ", " }, s.num_elements));
            }
            if stale {
                doc.push_str("\n\n*(reference data from last run \u{2014} may be outdated)*");
            }
            UserSymbol {
                name: s.name.clone(),
                category: category_of(s.ty),
                detail: format!("{} {}", refs::type_name(s.ty), sig),
                documentation: (!doc.is_empty()).then_some(doc),
            }
        })
        .collect()
}

fn item_kind(c: Category) -> CompletionItemKind {
    use CompletionItemKind as I;
    match c {
        Category::Group => I::FOLDER,
        Category::Dco | Category::DcoEnd | Category::SuffixName => I::KEYWORD,
        Category::SystemData => I::VALUE,
        Category::SystemAttribute => I::CONSTANT,
        Category::CompileConstant => I::ENUM_MEMBER,
        Category::Declaration => I::CLASS,
        Category::Reserved | Category::EmbeddedEnd | Category::SolveKey | Category::ExecuteAddition => I::KEYWORD,
        Category::Option => I::PROPERTY,
        Category::ModelType => I::ENUM_MEMBER,
        Category::VariableAttribute | Category::EquationAttribute => I::FIELD,
        Category::ModelAttribute => I::PROPERTY,
        Category::Symbol(s) => match s {
            SymbolCategory::Set | SymbolCategory::Alias => I::ENUM,
            SymbolCategory::Parameter | SymbolCategory::Scalar | SymbolCategory::Acronym => I::CONSTANT,
            SymbolCategory::Variable => I::VARIABLE,
            SymbolCategory::Equation | SymbolCategory::Function => I::FUNCTION,
            SymbolCategory::Model => I::MODULE,
            SymbolCategory::File => I::FILE,
            SymbolCategory::Macro => I::SNIPPET,
            SymbolCategory::Unknown => I::TEXT,
        },
    }
}

fn category_label(c: Category) -> &'static str {
    match c {
        Category::Group => "group",
        Category::Dco => "dollar control option",
        Category::DcoEnd => "end of block",
        Category::SystemData => "system data",
        Category::SystemAttribute => "system attribute",
        Category::CompileConstant => "compile-time constant",
        Category::Declaration => "declaration",
        Category::Reserved => "reserved word",
        Category::EmbeddedEnd => "end of embedded code",
        Category::Option => "option",
        Category::ModelType => "model type",
        Category::SolveKey => "solve statement",
        Category::ExecuteAddition => "execute addition",
        Category::SuffixName => "end of named block",
        Category::Symbol(_) | Category::VariableAttribute | Category::EquationAttribute | Category::ModelAttribute => "",
    }
}

/// LSP item of a candidate on `line`; `index` keeps the server's order (`sortText`).
pub fn to_item(c: Candidate, line: u32, index: usize) -> CompletionItem {
    let range = Range::new(Position::new(line, c.replace_range.start), Position::new(line, c.replace_range.end));
    let unknown = c.detail.contains("not known yet");
    let (detail, doc) = match c.kind_category {
        Category::Symbol(_) | Category::VariableAttribute | Category::EquationAttribute | Category::ModelAttribute => {
            (Some(c.detail), c.documentation)
        }
        k => (Some(category_label(k).to_string()), (!c.detail.is_empty()).then_some(c.detail)),
    };
    let group = c.kind_category == Category::Group;
    CompletionItem {
        kind: Some(item_kind(c.kind_category)),
        detail,
        documentation: doc.map(|d| Documentation::MarkupContent(MarkupContent { kind: MarkupKind::Markdown, value: d })),
        sort_text: Some(format!("{}{index:05}", if unknown { "z" } else { "" })),
        // the list is already filtered by prefix: let the client filter on the label
        filter_text: Some(c.label.clone()),
        preselect: c.preselect.then_some(true),
        text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(range, c.insert_text))),
        // a group row inserts `$`/`%` and reopens the list (Studio keeps it open)
        command: group.then(|| Command::new("Trigger Suggest".into(), "editor.action.triggerSuggest".into(), None)),
        label: c.label,
        ..Default::default()
    }
}

/// LSP item of an MPSGE completion (section keyword or field label).
fn mpsge_item(c: gams_syntax::mpsge::Completion, line: u32, index: usize) -> CompletionItem {
    CompletionItem {
        kind: Some(if c.section { CompletionItemKind::KEYWORD } else { CompletionItemKind::PROPERTY }),
        detail: Some(c.detail),
        documentation: Some(Documentation::MarkupContent(MarkupContent { kind: MarkupKind::Markdown, value: c.doc })),
        sort_text: Some(format!("{index:05}")),
        filter_text: Some(c.label.clone()),
        text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(Range::new(Position::new(line, c.start), Position::new(line, c.end)), c.insert))),
        label: c.label,
        ..Default::default()
    }
}

/// Append the symbols whose name (case-insensitive) is not known yet; O(n) with a hash set.
fn merge_unique(out: &mut Vec<UserSymbol>, seen: &mut std::collections::HashSet<String>, new: impl IntoIterator<Item = UserSymbol>) {
    for s in new {
        if seen.insert(s.name.to_ascii_lowercase()) {
            out.push(s);
        }
    }
}

impl Server {
    pub(crate) fn gms_completion(&mut self, p: CompletionParams) -> Res {
        let (uri, pos) = (p.text_document_position.text_document.uri, p.text_document_position.position);
        let trigger = p.context.as_ref().and_then(|c| c.trigger_character.as_deref());
        // `=` (trigger of `.opt` files) never opens the list
        if trigger.is_some_and(|t| t != " " && !GMS_TRIGGERS.contains(&t)) {
            return Ok(Value::Null);
        }
        // extension: a typed blank opens the list only where the next word is constrained
        if trigger == Some(" ") {
            let Some(doc) = self.docs.get_mut(&uri) else { return Ok(Value::Null) };
            let infos = doc.infos();
            let lines = split_lines(&doc.text);
            let Some(line) = lines.get(pos.line as usize) else { return Ok(Value::Null) };
            let prev = match pos.line {
                0 => LineState::default(),
                n => infos.get(n as usize - 1).map(|i| i.state.clone()).unwrap_or_default(),
            };
            return match blank_completions(&prev, line, pos.character, Casing::Camel) {
                Some(cs) => ok(CompletionResponse::Array(cs.into_iter().enumerate().map(|(i, c)| to_item(c, pos.line, i)).collect())),
                None => Ok(Value::Null),
            };
        }
        let mut symbols: Vec<UserSymbol> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Some(path) = crate::text::uri_to_path(&uri) {
            for e in self.entry_for(&path) {
                merge_unique(&mut symbols, &mut seen, ref_symbols(&self.refs[e].reference, self.refs[e].stale));
            }
        }
        let Some(doc) = self.docs.get_mut(&uri) else { return Ok(Value::Null) };
        let infos = doc.infos();
        merge_unique(&mut symbols, &mut seen, document_symbols(&doc.decls()));
        let lines = split_lines(&doc.text);
        // extension: MPSGE blocks have their own completion (the text is a comment for Studio)
        let blocks = gams_syntax::mpsge::find_blocks(&lines, &infos);
        if let Some(cs) = gams_syntax::mpsge::completions(&lines, &blocks, pos.line, pos.character) {
            let items: Vec<CompletionItem> = cs.into_iter().enumerate().map(|(i, c)| mpsge_item(c, pos.line, i)).collect();
            return ok(CompletionResponse::Array(items));
        }
        let Some(line) = lines.get(pos.line as usize) else { return Ok(Value::Null) };
        let prev = match pos.line {
            0 => LineState::default(),
            n => infos.get(n as usize - 1).map(|i| i.state.clone()).unwrap_or_default(),
        };
        let items: Vec<CompletionItem> = completions_in_line(&prev, line, pos.character, &symbols, Casing::Camel)
            .into_iter()
            .enumerate()
            .map(|(i, c)| to_item(c, pos.line, i))
            .collect();
        ok(CompletionResponse::Array(items))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(n: &str) -> UserSymbol {
        UserSymbol { name: n.into(), category: SymbolCategory::Set, detail: String::new(), documentation: None }
    }

    #[test]
    fn merge_unique_is_case_insensitive_and_fast() {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        merge_unique(&mut out, &mut seen, (0..30_000).map(|i| sym(&format!("Sym{i}"))));
        let t = std::time::Instant::now();
        merge_unique(&mut out, &mut seen, (0..30_000).map(|i| sym(&format!("SYM{}", i + 15_000))));
        assert!(t.elapsed() < std::time::Duration::from_millis(200), "{:?}", t.elapsed());
        assert_eq!(out.len(), 45_000);
        assert_eq!(out.iter().filter(|s| s.name.eq_ignore_ascii_case("sym20000")).count(), 1);
    }
}
