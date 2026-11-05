// SPDX-License-Identifier: GPL-3.0-or-later
//! MPSGE blocks (EXTENSION, not a Studio feature: Studio treats them as `$onText`
//! comments).
//!
//! An MPSGE model is written inside a `$onText ... $offText` block whose first
//! non-blank, non-`*` comment line starts with `$MODEL:<name>`; GAMS ignores the block
//! and the MPSGE preprocessor (`$sysInclude mpsgeset <name>`) reads it. This module
//! finds such blocks in the highlighter output and tokenizes their lines
//! (sections, record fields, identifiers, numbers, comments), derives outline,
//! folding, completion and hover data.
//!
//! The syntax (facts only, no documentation text) follows the MPSGE documentation (`$GAMS_SYSDIR/docs/UG_MPSGE*.html`,
//! `mpsge.pdf`, see `docs/dev/sources.md`):
//! - keywords start with `$` in column 1 and end with `:`, case-insensitive;
//! - end-of-line is significant, a `+` in column 1 continues a record;
//! - lines starting with `*` in column 1 and blank lines are comments;
//! - `!` starts a trailing comment (a variable descriptor in the declaration blocks);
//! - records are `LABEL:value` fields (`O:`, `I:`, `D:`, `E:`, `Q:`, `P:`, `A:`, `T:`,
//!   `N:`, `M:`, `R:`, `V:`, `W:`, nest identifiers, ...).
//!
//! All columns are UTF-16 code units.

use std::collections::HashSet;
use std::sync::OnceLock;

use crate::generated::syntaxdata as d;
use crate::highlighter::LineInfo;
use crate::kind::SyntaxKind as K;
use crate::outline::{NodeKind, OutlineNode};

/// The MPSGE section keywords (`$NAME:`) and run-time switches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SectionKind {
    Model,
    Sectors,
    Commodities,
    Consumers,
    Auxiliary,
    Prod,
    Demand,
    Constraint,
    Report,
    Echop,
    Peps,
    Eulchk,
    Walchk,
    Funlog,
    Datech,
}

struct SecDef {
    kind: SectionKind,
    name: &'static str,
    syntax: &'static str,
    doc: &'static str,
}

/// Order = order of the documentation (keywords table, then the switches).
const SECTIONS: &[SecDef] = &[
    SecDef {
        kind: SectionKind::Model,
        name: "MODEL",
        syntax: "$MODEL:model_name",
        doc: "Starts the model and names it; must be the first statement of the block.",
    },
    SecDef {
        kind: SectionKind::Sectors,
        name: "SECTORS",
        syntax: "$SECTORS:",
        doc: "Declares production sectors (activity levels).",
    },
    SecDef {
        kind: SectionKind::Commodities,
        name: "COMMODITIES",
        syntax: "$COMMODITIES:",
        doc: "Declares commodities (price variables).",
    },
    SecDef {
        kind: SectionKind::Consumers,
        name: "CONSUMERS",
        syntax: "$CONSUMERS:",
        doc: "Declares consumers (income levels).",
    },
    SecDef {
        kind: SectionKind::Auxiliary,
        name: "AUXILIARY",
        syntax: "$AUXILIARY:",
        doc: "Declares auxiliary variables for side constraints.",
    },
    SecDef {
        kind: SectionKind::Prod,
        name: "PROD",
        syntax: "$PROD:sector [s:expr] [t:expr] [a:expr {b:expr}]",
        doc: "Production function of one sector.",
    },
    SecDef {
        kind: SectionKind::Demand,
        name: "DEMAND",
        syntax: "$DEMAND:consumer [s:expr] [a:expr {b:expr}]",
        doc: "Demand function of one consumer.",
    },
    SecDef {
        kind: SectionKind::Constraint,
        name: "CONSTRAINT",
        syntax: "$CONSTRAINT:auxiliary",
        doc: "Side constraint tied to an auxiliary variable.",
    },
    SecDef {
        kind: SectionKind::Report,
        name: "REPORT",
        syntax: "$REPORT:",
        doc: "Declares report variables computed after the solve.",
    },
    SecDef {
        kind: SectionKind::Echop,
        name: "ECHOP",
        syntax: "$ECHOP: logical",
        doc: "Switch: echo the scalar MPSGE model (default `.FALSE.`).",
    },
    SecDef {
        kind: SectionKind::Peps,
        name: "PEPS",
        syntax: "$PEPS: real",
        doc: "Numeric tolerance for small prices (default `1.0E-6`).",
    },
    SecDef {
        kind: SectionKind::Eulchk,
        name: "EULCHK",
        syntax: "$EULCHK: logical",
        doc: "Switch: check Euler's identity (default `.TRUE.`).",
    },
    SecDef {
        kind: SectionKind::Walchk,
        name: "WALCHK",
        syntax: "$WALCHK: logical",
        doc: "Switch: check Walras's law (default `.TRUE.`).",
    },
    SecDef {
        kind: SectionKind::Funlog,
        name: "FUNLOG",
        syntax: "$FUNLOG: logical",
        doc: "Switch: log function evaluations (default `.FALSE.`).",
    },
    SecDef {
        kind: SectionKind::Datech,
        name: "DATECH",
        syntax: "$DATECH: logical",
        doc: "Switch: log data checks (default `.FALSE.`).",
    },
];

impl SectionKind {
    /// All section keywords in documentation order.
    pub fn all() -> impl Iterator<Item = SectionKind> {
        SECTIONS.iter().map(|s| s.kind)
    }
    fn def(self) -> &'static SecDef {
        SECTIONS
            .iter()
            .find(|s| s.kind == self)
            .expect("section table")
    }
    /// Keyword without `$` and `:`, upper case (`"PROD"`).
    pub fn keyword(self) -> &'static str {
        self.def().name
    }
    /// Syntax summary as printed in the documentation (`"$PROD:sector [s:expr] ..."`).
    pub fn syntax(self) -> &'static str {
        self.def().syntax
    }
    /// Documentation text (Markdown).
    pub fn doc(self) -> &'static str {
        self.def().doc
    }
    /// Section keyword by name (case-insensitive). `CONSUMER` (singular) is accepted
    /// because the shipped model `vonthmge` uses it.
    pub fn from_name(name: &str) -> Option<SectionKind> {
        if name.eq_ignore_ascii_case("CONSUMER") {
            return Some(SectionKind::Consumers);
        }
        SECTIONS
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case(name))
            .map(|s| s.kind)
    }
    /// `$SECTORS:`, `$COMMODITIES:`, `$CONSUMERS:`, `$AUXILIARY:`
    pub fn is_declaration(self) -> bool {
        matches!(
            self,
            Self::Sectors | Self::Commodities | Self::Consumers | Self::Auxiliary
        )
    }
    /// Run-time switches (`$ECHOP:` ... `$DATECH:`).
    pub fn is_switch(self) -> bool {
        matches!(
            self,
            Self::Echop | Self::Peps | Self::Eulchk | Self::Walchk | Self::Funlog | Self::Datech
        )
    }
    /// Sections whose keyword line is followed by a name (`$PROD:Y(R)`).
    pub fn takes_name(self) -> bool {
        matches!(
            self,
            Self::Model | Self::Prod | Self::Demand | Self::Constraint
        )
    }
    fn var_noun(self) -> &'static str {
        match self {
            Self::Sectors => "sector",
            Self::Commodities => "commodity",
            Self::Consumers => "consumer",
            _ => "auxiliary variable",
        }
    }
}

/// Lexical class of a token inside an MPSGE block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MKind {
    /// `$SECTORS:` (keyword including `$` and `:`)
    Section,
    /// `Q:`, `I:`, `a:`, `i.tl(m):` (label including `:`)
    Field,
    /// variable / parameter / set name
    Identifier,
    /// number, `.TRUE.`
    Value,
    /// quoted label
    Label,
    /// `*` comment line, trailing `!` comment
    Comment,
    /// `!` variable descriptor in a declaration block
    Description,
}

/// A token of an MPSGE line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MTok {
    pub start: u32,
    pub len: u32,
    pub kind: MKind,
    /// `Field` only: a value follows (directly or after blanks).
    pub value: bool,
}

/// A section of a block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Section {
    pub kind: SectionKind,
    /// line of the keyword
    pub line: u32,
    /// length of `$NAME:` (starts at column 0)
    pub key_len: u32,
    /// first word after the colon (`Y(R)$y0(R)`) with its UTF-16 range
    pub name: Option<(String, u32, u32)>,
    /// last relevant line of the section (trailing blank/`*` comment lines excluded)
    pub end_line: u32,
}

/// A variable declared in `$SECTORS:`, `$COMMODITIES:`, `$CONSUMERS:`, `$AUXILIARY:`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Var {
    pub name: String,
    /// text between the parentheses of the domain, `""` for scalars
    pub domain: String,
    pub kind: SectionKind,
    pub line: u32,
    pub start: u32,
    pub len: u32,
    pub description: Option<String>,
}

/// An MPSGE block.
#[derive(Clone, Debug)]
pub struct Block {
    pub name: String,
    /// line of the `$onText`
    pub on_line: u32,
    /// line of `$MODEL:`
    pub model_line: u32,
    /// line of the closing `$offText`, `None` when the file ends first
    pub end_line: Option<u32>,
    /// last line of the body (inclusive)
    pub last_line: u32,
    pub sections: Vec<Section>,
    pub vars: Vec<Var>,
    /// tokens of lines `model_line..=last_line` (index = line - model_line)
    pub tokens: Vec<Vec<MTok>>,
}

impl Block {
    /// Is `line` part of the MPSGE text (`$MODEL:` line .. last body line)?
    pub fn contains(&self, line: u32) -> bool {
        line >= self.model_line && line <= self.last_line
    }
    /// Tokens of a line inside the block.
    pub fn line_tokens(&self, line: u32) -> &[MTok] {
        if self.contains(line) {
            &self.tokens[(line - self.model_line) as usize]
        } else {
            &[]
        }
    }
    /// The section a line belongs to.
    pub fn section_at(&self, line: u32) -> Option<&Section> {
        self.sections.iter().rev().find(|s| s.line <= line)
    }
}

// ------------------------------------------------------------------ lexing

fn is_ws(c: u16) -> bool {
    c == b' ' as u16 || c == b'\t' as u16
}
fn is_alpha(c: u16) -> bool {
    (c >= b'a' as u16 && c <= b'z' as u16)
        || (c >= b'A' as u16 && c <= b'Z' as u16)
        || c == b'_' as u16
}
fn is_digit(c: u16) -> bool {
    c >= b'0' as u16 && c <= b'9' as u16
}
fn is_alnum(c: u16) -> bool {
    is_alpha(c) || is_digit(c)
}
fn ch(c: char) -> u16 {
    c as u16
}

fn reserved(word: &[u16]) -> bool {
    static SET: OnceLock<HashSet<String>> = OnceLock::new();
    let set = SET.get_or_init(|| {
        d::RESERVED
            .iter()
            .map(|(k, _)| k.to_ascii_lowercase())
            .collect()
    });
    set.contains(&String::from_utf16_lossy(word).to_ascii_lowercase())
}

fn tok(out: &mut Vec<MTok>, start: usize, end: usize, kind: MKind) {
    if end > start {
        out.push(MTok {
            start: start as u32,
            len: (end - start) as u32,
            kind,
            value: false,
        });
    }
}

fn trim_end(u: &[u16], from: usize, to: usize) -> usize {
    let mut e = to;
    while e > from && is_ws(u[e - 1]) {
        e -= 1;
    }
    e
}

/// End of the word starting at `i`: up to a blank or `!` outside parentheses and quotes.
fn word_end(u: &[u16], mut i: usize) -> usize {
    let n = u.len();
    let mut depth = 0usize;
    while i < n {
        let c = u[i];
        if c == ch('"') || c == ch('\'') {
            i += 1;
            while i < n && u[i] != c {
                i += 1;
            }
        } else if c == ch('(') {
            depth += 1;
        } else if c == ch(')') {
            depth = depth.saturating_sub(1);
        } else if depth == 0 && (is_ws(c) || c == ch('!')) {
            break;
        }
        i += 1;
    }
    i.min(n)
}

/// Index of the `)` matching the `(` at `i`, or `n` if there is none.
fn close_paren(u: &[u16], i: usize, to: usize) -> usize {
    let mut depth = 0usize;
    let mut j = i;
    while j < to {
        let c = u[j];
        if c == ch('"') || c == ch('\'') {
            j += 1;
            while j < to && u[j] != c {
                j += 1;
            }
        } else if c == ch('(') {
            depth += 1;
        } else if c == ch(')') {
            depth -= 1;
            if depth == 0 {
                return j;
            }
        }
        j += 1;
    }
    to
}

/// Identifiers, numbers and quoted labels of a GAMS-like expression `u[from..to]`.
fn lex_expr(u: &[u16], from: usize, to: usize, out: &mut Vec<MTok>) {
    let mut i = from;
    while i < to {
        let c = u[i];
        if is_alpha(c) {
            let s = i;
            while i < to && is_alnum(u[i]) {
                i += 1;
            }
            if !reserved(&u[s..i]) {
                tok(out, s, i, MKind::Identifier);
            }
        } else if is_digit(c) || (c == ch('.') && i + 1 < to && is_digit(u[i + 1])) {
            let s = i;
            while i < to && is_digit(u[i]) {
                i += 1;
            }
            if i < to && u[i] == ch('.') {
                i += 1;
                while i < to && is_digit(u[i]) {
                    i += 1;
                }
            }
            if i < to && (u[i] == ch('e') || u[i] == ch('E')) {
                let mut j = i + 1;
                if j < to && (u[j] == ch('+') || u[j] == ch('-')) {
                    j += 1;
                }
                if j < to && is_digit(u[j]) {
                    while j < to && is_digit(u[j]) {
                        j += 1;
                    }
                    i = j;
                }
            }
            tok(out, s, i, MKind::Value);
        } else if c == ch('"') || c == ch('\'') {
            let s = i;
            i += 1;
            while i < to && u[i] != c {
                i += 1;
            }
            if i < to {
                i += 1;
            }
            tok(out, s, i, MKind::Label);
        } else {
            i += 1;
        }
    }
}

/// `LABEL:` at `i` (end index after the colon): up to four letters (nest identifiers
/// are arbitrary names of at most four characters), an optional `.suffix` (`i.tl`) and
/// an optional `(set)` (`i.tl(m)`); `DEMAND` in `$REPORT:` records.
fn match_label(u: &[u16], i: usize, section: Option<SectionKind>) -> Option<usize> {
    let n = u.len();
    if i >= n || !is_alpha(u[i]) {
        return None;
    }
    let mut j = i;
    while j < n && is_alnum(u[j]) {
        j += 1;
    }
    let base = String::from_utf16_lossy(&u[i..j]);
    if j - i > 4 && !(section == Some(SectionKind::Report) && base.eq_ignore_ascii_case("demand")) {
        return None;
    }
    if j < n && u[j] == ch('.') {
        let mut k = j + 1;
        while k < n && is_alpha(u[k]) {
            k += 1;
        }
        if k == j + 1 {
            return None;
        }
        j = k;
    }
    if j < n && u[j] == ch('(') {
        let c = close_paren(u, j, n);
        if c >= n {
            return None;
        }
        j = c + 1;
    }
    (j < n && u[j] == ch(':')).then_some(j + 1)
}

/// Fields and expressions of a record line (or the rest of a `$PROD:`/`$DEMAND:` line).
fn lex_fields(u: &[u16], from: usize, section: Option<SectionKind>, out: &mut Vec<MTok>) {
    let n = u.len();
    let mut i = from;
    loop {
        while i < n && is_ws(u[i]) {
            i += 1;
        }
        if i >= n {
            break;
        }
        if u[i] == ch('!') {
            tok(out, i, trim_end(u, i, n), MKind::Comment);
            break;
        }
        if let Some(e) = match_label(u, i, section) {
            let mut value = word_end(u, e) > e;
            if !value {
                let mut j = e;
                while j < n && is_ws(u[j]) {
                    j += 1;
                }
                value = j < n && u[j] != ch('!') && match_label(u, j, section).is_none();
            }
            out.push(MTok {
                start: i as u32,
                len: (e - i) as u32,
                kind: MKind::Field,
                value,
            });
            i = e;
        }
        let e = word_end(u, i);
        if e > i {
            lex_expr(u, i, e, out);
            i = e;
        } else if i < n && !is_ws(u[i]) && u[i] != ch('!') {
            i += 1;
        }
    }
}

/// A declaration line: `name[(domain)][$condition] ... [! descriptor]`.
fn lex_decl(
    u: &[u16],
    from: usize,
    out: &mut Vec<MTok>,
    vars: &mut Vec<Var>,
    kind: SectionKind,
    line: u32,
) {
    let n = u.len();
    let mut i = from;
    while i < n {
        let c = u[i];
        if is_ws(c) {
            i += 1;
        } else if c == ch('!') {
            let e = trim_end(u, i, n);
            let text = String::from_utf16_lossy(&u[i + 1..e])
                .trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .trim()
                .to_string();
            tok(out, i, e, MKind::Description);
            if let Some(v) = vars.last_mut().filter(|v| v.line == line) {
                v.description = Some(text);
            }
            break;
        } else if is_alpha(c) {
            let s = i;
            while i < n && is_alnum(u[i]) {
                i += 1;
            }
            tok(out, s, i, MKind::Identifier);
            let name = String::from_utf16_lossy(&u[s..i]);
            let name_end = i;
            let mut domain = String::new();
            if i < n && u[i] == ch('(') {
                let e = close_paren(u, i, n);
                lex_expr(u, i + 1, e, out);
                domain = String::from_utf16_lossy(&u[i + 1..e]);
                i = (e + 1).min(n);
            }
            if i < n && u[i] == ch('$') {
                let e = if i + 1 < n && u[i + 1] == ch('(') {
                    (close_paren(u, i + 1, n) + 1).min(n)
                } else {
                    word_end(u, i + 1)
                };
                lex_expr(u, i + 1, e, out);
                i = e.max(i + 1);
            }
            vars.push(Var {
                name,
                domain,
                kind,
                line,
                start: s as u32,
                len: (name_end - s) as u32,
                description: None,
            });
        } else {
            i += 1;
        }
    }
}

/// Result of a `$NAME:` line.
struct KeyLine {
    kind: SectionKind,
    key_len: usize,
    name: Option<(String, u32, u32)>,
}

/// Tokenizes one line of a block. `cur` is the current section (updated by keyword
/// lines).
fn lex_line(
    u: &[u16],
    cur: &mut Option<SectionKind>,
    line: u32,
    out: &mut Vec<MTok>,
    vars: &mut Vec<Var>,
) -> Option<KeyLine> {
    let n = u.len();
    if n == 0 || u.iter().all(|&c| is_ws(c)) {
        return None;
    }
    if u[0] == ch('*') {
        tok(out, 0, trim_end(u, 0, n), MKind::Comment);
        return None;
    }
    if u[0] == ch('$') {
        let mut j = 1;
        while j < n && is_alpha(u[j]) {
            j += 1;
        }
        let word = String::from_utf16_lossy(&u[1..j]);
        let kind = if j < n && u[j] == ch(':') {
            SectionKind::from_name(&word)
        } else {
            None
        };
        let Some(kind) = kind else {
            tok(out, 0, trim_end(u, 0, n), MKind::Comment);
            return None;
        };
        let key_len = j + 1;
        tok(out, 0, key_len, MKind::Section);
        *cur = Some(kind);
        let mut i = key_len;
        while i < n && is_ws(u[i]) {
            i += 1;
        }
        let mut name = None;
        match kind {
            SectionKind::Model => {
                let e = word_end(u, i);
                if e > i {
                    tok(out, i, e, MKind::Identifier);
                    name = Some((String::from_utf16_lossy(&u[i..e]), i as u32, e as u32));
                }
                lex_fields(u, e, None, out);
            }
            k if k.is_switch() => {
                let stop = u[i..]
                    .iter()
                    .position(|&c| c == ch('!'))
                    .map_or(n, |p| i + p);
                tok(out, i, trim_end(u, i, stop), MKind::Value);
                lex_fields(u, stop, None, out);
            }
            k if k.is_declaration() => lex_decl(u, i, out, vars, k, line),
            SectionKind::Prod | SectionKind::Demand | SectionKind::Constraint => {
                let e = word_end(u, i);
                if e > i {
                    lex_expr(u, i, e, out);
                    name = Some((String::from_utf16_lossy(&u[i..e]), i as u32, e as u32));
                }
                if kind == SectionKind::Constraint {
                    lex_expr(u, e, n, out);
                } else {
                    lex_fields(u, e, Some(kind), out);
                }
            }
            _ => lex_fields(u, i, Some(kind), out),
        }
        return Some(KeyLine {
            kind,
            key_len,
            name,
        });
    }
    // record / continuation line of the current section
    let from = usize::from(u[0] == ch('+'));
    match *cur {
        Some(k) if k.is_declaration() => lex_decl(u, from, out, vars, k, line),
        Some(SectionKind::Prod | SectionKind::Demand | SectionKind::Report) => {
            lex_fields(u, from, *cur, out)
        }
        Some(SectionKind::Constraint) => lex_expr(u, from, n, out),
        _ => {}
    }
    None
}

// ------------------------------------------------------------------ block detection

/// `$MODEL:name` at column 0 (case-insensitive, blanks after the colon allowed).
fn model_name(line: &str) -> Option<String> {
    let b = line.as_bytes();
    if b.len() < 7 || b[0] != b'$' || !line[1..6].eq_ignore_ascii_case("model") {
        return None;
    }
    let rest = line[6..].strip_prefix(':')?;
    Some(
        rest.split(|c: char| c.is_whitespace() || c == '!')
            .find(|w| !w.is_empty())
            .unwrap_or("")
            .to_string(),
    )
}

/// Is this body line blank or a column-1 `*` comment?
fn skippable(line: &str) -> bool {
    line.trim().is_empty() || line.starts_with('*')
}

/// Finds the MPSGE blocks of a document given its lines and highlighter output.
pub fn find_blocks(lines: &[&str], infos: &[LineInfo]) -> Vec<Block> {
    let n = infos.len().min(lines.len());
    let in_comment = |i: usize| infos[i].state.top_kind() == K::CommentBlock;
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        if !(in_comment(i) && (i == 0 || !in_comment(i - 1))) {
            i += 1;
            continue;
        }
        let on_line = i;
        let mut j = i + 1;
        while j < n && in_comment(j) {
            j += 1;
        }
        // lines on_line+1 .. j are the body; j is the $offText line (or n)
        if let Some(k) = (on_line + 1..j).find(|&k| !skippable(lines[k])) {
            if let Some(name) = model_name(lines[k]) {
                out.push(analyze(
                    lines,
                    name,
                    on_line,
                    k,
                    (j < n).then_some(j),
                    j - 1,
                ));
            }
        }
        i = j;
    }
    out
}

fn analyze(
    lines: &[&str],
    name: String,
    on_line: usize,
    model_line: usize,
    end_line: Option<usize>,
    last: usize,
) -> Block {
    let mut cur = None;
    let mut tokens = Vec::with_capacity(last + 1 - model_line);
    let mut vars = Vec::new();
    let mut sections: Vec<Section> = Vec::new();
    for (ln, text) in lines.iter().enumerate().take(last + 1).skip(model_line) {
        let u: Vec<u16> = text.encode_utf16().collect();
        let mut t = Vec::new();
        if let Some(k) = lex_line(&u, &mut cur, ln as u32, &mut t, &mut vars) {
            sections.push(Section {
                kind: k.kind,
                line: ln as u32,
                key_len: k.key_len as u32,
                name: k.name,
                end_line: ln as u32,
            });
        }
        tokens.push(t);
    }
    // section extents: up to the next keyword line, without trailing blank/comment lines
    for s in 0..sections.len() {
        let limit = sections.get(s + 1).map_or(last, |x| x.line as usize - 1);
        let mut e = limit;
        while e > sections[s].line as usize && skippable(lines[e]) {
            e -= 1;
        }
        sections[s].end_line = e as u32;
    }
    Block {
        name,
        on_line: on_line as u32,
        model_line: model_line as u32,
        end_line: end_line.map(|e| e as u32),
        last_line: last as u32,
        sections,
        vars,
        tokens,
    }
}

// ------------------------------------------------------------------ outline and folding

fn line_len16(lines: &[&str], l: u32) -> u32 {
    lines
        .get(l as usize)
        .map_or(0, |t| t.encode_utf16().count() as u32)
}

/// Outline node of a block: the model with its sections; declaration sections contain
/// the declared variables.
pub fn outline_node(lines: &[&str], b: &Block) -> OutlineNode {
    let mut children = Vec::new();
    for s in &b.sections {
        let kw = format!("${}:", s.kind.keyword());
        let (name, detail) = match &s.name {
            Some((n, _, _)) if s.kind != SectionKind::Model => (format!("{kw}{n}"), None),
            _ => (kw, None),
        };
        if s.kind == SectionKind::Model {
            continue;
        }
        let kids: Vec<OutlineNode> = b
            .vars
            .iter()
            .filter(|v| v.line >= s.line && v.line <= s.end_line && s.kind.is_declaration())
            .map(|v| OutlineNode {
                name: if v.domain.is_empty() {
                    v.name.clone()
                } else {
                    format!("{}({})", v.name, v.domain)
                },
                detail: Some(match &v.description {
                    Some(x) if !x.is_empty() => format!("{} - {x}", v.kind.var_noun()),
                    _ => v.kind.var_noun().to_string(),
                }),
                kind: NodeKind::MpsgeVariable(v.kind),
                line: v.line,
                start: v.start,
                len: v.len,
                end_line: v.line,
                end_col: v.start + v.len,
                children: vec![],
            })
            .collect();
        children.push(OutlineNode {
            name,
            detail,
            kind: NodeKind::MpsgeSection(s.kind),
            line: s.line,
            start: 0,
            len: s.key_len,
            end_line: s.end_line,
            end_col: line_len16(lines, s.end_line),
            children: kids,
        });
    }
    let model = b.sections.first().filter(|s| s.kind == SectionKind::Model);
    OutlineNode {
        name: b.name.clone(),
        detail: Some("MPSGE model".into()),
        kind: NodeKind::MpsgeModel,
        line: b.model_line,
        start: model.and_then(|s| s.name.as_ref()).map_or(0, |n| n.1),
        len: model
            .and_then(|s| s.name.as_ref())
            .map_or(model.map_or(0, |s| s.key_len), |n| n.2 - n.1),
        end_line: b.last_line,
        end_col: line_len16(lines, b.last_line),
        children,
    }
}

/// Folding ranges `(start line, end line)` of the sections of a block.
pub fn fold_ranges(b: &Block) -> Vec<(u32, u32)> {
    b.sections
        .iter()
        .filter(|s| s.end_line > s.line)
        .map(|s| (s.line, s.end_line))
        .collect()
}

// ------------------------------------------------------------------ documentation

struct FieldDoc {
    syntax: String,
    doc: String,
}

fn field_doc(
    section: Option<SectionKind>,
    header: bool,
    label: &str,
    value: bool,
) -> Option<FieldDoc> {
    let lower = label.trim_end_matches(':').to_ascii_lowercase();
    let base = lower.split(['.', '(']).next().unwrap_or("").to_string();
    let prod = section == Some(SectionKind::Prod);
    let demand = section == Some(SectionKind::Demand);
    let report = section == Some(SectionKind::Report);
    let f = |s: &str, d: &str| {
        Some(FieldDoc {
            syntax: s.into(),
            doc: d.into(),
        })
    };
    let nest_extra = if lower.contains('.') {
        " The `.tl` suffix expands the nest over a set."
    } else {
        ""
    };
    if header && (prod || demand) {
        return match base.as_str() {
            "s" if prod => f("s:expr", "Top-level substitution elasticity (inputs)."),
            "s" => f("s:expr", "Top-level substitution elasticity (demands)."),
            "t" if prod => f("t:expr", "Transformation elasticity (outputs)."),
            _ => Some(FieldDoc {
                syntax: format!("{base}:expr"),
                doc: format!("Substitution elasticity of the {} nest `{base}`.{nest_extra}", if prod { "input" } else { "demand" }),
            }),
        };
    }
    if report {
        return match base.as_str() {
            "v" => f("V:name", "Name of the report variable."),
            "i" => f("I:commodity", "Input quantity report (commodity, sector)."),
            "o" => f("O:commodity", "Output quantity report (commodity, sector)."),
            "d" => f("D:commodity", "Demand quantity report (commodity, consumer)."),
            "w" => f("W:consumer", "Level value of a consumer."),
            "prod" => f("PROD:sector", "Sector of an `I:`/`O:` report record."),
            "demand" => f("DEMAND:consumer", "Consumer of a `D:` report record."),
            _ => None,
        };
    }
    match base.as_str() {
        "o" if prod => f("O:commodity", "Output commodity."),
        "i" if prod => f("I:commodity", "Input commodity."),
        "d" if demand => f("D:commodity", "Demanded commodity."),
        "e" if demand => f("E:commodity", "Endowed commodity."),
        "q" => f("Q:expr", "Reference quantity (default 1)."),
        "p" if prod || demand => f("P:expr", "Reference price (default 1)."),
        "a" if prod && value => f("A:consumer", "Consumer receiving the tax revenue; precedes `T:`/`N:`."),
        "t" if prod => f("T:expr", "Exogenous ad valorem tax rate."),
        "n" if prod => f("N:auxiliary", "Auxiliary variable carrying an endogenous tax."),
        "m" if prod => f("M:expr", "Multiplier of the endogenous tax (with `N:`)."),
        "r" if demand => f("R:auxiliary", "Auxiliary variable used as rationing instrument."),
        _ if (prod || demand) && !value => Some(FieldDoc {
            syntax: format!("{base}:"),
            doc: format!("Assigns the entry to nest `{base}`.{nest_extra}"),
        }),
        _ => None,
    }
}

/// Documentation page of the MPSGE language syntax (gams.com; no documentation text is bundled).
pub const DOC_LINK: &str = "[Documentation](https://www.gams.com/latest/docs/UG_MPSGE_Models.html#UG_MPSGE_Models_LanguageSyntax)";

/// Hover text for a range of a line.
pub struct Hover {
    pub start: u32,
    pub end: u32,
    pub markdown: String,
}

fn text16(lines: &[&str], line: u32, start: u32, len: u32) -> String {
    let u: Vec<u16> = lines
        .get(line as usize)
        .map(|l| l.encode_utf16().collect())
        .unwrap_or_default();
    let a = (start as usize).min(u.len());
    let b = ((start + len) as usize).min(u.len());
    String::from_utf16_lossy(&u[a..b])
}

/// Hover for the section keyword, field label or declared variable at (`line`, `col`);
/// `None` outside blocks or without documentation.
pub fn hover(lines: &[&str], blocks: &[Block], line: u32, col: u32) -> Option<Hover> {
    let b = blocks.iter().find(|b| b.contains(line))?;
    let t = b
        .line_tokens(line)
        .iter()
        .find(|t| t.start <= col && col < t.start + t.len)?;
    let text = text16(lines, line, t.start, t.len);
    match t.kind {
        MKind::Section => {
            let s = b.sections.iter().find(|s| s.line == line)?;
            Some(Hover {
                start: t.start,
                end: t.start + t.len,
                markdown: format!("**{}**\n\n{}\n\n{DOC_LINK}", s.kind.syntax(), s.kind.doc()),
            })
        }
        MKind::Field => {
            let sec = b.section_at(line);
            let header = sec.is_some_and(|s| s.line == line);
            let fd = field_doc(sec.map(|s| s.kind), header, &text, t.value)?;
            Some(Hover {
                start: t.start,
                end: t.start + t.len,
                markdown: format!("**{}**\n\n{}\n\n{DOC_LINK}", fd.syntax, fd.doc),
            })
        }
        MKind::Identifier => {
            let v = b.vars.iter().find(|v| v.name.eq_ignore_ascii_case(&text))?;
            let sig = if v.domain.is_empty() {
                v.name.clone()
            } else {
                format!("{}({})", v.name, v.domain)
            };
            let mut md = format!("```gams\n{} {}\n```", v.kind.var_noun(), sig);
            if let Some(x) = v.description.as_ref().filter(|x| !x.is_empty()) {
                md.push_str(&format!("\n\n{x}"));
            }
            Some(Hover {
                start: t.start,
                end: t.start + t.len,
                markdown: md,
            })
        }
        _ => None,
    }
}

// ------------------------------------------------------------------ completion

/// A completion item inside a block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub label: String,
    pub insert: String,
    pub detail: String,
    pub doc: String,
    /// section keyword (otherwise a field label)
    pub section: bool,
    /// replaced range (UTF-16 columns of the line)
    pub start: u32,
    pub end: u32,
}

fn field_item(label: &str, detail: &str, doc: &str, start: u32, end: u32) -> Completion {
    Completion {
        label: label.into(),
        insert: label.into(),
        detail: detail.into(),
        doc: doc.into(),
        section: false,
        start,
        end,
    }
}

/// Completion candidates at (`line`, `col`): section keywords after a `$` in column 1,
/// field labels where a record field can start. `None` when the position is not in an
/// MPSGE block (an empty list inside a block means "nothing to offer there").
pub fn completions(
    lines: &[&str],
    blocks: &[Block],
    line: u32,
    col: u32,
) -> Option<Vec<Completion>> {
    let b = blocks.iter().find(|b| b.contains(line))?;
    let u: Vec<u16> = lines.get(line as usize)?.encode_utf16().collect();
    let col = (col as usize).min(u.len());
    let mut out = Vec::new();
    // word around the cursor
    let mut ws = col;
    while ws > 0 && (is_alnum(u[ws - 1]) || u[ws - 1] == ch('.') || u[ws - 1] == ch('$')) {
        ws -= 1;
    }
    let mut we = col;
    while we < u.len() && is_alnum(u[we]) {
        we += 1;
    }
    if we < u.len() && u[we] == ch(':') {
        we += 1;
    }
    if ws == 0 && u.first() == Some(&ch('$')) {
        for k in SectionKind::all() {
            let name = k.keyword();
            let insert = format!("${name}:");
            out.push(Completion {
                label: insert.clone(),
                insert,
                detail: k.syntax().to_string(),
                doc: format!("{}\n\n{DOC_LINK}", k.doc()),
                section: true,
                start: 0,
                end: we as u32,
            });
        }
        return Some(out);
    }
    let sec = b.section_at(line);
    let Some(sec) = sec else { return Some(out) };
    // inside a comment, a parenthesis or a value there are no fields
    let before = &u[..ws];
    if u[..col].contains(&ch('!'))
        || u[..col].iter().filter(|&&c| c == ch('(')).count()
            > u[..col].iter().filter(|&&c| c == ch(')')).count()
    {
        return Some(out);
    }
    if ws > 0 && !is_ws(before[ws - 1]) && !(ws == 1 && before[0] == ch('+')) {
        return Some(out);
    }
    if u[ws..col].contains(&ch(':')) {
        return Some(out);
    }
    let toks = b.line_tokens(line);
    let record_start = before.iter().all(|&c| is_ws(c));
    let (s, e) = (ws as u32, we as u32);
    let header = sec.line == line;
    let fields: Vec<String> = toks
        .iter()
        .filter(|t| t.kind == MKind::Field && (t.start as usize) < ws)
        .map(|t| {
            text16(lines, line, t.start, t.len)
                .trim_end_matches(':')
                .to_ascii_lowercase()
        })
        .collect();
    let kind = Some(sec.kind);
    let mut add = |label: &str, hdr: bool| {
        if let Some(fd) = field_doc(kind, hdr, label, true) {
            out.push(field_item(label, &fd.syntax, &format!("{}\n\n{DOC_LINK}", fd.doc), s, e));
        }
    };
    match sec.kind {
        SectionKind::Prod | SectionKind::Demand if header => {
            // after the sector / consumer name
            if !record_start {
                add("s:", true);
                if sec.kind == SectionKind::Prod {
                    add("t:", true);
                }
            }
        }
        SectionKind::Prod if record_start => {
            add("O:", false);
            add("I:", false);
        }
        SectionKind::Prod => {
            for l in ["Q:", "P:", "A:", "T:", "N:", "M:"] {
                add(l, false);
            }
        }
        SectionKind::Demand if record_start => {
            add("D:", false);
            add("E:", false);
        }
        SectionKind::Demand => {
            let lead_e = fields.first().is_some_and(|f| f == "e");
            add("Q:", false);
            add(if lead_e { "R:" } else { "P:" }, false);
        }
        SectionKind::Report => match fields.len() {
            _ if record_start => add("V:", false),
            1 => {
                for l in ["I:", "O:", "D:", "W:"] {
                    add(l, false);
                }
            }
            2 => match fields[1].as_str() {
                "i" | "o" => add("PROD:", false),
                "d" => add("DEMAND:", false),
                _ => {}
            },
            _ => {}
        },
        _ => {}
    }
    Some(out)
}
