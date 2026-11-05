// SPDX-License-Identifier: GPL-3.0-or-later
//! Code completion for `.gms` files.
//!
//! Port of GAMS Studio's code completer (`src/editors/codecompleter.{h,cpp}`):
//!
//! - [`cc`]: the `CodeCompleterType` bit flags.
//! - the candidate list of `CodeCompleterModel::initData` (built from the `SyntaxData`
//!   keyword tables), its dynamic casing variants (`addDynamicData`) and the temporary
//!   name-suffix entries (`setActiveNameSuffix`, e.g. `$offEcho.name`);
//! - the context detection of `CodeCompleter::getSyntax` / `updateFilter` /
//!   `updateFilterFromSyntax`, driven by the block syntax of the line as
//!   `SyntaxHighlighter::scanSyntax` reports it;
//! - the filter of `FilterCompleterModel::filterAcceptsRow` (type filter, `.`-variants of
//!   execute additions, DCO enders matching the open block, `$...`/`%...` group rows, the
//!   case-insensitive prefix match), its sort order (`lessThan`), the hide rule of
//!   `updateFilter`, the preselected row and the replaced range of `insertCurrent`.
//!
//! Extensions of this project (not in Studio, see `docs/dev/sources.md`): completion of
//! user symbols (declared in the document or taken from a loaded `.ref`) and of
//! variable/equation/model attributes after `name.`.
//!
//! All columns are UTF-16 code units.

use crate::generated::syntaxdata as sd;
use crate::highlighter::{scan_line_utf16, split_lines, LineState, ScanMap};
use crate::kind::{flavor, SyntaxKind as K};
use crate::outline::{declarations, DeclaredSymbol};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// `CodeCompleterType` (Studio `codecompleter.h`).
pub mod cc {
    pub const NONE: u32 = 0x0000_0000;
    /// DCO (starter and standalone)
    pub const DCO_STRT: u32 = 0x0000_0001;
    /// DCO (ender, e.g. $offText)
    pub const DCO_END: u32 = 0x0000_0002;
    /// all DCOs
    pub const DCO: u32 = 0x0000_000F;
    /// all sub DCOs
    pub const SUB_DCO: u32 = 0x0000_000C;
    /// system data
    pub const SYS_DAT: u32 = 0x0000_0010;
    /// system suffix run-time
    pub const SYS_SUF_R: u32 = 0x0000_0020;
    /// system suffix compile-time
    pub const SYS_SUF_C: u32 = 0x0000_0040;
    /// compile time constants
    pub const CT_CONST: u32 = 0x0000_0080;
    /// declarations
    pub const DECL: u32 = 0x0000_0100;
    /// declaration: Set
    pub const DECL_S: u32 = 0x0000_0200;
    /// declaration: Variable
    pub const DECL_V: u32 = 0x0000_0400;
    /// declaration: Table
    pub const DECL_T: u32 = 0x0000_0800;
    /// declaration additions for "variable"
    pub const DECL_ADD_V: u32 = 0x0000_1000;
    /// declaration additions for "set"
    pub const DECL_ADD_S: u32 = 0x0000_2000;
    /// other reserved words
    pub const RES: u32 = 0x0000_4000;
    /// embedded end
    pub const RES_END: u32 = 0x0000_8000;
    /// all reserved words (w/o embeddedEnd)
    pub const RES_ALL: u32 = 0x0000_7F00;
    /// options
    pub const OPT: u32 = 0x0001_0000;
    /// models
    pub const MOD: u32 = 0x0002_0000;
    /// solve
    pub const SOLVE: u32 = 0x0004_0000;
    /// execute additions
    pub const EXEC: u32 = 0x0008_0000;
    /// executeTool addition
    pub const EXEC_T: u32 = 0x0010_0000;
    /// abort addition
    pub const ABORT: u32 = 0x0020_0000;
    /// temporary suffix name
    pub const SUF_NAME: u32 = 0x0100_0000;
    /// all starting keywords
    pub const START: u32 = 0x0000_7FE1;
    pub const ALL: u32 = 0x7FFF_FFFF;
}

/// `CodeCompleterCasing` (Studio setting "editor/completerCasing", default camel case).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Casing {
    #[default]
    Camel,
    Lower,
    Upper,
    /// every entry in its original, lower and upper case spelling; the filter is
    /// case-sensitive unless that leaves no entry
    Dynamic,
}

impl Casing {
    /// Studio's combo-box index (`CodeCompleterCasing` value).
    pub fn from_index(i: i64) -> Casing {
        match i {
            1 => Casing::Lower,
            2 => Casing::Upper,
            3 => Casing::Dynamic,
            _ => Casing::Camel,
        }
    }
}

/// Kind of a user symbol (extension).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SymbolCategory {
    Set,
    Alias,
    Parameter,
    Scalar,
    Acronym,
    Variable,
    Equation,
    Model,
    File,
    Function,
    Macro,
    Unknown,
}

impl SymbolCategory {
    /// Category of a declaration keyword (`Set`, `Parameters`, `Table`, ...).
    pub fn from_keyword(keyword: &str) -> SymbolCategory {
        let k = keyword.to_ascii_lowercase();
        if k.starts_with("alias") {
            SymbolCategory::Alias
        } else if k.starts_with("set") {
            SymbolCategory::Set
        } else if k.starts_with("par") || k.starts_with("tab") {
            SymbolCategory::Parameter
        } else if k.starts_with("scal") {
            SymbolCategory::Scalar
        } else if k.starts_with("acr") {
            SymbolCategory::Acronym
        } else if k.starts_with("var") {
            SymbolCategory::Variable
        } else if k.starts_with("equ") {
            SymbolCategory::Equation
        } else if k.starts_with("mod") {
            SymbolCategory::Model
        } else if k.starts_with("file") {
            SymbolCategory::File
        } else if k.starts_with("func") {
            SymbolCategory::Function
        } else {
            SymbolCategory::Unknown
        }
    }
}

/// A symbol offered by the user-symbol completion (extension).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserSymbol {
    pub name: String,
    pub category: SymbolCategory,
    /// short signature, e.g. `Parameter d(i,j)`
    pub detail: String,
    /// explanatory text and further information (markdown)
    pub documentation: Option<String>,
}

/// Category of a completion candidate (for the LSP item kind).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Category {
    /// `$...` / `%...` group rows: inserting them inserts the first character only
    Group,
    /// dollar control options incl. sub DCOs (`$call.async`)
    Dco,
    /// DCO ender of the open block (`$offText`, `$offEcho`, ...)
    DcoEnd,
    /// `system.xxx` system data (sets)
    SystemData,
    /// `system.xxx` / `%system.xxx%` system attributes
    SystemAttribute,
    /// `%modelStat.optimal%` compile-time constants
    CompileConstant,
    /// `Set`, `Parameter`, `Positive Variable`, ...
    Declaration,
    /// reserved words, embedded code starters, `execute`, `option`, `solve`
    Reserved,
    /// `endEmbeddedCode` / `pauseEmbeddedCode`
    EmbeddedEnd,
    /// option names (`option xxx`)
    Option,
    /// model types (`using LP`)
    ModelType,
    /// solve keywords (`minimize`, `maximize`, `using`)
    SolveKey,
    /// execute/executeTool/abort additions (`.async`, `.checkErrorLevel`, `.noError`)
    ExecuteAddition,
    /// block ender with the active name suffix (`$offEcho.name`)
    SuffixName,
    /// extension: a user symbol
    Symbol(SymbolCategory),
    /// extension: `.l`, `.lo`, ... of a variable
    VariableAttribute,
    /// extension: `.l`, `.m`, ... of an equation
    EquationAttribute,
    /// extension: `.modelStat`, `.optCR`, ... of a model
    ModelAttribute,
}

/// A completion candidate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// text shown in the list
    pub label: String,
    pub kind_category: Category,
    /// Studio `CodeCompleterType` of the entry (0 for extension candidates)
    pub cc_type: u32,
    /// description (tooltip of the Studio list, from `SyntaxData`)
    pub detail: String,
    /// further documentation (extension candidates)
    pub documentation: Option<String>,
    /// text replacing `replace_range`
    pub insert_text: String,
    /// UTF-16 column range on the requested line
    pub replace_range: std::ops::Range<u32>,
    /// the entry Studio selects when it opens the list
    pub preselect: bool,
}

/// Options of [`completions_with`].
#[derive(Clone, Debug, Default)]
pub struct Options<'a> {
    pub casing: Casing,
    /// extra symbols (e.g. from a `.ref`); they take precedence over document
    /// declarations of the same name
    pub symbols: &'a [UserSymbol],
    /// do not add the symbols declared in the document itself
    pub no_document_symbols: bool,
}

// ------------------------------------------------------------------ model

#[derive(Clone, Debug)]
struct Entry {
    text: String,
    /// `text` in lower case (for the case-insensitive filter and sort)
    lower: String,
    desc: String,
    ty: u32,
}

impl Entry {
    fn new(text: String, desc: String, ty: u32) -> Entry {
        Entry { lower: text.to_lowercase(), text, desc, ty }
    }
}

struct Model {
    entries: Vec<Entry>,
    dollar_row: usize,
    percent_row: usize,
}

/// `CodeCompleterModel::initData`: rows plus the type map, whose keys mark the last row
/// of a group (`mType.lowerBound(row)` gives a row's type).
/// rows (text, description), type map, `$...` row, `%...` row
type InitData = (Vec<(String, String)>, BTreeMap<usize, u32>, usize, usize);

fn init_data() -> InitData {
    let mut data: Vec<(String, String)> = Vec::new();
    let mut ty: BTreeMap<usize, u32> = BTreeMap::new();
    macro_rules! push {
        ($t:expr, $d:expr) => {
            data.push(($t.to_string(), $d.to_string()))
        };
    }
    macro_rules! mark {
        ($t:expr) => {
            ty.insert(data.len() - 1, $t)
        };
    }

    // DCOs
    let dollar_row = data.len();
    push!("$...", "");
    mark!(cc::DCO_STRT);
    let mut delayed = Vec::new();
    for (k, d) in sd::DIRECTIVES {
        if (!k.ends_with("mbeddedCode") && !k.ends_with("mbeddedCodeS") && !k.ends_with("mbeddedCodeV"))
            || k.starts_with('o')
        {
            if *k == "offText" || *k == "offEcho" || *k == "offPut" {
                push!(format!("${k}"), d);
            } else {
                delayed.push((k, d));
            }
        }
    }
    mark!(cc::DCO_END);
    for (k, d) in delayed {
        push!(format!("${k}"), d);
    }
    mark!(cc::DCO_STRT);

    // declarations
    for (k, d) in sd::DECLARATION {
        push!(k, d);
        if k.starts_with("Equation") {
            if k.ends_with('s') {
                push!("Equation Table", d);
            }
            mark!(cc::DECL);
        } else if k.starts_with("Parameter") {
            if k.ends_with('s') {
                push!("Parameter Table", d);
            }
            mark!(cc::DECL);
        } else if k.starts_with("Set") {
            mark!(cc::DECL_S);
            if k.ends_with('s') {
                push!("Set Table", d);
            }
            mark!(cc::DECL);
        } else if k.starts_with("Variable") {
            if k.ends_with('s') {
                push!("Variable Table", d);
            }
            mark!(cc::DECL_V);
        } else if *k == "Table" {
            mark!(cc::DECL_T);
        } else {
            mark!(cc::DECL);
        }
    }

    // declaration additions for "Variable" and "Set"
    for (k, d) in sd::DECLARATION4_VAR {
        push!(format!("{k} Variable"), d);
        push!(format!("{k} Variables"), d);
    }
    mark!(cc::DECL_ADD_V);
    for (k, d) in sd::DECLARATION4_VAR {
        push!(format!("{k} Variable Table"), d);
        push!(format!("{k} Variables Table"), d);
    }
    mark!(cc::DECL_ADD_V);
    for (k, d) in sd::DECLARATION4_SET {
        push!(format!("{k} Set"), d);
        push!(format!("{k} Sets"), d);
    }
    mark!(cc::DECL_ADD_S);

    // reserved
    for (k, d) in sd::RESERVED {
        if *k == "ord" {
            push!("option", "");
            push!("options", "");
        }
        if *k == "sum" {
            push!("solve ", "");
        }
        push!(k, d);
        if *k == "abort" {
            push!("abort.noError", "Don't throw an execution error");
        }
    }
    // embedded
    for (k, d) in sd::EMBEDDED {
        push!(k, d);
    }
    // execute
    for (k, d) in sd::KEY_EXECUTE {
        push!(k, d);
    }
    push!("executeTool", "Execute a GAMS tool");
    mark!(cc::RES);

    // embedded end
    for (k, d) in sd::EMBEDDED_END {
        push!(k, d);
    }
    mark!(cc::RES_END);

    // options
    for (k, d) in sd::OPTIONS {
        push!(k, d);
    }
    mark!(cc::OPT);

    // models
    for (k, d) in sd::MODEL_TYPES {
        push!(k, d);
    }
    mark!(cc::MOD);

    // solve keys
    for (k, d) in sd::EXTENDABLE_KEY {
        push!(format!("{k} "), d);
        push!(d, "");
    }
    mark!(cc::SOLVE);

    // sub DCOs
    for (k, d) in sd::EXECUTE {
        push!(format!("$call.{k}"), d);
        push!(format!("$hiddenCall.{k}"), d);
    }
    mark!(cc::DCO_STRT);
    push!("$eval.set", "compile-time variable based on a GAMS set");
    push!("$evalGlobal.set", "compile-time variable based on a GAMS set");
    push!("$evalLocal.set", "compile-time variable based on a GAMS set");
    mark!(cc::DCO_STRT);
    push!("$abort.noError", "Abort without error");
    mark!(cc::DCO_STRT);
    push!("$save.keepCode", "Create save also with unexecuted execution code");
    mark!(cc::DCO_STRT);

    // system data
    for (k, d) in sd::SYSTEM_DATA {
        push!(format!("system.{k}"), d);
    }
    mark!(cc::SYS_DAT);
    for (k, d) in sd::SYSTEM_ATTRIBUTES {
        push!(format!("system.{k}"), d);
    }
    mark!(cc::SYS_SUF_R);

    let percent_row = data.len();
    push!("%...", "");
    for (k, d) in sd::SYSTEM_ATTRIBUTES {
        push!(format!("%system.{k}%"), d);
    }
    // SyntaxAbstract::systemEmpData (syntaxformats.cpp)
    push!("%emp.info%", "Name of the EMP Info File");
    mark!(cc::SYS_SUF_C);

    for (k, v) in sd::SYSTEM_CT_CONSTANTS {
        let key = &k[..k.find('.').unwrap_or(k.len())];
        let text = sd::SYSTEM_CT_CONST_TEXT
            .iter()
            .find(|(n, _)| *n == key)
            .map(|(_, t)| *t)
            .unwrap_or("");
        push!(format!("%{k}%"), format!("{text}: {v}"));
    }
    mark!(cc::CT_CONST);

    // execute additions
    for (k, d) in sd::EXECUTE {
        push!(k, d);
        push!(format!(".{k}"), d);
    }
    mark!(cc::EXEC);
    push!("checkErrorLevel", "Check errorLevel automatically after executing a GAMS tool");
    push!(".checkErrorLevel", "Check errorLevel automatically after executing a GAMS tool");
    mark!(cc::EXEC_T);
    push!("noError", "Abort without error");
    push!(".noError", "Abort without error");
    mark!(cc::ABORT);
    for (k, d) in sd::EXECUTE {
        push!(format!("execute.{k}"), d);
    }
    push!("executeTool.checkErrorLevel", "Check errorLevel automatically after executing a GAMS tool");
    mark!(cc::RES);

    (data, ty, dollar_row, percent_row)
}

fn lower_bound(ty: &BTreeMap<usize, u32>, row: usize) -> u32 {
    ty.range(row..).next().map(|(_, t)| *t).unwrap_or(0)
}

fn build_model(dynamic: bool) -> Model {
    let (data, ty, dollar, percent) = init_data();
    let mut entries = Vec::with_capacity(data.len() * if dynamic { 3 } else { 1 });
    let (mut dollar_row, mut percent_row) = (dollar, percent);
    for (i, (text, desc)) in data.iter().enumerate() {
        let t = lower_bound(&ty, i);
        entries.push(Entry::new(text.clone(), desc.clone(), t));
        if dynamic {
            // CodeCompleterModel::addDynamicData
            let lo = text.to_lowercase();
            if lo != *text {
                entries.push(Entry::new(lo, desc.clone(), t));
            }
            let up = text.to_uppercase();
            if up != *text {
                entries.push(Entry::new(up, desc.clone(), t));
            }
        }
        if i == dollar {
            dollar_row = entries.len() - 1;
        }
        if i == percent {
            percent_row = entries.len() - 1;
        }
    }
    Model { entries, dollar_row, percent_row }
}

fn model(dynamic: bool) -> &'static Model {
    static PLAIN: OnceLock<Model> = OnceLock::new();
    static DYNAMIC: OnceLock<Model> = OnceLock::new();
    if dynamic {
        DYNAMIC.get_or_init(|| build_model(true))
    } else {
        PLAIN.get_or_init(|| build_model(false))
    }
}

/// `mNameSuffixAssignments`
fn suffix_assignments(c: char) -> &'static [&'static str] {
    match c {
        'c' => &["$offEcho"],
        'p' => &["$offPut"],
        'm' => &["$offEmbeddedCode"],
        'e' => &["endEmbeddedCode", "pauseEmbeddedCode"],
        _ => &[],
    }
}

/// `CodeCompleterModel::setActiveNameSuffix`: entries `<ender>.<name>`.
fn suffix_entries(model: &Model, suffix: &str) -> Vec<Entry> {
    let mut chars = suffix.chars();
    let Some(first) = chars.next() else { return vec![] };
    let name: String = chars.collect();
    if name.is_empty() {
        return vec![];
    }
    let assigns = suffix_assignments(first);
    let mut out = Vec::new();
    for e in &model.entries {
        if assigns.iter().any(|k| e.text.eq_ignore_ascii_case(k)) {
            out.push(Entry::new(
                format!("{}.{}", e.text, name),
                format!("{} (name: {})", e.desc, name),
                cc::SUF_NAME,
            ));
        }
    }
    out
}

// ------------------------------------------------------------------ context

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CharGroup {
    Alpha,
    Num,
    NumSym,
    Fix,
    Break,
    Space,
}

fn group(c: u16) -> CharGroup {
    match c {
        0x61..=0x7A | 0x41..=0x5A | 0x5F => CharGroup::Alpha,
        0x30..=0x39 => CharGroup::Num,
        0x3A | 0x2E => CharGroup::NumSym,
        0x24 | 0x25 => CharGroup::Fix,
        0x20 | 0x09 => CharGroup::Space,
        _ => CharGroup::Break,
    }
}

fn is_entering(k: K) -> bool {
    matches!(k, K::IdentifierDescription | K::String)
}
fn is_execute(k: K) -> bool {
    matches!(
        k,
        K::Execute | K::ExecuteKey | K::ExecuteBody | K::ExecuteTool | K::ExecuteToolKey | K::Abort | K::AbortKey
    )
}
fn is_block(k: K) -> bool {
    matches!(k, K::CommentBlock | K::IgnoredBlock | K::EmbeddedBody)
}

/// `CodeCompleter::getSyntax`: syntax (kind, flavor) at `pos`, the flavor of the last
/// DCO before it and the position of an execute dot.
fn get_syntax(scan: &ScanMap, pos: isize) -> ((K, i32), i32, isize) {
    let mut res = scan.values().next().copied().unwrap_or((K::Standard, 0));
    let mut dco_flavor = 0;
    let mut last_end: isize = 0;
    let mut dot_pos: isize = -1;
    for (&key, &val) in scan {
        if is_execute(val.0)
            && val.1 % 2 != 0
            && matches!(res.0, K::Abort | K::Execute | K::ExecuteTool)
            && res.1 % 2 == 0
        {
            dot_pos = last_end;
        }
        if key >= pos {
            if is_entering(res.0) {
                if res.0 == K::IdentifierDescription && last_end == pos {
                    break;
                }
                res = val;
            }
            if is_entering(val.0) && last_end < pos {
                res = val;
            }
            if is_block(val.0) && last_end == pos {
                res = val;
            }
            break;
        }
        last_end = key;
        res = val;
        if res.0 == K::Dco {
            dco_flavor = res.1;
        }
    }
    (res, dco_flavor, dot_pos)
}

/// `FilterCompleterModel::test`
fn test(ty: u32, mut pattern: u32) -> bool {
    if ty & cc::SUB_DCO != 0 && pattern & cc::SUB_DCO != 0 {
        if (ty & cc::SUB_DCO) == (pattern & cc::SUB_DCO) {
            return true;
        }
        pattern -= pattern & cc::SUB_DCO;
    }
    ty & pattern != 0
}

/// The completer state for a cursor position (Studio's `mFilterText`, type filter,
/// sub type and `needDot`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Context {
    /// syntax kind and flavor at the cursor
    pub kind: K,
    pub flavor: i32,
    /// start of the filter text (UTF-16 column)
    pub start: u32,
    /// the filter text (text from `start` to the cursor)
    pub filter_text: String,
    /// `CodeCompleterType` filter
    pub filter: u32,
    /// DCO ender of the open block: 1 `$offText`, 2 `$offEcho`, 3 `$offPut`,
    /// 4 `$offEmbeddedCode`, 5 `$endEmbeddedCode`/`$pauseEmbeddedCode`
    pub sub_type: u8,
    pub need_dot: bool,
    /// active name suffix of the block (`flagSuffixName`, e.g. `cname`)
    pub suffix_name: Option<String>,
}

/// `CodeCompleter::updateFilter` (filter text) and `updateFilterFromSyntax`.
fn context(line: &[u16], pos: usize, scan: &ScanMap, suffix_name: Option<String>) -> Context {
    let pos = pos.min(line.len());
    let ipos = pos as isize;
    let ((kind, flav), dco_flavor, dot_pos) = get_syntax(scan, ipos);

    // --- filter text (updateFilter)
    let mut peek = pos;
    let mut valid_start = pos;
    while peek > 0 {
        peek -= 1;
        let cg = group(line[peek]);
        if cg >= CharGroup::Break {
            break;
        }
        if cg == CharGroup::Alpha || cg == CharGroup::Num {
            valid_start = peek;
        }
        if cg == CharGroup::NumSym {
            if is_execute(kind) && dot_pos >= 0 {
                valid_start = peek + 1;
                break;
            } else if matches!(kind, K::IdentifierAssignment | K::AssignmentLabel | K::AssignmentSystemData) {
                if line[peek] == b'.' as u16 {
                    const SYS: &str = "system.";
                    let n = SYS.len();
                    if peek >= n && valid_start >= n {
                        let part = String::from_utf16_lossy(&line[valid_start - n..valid_start]);
                        if part.eq_ignore_ascii_case(SYS) {
                            valid_start -= n;
                            if valid_start > 0 && line[valid_start - 1] == b'%' as u16 {
                                valid_start -= 1;
                            }
                        }
                    }
                    break;
                }
            } else {
                valid_start = peek;
            }
        }
        if cg == CharGroup::Fix {
            valid_start = peek;
            break;
        }
    }
    let filter_text = String::from_utf16_lossy(&line[valid_start..pos]);

    // --- updateFilterFromSyntax
    let len = line.len();
    let mut start = valid_start;
    let mut need_dot = false;
    let at = |i: usize| line[i];
    let mut filter = match kind {
        K::Standard | K::Formula | K::Assignment | K::Semicolon | K::CommaIdent => cc::START,
        K::SubDCO
        | K::AssignmentSystemData
        | K::SystemCompileAttrib
        | K::SystemCompileAttribR
        | K::UserCompileAttrib => cc::NONE,
        // [set parameter variable equation] allows table
        K::Declaration => {
            cc::DCO_STRT | cc::SYS_SUF_C | cc::CT_CONST | if flav == flavor::ABORT { cc::DECL_T } else { 0 }
        }
        K::DeclarationSetType => cc::DCO_STRT | cc::DECL_S,
        K::DeclarationVariableType => cc::DCO_STRT | cc::DECL_V,
        K::Dco => cc::DCO_STRT | cc::SYS_SUF_C | cc::CT_CONST,
        K::IgnoredHead
        | K::IgnoredBlock
        | K::DcoComment
        | K::CommentBlock
        | K::CommentLine
        | K::CommentEndline
        | K::CommentInline => cc::NONE,
        K::DcoBody | K::Title | K::String => cc::SYS_SUF_C | cc::CT_CONST,
        K::Identifier
        | K::IdentifierDim
        | K::IdentifierDimEnd
        | K::IdentifierDescription
        | K::AssignmentValue
        | K::IdentifierAssignmentEnd
        | K::IdentifierTableAssignmentColHead
        | K::IdentifierTableAssignmentRowHead
        | K::IdentifierTableAssignmentRow => cc::DCO_STRT | cc::SYS_SUF_C | cc::CT_CONST,
        K::IdentifierAssignment | K::AssignmentLabel => cc::DCO_STRT | cc::SYS_DAT | cc::SYS_SUF_C | cc::CT_CONST,
        K::Embedded | K::EmbeddedBody | K::EmbeddedEnd => {
            if flav != 0 {
                cc::NONE
            } else {
                cc::RES_END
            }
        }
        K::Reserved | K::Solve | K::SolveBody | K::SolveKey | K::Put | K::PutFormula => cc::START,
        K::Abort | K::AbortKey | K::ExecuteTool | K::ExecuteToolKey | K::ExecuteKey | K::ExecuteBody | K::Execute => {
            let sub = match kind {
                K::Abort | K::AbortKey => cc::ABORT,
                K::ExecuteTool | K::ExecuteToolKey => cc::EXEC_T,
                _ => cc::EXEC,
            };
            need_dot = if start < len && at(start) == b'.' as u16 { true } else { flav % 2 == 0 };
            if matches!(kind, K::ExecuteBody | K::Formula) && !need_dot && flav % 2 == 0 {
                cc::DCO_STRT | cc::SYS_SUF_C | cc::CT_CONST
            } else if need_dot {
                cc::START | sub
            } else {
                cc::DCO_STRT | cc::SYS_SUF_C | cc::CT_CONST | sub
            }
        }
        K::OptionKey | K::Option | K::OptionBody => cc::OPT | cc::MOD,
        _ => cc::ALL,
    };
    // Deviation from Studio: Studio builds the `ccSolve` (`minimize`, `maximize`,
    // `using`) and `ccMod` (model types) entries but filters the solve statement with
    // `cc_Start`, which contains neither, so they are never offered there.
    if matches!(kind, K::SolveBody | K::SolveKey) {
        filter |= cc::SOLVE | cc::MOD;
    }

    start = start.min(len.saturating_sub(1));
    let is_whitespace = line[..start].iter().all(|&c| c == b' ' as u16 || c == b'\t' as u16);
    let dco_check = (start + 2).min(len);
    let mut d_count = 1;
    for &c in &line[..dco_check] {
        if c != b' ' as u16 && c != b'\t' as u16 && c != b'$' as u16 {
            d_count = 0;
            break;
        }
        if c == b'$' as u16 {
            d_count += 1;
        } else if d_count == 1 {
            d_count = 0;
        }
        if d_count == 2 {
            break;
        }
    }

    if pos > 0 && pos <= len && line[pos - 1] == b'%' as u16 {
        let mut i = pos as isize - 2;
        while i >= 0 {
            let c = line[i as usize];
            if c == b'%' as u16 {
                filter &= !0x0000_00E0;
                break;
            }
            if c == b'_' as u16 || c == b'.' as u16 || (b'A' as u16..=b'Z' as u16).contains(&c) || (b'a' as u16..=b'z' as u16).contains(&c) {
                i -= 1;
                continue;
            }
            break;
        }
    }

    let mut sub_type = 0;
    if is_whitespace {
        if d_count != 2 && start > 0 {
            filter &= !cc::DCO;
        } else if kind == K::CommentBlock {
            filter = cc::START | cc::DCO_END;
            sub_type = 1;
        } else if matches!(kind, K::IgnoredHead | K::IgnoredBlock) {
            filter = cc::START | cc::DCO_END;
            sub_type = if flav == flavor::ECHO1 { 2 } else { 3 };
        } else if kind == K::EmbeddedBody {
            if flav == 0 {
                filter = cc::START | cc::RES_END;
            } else {
                filter = cc::START | cc::DCO_END;
                sub_type = if flav == flavor::EMBED1 { 4 } else { 5 };
            }
        } else if !test(filter, cc::DCO) {
            filter &= cc::DCO_STRT;
        }
    } else if dco_flavor >= flavor::ABORT {
        need_dot = true;
        let mut i = start;
        while i > 0 {
            if need_dot && line[i] == b'.' as u16 {
                need_dot = false;
            } else if group(line[i]) >= CharGroup::Break {
                filter &= !cc::DCO;
                break;
            }
            i -= 1;
        }
        if (flavor::ABORT..=flavor::EVAL).contains(&dco_flavor) {
            filter = cc::SYS_SUF_C | cc::CT_CONST;
        } else {
            filter &= !cc::DCO;
        }
    } else if d_count != 2 && start > 0 {
        filter &= !cc::DCO;
    }

    if suffix_name.as_ref().is_some_and(|s| s.chars().count() > 1) {
        filter |= cc::SUF_NAME;
    }
    Context {
        kind,
        flavor: flav,
        start: valid_start as u32,
        filter_text,
        filter,
        sub_type,
        need_dot,
        suffix_name,
    }
}

/// `FilterCompleterModel::filterAcceptsRow`
/// The display casing does not change the result: only the dynamic casing filters
/// case-sensitively, and it displays the entries as they are.
fn accepts(ctx: &Context, filter_lower: &str, e: &Entry, group_row: bool, case_sensitive: bool) -> bool {
    let text = e.text.as_str();
    let prefix = || {
        if case_sensitive {
            e.text.starts_with(&ctx.filter_text)
        } else {
            e.lower.starts_with(filter_lower)
        }
    };
    if e.ty & cc::SUF_NAME != 0 {
        return prefix();
    }
    if !test(e.ty, ctx.filter) {
        return false;
    }
    if (e.ty & cc::SUB_DCO != 0 || e.ty & cc::EXEC != 0 || e.ty & cc::EXEC_T != 0 || e.ty & cc::ABORT != 0)
        && text.starts_with('.') != ctx.need_dot
    {
        return false;
    }
    if e.ty == cc::DCO_END {
        let l = &e.lower;
        let ok = match ctx.sub_type {
            1 => l.starts_with("$offtext"),
            2 => l.starts_with("$offecho"),
            3 => l.starts_with("$offput"),
            4 => l.starts_with("$offembeddedcode"),
            5 => l.starts_with("$endembeddedcode") || l.starts_with("$pauseembeddedcode"),
            _ => true,
        };
        if !ok {
            return false;
        }
    }
    if ctx.filter_text.is_empty() {
        if group_row {
            return true;
        } else if (text.starts_with('$') || text.starts_with('%')) && e.ty != cc::DCO_END {
            return false;
        }
    } else if group_row {
        return false;
    }
    prefix()
}

fn category(ty: u32, group_row: bool) -> Category {
    if group_row {
        return Category::Group;
    }
    match ty {
        cc::DCO_STRT => Category::Dco,
        cc::DCO_END => Category::DcoEnd,
        cc::SYS_DAT => Category::SystemData,
        cc::SYS_SUF_R | cc::SYS_SUF_C => Category::SystemAttribute,
        cc::CT_CONST => Category::CompileConstant,
        cc::DECL | cc::DECL_S | cc::DECL_V | cc::DECL_T | cc::DECL_ADD_V | cc::DECL_ADD_S => Category::Declaration,
        cc::RES_END => Category::EmbeddedEnd,
        cc::OPT => Category::Option,
        cc::MOD => Category::ModelType,
        cc::SOLVE => Category::SolveKey,
        cc::EXEC | cc::EXEC_T | cc::ABORT => Category::ExecuteAddition,
        cc::SUF_NAME => Category::SuffixName,
        _ => Category::Reserved,
    }
}

fn fold(s: &str) -> String {
    s.to_lowercase()
}

/// `CodeCompleter::insertCurrent`: the inserted text replaces the filter text and the
/// following characters that already match it (compared case-insensitively).
fn replace_end(line: &[u16], start: usize, filter_len: usize, res: &str) -> usize {
    let lc = |c: u16| if (b'A' as u16..=b'Z' as u16).contains(&c) { c + 32 } else { c };
    let mut i = filter_len;
    for r in res.encode_utf16().skip(filter_len) {
        if start + i >= line.len() || lc(line[start + i]) != lc(r) {
            break;
        }
        i += 1;
    }
    start + i
}

/// Studio candidates for a context (`FilterCompleterModel` + `updateFilter`).
fn studio_candidates(line: &[u16], pos: usize, ctx: &Context, casing: Casing) -> Vec<Candidate> {
    let m = model(casing == Casing::Dynamic);
    let extra = ctx.suffix_name.as_deref().map(|s| suffix_entries(m, s)).unwrap_or_default();
    let display = |t: &str| match casing {
        Casing::Lower => t.to_lowercase(),
        Casing::Upper => t.to_uppercase(),
        _ => t.to_string(),
    };
    let filter_lower = ctx.filter_text.to_lowercase();
    let collect = |case_sensitive: bool| {
        let mut rows: Vec<(String, &Entry, bool)> = Vec::new();
        for (i, e) in m.entries.iter().enumerate() {
            let g = i == m.dollar_row || i == m.percent_row;
            if accepts(ctx, &filter_lower, e, g, case_sensitive) {
                rows.push((display(&e.text), e, g));
            }
        }
        for e in &extra {
            if accepts(ctx, &filter_lower, e, false, case_sensitive) {
                rows.push((display(&e.text), e, false));
            }
        }
        rows
    };
    let mut case_sensitive = casing == Casing::Dynamic;
    let mut rows = collect(case_sensitive);
    if case_sensitive && rows.is_empty() {
        case_sensitive = false;
        rows = collect(false);
    }
    if rows.is_empty() || (rows.len() == 1 && rows[0].0 == ctx.filter_text) {
        return vec![];
    }
    // FilterCompleterModel::lessThan (stable sort, case-insensitive)
    let rank = |ty: u32| {
        if ty == cc::SUF_NAME {
            0
        } else if ty == cc::DCO_END {
            1
        } else if ty == cc::RES_END {
            2
        } else {
            3
        }
    };
    rows.sort_by(|a, b| rank(a.1.ty).cmp(&rank(b.1.ty)).then_with(|| a.1.lower.cmp(&b.1.lower)));

    // best index
    let start = ctx.start as usize;
    let mut valid_end = pos;
    for (i, &c) in line.iter().enumerate().skip(pos + 1) {
        if group(c) >= CharGroup::Break {
            break;
        }
        valid_end = i;
    }
    let full: Vec<u16> = line[start.min(line.len())..(valid_end + 1).min(line.len())].to_vec();
    let full = String::from_utf16_lossy(&full);
    let cmp_key = |s: &str| if case_sensitive { s.to_string() } else { fold(s) };
    let full_key = cmp_key(&full);
    let full_len = full.encode_utf16().count();
    let mut best = 0;
    while best + 1 < rows.len() {
        let item: Vec<u16> = rows[best].0.encode_utf16().take(full_len).collect();
        let item = cmp_key(&String::from_utf16_lossy(&item));
        if item >= full_key {
            break;
        }
        best += 1;
    }

    let filter_len = ctx.filter_text.encode_utf16().count();
    rows.into_iter()
        .enumerate()
        .map(|(i, (t, e, g))| {
            let insert = if g { t.chars().next().map(String::from).unwrap_or_default() } else { t.clone() };
            let end = replace_end(line, start, filter_len, &insert);
            Candidate {
                label: t,
                kind_category: category(e.ty, g),
                cc_type: e.ty,
                detail: e.desc.clone(),
                documentation: None,
                insert_text: insert,
                replace_range: start as u32..end as u32,
                preselect: i == best,
            }
        })
        .collect()
}

// ------------------------------------------------------------------ extensions

/// Kinds in which statements, formulas and symbol references are written.
fn code_context(k: K) -> bool {
    matches!(
        k,
        K::Standard
            | K::Formula
            | K::Assignment
            | K::Semicolon
            | K::CommaIdent
            | K::Reserved
            | K::Solve
            | K::SolveBody
            | K::SolveKey
            | K::Put
            | K::PutFormula
            | K::Option
            | K::OptionBody
            | K::OptionKey
            | K::Abort
            | K::AbortKey
            | K::Execute
            | K::ExecuteBody
            | K::ExecuteKey
            | K::IdentifierDim
            | K::IdentifierDimEnd
    )
}

/// ASCII case-insensitive prefix test.
fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn is_ident(c: u16) -> bool {
    matches!(group(c), CharGroup::Alpha | CharGroup::Num)
}

fn attribute_table(c: SymbolCategory) -> Option<(&'static [(&'static str, &'static str)], Category)> {
    match c {
        SymbolCategory::Variable => Some((VARIABLE_ATTRIBUTES, Category::VariableAttribute)),
        SymbolCategory::Equation => Some((EQUATION_ATTRIBUTES, Category::EquationAttribute)),
        SymbolCategory::Model => Some((MODEL_ATTRIBUTES, Category::ModelAttribute)),
        _ => None,
    }
}

fn attr_doc_link(c: Category) -> &'static str {
    match c {
        Category::VariableAttribute => "[Documentation](https://www.gams.com/latest/docs/UG_Variables.html#UG_Variables_VariableAttributes)",
        Category::EquationAttribute => "[Documentation](https://www.gams.com/latest/docs/UG_Equations.html#UG_Equations_Attributes)",
        _ => "[Documentation](https://www.gams.com/latest/docs/UG_ModelSolve.html#UG_ModelSolve_ModelAttributes)",
    }
}

/// Extension: `.l`, `.lo`, ... after `x.` (variables, equations) and model attributes
/// after `m.`. Returns `None` when the cursor is not after `<symbol>.`.
fn attribute_candidates(line: &[u16], pos: usize, symbols: &[UserSymbol]) -> Option<Vec<Candidate>> {
    let mut a = pos;
    while a > 0 && is_ident(line[a - 1]) {
        a -= 1;
    }
    if a == 0 || line[a - 1] != b'.' as u16 {
        return None;
    }
    let dot = a - 1;
    let mut s = dot;
    while s > 0 && is_ident(line[s - 1]) {
        s -= 1;
    }
    if s == dot || group(line[s]) != CharGroup::Alpha || (s > 0 && matches!(line[s - 1], 0x2E | 0x24 | 0x25)) {
        return None;
    }
    let name = String::from_utf16_lossy(&line[s..dot]);
    let typed_early = String::from_utf16_lossy(&line[a..pos]);
    let Some(sym) = symbols.iter().find(|u| u.name.eq_ignore_ascii_case(&name)) else {
        return unknown_attribute_candidates(&name, &typed_early, a, pos, line);
    };
    let (table, cat) = attribute_table(sym.category)?;
    let typed = String::from_utf16_lossy(&line[a..pos]);
    let mut end = pos;
    while end < line.len() && is_ident(line[end]) {
        end += 1;
    }
    let what = match cat {
        Category::VariableAttribute => "variable",
        Category::EquationAttribute => "equation",
        _ => "model",
    };
    Some(
        table
            .iter()
            .filter(|(n, _)| starts_with_ci(n, &typed))
            .map(|(n, d)| Candidate {
                label: n.to_string(),
                kind_category: cat,
                cc_type: 0,
                detail: format!("{} attribute of {}", what, sym.name),
                documentation: Some(format!("{d}\n\n{}", attr_doc_link(cat))),
                insert_text: n.to_string(),
                replace_range: a as u32..end as u32,
                preselect: false,
            })
            .collect(),
    )
}

/// Extension: `name.` where `name` is not declared in the document nor in a loaded `.ref`
/// (e.g. declared in an `$include` before the first run): the union of the variable and
/// equation attributes, marked as uncertain.
fn unknown_attribute_candidates(name: &str, typed: &str, a: usize, pos: usize, line: &[u16]) -> Option<Vec<Candidate>> {
    if ["system", "gams", "execute", "executetool", "abort"].iter().any(|r| name.eq_ignore_ascii_case(r)) {
        return None;
    }
    let mut end = pos;
    while end < line.len() && is_ident(line[end]) {
        end += 1;
    }
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for (table, cat) in [(VARIABLE_ATTRIBUTES, Category::VariableAttribute), (EQUATION_ATTRIBUTES, Category::EquationAttribute)] {
        for (n, d) in table {
            if !starts_with_ci(n, typed) || seen.contains(n) {
                continue;
            }
            seen.push(n);
            out.push(Candidate {
                label: n.to_string(),
                kind_category: cat,
                cc_type: 0,
                detail: "attribute (symbol not known yet \u{2014} run/compile to resolve)".to_string(),
                documentation: Some(format!("{d}\n\n{}", attr_doc_link(cat))),
                insert_text: n.to_string(),
                replace_range: a as u32..end as u32,
                preselect: false,
            });
        }
    }
    Some(out)
}

/// Extension: symbol names in code contexts.
fn symbol_candidates(line: &[u16], pos: usize, ctx: &Context, symbols: &[UserSymbol]) -> Vec<Candidate> {
    if !code_context(ctx.kind) || ctx.filter_text.starts_with(['$', '%']) {
        return vec![];
    }
    let mut a = pos;
    while a > 0 && is_ident(line[a - 1]) {
        a -= 1;
    }
    // not after a dot (attribute / label position) or a DCO / compile-time variable
    if a > 0 && matches!(line[a - 1], 0x2E | 0x24 | 0x25) {
        return vec![];
    }
    if a < pos && group(line[a]) != CharGroup::Alpha {
        return vec![];
    }
    let typed = String::from_utf16_lossy(&line[a..pos]);
    let mut end = pos;
    while end < line.len() && is_ident(line[end]) {
        end += 1;
    }
    symbols
        .iter()
        .filter(|s| starts_with_ci(&s.name, &typed))
        .map(|s| Candidate {
            label: s.name.clone(),
            kind_category: Category::Symbol(s.category),
            cc_type: 0,
            detail: s.detail.clone(),
            documentation: s.documentation.clone(),
            insert_text: s.name.clone(),
            replace_range: a as u32..end as u32,
            preselect: false,
        })
        .collect()
}

/// User symbols of the declarations of a document (see [`declarations`]).
pub fn document_symbols(decls: &[DeclaredSymbol]) -> Vec<UserSymbol> {
    let mut out: Vec<UserSymbol> = Vec::new();
    for d in decls {
        if d.name.is_empty() || out.iter().any(|u| u.name.eq_ignore_ascii_case(&d.name)) {
            continue;
        }
        let category = if d.type_prefix.as_deref().is_some_and(|p| p.to_ascii_lowercase().starts_with("singleton")) {
            SymbolCategory::Set
        } else if d.type_prefix.is_some() {
            SymbolCategory::Variable
        } else {
            SymbolCategory::from_keyword(&d.keyword)
        };
        let prefix = d.type_prefix.as_ref().map(|p| format!("{p} ")).unwrap_or_default();
        out.push(UserSymbol {
            name: d.name.clone(),
            category,
            detail: format!("{prefix}{} {}", d.keyword, d.name),
            documentation: d.description.clone().filter(|s| !s.is_empty()),
        });
    }
    out
}

// ------------------------------------------------------------------ API

/// The completer context at a UTF-16 column of a line, given the state at the end of
/// the previous line.
pub fn context_at(prev: &LineState, line_text: &str, utf16_col: u32) -> Context {
    let u: Vec<u16> = line_text.encode_utf16().collect();
    let (info, scan) = scan_line_utf16(prev, &u);
    context(&u, (utf16_col as usize).min(u.len()), &scan, info.state.suffix_name())
}

/// Completion candidates for a line given the state at the end of the previous line.
/// `symbols` are the user symbols to offer (extension; empty for plain Studio behavior).
pub fn completions_in_line(
    prev: &LineState,
    line_text: &str,
    utf16_col: u32,
    symbols: &[UserSymbol],
    casing: Casing,
) -> Vec<Candidate> {
    let u: Vec<u16> = line_text.encode_utf16().collect();
    let pos = (utf16_col as usize).min(u.len());
    let (info, scan) = scan_line_utf16(prev, &u);
    // Deviation from Studio: no completion inside a line or end-of-line comment.
    // (Studio's getSyntax reports the syntax *before* the block at the cursor, so it
    // treats the text of a `*` comment line like code.)
    let at_cursor = scan.range(pos as isize..).next().map(|(_, v)| v.0);
    if matches!(at_cursor, Some(K::CommentLine | K::CommentEndline | K::CommentInline)) {
        return vec![];
    }
    let ctx = context(&u, pos, &scan, info.state.suffix_name());
    if code_context(ctx.kind) {
        if let Some(attrs) = attribute_candidates(&u, pos, symbols) {
            return attrs;
        }
    }
    let mut out = studio_candidates(&u, pos, &ctx, casing);
    if matches!(ctx.kind, K::Solve | K::SolveBody | K::SolveKey) {
        // extension: the solve keywords and model types first (stable), then the other valid items
        out.sort_by_key(|c| !matches!(c.kind_category, Category::SolveKey | Category::ModelType));
    }
    out.extend(symbol_candidates(&u, pos, &ctx, symbols));
    out
}

/// Extension: candidates after a typed blank (trigger character " "). Only where the next
/// word is constrained; `None` elsewhere (no popup after every word).
pub fn blank_completions(prev: &LineState, line_text: &str, utf16_col: u32, casing: Casing) -> Option<Vec<Candidate>> {
    let mut u: Vec<u16> = line_text.encode_utf16().collect();
    let pos = (utf16_col as usize).min(u.len());
    // the text after the cursor is irrelevant (and would change the scanned syntax)
    u.truncate(pos);
    if pos == 0 || !matches!(u[pos - 1], 0x20 | 0x09) {
        return None;
    }
    let (info, scan) = scan_line_utf16(prev, &u);
    let at_cursor = scan.range(pos as isize..).next().map(|(_, v)| v.0);
    if matches!(at_cursor, Some(K::CommentLine | K::CommentEndline | K::CommentInline)) {
        return None;
    }
    let ctx = context(&u, pos, &scan, info.state.suffix_name());
    if !ctx.filter_text.is_empty() {
        return None;
    }
    let before = String::from_utf16_lossy(&u[..pos]);
    let words: Vec<&str> = before.split(|c: char| c.is_whitespace() || c == ';').filter(|w| !w.is_empty()).collect();
    let all = studio_candidates(&u, pos, &ctx, casing);
    let keep = |f: &dyn Fn(&Candidate) -> bool| -> Option<Vec<Candidate>> {
        let v: Vec<Candidate> = all.iter().filter(|c| f(c)).cloned().collect();
        (!v.is_empty()).then_some(v)
    };
    match ctx.kind {
        K::DeclarationVariableType | K::DeclarationSetType => keep(&|c| c.kind_category == Category::Declaration),
        K::Solve | K::SolveBody | K::SolveKey => {
            let sw = words.iter().rposition(|w| w.eq_ignore_ascii_case("solve"))?;
            let w = &words[sw + 1..];
            let is_model_type = |s: &str| all.iter().any(|c| c.kind_category == Category::ModelType && c.label.eq_ignore_ascii_case(s));
            match w {
                [_] => keep(&|c| c.kind_category == Category::SolveKey),
                [_, using] if using.eq_ignore_ascii_case("using") => keep(&|c| c.kind_category == Category::ModelType),
                [.., last] if w.len() >= 3 && w[1].eq_ignore_ascii_case("using") && w.len() == 3 && is_model_type(last) => keep(&|c| {
                    c.kind_category == Category::SolveKey && (starts_with_ci(&c.label, "min") || starts_with_ci(&c.label, "max"))
                }),
                _ => None,
            }
        }
        K::Option | K::OptionBody | K::OptionKey => {
            if words.len() == 1 && (words[0].eq_ignore_ascii_case("option") || words[0].eq_ignore_ascii_case("options")) {
                keep(&|c| c.kind_category == Category::Option)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Completion candidates at a UTF-16 position of a document (Studio behavior plus the
/// symbols declared in the document).
pub fn completions(text: &str, line: u32, utf16_col: u32) -> Vec<Candidate> {
    completions_with(text, line, utf16_col, &Options::default())
}

/// [`completions`] with options.
pub fn completions_with(text: &str, line: u32, utf16_col: u32, opts: &Options) -> Vec<Candidate> {
    let lines = split_lines(text);
    let Some(&cur) = lines.get(line as usize) else { return vec![] };
    let mut state = LineState::default();
    for l in &lines[..line as usize] {
        state = crate::highlighter::highlight_line_info(&state, l).state;
    }
    let mut symbols: Vec<UserSymbol> = opts.symbols.to_vec();
    if !opts.no_document_symbols {
        for s in document_symbols(&declarations(text)) {
            if !symbols.iter().any(|u| u.name.eq_ignore_ascii_case(&s.name)) {
                symbols.push(s);
            }
        }
    }
    completions_in_line(&state, cur, utf16_col, &symbols, opts.casing)
}

// ------------------------------------------------------------------ attribute tables
// Extension feature. One-line descriptions written for this extension (facts only, no documentation
// text); the completion item links to the documentation section (see `attr_doc_link`).

/// Attributes listed in the GAMS documentation (UG_Variables).
pub(crate) const VARIABLE_ATTRIBUTES: &[(&str, &str)] = &[
    ("lo", "Lower bound"),
    ("up", "Upper bound"),
    ("fx", "Fixed value (sets both bounds)"),
    ("l", "Level value"),
    ("m", "Marginal value"),
    ("scale", "Scaling factor"),
    ("prior", "Branching priority"),
    ("stage", "Stage number"),
    ("range", "Distance between upper and lower bound"),
    ("slackup", "Distance to upper bound"),
    ("slacklo", "Distance to lower bound"),
    ("slack", "Smaller of the distances to the bounds"),
    ("infeas", "Amount of bound violation"),
];

/// Attributes listed in the GAMS documentation (UG_Equations).
pub(crate) const EQUATION_ATTRIBUTES: &[(&str, &str)] = &[
    ("lo", "Lower bound (right-hand side for =g=, =e=, =b=)"),
    ("up", "Upper bound (right-hand side for =l=, =e=, =b=)"),
    ("l", "Level value"),
    ("m", "Marginal value (shadow price)"),
    ("scale", "Scaling factor"),
    ("stage", "Stage number"),
    ("range", "Distance between upper and lower bound"),
    ("slacklo", "Distance to lower bound"),
    ("slackup", "Distance to upper bound"),
    ("slack", "Smaller of the distances to the bounds"),
    ("infeas", "Amount of bound violation"),
];

/// Attributes listed in the GAMS documentation (UG_ModelSolve).
pub(crate) const MODEL_ATTRIBUTES: &[(&str, &str)] = &[
    ("bRatio", "Basis detection threshold"),
    ("cheat", "Required improvement of a new solution"),
    ("cutOff", "Cutoff value for branch and bound"),
    ("defPoint", "Pass the default point"),
    ("dictFile", "Dictionary file switch"),
    ("domLim", "Domain violation limit solver default"),
    ("fdDelta", "Step size for finite differences"),
    ("fdOpt", "Options for finite differences"),
    ("holdFixed", "Treat fixed variables as constants"),
    ("integer1", "Integer communication cells"),
    ("integer2", "Integer communication cells"),
    ("integer3", "Integer communication cells"),
    ("integer4", "Integer communication cells"),
    ("integer5", "Integer communication cells"),
    ("iterLim", "Iteration limit of solver"),
    ("limCol", "Columns listed per variable block"),
    ("limRow", "Rows listed per equation block"),
    ("MCPRHoldFx", "MCP rows paired with fixed variables"),
    ("nodLim", "Node limit in branch and bound tree"),
    ("optCA", "Absolute Optimality criterion solver default"),
    ("optCR", "Relative Optimality criterion solver default"),
    ("optFile", "Default option file"),
    ("priorOpt", "Priority option for variable attribute .prior"),
    ("real1", "Real communication cells"),
    ("real2", "Real communication cells"),
    ("real3", "Real communication cells"),
    ("real4", "Real communication cells"),
    ("real5", "Real communication cells"),
    ("reform", "Reformulation level"),
    ("requestMarginals", "Request marginals"),
    ("resLim", "Wall-clock time limit for solver"),
    ("savePoint", "Save solver point in GDX file"),
    ("scaleOpt", "Use user-supplied scale factors"),
    ("solPrint", "Solution report print option"),
    ("solveLink", "Solver link option"),
    ("solveOpt", "Multiple solve management"),
    ("sysOut", "Solver Status file reporting option"),
    ("threads", "Number of solver threads"),
    ("tolInfeas", "Tolerance for empty infeasible rows"),
    ("tolInfRep", "Tolerance for marking infeasible rows in listing"),
    ("tolProj", "Tolerance for snapping solution values to bounds"),
    ("tryInt", "Use partial integer-feasible solution"),
    ("tryLinear", "Fall back to an LP solver for linear NLPs"),
    ("workFactor", "Memory estimate multiplier"),
    ("workSpace", "Solver work space in MB"),
    ("domUsd", "Number of domain violations"),
    ("etAlg", "Solver dependent timing information"),
    ("etSolve", "Elapsed time of the solve statement"),
    ("etSolver", "Elapsed time of the solver"),
    ("handle", "Unique handle number of SOLVE statement"),
    ("iterUsd", "Number of iterations used"),
    ("line", "Line of the last solve"),
    ("linkUsed", "SolveLink value of the last solve"),
    ("marginals", "Indicator for marginals present"),
    ("maxInfes", "Maximum of infeasibilities"),
    ("meanInfes", "Mean of infeasibilities"),
    ("modelStat", "Model status code"),
    ("nodUsd", "Branch-and-bound nodes used"),
    ("number", "Model instance serial number"),
    ("numDepnd", "Number of dependencies in a CNS model"),
    ("numDVar", "Number of discrete variables"),
    ("numEqu", "Number of equations"),
    ("numInfes", "Number of infeasibilities"),
    ("numNLIns", "Number of nonlinear instructions"),
    ("numNLNZ", "Number of nonlinear nonzeros"),
    ("numNOpt", "Number of nonoptimalities"),
    ("numNZ", "Number of nonzeros"),
    ("numRedef", "Number of MCP redefinitions"),
    ("numVar", "Number of variables"),
    ("numVarProj", "Number of bound projections during model generation"),
    ("objEst", "Best possible objective estimate (MIP)"),
    ("objVal", "Objective function value"),
    ("procUsed", "Model type code"),
    ("resCalc", "Function/derivative time (deprecated)"),
    ("resDeriv", "Time spent in derivative calculations (deprecated)"),
    ("resGen", "Model generation time"),
    ("resIn", "Time to import model (deprecated)"),
    ("resOut", "Time to export solution (deprecated)"),
    ("resUsd", "Solver time"),
    ("rngBndMax", "Largest absolute finite bound"),
    ("rngBndMin", "Smallest absolute nonzero bound"),
    ("rngMatMax", "Largest absolute matrix coefficient"),
    ("rngMatMin", "Smallest absolute matrix coefficient"),
    ("rngRhsMax", "Largest absolute finite right-hand side"),
    ("rngRhsMin", "Smallest absolute nonzero right-hand side"),
    ("rObj", "Relaxed objective value of a MIP"),
    ("solveStat", "Indicates the solver termination condition"),
    ("sumInfes", "Sum of infeasibilities"),
    ("sysIdent", "Solver identification number"),
    ("sysVer", "Solver version"),
];


#[cfg(test)]
mod tests {
    //! Port of Studio `tests/testcompleter/testcompleter.cpp`: the block syntax is
    //! simulated (`SyntaxSimulator`) and the resulting type filter is checked.
    use super::*;

    fn sim(entries: &[(isize, K, i32)]) -> ScanMap {
        entries.iter().map(|&(p, k, f)| (p, (k, f))).collect()
    }
    fn filter_at(line: &str, pos: usize, scan: &ScanMap) -> u32 {
        let u: Vec<u16> = line.encode_utf16().collect();
        context(&u, pos, scan, None).filter
    }

    #[test]
    fn test_dco() {
        // empty line
        assert_eq!(filter_at("", 0, &sim(&[(0, K::Standard, 0)])), cc::START);
        // empty line in non-GAMS blocks
        let expect = cc::DCO_END | cc::START;
        assert_eq!(filter_at("", 0, &sim(&[(0, K::CommentBlock, 0)])), expect);
        assert_eq!(filter_at("", 0, &sim(&[(0, K::IgnoredBlock, 5)])), expect);
        assert_eq!(filter_at("", 0, &sim(&[(0, K::EmbeddedBody, 19)])), expect);
        assert_eq!(filter_at("", 0, &sim(&[(0, K::EmbeddedBody, 20)])), expect);
        assert_eq!(filter_at("", 0, &sim(&[(0, K::EmbeddedBody, 0)])), cc::RES_END | cc::START);
    }

    #[test]
    fn test_declaration() {
        let line = "    i 'canning plants' / seattle  san-diego /;";
        let s = sim(&[
            (0, K::Declaration, 16),
            (4, K::Declaration, 16),
            (6, K::Identifier, 16),
            (22, K::IdentifierDescription, 16),
            (24, K::IdentifierAssignment, 16),
            (32, K::AssignmentLabel, 16),
            (33, K::IdentifierAssignment, 16),
            (44, K::AssignmentLabel, 16),
            (46, K::IdentifierAssignmentEnd, 16),
            (47, K::Semicolon, 16),
        ]);
        assert_eq!(filter_at(line, 3, &s), cc::SYS_SUF_C | cc::CT_CONST | cc::DECL_T);
        assert_eq!(filter_at(line, 21, &s), cc::SYS_SUF_C | cc::CT_CONST);
        assert_eq!(filter_at(line, 24, &s), cc::SYS_SUF_C | cc::CT_CONST | cc::SYS_DAT);
    }

    #[test]
    fn test_put() {
        let line = "put 'abc %system.Date%';";
        let s = sim(&[
            (0, K::Standard, 0),
            (3, K::Put, 0),
            (4, K::PutFormula, 0),
            (23, K::String, 0),
            (24, K::Semicolon, 0),
        ]);
        assert_eq!(filter_at(line, 3, &s), cc::START);
        assert_eq!(filter_at(line, 4, &s), cc::RES_ALL | cc::SYS_SUF_R | cc::SYS_SUF_C | cc::CT_CONST);
        assert_eq!(filter_at(line, 6, &s), cc::SYS_SUF_C | cc::CT_CONST);
        assert_eq!(filter_at(line, 24, &s), cc::START & !(cc::DCO_STRT | cc::DCO_END));
    }

    #[test]
    fn model_types_follow_lower_bound() {
        let m = model(false);
        let ty = |t: &str| m.entries.iter().find(|e| e.text == t).map(|e| e.ty);
        assert_eq!(ty("$..."), Some(cc::DCO_STRT));
        assert_eq!(ty("$offText"), Some(cc::DCO_END));
        assert_eq!(ty("$offEcho"), Some(cc::DCO_END));
        assert_eq!(ty("$offEmbeddedCode"), Some(cc::DCO_STRT));
        assert_eq!(ty("$onText"), Some(cc::DCO_STRT));
        // `Set` is overwritten with ccDecl, `Sets` stays ccDeclS (Studio initData)
        assert_eq!(ty("Set"), Some(cc::DECL));
        assert_eq!(ty("Sets"), Some(cc::DECL_S));
        assert_eq!(ty("Variable"), Some(cc::DECL_V));
        assert_eq!(ty("Variable Table"), Some(cc::DECL_V));
        assert_eq!(ty("Table"), Some(cc::DECL_T));
        assert_eq!(ty("Positive Variables"), Some(cc::DECL_ADD_V));
        assert_eq!(ty("Singleton Set"), Some(cc::DECL_ADD_S));
        assert_eq!(ty("solve "), Some(cc::RES));
        assert_eq!(ty("abort.noError"), Some(cc::RES));
        assert_eq!(ty("endEmbeddedCode"), Some(cc::RES_END));
        assert_eq!(ty("LimRow"), Some(cc::OPT));
        assert_eq!(ty("MIQCP"), Some(cc::MOD));
        assert_eq!(ty("using"), Some(cc::SOLVE));
        assert_eq!(ty("$call.async"), Some(cc::DCO_STRT));
        assert_eq!(ty("system.empty"), Some(cc::SYS_DAT));
        assert_eq!(ty("system.Date"), Some(cc::SYS_SUF_R));
        assert_eq!(ty("%..."), Some(cc::SYS_SUF_C));
        assert_eq!(ty("%emp.info%"), Some(cc::SYS_SUF_C));
        assert_eq!(ty("%modelStat.optimal%"), Some(cc::CT_CONST));
        assert_eq!(ty(".async"), Some(cc::EXEC));
        assert_eq!(ty(".checkErrorLevel"), Some(cc::EXEC)); // from SyntaxData::execute()
        assert_eq!(ty("noError"), Some(cc::ABORT));
        assert_eq!(ty("executeTool.checkErrorLevel"), Some(cc::RES));
        let d = m.entries.iter().find(|e| e.text == "%modelStat.optimal%").unwrap();
        assert_eq!(d.desc, "Model status: 1");
    }

    #[test]
    fn dynamic_casing_adds_variants() {
        let m = model(true);
        for t in ["Set", "set", "SET"] {
            assert!(m.entries.iter().any(|e| e.text == t), "{t}");
        }
        assert_eq!(m.entries[m.dollar_row].text, "$...");
        assert_eq!(m.entries[m.percent_row].text, "%...");
    }
}
