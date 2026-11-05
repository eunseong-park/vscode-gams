// SPDX-License-Identifier: GPL-3.0-or-later
//! Option definitions (`optgams.def`, `opt<solver>.def`), solver option files (`.opt`, `.op2`..,
//! `.pf`) and the `gams/optionDefinitions` request.
//!
//! Studio sources: `src/option/option.cpp` (definition model), `src/option/optiontokenizer.cpp`
//! (`getOptionItemFromStr`, `logAndClearMessage`), `src/file/filetype.cpp` (option file suffixes),
//! `src/file/filemeta.cpp` (`createEdit`: which `.def` belongs to which file),
//! `src/support/solverconfiginfo.cpp` (solver list, default def file name, default solvers).
//! Deviation: the solver table is parsed directly from `gmscmpun.txt` instead of through the
//! `cfg` C API (not bound here); the file format is documented in its header.
use gams_capi::opt::*;
use gams_capi::optfile::{check_lines, load_definition, OptDefinition, OptEntry, OptMessage};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

#[derive(Debug, Clone, PartialEq)]
pub struct SolverEntry {
    pub name: String,
    pub def_file: String,
    pub hidden: bool,
    pub model_types: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SolverTable {
    pub solvers: Vec<SolverEntry>,
    /// model type -> default solver (`DEFAULTS` section)
    pub defaults: Vec<(String, String)>,
}

/// Parse `gmscmpun.txt`: `solverId fileType dictType licCodes defaultOkFlag hiddenFlag
/// linesToFollow modelTypes...` followed by `scriptName [defFileName]`, further lines up to a blank
/// line; a trailing `DEFAULTS` section lists `modelType solver`.
pub fn parse_solver_table(text: &str) -> SolverTable {
    let mut t = SolverTable::default();
    let mut lines = text.lines().peekable();
    let mut in_defaults = false;
    while let Some(line) = lines.next() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('*') {
            continue;
        }
        if l.eq_ignore_ascii_case("DEFAULTS") {
            in_defaults = true;
            continue;
        }
        let tok: Vec<&str> = l.split_whitespace().collect();
        if in_defaults {
            if tok.len() >= 2 {
                t.defaults.push((tok[0].to_ascii_uppercase(), tok[1].to_ascii_uppercase()));
            }
            continue;
        }
        let is_num = |s: &str| s.parse::<i64>().is_ok();
        if tok.len() >= 7 && is_num(tok[1]) && is_num(tok[6]) {
            let name = tok[0].to_ascii_uppercase();
            let script = lines.next().map(str::trim).unwrap_or("");
            let def_file = script.split_whitespace().nth(1).map(str::to_string).unwrap_or_else(|| format!("opt{}.def", name.to_ascii_lowercase()));
            t.solvers.push(SolverEntry {
                name,
                def_file,
                hidden: tok[5] == "1",
                model_types: tok[7..].iter().map(|s| s.to_ascii_uppercase()).collect(),
            });
        }
    }
    t
}

impl SolverTable {
    pub fn find(&self, name: &str) -> Option<&SolverEntry> {
        self.solvers.iter().find(|s| s.name.eq_ignore_ascii_case(name))
    }
    pub fn solver_names(&self) -> Vec<String> {
        self.solvers.iter().filter(|s| !s.hidden).map(|s| s.name.clone()).collect()
    }
    pub fn solvers_for(&self, model_type: &str) -> Vec<String> {
        self.solvers.iter().filter(|s| !s.hidden && s.model_types.iter().any(|m| m.eq_ignore_ascii_case(model_type))).map(|s| s.name.clone()).collect()
    }
    pub fn default_for(&self, model_type: &str) -> Option<&str> {
        self.defaults.iter().find(|(m, _)| m.eq_ignore_ascii_case(model_type)).map(|(_, s)| s.as_str())
    }
}

/// `.opt`, `.op2`-`.op9`, `.o10`-`.o99`, `.100`+ (Studio `FileType::from` regex
/// `[oO][pP][2-9]|[oO][1-9]\d|[1-9]\d\d+`) or `opt`.
pub fn is_option_suffix(ext: &str) -> bool {
    let e = ext.to_ascii_lowercase();
    let b = e.as_bytes();
    e == "opt"
        || (b.len() == 3 && b[0] == b'o' && b[1] == b'p' && (b'2'..=b'9').contains(&b[2]))
        || (b.len() == 3 && b[0] == b'o' && (b'1'..=b'9').contains(&b[1]) && b[2].is_ascii_digit())
        || (b.len() >= 3 && (b'1'..=b'9').contains(&b[0]) && b.iter().all(u8::is_ascii_digit))
}

pub struct Opts {
    sysdir: Option<PathBuf>,
    solvers: Option<Rc<SolverTable>>,
    defs: HashMap<String, Rc<OptDefinition>>,
}

impl Opts {
    pub fn new(sysdir: Option<PathBuf>) -> Opts {
        Opts { sysdir, solvers: None, defs: HashMap::new() }
    }

    /// Why no definitions can be found at all: no (existing) GAMS system directory, or one without
    /// the solver table `gmscmpun.txt`. `None` when the directory is usable.
    pub fn sysdir_problem(&self) -> Option<String> {
        match &self.sysdir {
            None => Some("GAMS system directory not found \u{2014} set gams.sysdir".into()),
            Some(d) if !d.is_dir() => Some(format!("GAMS system directory not found ({}) \u{2014} set gams.sysdir", d.display())),
            Some(d) if !d.join("gmscmpun.txt").is_file() => {
                Some(format!("gmscmpun.txt not found in the GAMS system directory ({}) \u{2014} check gams.sysdir", d.display()))
            }
            Some(_) => None,
        }
    }

    pub fn solvers(&mut self) -> Rc<SolverTable> {
        if self.solvers.is_none() {
            let t = self
                .sysdir
                .as_ref()
                .and_then(|d| std::fs::read(d.join("gmscmpun.txt")).ok())
                .map(|b| parse_solver_table(&String::from_utf8_lossy(&b)))
                .unwrap_or_default();
            self.solvers = Some(Rc::new(t));
        }
        self.solvers.clone().unwrap()
    }

    /// Definition file for an option file path: `.pf` -> `optgams.def`; `<solver>.opt` etc. ->
    /// the solver's def file (fallback `opt<name>.def` when it exists).
    pub fn def_for_path(&mut self, path: &Path) -> Option<String> {
        let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
        if ext == "pf" {
            return Some("optgams.def".into());
        }
        if !is_option_suffix(&ext) {
            return None;
        }
        let stem = path.file_stem()?.to_string_lossy().to_string();
        if let Some(s) = self.solvers().find(&stem) {
            return Some(s.def_file.clone());
        }
        let fallback = format!("opt{}.def", stem.to_ascii_lowercase());
        let d = self.sysdir.as_ref()?;
        d.join(&fallback).is_file().then_some(fallback)
    }

    /// Cached definition. For `optgams.def`, `solver` and model-type options get the solver names
    /// from the solver table (Studio `readDefinitionFile`).
    pub fn definition(&mut self, def_file: &str) -> Result<Rc<OptDefinition>, String> {
        let key = def_file.to_ascii_lowercase();
        if let Some(d) = self.defs.get(&key) {
            return Ok(d.clone());
        }
        let sysdir = self.sysdir.clone().ok_or("GAMS system directory is unknown: set \"gams.sysdir\"")?;
        let mut def = load_definition(&sysdir, def_file)?;
        if key == "optgams.def" {
            let t = self.solvers();
            for o in &mut def.options {
                if o.name.eq_ignore_ascii_case("solver") {
                    o.enums = t.solver_names().into_iter().map(|s| enum_val(&s)).collect();
                } else if o.opt_type == OPT_TYPE_STRING && t.defaults.iter().any(|(m, _)| m.eq_ignore_ascii_case(&o.name)) {
                    o.enums = t.solvers_for(&o.name).into_iter().map(|s| enum_val(&s)).collect();
                    if let Some(d) = t.default_for(&o.name) {
                        o.default = d.to_string();
                    }
                }
            }
        }
        let d = Rc::new(def);
        self.defs.insert(key, d.clone());
        Ok(d)
    }

    /// Per-line diagnostics `(line, message, severity 1=error 2=warning)` for an option file.
    pub fn diagnose(&mut self, def_file: &str, text: &str) -> Vec<(usize, String, u8)> {
        let Some(sysdir) = self.sysdir.clone() else { return vec![] };
        let lines: Vec<&str> = gams_syntax::split_lines(text);
        let Ok(res) = check_lines(&sysdir, def_file, &lines) else { return vec![] };
        let mut out = Vec::new();
        for (i, msgs) in res.iter().enumerate() {
            if let Some((m, sev)) = summarize(msgs) {
                out.push((i, m, sev));
            }
        }
        out
    }
}

fn enum_val(s: &str) -> gams_capi::optfile::EnumValue {
    gams_capi::optfile::EnumValue { value: s.to_string(), description: String::new(), hidden: false }
}

/// Strip the library's `*** Xxx Error ` prefix.
fn clean(m: &str) -> String {
    let m = m.trim();
    let m = m.strip_prefix("***").map(str::trim_start).unwrap_or(m);
    for p in ["Value Error", "Value Warning", "Error", "Warning", "Deprecated"] {
        if let Some(r) = m.strip_prefix(p) {
            return r.trim().to_string();
        }
    }
    m.to_string()
}

/// Combine the messages of one line: errors (define/value/user) -> severity 1, value warning and
/// deprecated -> 2, help/echo ignored (Studio `logAndClearMessage`).
fn summarize(msgs: &[OptMessage]) -> Option<(String, u8)> {
    let mut sev = 0u8;
    let mut parts = Vec::new();
    for m in msgs {
        let s = match m.kind {
            OPT_MSG_DEFINE_ERROR | OPT_MSG_VALUE_ERROR | OPT_MSG_USER_ERROR => 1,
            OPT_MSG_VALUE_WARNING | OPT_MSG_DEPRECATED => 2,
            _ => continue,
        };
        sev = if sev == 0 { s } else { sev.min(s) };
        parts.push(clean(&m.text));
    }
    (!parts.is_empty()).then(|| (parts.join(" "), sev))
}

pub fn definition_json(d: &OptDefinition) -> Value {
    let opts: Vec<Value> = d.options.iter().map(entry_json).collect();
    json!({
        "file": d.file,
        "eolChars": d.eol_chars,
        "separator": d.separator,
        "stringQuote": d.string_quote,
        "options": opts,
        "synonyms": d.synonyms.iter().map(|s| json!({ "synonym": s.synonym, "option": s.option, "deprecated": s.deprecated })).collect::<Vec<_>>(),
        "groups": d.groups.iter().map(|g| json!({ "nr": g.nr, "name": g.name, "description": g.description, "hidden": g.hidden })).collect::<Vec<_>>(),
    })
}

fn entry_json(o: &OptEntry) -> Value {
    json!({
        "nr": o.nr, "name": o.name, "description": o.description, "group": o.group,
        "type": o.opt_type, "typeName": o.type_name, "dataType": o.data_type, "subType": o.sub_type,
        "deprecated": o.deprecated, "hidden": o.hidden, "synonyms": o.synonyms,
        "default": o.default, "lower": o.lower, "upper": o.upper,
        "enums": o.enums.iter().map(|e| json!({ "value": e.value, "description": e.description, "hidden": e.hidden })).collect::<Vec<_>>(),
    })
}

/// Markdown for hover over an option.
pub fn option_markdown(o: &OptEntry, group: Option<&str>) -> String {
    let mut s = format!("**{}**", o.name);
    if o.deprecated {
        s.push_str(" _(deprecated, will be ignored)_");
    }
    s.push_str(&format!("\n\n{}", o.description));
    let mut meta = vec![format!("Type: {}", if o.type_name.is_empty() { "?" } else { &o.type_name })];
    if let (Some(lo), Some(hi)) = (&o.lower, &o.upper) {
        meta.push(format!("Range: [{lo}, {hi}]"));
    }
    if o.opt_type != OPT_TYPE_IMMEDIATE && o.opt_type != OPT_TYPE_STR_LIST && o.opt_type != OPT_TYPE_MULTI_LIST {
        meta.push(format!("Default: {}", if o.default.is_empty() { "(empty)" } else { &o.default }));
    }
    if let Some(g) = group {
        meta.push(format!("Group: {g}"));
    }
    if !o.synonyms.is_empty() {
        meta.push(format!("Synonyms: {}", o.synonyms.join(", ")));
    }
    s.push_str(&format!("\n\n{}", meta.join("  \n")));
    let vis: Vec<_> = o.enums.iter().filter(|e| !e.hidden).collect();
    if !vis.is_empty() {
        s.push_str("\n\nValues:\n");
        for e in vis.iter().take(40) {
            if e.description.is_empty() {
                s.push_str(&format!("- `{}`\n", e.value));
            } else {
                s.push_str(&format!("- `{}`: {}\n", e.value, e.description));
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffixes() {
        for e in ["opt", "OPT", "op2", "op9", "o10", "o99", "100", "1234"] {
            assert!(is_option_suffix(e), "{e}");
        }
        for e in ["op1", "op", "o01", "gms", "99", "10", "o1", "lst"] {
            assert!(!is_option_suffix(e), "{e}");
        }
    }

    #[test]
    fn solver_table() {
        let t = parse_solver_table(
            "* c\n\nCONOPT4 1 0 CO 1 1 2 LP NLP\ngmsgenus.run optconopt.def\ngmsgenux.out\n\nCPLEX 1 0 CP 1 0 1 LP MIP\ngmscpl.run\n\n\nDEFAULTS\nLP CPLEX\n",
        );
        assert_eq!(t.solvers.len(), 2);
        assert_eq!(t.find("conopt4").unwrap().def_file, "optconopt.def");
        assert_eq!(t.find("CPLEX").unwrap().def_file, "optcplex.def");
        assert_eq!(t.solver_names(), vec!["CPLEX"]);
        assert_eq!(t.default_for("lp"), Some("CPLEX"));
    }
}

/// Position inside an option-file line (character indices).
#[derive(Debug, PartialEq)]
pub enum LineCtx {
    /// on/at the end of the key token `[start, end)`
    Key { start: usize, end: usize },
    /// in the value of `key`; `[start, end)` is the value token under the cursor (maybe empty)
    Value { key: String, start: usize, end: usize },
}

/// Locate `col` (char index) in `key<sep>value`: key ends at whitespace or `=`; between key and
/// value only blanks and at most one `=` (Studio `offsetAssignment`). `None` for comment lines.
pub fn line_context(line: &str, col: usize, eol: &str) -> Option<LineCtx> {
    let ch: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < ch.len() && ch[i].is_whitespace() {
        i += 1;
    }
    if i < ch.len() && (ch[i] == '*' || eol.contains(ch[i])) {
        return None;
    }
    // text after an end-of-line comment character is not completed
    if let Some(p) = ch.iter().position(|c| eol.contains(*c)) {
        if col > p && p > i {
            return None;
        }
    }
    let ks = i;
    while i < ch.len() && !ch[i].is_whitespace() && ch[i] != '=' {
        i += 1;
    }
    let ke = i;
    if col <= ke {
        return Some(LineCtx::Key { start: ks, end: ke });
    }
    let mut seen_eq = false;
    while i < ch.len() && (ch[i].is_whitespace() || (ch[i] == '=' && !seen_eq)) {
        seen_eq |= ch[i] == '=';
        i += 1;
    }
    let key: String = ch[ks..ke].iter().collect();
    if col < i {
        // cursor inside the separator
        return Some(LineCtx::Value { key, start: col, end: col });
    }
    let mut ve = i;
    while ve < ch.len() && !ch[ve].is_whitespace() {
        ve += 1;
    }
    Some(LineCtx::Value { key, start: i, end: ve.max(col) })
}

#[cfg(test)]
mod ctx_tests {
    use super::*;
    #[test]
    fn contexts() {
        assert_eq!(line_context("  lpm", 5, "!"), Some(LineCtx::Key { start: 2, end: 5 }));
        assert_eq!(line_context("lpmethod 4", 10, "!"), Some(LineCtx::Value { key: "lpmethod".into(), start: 9, end: 10 }));
        assert_eq!(line_context("lpmethod = ", 11, "!"), Some(LineCtx::Value { key: "lpmethod".into(), start: 11, end: 11 }));
        assert_eq!(line_context("* x", 2, "!"), None);
        assert_eq!(line_context("a 1 ! x", 6, "!"), None);
    }
}
