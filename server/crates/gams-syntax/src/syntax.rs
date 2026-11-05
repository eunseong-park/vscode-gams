// SPDX-License-Identifier: GPL-3.0-or-later
//! The per-kind syntax classes of the Studio highlighter.
//!
//! Faithful port of (GAMS Studio, `src/syntax/`):
//! - `syntaxformats.cpp`: SyntaxStandard, SyntaxDco, SyntaxDcoBody, SyntaxCommentLine,
//!   SyntaxCommentEndline, SyntaxUniformBlock, SyntaxSubDCO, SyntaxDelimiter,
//!   SyntaxFormula, SyntaxQuoted, SyntaxAssign, `hasMatchingSuffix`
//! - `syntaxdeclaration.cpp`: SyntaxDeclaration, SyntaxPreDeclaration, SyntaxReserved,
//!   SyntaxSimpleKeyword, SyntaxSubsetKey, SyntaxEmbedded, SyntaxEmbeddedBody,
//!   AssignmentSystemData
//! - `syntaxidentifier.cpp`: SyntaxIdentifier, SyntaxIdentifierDim, SyntaxIdentifierDimEnd,
//!   SyntaxIdentDescript, SyntaxIdentAssign, AssignmentLabel, AssignmentValue,
//!   SyntaxTableAssign, SyntaxSimpleWord
//!
//! Instead of virtual classes, every function dispatches on the `SyntaxKind` of the
//! syntax instance (`kind`) and receives the kind of the currently active syntax
//! (`entry`, Studio's `entryKind`).
//!
//! Deviation: Studio keeps the end-of-line comment configuration (`$onEolCom`,
//! `$eolCom`) in highlighter-global mutable objects (`SharedSyntaxData`). Here it is
//! [`EolState`], carried in the line state, so a top-down pass gives the same result
//! deterministically.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::chars::*;
use crate::dict::DictList;
use crate::generated::syntaxdata as data;
use crate::kind::flavor::*;
use crate::kind::SyntaxKind as K;

/// `SyntaxShift` (variant names kept from Studio)
#[allow(clippy::enum_variant_names)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Shift {
    /// replace current-top-kind by this
    Shift,
    /// skips this kind (keep current-top-kind)
    Skip,
    /// stacks the nextKind on top of current-top-kind
    In,
    /// steps out of the kind (unstacks current-top-kind)
    Out,
    /// steps out of the whole stack until SyntaxKind::Standard is reached
    Reset,
}

/// `SyntaxState`: flavor plus the only syntax flag Studio uses (`flagSuffixName`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub(crate) struct SyntaxState {
    pub flavor: i32,
    pub suffix: Option<Vec<u16>>,
}

/// End-of-line comment configuration (Studio: `SyntaxCommentEndline::mCommentChars`,
/// `SyntaxDcoBody::mEolComChars`, `SyntaxFormula::mSpecialDynamicChars`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct EolState {
    /// comment characters of `SyntaxCommentEndline` (default `"!!"`)
    pub endline: Vec<u16>,
    /// first eol-comment char after `$onEolCom`/`$eolCom` (`setSpecialDynamicChars`)
    pub dyn_char: Option<u16>,
}

impl Default for EolState {
    fn default() -> Self {
        EolState {
            endline: vec![u('!'), u('!')],
            dyn_char: None,
        }
    }
}

impl EolState {
    fn dco_body_chars(&self) -> &[u16] {
        match &self.dyn_char {
            Some(c) => std::slice::from_ref(c),
            None => &[],
        }
    }
    /// `SyntaxFormula::mSpecialDynamicChars` of the instance `kind`
    fn formula_specials(&self, kind: K) -> ([u16; 2], usize) {
        match self.dyn_char {
            None => ([0, 0], 0),
            Some(c) if kind == K::Formula => ([c, u('=')], 2),
            Some(c) => ([c, 0], 1),
        }
    }
    /// `SyntaxCommentEndline::check`
    pub fn check_endline(&self, line: &Line, index: isize) -> bool {
        let cs = &self.endline;
        if index + cs.len() as isize > line.len() {
            return false;
        }
        if line.at(index) != cs[0] {
            return false;
        }
        if cs.len() > 1 && line.at(index + 1) != cs[1] {
            return false;
        }
        true
    }
}

/// Reference to the documentation of a matched keyword (`docForLastRequest`).
#[derive(Clone, Copy, Debug)]
pub(crate) enum DocRef {
    Dict { inst: K, dict: K, idx: usize },
    Dco { idx: usize },
    DcoEnd { idx: usize },
}

/// `SyntaxBlock`
#[derive(Clone, Debug)]
pub(crate) struct Block {
    pub syntax: Option<K>,
    pub state: SyntaxState,
    pub start: isize,
    pub end: isize,
    pub error: bool,
    pub shift: Shift,
    pub next: K,
    pub doc: Option<DocRef>,
}

impl Block {
    /// `SyntaxBlock()` / `SyntaxBlock(this)` (both are invalid blocks)
    pub fn none() -> Self {
        Block {
            syntax: None,
            state: SyntaxState::default(),
            start: 0,
            end: 0,
            error: false,
            shift: Shift::Shift,
            next: K::Standard,
            doc: None,
        }
    }
    /// `SyntaxBlock(this, state, start, end)` with `shift == SyntaxShift::shift`
    fn new(kind: K, state: &SyntaxState, start: isize, end: isize) -> Self {
        Block {
            syntax: Some(kind),
            state: state.clone(),
            start,
            end,
            error: false,
            shift: Shift::Shift,
            next: K::Standard,
            doc: None,
        }
    }
    fn shift(mut self, s: Shift) -> Self {
        self.shift = s;
        self
    }
    /// constructor variant with `_next` (implies `SyntaxShift::in`)
    fn into_kind(mut self, next: K) -> Self {
        self.shift = Shift::In;
        self.next = next;
        self
    }
    fn next(mut self, next: K) -> Self {
        self.next = next;
        self
    }
    fn error(mut self, e: bool) -> Self {
        self.error = e;
        self
    }
    fn doc(mut self, d: Option<DocRef>) -> Self {
        self.doc = d;
        self
    }
    pub fn is_valid(&self) -> bool {
        self.syntax.is_some() && self.start < self.end
    }
    pub fn len(&self) -> isize {
        self.end - self.start
    }
}

// ---------------------------------------------------------------------------
// Registry: dictionaries and constant data, built once.
// ---------------------------------------------------------------------------

pub(crate) struct DcoData {
    pub dcos: Vec<String>,
    pub dco_low: Vec<String>,
    pub descr: Vec<&'static str>,
    pub end_dcos: Vec<String>,
    pub end_low: Vec<String>,
    pub end_descr: Vec<&'static str>,
    pub flavors: HashMap<String, i32>,
    pub special: HashMap<String, K>,
}

pub(crate) struct Registry {
    pub dicts: Vec<Option<DictList>>,
    /// `SyntaxDeclaration::mFlavors`, indexed by position in the sorted declaration dict.
    pub decl_flavors: Vec<i32>,
    /// `SyntaxSubsetKey::mOtherKey`
    pub solve_other_keys: Vec<usize>,
    /// `SyntaxSubDCO::mSubDCOs`
    pub execute_subs: Vec<Vec<u16>>,
    pub sub_abort: Vec<Vec<u16>>,
    pub sub_save: Vec<Vec<u16>>,
    pub sub_eval: Vec<Vec<u16>>,
    pub dco: DcoData,
}

/// Fixed texts defined in Studio source (not in syntaxdata.h).
const ABORT_KEY: (&str, &str) = ("noError", "Don't throw an execution error");
const EXECUTE_TOOL: (&str, &str) = ("executeTool", "Execute a GAMS tool");
const EXECUTE_TOOL_KEY: (&str, &str) = (
    "checkErrorLevel",
    "Check errorLevel automatically after executing external program",
);
/// `SyntaxAbstract::systemEmpData`
const SYSTEM_EMP_DATA: (&str, &str) = ("emp.info", "Name of the EMP Info File");

fn pairs(t: &[(&str, &str)]) -> Vec<(String, String)> {
    t.iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

/// `cleanChars`
fn clean_chars(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_' | '(' | ')'))
        .collect()
}

fn build_dco() -> DcoData {
    let mut block_ending: Vec<&str> = vec![
        "offText",
        "offPut",
        "pauseEmbeddedCode",
        "endEmbeddedCode",
        "offEmbeddedCode",
    ];
    let mut d = DcoData {
        dcos: vec![],
        dco_low: vec![],
        descr: vec![],
        end_dcos: vec![],
        end_low: vec![],
        end_descr: vec![],
        flavors: HashMap::new(),
        special: HashMap::new(),
    };
    for (name, desc) in data::DIRECTIVES {
        if let Some(p) = block_ending.iter().position(|b| b == name) {
            // block-ending DCOs are checked separately
            block_ending.remove(p);
            d.end_dcos.push(name.to_string());
            d.end_low.push(name.to_lowercase());
            d.end_descr.push(desc);
        } else {
            d.dcos.push(name.to_string());
            d.dco_low.push(name.to_lowercase());
            d.descr.push(desc);
        }
    }
    // ensure offtext to be first and offput second
    for key in ["offput", "offtext"] {
        if let Some(i) = d.end_low.iter().position(|s| s == key) {
            if i > 0 {
                let a = d.end_dcos.remove(i);
                d.end_dcos.insert(0, a);
                let b = d.end_low.remove(i);
                d.end_low.insert(0, b);
                let c = d.end_descr.remove(i);
                d.end_descr.insert(0, c);
            }
        }
    }
    let fl: &[(&str, i32)] = &[
        ("onText", TEXT1),
        ("offText", TEXT0),
        ("onEcho", ECHO1),
        ("onEchoV", ECHO1),
        ("onEchoS", ECHO1),
        ("offEcho", ECHO0),
        ("onPut", PUT1),
        ("onPutV", PUT1),
        ("onPutS", PUT1),
        ("offPut", PUT0),
        ("onExternalInput", EX_IN1),
        ("offExternalInput", EX_IN0),
        ("onExternalOutput", EX_OUT1),
        ("offExternalOutput", EX_OUT0),
        ("ifThen", IF1),
        ("ifThenI", IF1),
        ("ifThenE", IF1),
        ("endIf", IF0),
        ("onFold", FOLD1),
        ("offFold", FOLD0),
        ("include", INC),
        ("abort", ABORT),
        ("call", CALL),
        ("hiddenCall", CALL),
        ("save", SAVE),
        ("eval", EVAL),
        ("evalLocal", EVAL),
        ("evalGlobal", EVAL),
        ("onEmbeddedCode", EMBED1),
        ("onEmbeddedCodeS", EMBED1),
        ("onEmbeddedCodeV", EMBED1),
        ("offEmbeddedCode", EMBED0),
        ("offEmbeddedCodeS", EMBED0),
        ("offEmbeddedCodeV", EMBED0),
    ];
    for (n, f) in fl {
        d.flavors.insert(n.to_lowercase(), *f);
    }
    let sk: &[(&str, K)] = &[
        ("title", K::Title),
        ("onText", K::CommentBlock),
        ("onEcho", K::IgnoredHead),
        ("onEchoV", K::IgnoredHead),
        ("onEchoS", K::IgnoredHead),
        ("onPut", K::IgnoredBlock),
        ("onPutV", K::IgnoredBlock),
        ("onPutS", K::IgnoredBlock),
        ("continueEmbeddedCode", K::EmbeddedBody),
        ("continueEmbeddedCodeS", K::EmbeddedBody),
        ("continueEmbeddedCodeV", K::EmbeddedBody),
        ("onEmbeddedCode", K::EmbeddedBody),
        ("onEmbeddedCodeS", K::EmbeddedBody),
        ("onEmbeddedCodeV", K::EmbeddedBody),
        ("hidden", K::DcoComment),
        ("abort", K::SubDCO),
        ("call", K::SubDCO),
        ("hiddenCall", K::SubDCO),
        ("save", K::SubDCO),
        ("eval", K::SubDCO),
        ("evalLocal", K::SubDCO),
        ("evalGlobal", K::SubDCO),
    ];
    for (n, k) in sk {
        d.special.insert(n.to_lowercase(), *k);
    }
    d
}

fn build_registry() -> Registry {
    let mut dicts: Vec<Option<DictList>> = (0..DICT_SLOTS).map(|_| None).collect();
    let mut ins = |inst: K, dict: K, l: Vec<(String, String)>, prefix: &str| {
        dicts[dict_slot(inst, dict)] = Some(DictList::new(l, prefix));
    };

    // SyntaxDeclaration
    ins(K::Declaration, K::Declaration, pairs(data::DECLARATION), "");
    ins(
        K::Declaration,
        K::DeclarationSetType,
        pairs(&[("Set", ""), ("Sets", "")]),
        "",
    );
    ins(
        K::Declaration,
        K::DeclarationVariableType,
        pairs(&[("Variable", ""), ("Variables", "")]),
        "",
    );
    // SyntaxPreDeclaration
    ins(
        K::DeclarationSetType,
        K::DeclarationSetType,
        pairs(data::DECLARATION4_SET),
        "",
    );
    ins(
        K::DeclarationVariableType,
        K::DeclarationVariableType,
        pairs(data::DECLARATION4_VAR),
        "",
    );
    // SyntaxReserved
    ins(K::Reserved, K::Reserved, pairs(&data::RESERVED[1..]), ""); // list.remove(0)
    ins(K::Abort, K::Abort, pairs(&data::RESERVED[..1]), "");
    ins(K::AbortKey, K::AbortKey, pairs(&[ABORT_KEY]), "");
    ins(K::Solve, K::Solve, pairs(data::KEY_SOLVE), "");
    ins(K::Option, K::Option, pairs(data::KEY_OPTION), "");
    ins(K::Execute, K::Execute, pairs(data::KEY_EXECUTE), "");
    ins(K::ExecuteKey, K::ExecuteKey, pairs(data::EXECUTE), "");
    ins(K::ExecuteTool, K::ExecuteTool, pairs(&[EXECUTE_TOOL]), "");
    ins(
        K::ExecuteToolKey,
        K::ExecuteToolKey,
        pairs(&[EXECUTE_TOOL_KEY]),
        "",
    );
    ins(K::Put, K::Put, pairs(data::KEY_PUT), "");
    // SyntaxEmbedded
    ins(K::Embedded, K::Embedded, pairs(data::EMBEDDED), "");
    ins(
        K::EmbeddedEnd,
        K::EmbeddedEnd,
        pairs(data::EMBEDDED_END),
        "",
    );
    // SyntaxSubsetKey
    let mut l = pairs(data::MODEL_TYPES);
    l.extend(pairs(data::OPTIONS));
    ins(K::OptionKey, K::OptionKey, l, "");
    let mut l = pairs(data::MODEL_TYPES);
    l.extend(pairs(data::EXTENDABLE_KEY));
    ins(K::SolveKey, K::SolveKey, l, "");
    // AssignmentSystemData
    ins(
        K::AssignmentSystemData,
        K::AssignmentSystemData,
        pairs(data::SYSTEM_DATA),
        "",
    );
    // SyntaxSimpleKeyword
    let mut attribs = pairs(data::SYSTEM_ATTRIBUTES);
    attribs.extend(pairs(data::MODEL_TYPES));
    ins(
        K::SystemRunAttrib,
        K::SystemRunAttrib,
        attribs.clone(),
        "system.",
    );
    let mut l2 = pairs(&[SYSTEM_EMP_DATA]);
    l2.extend(
        attribs
            .iter()
            .map(|(a, b)| (format!("system.{a}"), b.clone())),
    );
    ins(K::SystemCompileAttrib, K::SystemCompileAttrib, l2, "");
    let descript: HashMap<&str, &str> = data::SYSTEM_CT_CONST_TEXT.iter().copied().collect();
    let l3: Vec<(String, String)> = data::SYSTEM_CT_CONSTANTS
        .iter()
        .map(|(name, val)| {
            let split = name.find('.').unwrap_or(name.len());
            let key = &name[..split];
            let value = format!("{key}{}", clean_chars(&name[split..]));
            (
                value,
                format!("{}: {}", descript.get(key).copied().unwrap_or(""), val),
            )
        })
        .collect();
    ins(K::SystemCompileAttribR, K::SystemCompileAttribR, l3, "");

    // Declaration flavors. Studio keys them by the index in the *unsorted* list but
    // looks them up with the index of the *sorted* DictList; the generated list is
    // already sorted so both agree. Here they are keyed by sorted position.
    let pre_tables = [
        "set",
        "parameter",
        "variable",
        "equation",
        "sets",
        "parameters",
        "variables",
        "equations",
    ];
    let decl = dicts[dict_slot(K::Declaration, K::Declaration)]
        .as_ref()
        .expect("dict");
    let decl_flavors = decl
        .iter()
        .map(|(name, _)| {
            let n = name.to_lowercase();
            if n == "table" {
                TABLE
            } else if n == "model" || n == "models" {
                MODEL
            } else if pre_tables.contains(&n.as_str()) {
                PRE_TABLE
            } else {
                0
            }
        })
        .collect();

    let solve = dicts[dict_slot(K::SolveKey, K::SolveKey)]
        .as_ref()
        .expect("dict");
    let ex = utf16("._");
    let solve_other_keys = data::EXTENDABLE_KEY
        .iter()
        .map(|(k, _)| {
            let ku = utf16(k);
            solve.find_end(&ex, &Line::new(&ku), 0, false, false).1
        })
        .collect();

    let execute_subs = data::EXECUTE.iter().map(|(k, _)| utf16(k)).collect();

    Registry {
        dicts,
        decl_flavors,
        solve_other_keys,
        execute_subs,
        sub_abort: vec![utf16("noerror")],
        sub_save: vec![utf16("keepCode")],
        sub_eval: vec![utf16("set")],
        dco: build_dco(),
    }
}

const DICT_SLOTS: usize = K::ALL.len() + 2;

/// Storage slot of the dictionary `dict` of the syntax instance `inst`
/// (Studio: `mKeywords` of each `SyntaxKeywordBase`).
fn dict_slot(inst: K, dict: K) -> usize {
    match (inst, dict) {
        (K::Declaration, K::DeclarationSetType) => K::ALL.len(),
        (K::Declaration, K::DeclarationVariableType) => K::ALL.len() + 1,
        (k, _) => k as usize,
    }
}

pub(crate) fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(build_registry)
}

impl Registry {
    fn dict(&self, inst: K, dict: K) -> &DictList {
        self.dicts[dict_slot(inst, dict)]
            .as_ref()
            .expect("keyword dictionary")
    }

    /// Resolves a [`DocRef`] to `(keyword, description)`.
    pub fn resolve_doc(&'static self, d: DocRef) -> Option<(String, &'static str)> {
        match d {
            DocRef::Dict { inst, dict, idx } => {
                let l = self.dicts.get(dict_slot(inst, dict))?.as_ref()?;
                (idx < l.count()).then(|| (l.entry(idx).to_string(), l.doc(idx)))
            }
            DocRef::Dco { idx } => Some((format!("${}", self.dco.dcos[idx]), self.dco.descr[idx])),
            DocRef::DcoEnd { idx } => Some((
                format!("${}", self.dco.end_dcos[idx]),
                self.dco.end_descr[idx],
            )),
        }
    }
}

/// `mExtraKeywordChars` of the keyword syntax instance.
fn extra_chars(kind: K) -> &'static [u16] {
    const DEF: [u16; 2] = [u('.'), u('_')];
    const SP: [u16; 3] = [u('.'), u('_'), u(' ')];
    match kind {
        K::SystemCompileAttrib | K::SystemCompileAttribR => &SP,
        _ => &DEF,
    }
}

fn find_end_kw(
    inst: K,
    dict: K,
    line: &Line,
    index: isize,
    open_end: bool,
    relax_dot: bool,
) -> (isize, usize, DocRef) {
    let (e, k) =
        registry()
            .dict(inst, dict)
            .find_end(extra_chars(inst), line, index, open_end, relax_dot);
    (e, k, DocRef::Dict { inst, dict, idx: k })
}

/// Whether a syntax is registered for this kind (`mKinds.value(kind)` non-null).
pub(crate) fn is_registered(kind: K) -> bool {
    kind != K::CommentInline
}

// ---------------------------------------------------------------------------
// nextKinds (mSubKinds / mEmptyLineKinds)
// ---------------------------------------------------------------------------

/// `SyntaxAbstract::nextKinds(emptyLine)`
pub(crate) fn next_kinds(kind: K, empty_line: bool) -> &'static [K] {
    use K::*;
    let (sub, empty): (&'static [K], &'static [K]) = match kind {
        Standard => (
            &[
                Semicolon,
                CommentLine,
                CommentEndline,
                CommentInline,
                Declaration,
                DeclarationSetType,
                DeclarationVariableType,
                Dco,
                Solve,
                Option,
                ExecuteTool,
                Execute,
                Put,
                Reserved,
                Abort,
                Embedded,
                Formula,
            ],
            &[],
        ),
        DcoBody | DcoComment | Title => (&[CommentEndline, CommentInline, DcoBody], &[]),
        IgnoredHead => (&[Dco, IgnoredHead, IgnoredBlock], &[IgnoredBlock]),
        SubDCO => (&[SubDCO, DcoBody], &[]),
        CommentBlock | IgnoredBlock => (&[Dco], &[]),
        Semicolon => (&[CommentEndline, CommentLine], &[]),
        CommaIdent => (&[CommentEndline, CommentLine, Identifier], &[]),
        Formula => (
            &[
                Embedded,
                Semicolon,
                CommentLine,
                CommentEndline,
                CommentInline,
                Solve,
                Option,
                Abort,
                ExecuteTool,
                Execute,
                Put,
                Reserved,
                Dco,
                Assignment,
                Declaration,
                DeclarationSetType,
                DeclarationVariableType,
                String,
                Formula,
            ],
            &[],
        ),
        PutFormula => (
            &[
                Embedded,
                Semicolon,
                CommentLine,
                CommentEndline,
                CommentInline,
                Solve,
                Option,
                Abort,
                ExecuteTool,
                Execute,
                Put,
                Reserved,
                Dco,
                Assignment,
                Declaration,
                DeclarationSetType,
                DeclarationVariableType,
                String,
                SystemRunAttrib,
                PutFormula,
            ],
            &[],
        ),
        SolveBody => (
            &[
                Embedded,
                Semicolon,
                CommentLine,
                CommentEndline,
                CommentInline,
                Solve,
                Option,
                Abort,
                ExecuteTool,
                Execute,
                Put,
                Reserved,
                Dco,
                Assignment,
                Declaration,
                DeclarationSetType,
                DeclarationVariableType,
                String,
                SolveKey,
                SolveBody,
            ],
            &[],
        ),
        OptionBody => (
            &[
                Embedded,
                Semicolon,
                CommentLine,
                CommentEndline,
                CommentInline,
                Solve,
                Option,
                Abort,
                ExecuteTool,
                Execute,
                Put,
                Reserved,
                Dco,
                Assignment,
                Declaration,
                DeclarationSetType,
                DeclarationVariableType,
                String,
                OptionKey,
                OptionBody,
            ],
            &[],
        ),
        ExecuteBody => (
            &[
                Embedded,
                Semicolon,
                CommentLine,
                CommentEndline,
                CommentInline,
                Solve,
                Option,
                Abort,
                ExecuteTool,
                Execute,
                Put,
                Reserved,
                Dco,
                Assignment,
                Declaration,
                DeclarationSetType,
                DeclarationVariableType,
                String,
                ExecuteBody,
            ],
            &[],
        ),
        String => (&[String], &[]),
        Declaration => (
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                Declaration,
                Identifier,
            ],
            &[],
        ),
        DeclarationSetType | DeclarationVariableType => (
            &[Declaration, Dco, CommentLine, CommentEndline, CommentInline],
            &[],
        ),
        Reserved | Abort | AbortKey | Solve | Option | Execute | ExecuteKey | ExecuteTool
        | ExecuteToolKey | Put => {
            let s: &'static [K] = match kind {
                Reserved => &[Semicolon, String, Embedded, Solve, Reserved, Abort, CommentLine,
                    CommentEndline, CommentInline, Dco, Declaration, DeclarationSetType,
                    DeclarationVariableType, Formula],
                Abort => &[Semicolon, String, Embedded, Solve, Reserved, Abort, CommentLine,
                    CommentEndline, CommentInline, Dco, Declaration, DeclarationSetType,
                    DeclarationVariableType, Abort, AbortKey, Formula],
                AbortKey => &[Semicolon, String, Embedded, Solve, Reserved, Abort, CommentLine,
                    CommentEndline, CommentInline, Dco, Declaration, DeclarationSetType,
                    DeclarationVariableType, Formula],
                Solve => &[Semicolon, String, Embedded, Solve, Reserved, Abort, CommentLine,
                    CommentEndline, CommentInline, Dco, Declaration, DeclarationSetType,
                    DeclarationVariableType, SolveKey, SolveBody],
                Option => &[Semicolon, String, Embedded, Solve, Reserved, Abort, CommentLine,
                    CommentEndline, CommentInline, Dco, Declaration, DeclarationSetType,
                    DeclarationVariableType, OptionKey, OptionBody],
                Execute => &[Semicolon, String, Embedded, Solve, Reserved, Abort, CommentLine,
                    CommentEndline, CommentInline, Dco, Declaration, DeclarationSetType,
                    DeclarationVariableType, Execute, ExecuteKey, ExecuteBody],
                ExecuteKey | ExecuteToolKey => &[Semicolon, String, Embedded, Solve, Reserved, Abort,
                    CommentLine, CommentEndline, CommentInline, Dco, Declaration, DeclarationSetType,
                    DeclarationVariableType, ExecuteBody],
                ExecuteTool => &[Semicolon, String, Embedded, Solve, Reserved, Abort, CommentLine,
                    CommentEndline, CommentInline, Dco, Declaration, DeclarationSetType,
                    DeclarationVariableType, ExecuteTool, ExecuteToolKey, ExecuteBody],
                _ /* Put */ => &[Semicolon, String, Embedded, Solve, Reserved, Abort, CommentLine,
                    CommentEndline, CommentInline, Dco, Declaration, DeclarationSetType,
                    DeclarationVariableType, PutFormula],
            };
            (s, &[])
        }
        Embedded => (&[EmbeddedBody], &[]),
        EmbeddedBody => (&[EmbeddedEnd, Dco], &[]),
        OptionKey => (
            &[
                Semicolon,
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                OptionKey,
                OptionBody,
            ],
            &[],
        ),
        SolveKey => (
            &[
                Semicolon,
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                SolveKey,
                SolveBody,
            ],
            &[],
        ),
        AssignmentSystemData => (
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierAssignmentEnd,
                IdentifierAssignment,
                AssignmentLabel,
                AssignmentValue,
            ],
            &[],
        ),
        Identifier => (
            &[
                Semicolon,
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierDim,
                IdentifierAssignment,
                IdentifierTableAssignmentColHead,
                CommaIdent,
                IdentifierDescription,
            ],
            &[
                Semicolon,
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierDim,
                IdentifierAssignment,
                IdentifierTableAssignmentColHead,
                CommaIdent,
                Identifier,
                DeclarationSetType,
                DeclarationVariableType,
                Declaration,
            ],
        ),
        IdentifierDim => (
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierDimEnd,
            ],
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierDimEnd,
            ],
        ),
        IdentifierDimEnd => (
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                CommaIdent,
                Semicolon,
                IdentifierAssignment,
                IdentifierTableAssignmentColHead,
                IdentifierDescription,
            ],
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                CommaIdent,
                Semicolon,
                IdentifierAssignment,
                IdentifierTableAssignmentColHead,
                Identifier,
                DeclarationSetType,
                DeclarationVariableType,
                Declaration,
            ],
        ),
        IdentifierDescription => (
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                CommaIdent,
                Semicolon,
                IdentifierAssignment,
            ],
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                DeclarationSetType,
                DeclarationVariableType,
                Declaration,
                IdentifierAssignment,
                IdentifierTableAssignmentColHead,
                Identifier,
            ],
        ),
        IdentifierAssignment => (
            &[
                Semicolon,
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierAssignmentEnd,
                AssignmentSystemData,
                AssignmentLabel,
            ],
            &[],
        ),
        // `mEmptyLineKinds = mSubKinds << SyntaxKind::Identifier;` appends to both lists
        IdentifierAssignmentEnd => (
            &[
                Semicolon,
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                CommaIdent,
                Identifier,
            ],
            &[],
        ),
        AssignmentLabel => (
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierAssignmentEnd,
                IdentifierAssignment,
                AssignmentSystemData,
                AssignmentLabel,
                AssignmentValue,
            ],
            &[],
        ),
        AssignmentValue => (
            &[
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierAssignment,
                IdentifierAssignmentEnd,
            ],
            &[],
        ),
        IdentifierTableAssignmentColHead => (
            &[
                Semicolon,
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierTableAssignmentRowHead,
            ],
            &[],
        ),
        IdentifierTableAssignmentRowHead | IdentifierTableAssignmentRow => (
            &[
                Semicolon,
                Dco,
                CommentLine,
                CommentEndline,
                CommentInline,
                IdentifierTableAssignmentColHead,
                IdentifierTableAssignmentRowHead,
                IdentifierTableAssignmentRow,
            ],
            &[],
        ),
        Dco | CommentLine | CommentEndline | CommentInline | Assignment | EmbeddedEnd
        | SystemRunAttrib | SystemCompileAttrib | SystemCompileAttribR | UserCompileAttrib => {
            (&[], &[])
        }
    };
    if empty_line && !empty.is_empty() {
        empty
    } else {
        sub
    }
}

// ---------------------------------------------------------------------------
// find / validTail dispatch
// ---------------------------------------------------------------------------

/// `SyntaxAbstract::find(entryKind, state, line, index)` of the syntax for `kind`.
pub(crate) fn find(
    kind: K,
    entry: K,
    state: &SyntaxState,
    line: &Line,
    index: isize,
    eol: &mut EolState,
) -> Block {
    match kind {
        K::Standard => standard_find(entry, state, line, index),
        K::Dco => dco_find(entry, state, line, index, eol),
        K::DcoBody | K::DcoComment | K::Title | K::IgnoredHead => {
            dco_body_find(kind, entry, state, line, index, eol)
        }
        K::SubDCO => sub_dco_find(state, line, index),
        K::Formula | K::PutFormula | K::SolveBody | K::OptionBody | K::ExecuteBody => {
            formula_find(kind, entry, state, line, index, eol)
        }
        K::SystemRunAttrib | K::SystemCompileAttrib | K::SystemCompileAttribR => {
            simple_keyword_find(kind, state, line, index)
        }
        K::UserCompileAttrib => simple_word_find(state, line, index),
        K::Assignment => assign_find(state, line, index),
        K::String => quoted_find(entry, state, line, index),
        K::CommentLine => comment_line_find(entry, state, line, index),
        K::CommentBlock | K::IgnoredBlock => Block::new(kind, state, index, line.len()),
        K::CommentEndline => comment_endline_find(state, line, index, eol),
        K::Reserved
        | K::Abort
        | K::AbortKey
        | K::Solve
        | K::Option
        | K::Execute
        | K::ExecuteKey
        | K::ExecuteTool
        | K::ExecuteToolKey
        | K::Put => reserved_find(kind, entry, state, line, index),
        K::SolveKey | K::OptionKey => subset_key_find(kind, state, line, index),
        K::Semicolon | K::CommaIdent => delimiter_find(kind, state, line, index),
        K::Embedded | K::EmbeddedEnd => embedded_find(kind, state, line, index),
        K::EmbeddedBody => Block::new(kind, state, index, line.len()),
        K::DeclarationSetType | K::DeclarationVariableType => {
            pre_declaration_find(kind, entry, state, line, index)
        }
        K::Declaration => declaration_find(entry, state, line, index),
        K::Identifier => identifier_find(state, line, index),
        K::IdentifierDim => identifier_dim_find(state, line, index),
        K::IdentifierDimEnd => identifier_dim_end_find(state, line, index),
        K::IdentifierDescription => ident_descript_find(entry, state, line, index),
        K::IdentifierAssignment | K::IdentifierAssignmentEnd => {
            ident_assign_find(kind, entry, state, line, index)
        }
        K::AssignmentLabel => assignment_label_find(entry, state, line, index),
        K::AssignmentValue => assignment_value_find(state, line, index),
        K::AssignmentSystemData => assignment_system_data_find(state, line, index),
        K::IdentifierTableAssignmentColHead
        | K::IdentifierTableAssignmentRowHead
        | K::IdentifierTableAssignmentRow => {
            table_assign_find(kind, entry, state, line, index, eol)
        }
        K::CommentInline => Block::none(),
    }
}

/// `SyntaxAbstract::validTail(line, index, state, hasContent)` of the syntax for `kind`.
pub(crate) fn valid_tail(
    kind: K,
    line: &Line,
    index: isize,
    state: &SyntaxState,
    has_content: &mut bool,
    eol: &EolState,
) -> Block {
    match kind {
        K::Standard => Block::none(),
        K::Dco => {
            // SyntaxDco::validTail
            let mut end = index;
            if state.flavor < ABORT || state.flavor > EVAL {
                while line.white(end) {
                    end += 1;
                }
            }
            *has_content = false;
            let shift = if line.len() == end {
                Shift::Skip
            } else {
                Shift::In
            };
            Block::new(kind, state, index, end).shift(shift)
        }
        K::DcoBody | K::DcoComment | K::Title | K::IgnoredHead => {
            let chars = eol.dco_body_chars();
            let mut start = index;
            while line.white(start) {
                start += 1;
            }
            let mut end = start;
            while end < line.len() && !chars.contains(&line.at(end)) {
                end += 1;
            }
            *has_content = end > start;
            Block::new(kind, state, start, end)
        }
        K::SubDCO => {
            *has_content = false;
            let mut end = index;
            while line.white(end) {
                end += 1;
            }
            if end >= index && end < line.len() - 1 {
                return Block::new(kind, state, index, end).into_kind(K::DcoBody);
            }
            if end > index {
                return Block::new(kind, state, index, end).shift(Shift::Out);
            }
            Block::none()
        }
        K::Formula | K::PutFormula | K::SolveBody | K::OptionBody | K::ExecuteBody => {
            let mut end = index;
            while line.white(end) {
                end += 1;
            }
            if end >= line.len() {
                return if end > index {
                    Block::new(kind, state, index, end)
                } else {
                    Block::none()
                };
            }
            let (sp, n) = eol.formula_specials(kind);
            let sp = &sp[..n];
            let mut prev = 0;
            let cb1 = char_class(line.at(end), &mut prev, sp);
            loop {
                end += 1;
                if !(end < line.len() && char_class(line.at(end), &mut prev, sp) == cb1) {
                    break;
                }
            }
            *has_content = false;
            Block::new(kind, state, index, end)
        }
        K::CommentLine => {
            let mut end = index;
            while line.white(end) {
                end += 1;
            }
            *has_content = end < line.len();
            Block::new(kind, state, index, line.len()).shift(Shift::Out)
        }
        K::CommentBlock | K::IgnoredBlock => {
            let mut end = index;
            while line.white(end) {
                end += 1;
            }
            *has_content = end < line.len();
            Block::new(kind, state, index, line.len())
        }
        K::Semicolon | K::CommaIdent => {
            *has_content = false;
            let mut end = index;
            while line.white(end) {
                end += 1;
            }
            let b = Block::new(kind, state, index, end);
            if kind == K::Semicolon {
                b.shift(Shift::Reset)
            } else {
                b
            }
        }
        K::EmbeddedBody => Block::new(kind, state, index, line.len()),
        K::String
        | K::Assignment
        | K::CommentEndline
        | K::SystemRunAttrib
        | K::SystemCompileAttrib
        | K::SystemCompileAttribR
        | K::AssignmentSystemData
        | K::UserCompileAttrib
        | K::CommentInline => Block::none(),
        // SyntaxKeywordBase::validTail (also SyntaxSubsetKey)
        K::Declaration
        | K::DeclarationSetType
        | K::DeclarationVariableType
        | K::Reserved
        | K::Abort
        | K::AbortKey
        | K::Solve
        | K::Option
        | K::Execute
        | K::ExecuteKey
        | K::ExecuteTool
        | K::ExecuteToolKey
        | K::Put
        | K::Embedded
        | K::EmbeddedEnd
        | K::SolveKey
        | K::OptionKey => {
            *has_content = false;
            let mut end = index;
            while line.white(end) {
                end += 1;
            }
            Block::new(kind, state, index, end)
        }
        K::Identifier => {
            let mut start = index;
            while line.white(start) {
                start += 1;
            }
            *has_content = false;
            Block::new(kind, state, index, start)
        }
        K::IdentifierDim => {
            let closer = if state.flavor & QUOTE_PART == BRACE {
                u(']')
            } else {
                u(')')
            };
            const DELIMS: [u16; 4] = [u('('), u('['), u(')'), u(']')];
            let mut end = index - 1;
            // inside valid identifier dimension
            loop {
                end += 1;
                if end >= line.len() {
                    break;
                }
                let c = line.at(end);
                end -= 1;
                if c == closer {
                    break;
                }
                end += 1;
                if DELIMS.contains(&line.at(end)) {
                    return Block::new(kind, state, index, end)
                        .shift(Shift::Out)
                        .error(true);
                }
            }
            *has_content = index < end;
            Block::new(kind, state, index, end + 1)
        }
        K::IdentifierDimEnd
        | K::IdentifierDescription
        | K::AssignmentLabel
        | K::AssignmentValue => {
            let mut end = index;
            while line.white(end) {
                end += 1;
            }
            *has_content = false;
            Block::new(kind, state, index, end)
        }
        K::IdentifierAssignment | K::IdentifierAssignmentEnd => {
            let delims: &[u16] = if state.flavor & MODEL != 0 {
                &[u(','), u('+'), u('-')]
            } else {
                &[u(',')]
            };
            let mut start = index;
            while line.white(start) {
                start += 1;
            }
            let mut end = if line.len() > start { start + 1 } else { start };
            while line.white(end) || (line.len() > end && delims.contains(&line.at(end))) {
                end += 1;
            }
            *has_content = end > start;
            Block::new(kind, state, index, end)
        }
        K::IdentifierTableAssignmentColHead
        | K::IdentifierTableAssignmentRowHead
        | K::IdentifierTableAssignmentRow => {
            let mut end = index;
            while end < line.len() && line.at(end) != u(';') && !eol.check_endline(line, end) {
                end += 1;
            }
            Block::new(kind, state, index, end)
        }
    }
}

// ---------------------------------------------------------------------------
// syntaxformats.cpp
// ---------------------------------------------------------------------------

fn standard_find(entry: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    let error = matches!(
        entry,
        K::Declaration | K::DeclarationSetType | K::DeclarationVariableType
    );
    let mut end = index;
    while line.kw(end) {
        end += 1;
    }
    while !line.kw(end) && end < line.len() {
        end += 1;
    }
    Block::new(K::Standard, state, index, end).error(error)
}

/// `SyntaxAbstract::convertAndCompareSuffix`
fn convert_and_compare_suffix(suffix: &mut Vec<u16>, out_type: u16, out_name: &[u16]) -> bool {
    // No suffix-block active
    if suffix.is_empty() {
        if is_lower(out_type) {
            return false;
        }
        suffix.clear();
        suffix.push(to_lower(out_type));
        suffix.extend_from_slice(out_name);
        return true;
    }
    // Active suffix-block
    if is_upper(out_type) {
        return false;
    }
    let mut cmp = vec![out_type];
    cmp.extend_from_slice(out_name);
    if !eq_ci(suffix, &cmp) {
        return false;
    }
    suffix.clear();
    true
}

/// `SyntaxAbstract::hasMatchingSuffix`. `type_char == 0` is a null `QChar`.
fn has_matching_suffix(
    type_char: u16,
    state: &mut SyntaxState,
    line: &Line,
    pos: &mut isize,
    suffix: &mut Vec<u16>,
) -> bool {
    let mut name: &[u16] = &[];
    if *pos + 1 < line.len() && line.at(*pos) == u('.') && is_letter(line.at(*pos + 1)) {
        *pos += 1;
        let name_start = *pos;
        loop {
            *pos += 1;
            if !(*pos < line.len() && is_keyword_char(line.at(*pos), &[u('_')])) {
                break;
            }
        }
        name = line.slice(name_start, *pos);
    }
    if !convert_and_compare_suffix(suffix, type_char, name) {
        return false;
    }
    if is_lower(type_char) {
        state.suffix = None;
    } else {
        state.suffix = Some(suffix.clone());
    }
    true
}

fn dco_find(entry: K, state: &SyntaxState, line: &Line, index: isize, eol: &mut EolState) -> Block {
    let reg = registry();
    let Some(m) = line.dco_match(index) else {
        return Block::none();
    };
    let name = line.slice(m.name_start, m.name_end);
    let name_low = lower_string(name);
    let mut out = state.clone();
    out.flavor = reg.dco.flavors.get(&name_low).copied().unwrap_or(0);
    let flav_char: u16 = if (ECHO1..=PUT0).contains(&out.flavor) {
        FLAVOR_CHARS[(out.flavor - 1) as usize] as u16
    } else if out.flavor == EMBED1 {
        u('M')
    } else if out.flavor == EMBED0 {
        u('m')
    } else {
        0
    };
    let last_end_ikey: isize = reg
        .dco
        .end_low
        .iter()
        .position(|s| *s == name_low)
        .map(|p| p as isize)
        .unwrap_or(-1);
    let mut end = m.name_end;
    let end_doc = (last_end_ikey >= 0).then_some(DocRef::DcoEnd {
        idx: last_end_ikey as usize,
    });
    let state_suffix = || state.suffix.clone().unwrap_or_default();

    if entry == K::CommentBlock {
        if last_end_ikey == 0 {
            return Block::new(K::Dco, &out, m.g1_start, m.name_end)
                .shift(Shift::Out)
                .doc(end_doc);
        }
        return Block::none();
    } else if entry == K::IgnoredBlock || entry == K::IgnoredHead {
        let mut suffix = state_suffix();
        if state.flavor == ECHO1
            && out.flavor == ECHO0
            && has_matching_suffix(flav_char, &mut out, line, &mut end, &mut suffix)
        {
            return Block::new(K::Dco, &out, m.g1_start, end).shift(Shift::Out);
        }
        if state.flavor == PUT1
            && last_end_ikey == 1
            && has_matching_suffix(flav_char, &mut out, line, &mut end, &mut suffix)
        {
            return Block::new(K::Dco, &out, m.g1_start, end)
                .shift(Shift::Out)
                .doc(end_doc);
        }
        return Block::none();
    } else if entry == K::EmbeddedBody {
        let mut suffix = state_suffix();
        if last_end_ikey > 1
            && has_matching_suffix(flav_char, &mut out, line, &mut end, &mut suffix)
        {
            return Block::new(K::Dco, &out, m.g1_start, end)
                .shift(Shift::Out)
                .doc(end_doc);
        }
        return Block::none();
    } else {
        // side effect on the shared eol-comment configuration
        if name_low.starts_with("oneolcom") {
            // This only activates the current eolCom
            eol.dyn_char = Some(u('!'));
        } else if name_low.starts_with("eolcom") {
            let mut i = m.name_end;
            while line.white(i) {
                i += 1;
            }
            let mut com_size = 2;
            if i + 1 == line.len() || line.white(i + 1) {
                com_size = 1;
            }
            if i + com_size <= line.len() {
                eol.endline = line.slice(i, i + com_size).to_vec();
                eol.dyn_char = Some(line.at(i));
            }
        }
    }
    let mut next = reg
        .dco
        .special
        .get(&name_low)
        .copied()
        .unwrap_or(K::DcoBody);
    let last_ikey = reg.dco.dco_low.iter().position(|s| *s == name_low);
    if let Some(ik) = last_ikey {
        if flav_char != 0 {
            let mut suffix = state_suffix();
            if !has_matching_suffix(flav_char, &mut out, line, &mut end, &mut suffix) {
                return Block::none();
            }
        }
        let at_end = m.name_end >= line.len();
        if next == K::IgnoredHead && at_end {
            next = K::IgnoredBlock;
        }
        let multi = matches!(next, K::CommentBlock | K::IgnoredBlock | K::EmbeddedBody);
        let shift = if at_end && !multi {
            Shift::Skip
        } else {
            Shift::In
        };
        Block::new(K::Dco, &out, m.g1_start, end)
            .shift(shift)
            .next(next)
            .doc(Some(DocRef::Dco { idx: ik }))
    } else {
        Block::new(K::Dco, &out, m.g1_start, end)
            .into_kind(next)
            .error(true)
            .doc(end_doc)
    }
}

fn dco_body_find(
    kind: K,
    entry: K,
    state: &SyntaxState,
    line: &Line,
    index: isize,
    eol: &EolState,
) -> Block {
    let chars = eol.dco_body_chars();
    let mut end = index;
    if index == 0 && entry == K::IgnoredHead {
        return Block::none();
    }
    if entry == K::DcoBody && end < line.len() && chars.contains(&line.at(end)) {
        end += 1;
    }
    while end < line.len() && !chars.contains(&line.at(end)) {
        end += 1;
    }
    Block::new(kind, state, index, end)
}

fn comment_line_find(entry: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    if entry == K::CommentLine || (index == 0 && line.at(0) == u('*') && line.len() > 0) {
        return Block::new(K::CommentLine, state, index, line.len()).shift(Shift::Skip);
    }
    Block::none()
}

fn comment_endline_find(state: &SyntaxState, line: &Line, index: isize, eol: &EolState) -> Block {
    let cs = &eol.endline;
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if start + cs.len() as isize <= line.len()
        && line.at(start) == cs[0]
        && (cs.len() == 1 || line.at(start + 1) == cs[1])
    {
        return Block::new(K::CommentEndline, state, start, line.len()).shift(Shift::Skip);
    }
    Block::none()
}

fn sub_dco_find(state: &SyntaxState, line: &Line, index: isize) -> Block {
    let reg = registry();
    let mut start = index;
    if start < line.len() && line.at(start) == u('.') {
        start += 1;
    }
    let subs: &[Vec<u16>] = match state.flavor {
        ABORT => &reg.sub_abort,
        CALL => &reg.execute_subs,
        SAVE => &reg.sub_save,
        EVAL => &reg.sub_eval,
        _ => &[],
    };
    for sub in subs.iter().rev() {
        let sl = sub.len() as isize;
        if line.len() >= start + sl
            && eq_ci(sub, line.slice(start, start + sl))
            && (line.len() == start + sl || !is_letter_or_number(line.at(start + sl)))
        {
            let shift = if line.len() == start + sl {
                Shift::Skip
            } else {
                Shift::Shift
            };
            return Block::new(K::SubDCO, state, index, start + sl).shift(shift);
        }
    }
    Block::none()
}

fn delimiter_find(kind: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    let delim = if kind == K::Semicolon { u(';') } else { u(',') };
    let mut end = index;
    while line.white(end) {
        end += 1;
    }
    if end < line.len() && line.at(end) == delim {
        let b = Block::new(kind, state, index, end + 1);
        return if kind == K::Semicolon {
            b.shift(Shift::Reset)
        } else {
            b
        };
    }
    Block::none()
}

fn formula_find(
    kind: K,
    entry: K,
    state: &SyntaxState,
    line: &Line,
    index: isize,
    eol: &EolState,
) -> Block {
    let mut st = state.clone();
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if start >= line.len() {
        return Block::none();
    }
    let cc = eol.dco_body_chars();
    if start + (cc.len() as isize) < line.len() {
        for (i, c) in cc.iter().enumerate() {
            if line.at(start + i as isize) != *c {
                break;
            }
            if i + 1 == cc.len() {
                return Block::none();
            }
        }
    }
    if kind == K::ExecuteBody || st.flavor & ABORT_CMD != 0 {
        if matches!(entry, K::Abort | K::Execute | K::ExecuteTool) {
            if st.flavor % 2 == 0 && start < line.len() && line.at(start) == u('.') {
                st.flavor += 1;
            }
        } else if st.flavor % 2 != 0 {
            st.flavor -= 1;
        }
    }
    let (sp, n) = eol.formula_specials(kind);
    let sp = &sp[..n];
    let mut prev = 0;
    let mut end = start;
    let mut ch_kind = char_class(line.at(end), &mut prev, sp);
    if start > index && ch_kind == CC_ALPHA {
        return Block::new(kind, &st, index, start);
    }
    let mut skip_word = ch_kind == CC_ALPHA;
    if ch_kind == CC_SPECIAL {
        end -= 1;
    }
    loop {
        end += 1;
        if end >= line.len() {
            break;
        }
        let c = line.at(end);
        ch_kind = char_class(c, &mut prev, sp);
        if st.flavor % 2 != 0 && (c == u(' ') || c == u('\t')) {
            break;
        }
        if ch_kind == CC_SPECIAL {
            break;
        }
        if ch_kind != CC_ALPHA {
            skip_word = false;
        } else if !skip_word {
            break;
        }
    }
    Block::new(kind, &st, index, end)
}

fn quoted_find(entry: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    const DELIMS: [u16; 3] = [u(' '), u('\''), u('"')];
    let mut st = state.clone();
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    let mut end = start;
    if st.flavor & QUOTE_PART == 0 {
        match DELIMS.iter().position(|d| *d == line.at(start)) {
            Some(p) if p > 0 && start < line.len() => st.flavor += p as i32,
            _ => return Block::none(),
        }
    }
    // Studio would index past the 3-char delimiter string for flavor&3 == 3;
    // such a delimiter never matches here.
    let qi = (st.flavor & QUOTE_PART) as usize;
    let delim = DELIMS.get(qi).copied();
    loop {
        end += 1;
        if !(end < line.len() && Some(line.at(end)) != delim) {
            break;
        }
    }
    if end < line.len() {
        let shift = if entry == K::String {
            Shift::Out
        } else {
            Shift::Skip
        };
        return Block::new(K::String, &st, start, end + 1).shift(shift);
    }
    Block::none()
}

fn assign_find(state: &SyntaxState, line: &Line, index: isize) -> Block {
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if start >= line.len() {
        return Block::none();
    }
    let b = |s, e| Block::new(K::Assignment, state, s, e).shift(Shift::Skip);
    if line.at(start) == u('.') {
        if line.len() > start + 1 && line.at(start + 1) == u('.') {
            return b(start, start + 2);
        }
    } else if line.at(start) == u('=') {
        if start + 1 >= line.len() {
            return b(start, start + 1);
        }
        if line.at(start + 1) == u('=') {
            return b(start, start + 2);
        }
        if start + 2 >= line.len() || line.at(start + 2) != u('=') {
            return b(start, start + 1);
        }
        let c = to_lower(line.at(start + 1));
        let error = !"eglnxcb".encode_utf16().any(|x| x == c);
        return b(start, start + 3).error(error);
    }
    Block::none()
}

// ---------------------------------------------------------------------------
// syntaxdeclaration.cpp
// ---------------------------------------------------------------------------

fn declaration_find(entry: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    let reg = registry();
    let fl = |k: usize| reg.decl_flavors.get(k).copied().unwrap_or(0);
    let mut st = state.clone();
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if entry == K::DeclarationSetType || entry == K::DeclarationVariableType {
        // search for kind-valid declaration keyword
        let (end, ik, doc) = find_end_kw(K::Declaration, entry, line, start, false, false);
        if entry != K::DeclarationSetType {
            // Studio quirk: iKey of the {"Variable","Variables"} list is used as index
            // into the declaration flavors (yields 0 for the current data).
            st.flavor |= fl(ik);
        }
        if end > start {
            return Block::new(K::Declaration, &st, start, end).doc(Some(doc));
        }
        // search for invalid new declaration keyword
        let (end, _, doc) = find_end_kw(K::Declaration, K::Declaration, line, start, false, false);
        if end > start {
            return Block::new(K::Declaration, &st, start, end)
                .error(true)
                .shift(Shift::Reset)
                .doc(Some(doc));
        }
        return Block::none();
    }
    let (end, ik, doc) = find_end_kw(K::Declaration, K::Declaration, line, start, false, false);
    if end > start {
        st.flavor |= fl(ik);
        if entry == K::Declaration {
            if st.flavor & PRE_TABLE != 0 && fl(ik) == TABLE {
                st.flavor -= PRE_TABLE;
                return Block::new(K::Declaration, &st, start, end)
                    .next(K::Declaration)
                    .doc(Some(doc));
            }
            return Block::new(K::Declaration, &st, start, end)
                .error(true)
                .shift(Shift::Reset)
                .doc(Some(doc));
        }
        return Block::new(K::Declaration, &st, start, end)
            .into_kind(K::Declaration)
            .doc(Some(doc));
    }
    Block::none()
}

fn pre_declaration_find(
    kind: K,
    entry: K,
    state: &SyntaxState,
    line: &Line,
    index: isize,
) -> Block {
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    let (end, _, doc) = find_end_kw(kind, kind, line, start, false, false);
    if end > start {
        if matches!(
            entry,
            K::DeclarationSetType | K::DeclarationVariableType | K::Declaration
        ) {
            return Block::new(kind, state, start, end)
                .error(true)
                .shift(Shift::Reset)
                .doc(Some(doc));
        }
        return Block::new(kind, state, start, end)
            .into_kind(kind)
            .doc(Some(doc));
    } else if entry == kind {
        return Block::new(kind, state, index, start);
    }
    Block::none()
}

fn reserved_find(kind: K, entry: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    let mut st = state.clone();
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if entry == kind && start > index {
        return Block::new(kind, &st, index, start);
    }
    if matches!(kind, K::Abort | K::AbortKey) && st.flavor & ABORT_CMD == 0 {
        st.flavor += ABORT_CMD;
    }
    let exec_like = matches!(kind, K::Abort | K::Execute | K::ExecuteTool);
    if exec_like && entry == kind && st.flavor & EXEC_DOT == 0 {
        if start < line.len() && line.at(start) == u('.') {
            let mut end = start + 1;
            while line.white(end) {
                end += 1;
            }
            st.flavor += EXEC_DOT;
            return Block::new(kind, &st, index, end);
        }
        return Block::none();
    }
    let key_kind = matches!(kind, K::AbortKey | K::ExecuteKey | K::ExecuteToolKey);
    if !key_kind && st.flavor & EXEC_DOT != 0 {
        return Block::none();
    }
    let (mut end, _, doc) = find_end_kw(kind, kind, line, start, exec_like, false);
    let doc = Some(doc);
    if end > start {
        match kind {
            K::Reserved => {
                return Block::new(kind, &st, start, end)
                    .into_kind(K::Formula)
                    .doc(doc)
            }
            K::Solve => {
                return Block::new(kind, &st, start, end)
                    .into_kind(K::SolveBody)
                    .doc(doc)
            }
            K::Option => {
                return Block::new(kind, &st, start, end)
                    .into_kind(K::OptionBody)
                    .doc(doc)
            }
            K::Put => {
                return Block::new(kind, &st, start, end)
                    .into_kind(K::PutFormula)
                    .doc(doc)
            }
            K::Abort | K::Execute | K::ExecuteTool => {
                while line.white(end) {
                    end += 1;
                }
                if end == line.len() || line.at(end) != u('_') {
                    return Block::new(kind, &st, start, end).doc(doc);
                }
            }
            K::AbortKey | K::ExecuteKey | K::ExecuteToolKey
                if matches!(entry, K::Abort | K::Execute | K::ExecuteTool)
                    && st.flavor & EXEC_DOT != 0 =>
            {
                st.flavor -= EXEC_DOT;
                return Block::new(kind, &st, index, end).doc(doc);
            }
            _ => {}
        }
    }
    Block::none()
}

fn embedded_find(kind: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    let mut st = state.clone();
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    let (mut end, _, doc) = find_end_kw(kind, kind, line, start, true, false);
    if end > start {
        let kind_shift = if kind == K::EmbeddedEnd {
            Shift::Out
        } else {
            Shift::In
        };
        let mut suffix = st.suffix.clone().unwrap_or_default();
        let in_type = if kind == K::Embedded { u('E') } else { u('e') };
        if has_matching_suffix(in_type, &mut st, line, &mut end, &mut suffix) {
            return Block::new(kind, &st, start, end)
                .shift(kind_shift)
                .next(kind)
                .doc(Some(doc));
        }
    }
    Block::none()
}

fn subset_key_find(kind: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    let reg = registry();
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if start >= line.len() {
        return Block::none();
    }
    let (mut end, ik, doc) = find_end_kw(kind, kind, line, start, kind == K::SolveKey, false);
    if kind == K::SolveKey && end >= 0 && end < line.len() {
        let mut prev = CC_ALPHA;
        if !reg.solve_other_keys.contains(&ik)
            && char_class(line.at(end), &mut prev, &[]) == CC_ALPHA
        {
            end = -1;
        } else {
            while end < line.len() && char_class(line.at(end), &mut prev, &[]) == CC_ALPHA {
                end += 1;
            }
        }
    }
    if end > start {
        return Block::new(kind, state, start, end)
            .next(kind)
            .doc(Some(doc));
    }
    Block::none()
}

fn assignment_system_data_find(state: &SyntaxState, line: &Line, index: isize) -> Block {
    let mut st = state.clone();
    let sys = utf16("system.");
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    // always starts with "system."
    if line.len() < start + sys.len() as isize {
        return Block::none();
    }
    for (i, c) in sys.iter().enumerate() {
        if *c != to_lower(line.at(start + i as isize)) {
            return Block::none();
        }
    }
    start += sys.len() as isize;
    // look for system-data keyword
    let (end, _, doc) = find_end_kw(
        K::AssignmentSystemData,
        K::AssignmentSystemData,
        line,
        start,
        false,
        false,
    );
    if end > start {
        if st.flavor & BIND_LABEL != 0 {
            st.flavor -= BIND_LABEL;
        }
        return Block::new(K::AssignmentSystemData, &st, index, end)
            .next(K::AssignmentSystemData)
            .doc(Some(doc));
    }
    Block::none()
}

fn simple_keyword_find(kind: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    let compile = matches!(kind, K::SystemCompileAttrib | K::SystemCompileAttribR);
    let mut start = index;
    if compile {
        if start + 1 >= line.len() || line.at(start) != u('%') {
            return Block::none();
        }
        start += 1;
    }
    let (mut end, _, doc) = find_end_kw(
        kind,
        kind,
        line,
        start,
        false,
        kind == K::SystemCompileAttribR,
    );
    if end > start {
        if compile {
            if end >= line.len() || line.at(end) != u('%') {
                return Block::none();
            }
            start -= 1;
            end += 1;
        }
        return Block::new(kind, state, start, end)
            .shift(Shift::Skip)
            .doc(Some(doc));
    }
    Block::none()
}

// ---------------------------------------------------------------------------
// syntaxidentifier.cpp
// ---------------------------------------------------------------------------

/// `SyntaxIdentifier::identChar`
fn ident_char(c: u16) -> i32 {
    if (u('A')..=u('z')).contains(&c) && (c >= u('a') || c <= u('Z')) {
        return 2; // valid start identifier letter
    }
    if (u('0')..=u('9')).contains(&c) || c == u('_') {
        return 1; // valid next identifier letter
    }
    0
}

fn identifier_find(state: &SyntaxState, line: &Line, index: isize) -> Block {
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if start >= line.len() {
        return Block::none();
    }
    let mut end = start;
    let c = line.at(end);
    end += 1;
    if ident_char(c) != 2 {
        return Block::none();
    }
    while end < line.len() {
        let c = line.at(end);
        end += 1;
        if ident_char(c) == 0 {
            return Block::new(K::Identifier, state, start, end - 1);
        }
    }
    Block::new(K::Identifier, state, start, end)
}

fn identifier_dim_find(state: &SyntaxState, line: &Line, index: isize) -> Block {
    let mut st = state.clone();
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if start >= line.len() {
        return Block::none();
    }
    if line.at(start) == u('(') {
        return Block::new(K::IdentifierDim, &st, start, start + 1);
    }
    if line.at(start) == u('[') {
        st.flavor += BRACE;
        return Block::new(K::IdentifierDim, &st, start, start + 1);
    }
    Block::none()
}

fn identifier_dim_end_find(state: &SyntaxState, line: &Line, index: isize) -> Block {
    let mut st = state.clone();
    let brace = st.flavor & QUOTE_PART == BRACE;
    let closer = if brace { u(']') } else { u(')') };
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if start >= line.len() || line.at(start) != closer {
        return Block::none();
    }
    if brace {
        st.flavor -= BRACE;
    }
    Block::new(K::IdentifierDimEnd, &st, index, (start + 1).min(line.len()))
}

fn ident_descript_find(entry: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    if index == 0 {
        return Block::none();
    }
    if entry != K::Identifier && entry != K::IdentifierDimEnd {
        return Block::none();
    }
    let invalid_first = [u('/'), u('('), u('['), u(';')];
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if start >= line.len() || invalid_first.contains(&line.at(start)) {
        return Block::none();
    }
    let mut delim = line.at(start);
    if delim != u('"') && delim != u('\'') {
        delim = u('/');
    }
    let mut end = start;
    let mut last_non_white = start;
    loop {
        end += 1;
        if end >= line.len() {
            break;
        }
        let c = line.at(end);
        if c == delim {
            let e = end + if delim == u('/') { 0 } else { 1 };
            return Block::new(K::IdentifierDescription, state, start, e);
        }
        if delim == u('/') && (c == u(';') || c == u(',')) {
            break;
        }
        if !line.white(end) {
            last_non_white = end;
        }
    }
    Block::new(K::IdentifierDescription, state, start, last_non_white + 1).error(delim != u('/'))
}

fn ident_assign_find(kind: K, entry: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    if state.flavor & TABLE != 0 {
        return Block::none();
    }
    let mut end = index;
    let inside = kind != K::IdentifierAssignmentEnd
        && matches!(
            entry,
            K::AssignmentLabel | K::AssignmentValue | K::AssignmentSystemData
        );
    let delims: &[u16] = if inside {
        if state.flavor & MODEL != 0 {
            &[u(','), u('+'), u('-')]
        } else {
            &[u(',')]
        }
    } else {
        &[u('/')]
    };
    while line.white(end) {
        end += 1;
    }
    if end < line.len() && delims.contains(&line.at(end)) {
        end += 1;
        return Block::new(kind, state, index, end);
    }
    Block::none()
}

/// `SyntaxAbstract::endOfQuotes`
fn end_of_quotes(line: &Line, start: isize) -> isize {
    if start > line.len() {
        return start;
    }
    let ch = line.at(start);
    if ch != u('"') && ch != u('\'') {
        return start; // no start character
    }
    let mut i = start + 1;
    while i < line.len() {
        if line.at(i) == ch {
            return i;
        }
        i += 1;
    }
    line.len()
}

/// `SyntaxAbstract::endOfParentheses` with validPairs "()[]"
fn end_of_parentheses(line: &Line, start: isize, nest: &mut i32) -> isize {
    const PAIRS: [u16; 4] = [u('('), u(')'), u('['), u(']')];
    if start > line.len() {
        return start;
    }
    let ch = line.at(start);
    match PAIRS.iter().position(|p| *p == ch) {
        Some(p) if p % 2 == 0 => {}
        _ => return start, // no start character
    }
    let mut i = start + 1;
    while i < line.len() {
        if let Some(p) = PAIRS.iter().position(|q| *q == line.at(i)) {
            if p % 2 == 1 {
                *nest -= 1;
            } else {
                *nest += 1;
            }
            if *nest == 0 {
                return i;
            }
        }
        i += 1;
    }
    line.len()
}

fn assignment_label_find(entry: K, state: &SyntaxState, line: &Line, index: isize) -> Block {
    let mut st = state.clone();
    if st.flavor & TABLE != 0 {
        return Block::none();
    }
    let mut start = index;
    while line.white(start) {
        start += 1;
    }
    if start >= line.len() {
        return Block::none();
    }
    if matches!(entry, K::AssignmentLabel | K::AssignmentSystemData)
        && index != 0
        && st.flavor & BIND_LABEL == 0
    {
        return Block::none();
    }
    let mut nesting = 0; // (JM) Best, if we can get nesting from prev line
    let is_quote = |c: u16| c == u('\'') || c == u('"');
    let is_extender = |c: u16| c == u('.') || c == u(':') || c == u('*');
    let model = st.flavor & MODEL != 0;
    let is_ender = |c: u16| c == u('/') || c == u(',') || (model && (c == u('+') || c == u('-')));
    let mut end = start;
    let mut extended = false;
    if st.flavor & BIND_LABEL != 0 {
        extended = true;
        st.flavor -= BIND_LABEL;
    }
    let mut pos = start;
    while pos < line.len() {
        let c = line.at(pos);
        if is_extender(c) {
            while line.white(pos + 1) {
                pos += 1;
            }
            if line.at(pos) == u('*') {
                extended = true;
            } else {
                st.flavor |= BIND_LABEL;
                return Block::new(K::AssignmentLabel, &st, index, pos + 1);
            }
        } else {
            if is_quote(c) {
                pos = end_of_quotes(line, pos);
                if pos < start {
                    return Block::none();
                }
            } else if c == u('(') || c == u('[') {
                nesting += 1;
                pos = end_of_parentheses(line, pos, &mut nesting);
                if pos <= start {
                    pos = line.len() - 1; // wrong_nesting
                }
            } else if line.white(pos) {
                while line.white(pos + 1) {
                    pos += 1;
                }
                if !extended && pos + 1 < line.len() && !is_extender(line.at(pos + 1)) {
                    return Block::new(K::AssignmentLabel, &st, index, pos);
                }
            } else if is_ender(c) {
                return Block::new(K::AssignmentLabel, &st, index, pos);
            }
            extended = false;
        }
        end = pos + 1;
        pos += 1;
    }
    if end > index {
        return Block::new(K::AssignmentLabel, &st, index, end);
    }
    Block::none()
}

fn assignment_value_find(state: &SyntaxState, line: &Line, index: isize) -> Block {
    if state.flavor & TABLE != 0 {
        return Block::none();
    }
    let mut start = index + 1;
    while line.white(start) {
        start += 1;
    }
    if start >= line.len() {
        return Block::none();
    }
    let mut pos = start;
    let c = line.at(pos);
    let quote_kind = if c == u('"') {
        1
    } else if c == u('\'') {
        2
    } else if c == u('[') {
        3
    } else {
        0
    };
    if quote_kind != 0 {
        // find matching quote
        let ch = match quote_kind {
            1 => u('"'),
            2 => u('\''),
            _ => u(']'),
        };
        let e = line.index_of(ch, pos + 1);
        if e < 0 {
            return Block::new(K::AssignmentValue, state, start, pos + 1)
                .shift(Shift::Out)
                .error(true);
        }
        pos = e + 1;
    } else {
        loop {
            pos += 1;
            if !(pos < line.len() && line.at(pos) != u('/') && line.at(pos) != u(',')) {
                break;
            }
        }
    }
    let end = pos;
    if end > start {
        return Block::new(K::AssignmentValue, state, start, end).shift(Shift::Skip);
    }
    Block::none()
}

fn table_assign_find(
    kind: K,
    entry: K,
    state: &SyntaxState,
    line: &Line,
    index: isize,
    eol: &EolState,
) -> Block {
    let mut st = state.clone();
    let in_table = matches!(
        entry,
        K::IdentifierTableAssignmentColHead
            | K::IdentifierTableAssignmentRowHead
            | K::IdentifierTableAssignmentRow
    );
    if !in_table && st.flavor & TABLE == 0 {
        return Block::none();
    }
    if index > 0 && kind != K::IdentifierTableAssignmentRow {
        return Block::none();
    }
    if kind == K::IdentifierTableAssignmentColHead {
        let mut end = index;
        st.flavor = 0;
        if in_table {
            // validate this is a continued table using '+' and find start of first column
            let mut plus_count = 0;
            while end < line.len() && (line.white(end) || line.at(end) == u('+')) {
                if line.at(end) == u('\t') {
                    st.flavor = ((st.flavor / 8) + 1) * 8;
                } else {
                    st.flavor += 1;
                }
                if line.at(end) == u('+') {
                    plus_count += 1;
                }
                end += 1;
            }
            if end >= line.len() || plus_count != 1 {
                return Block::none();
            }
        } else {
            // find start of first column
            while end < line.len() && line.white(end) {
                if line.at(end) == u('\t') {
                    st.flavor = ((st.flavor / 8) + 1) * 8;
                } else {
                    st.flavor += 1;
                }
                end += 1;
            }
        }
        Block::new(kind, &st, index, end)
    } else {
        // find split point between row-header and value
        let mut split = st.flavor as isize;
        if line.len() >= st.flavor as isize {
            while split >= 0 && !line.white(split) {
                split -= 1;
            }
        } else {
            split = line.len();
        }
        if split <= 0 {
            return Block::none();
        }
        let mut end = index;
        while end < line.len() && line.at(end) != u(';') && !eol.check_endline(line, end) {
            end += 1;
        }
        if split > end {
            split = end;
        }
        if kind == K::IdentifierTableAssignmentRowHead {
            return Block::new(kind, &st, index, split);
        }
        if index < split {
            return Block::none();
        }
        Block::new(kind, &st, index, end)
    }
}

fn simple_word_find(state: &SyntaxState, line: &Line, index: isize) -> Block {
    let alpha = |c: u16| (u('A')..=u('Z')).contains(&c) || (u('a')..=u('z')).contains(&c);
    if line.len() <= index + 1 || line.at(index) != u('%') {
        return Block::none();
    }
    let mut end = index + 1;
    if !alpha(line.at(end)) {
        return Block::none();
    }
    end += 1;
    while line.len() > end {
        let c = line.at(end);
        if c == u('%') {
            return Block::new(K::UserCompileAttrib, state, index, end + 1);
        }
        if !alpha(c) && !(u('0')..=u('9')).contains(&c) && c != u('_') {
            return Block::none();
        }
        end += 1;
    }
    Block::none()
}
