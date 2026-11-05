// SPDX-License-Identifier: GPL-3.0-or-later
//! Cheap document outline derived from the highlighter tokens: identifiers that
//! follow a declaration keyword (`Set`, `Parameter`, `Scalar`, `Table`, `Variable`,
//! `Equation`, `Model`, ...). This is a helper of this project (not a Studio port);
//! Studio builds its outline from the GAMS reference file instead.
//!
//! EXTENSIONS (not in Studio): comment section headers (`* Data ----------`, see
//! [`comment_sections`]) nest the declarations below them, and MPSGE blocks
//! ([`crate::mpsge`]) appear as models with their sections.

use crate::highlighter::{highlight_document_info, highlight_line_utf16, split_lines, LineInfo, LineState, Token};
use crate::kind::SyntaxKind as K;
use crate::mpsge::{self, SectionKind};

/// A declared symbol. Positions are 0-based lines and UTF-16 columns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclaredSymbol {
    /// Declaration keyword as written, e.g. `"Parameter"` or `"Table"`.
    pub keyword: String,
    /// Optional type prefix, e.g. `"Positive"` for `Positive Variable x;`.
    pub type_prefix: Option<String>,
    pub name: String,
    pub line: u32,
    pub start: u32,
    pub len: u32,
    /// Explanatory text following the name, without quotes.
    pub description: Option<String>,
}

/// Range of `[start, start+len)` without surrounding blanks.
fn trimmed_range(line: &[u16], start: u32, len: u32) -> (u32, u32) {
    let blank = |c: u16| c == b' ' as u16 || c == b'\t' as u16;
    let (mut a, mut b) = (start as usize, ((start + len) as usize).min(line.len()));
    while a < b && blank(line[a]) {
        a += 1;
    }
    while b > a && blank(line[b - 1]) {
        b -= 1;
    }
    (a as u32, (b - a) as u32)
}

fn slice16(line: &[u16], start: u32, len: u32) -> String {
    let a = (start as usize).min(line.len());
    let b = ((start + len) as usize).min(line.len());
    String::from_utf16_lossy(&line[a..b]).trim().to_string()
}

/// Lists the declared symbols of a GAMS document in source order.
pub fn declarations(text: &str) -> Vec<DeclaredSymbol> {
    let lines = split_lines(text);
    let infos = highlight_document_info(text);
    declarations_from(&lines, &infos)
}

/// [`declarations`] for already highlighted text.
///
/// Besides the identifiers Studio's highlighter marks after a declaration keyword, this also
/// lists (EXTENSIONS, the highlighter drops these parts of the line):
/// - the new names of `Alias (i,ii),(j,jj);` (all names of a group except the one declared
///   before; without a known one, all but the first),
/// - declarations in the new input line of `$if`/`$ifI`/`$ifE` (`$if set x Set k / a /;`).
///
/// A symbol declared again (`Variable x; Positive Variable x;`) is listed once, at its first
/// declaration; a later type prefix or description completes it.
pub fn declarations_from(lines: &[&str], infos: &[LineInfo]) -> Vec<DeclaredSymbol> {
    let mut c = Collector::default();
    let mut ln = 0;
    while ln < infos.len() {
        let info = &infos[ln];
        let if_line = info.tokens.first().is_some_and(|t| t.kind == K::Dco);
        let any = |f: fn(K) -> bool| info.tokens.iter().any(|t| f(t.kind));
        // nothing to collect on most lines (no text needed)
        if !if_line && !(if c.active() { any(Collector::relevant) } else { any(starts_declaration) }) {
            if c.active() && !in_declaration(&info.state) {
                c.reset();
            }
            ln += 1;
            continue;
        }
        let u: Vec<u16> = lines[ln].encode_utf16().collect();
        c.line(ln as u32, &u, &info.tokens, &info.state);
        if let Some(stmt) = if_line.then(|| if_statement_start(&u, &info.tokens)).flatten() {
            // the rest of the line is a statement of its own, highlighted from the standard state
            let mut sub = Collector { out: std::mem::take(&mut c.out), index: std::mem::take(&mut c.index), ..Default::default() };
            let mut li = highlight_line_utf16(&LineState::default(), &u[stmt..]);
            for t in &mut li.tokens {
                t.start += stmt as u32;
            }
            sub.line(ln as u32, &u, &li.tokens, &li.state);
            // a declaration continued on the next lines (until the statement ends)
            let mut st = li.state;
            while in_declaration(&st) && ln + 1 < infos.len() {
                ln += 1;
                let u: Vec<u16> = lines[ln].encode_utf16().collect();
                let li = highlight_line_utf16(&st, &u);
                sub.line(ln as u32, &u, &li.tokens, &li.state);
                st = li.state;
            }
            c.out = sub.out;
            c.index = sub.index;
        }
        ln += 1;
    }
    c.out
}

/// State of [`declarations_from`].
#[derive(Default)]
struct Collector {
    out: Vec<DeclaredSymbol>,
    /// lower-case name -> index into `out`
    index: std::collections::HashMap<String, usize>,
    keyword: Option<String>,
    prefix: Option<String>,
    last_symbol: Option<usize>,
}

impl Collector {
    /// Adds a symbol (or completes the one declared before); returns its index.
    fn add(&mut self, sym: DeclaredSymbol) -> usize {
        let key = sym.name.to_ascii_lowercase();
        if let Some(&i) = self.index.get(&key) {
            let d = &mut self.out[i];
            if d.type_prefix.is_none() {
                d.type_prefix = sym.type_prefix;
            }
            return i;
        }
        self.out.push(sym);
        self.index.insert(key, self.out.len() - 1);
        self.out.len() - 1
    }

    fn active(&self) -> bool {
        self.keyword.is_some() || self.prefix.is_some() || self.last_symbol.is_some()
    }

    /// Token kinds [`Collector::line`] looks at.
    fn relevant(k: K) -> bool {
        starts_declaration(k) || matches!(k, K::Identifier | K::IdentifierDescription | K::Semicolon)
    }

    fn reset(&mut self) {
        self.keyword = None;
        self.prefix = None;
        self.last_symbol = None;
    }

    fn line(&mut self, ln: u32, u: &[u16], tokens: &[Token], end: &LineState) {
        for t in tokens {
            match t.kind {
                _ if !Self::relevant(t.kind) => {}
                // tails of these kinds may be pure whitespace
                _ if trimmed_range(u, t.start, t.len).1 == 0 => {}
                K::DeclarationSetType | K::DeclarationVariableType if !t.error => {
                    self.prefix = Some(slice16(u, t.start, t.len));
                    self.keyword = None;
                    self.last_symbol = None;
                }
                K::Declaration if !t.error => {
                    let kw = slice16(u, t.start, t.len);
                    self.last_symbol = None;
                    if kw.eq_ignore_ascii_case("alias") {
                        self.alias(ln, u, (t.start + t.len) as usize);
                        self.keyword = None;
                    } else {
                        self.keyword = Some(kw);
                    }
                }
                K::Identifier if !t.error => {
                    if let Some(kw) = &self.keyword {
                        let (start, len) = trimmed_range(u, t.start, t.len);
                        let sym = DeclaredSymbol {
                            keyword: kw.clone(),
                            type_prefix: self.prefix.clone(),
                            name: slice16(u, start, len),
                            line: ln,
                            start,
                            len,
                            description: None,
                        };
                        self.last_symbol = Some(self.add(sym));
                    }
                }
                K::IdentifierDescription => {
                    if let Some(i) = self.last_symbol {
                        if self.out[i].description.is_none() {
                            let d = slice16(u, t.start, t.len);
                            let d = d.trim_matches(|c| c == '\'' || c == '"').to_string();
                            self.out[i].description = Some(d);
                        }
                    }
                }
                K::Semicolon => self.reset(),
                _ => {}
            }
        }
        // a statement left the declaration context (e.g. error reset)
        if !in_declaration(end) {
            self.reset();
        }
    }

    /// The groups `(a, b, ...)` of an alias statement from column `from` up to `;`.
    fn alias(&mut self, ln: u32, u: &[u16], from: usize) {
        let is_word = |c: u16| c < 0x80 && ((c as u8).is_ascii_alphanumeric() || c == b'_' as u16);
        let mut i = from;
        let mut group: Vec<(usize, usize)> = Vec::new();
        let mut open = false;
        while i < u.len() && u[i] != b';' as u16 {
            let c = u[i];
            if c == b'(' as u16 {
                open = true;
                group.clear();
            } else if c == b')' as u16 && open {
                open = false;
                self.alias_group(ln, u, &group);
            } else if open && is_word(c) {
                let s = i;
                while i < u.len() && is_word(u[i]) {
                    i += 1;
                }
                group.push((s, i));
                continue;
            }
            i += 1;
        }
    }

    fn alias_group(&mut self, ln: u32, u: &[u16], group: &[(usize, usize)]) {
        let names: Vec<String> = group.iter().map(|&(a, b)| String::from_utf16_lossy(&u[a..b])).collect();
        let known = names.iter().position(|n| self.index.contains_key(&n.to_ascii_lowercase())).unwrap_or(0);
        for (k, &(a, b)) in group.iter().enumerate() {
            if k == known {
                continue;
            }
            self.add(DeclaredSymbol {
                keyword: "Alias".into(),
                type_prefix: None,
                name: names[k].clone(),
                line: ln,
                start: a as u32,
                len: (b - a) as u32,
                description: Some(format!("alias of {}", names[known])),
            });
        }
    }
}

fn starts_declaration(k: K) -> bool {
    matches!(k, K::Declaration | K::DeclarationSetType | K::DeclarationVariableType)
}

fn in_declaration(state: &LineState) -> bool {
    state.has_kind(|k| {
        matches!(
            k,
            K::Declaration
                | K::DeclarationSetType
                | K::DeclarationVariableType
                | K::Identifier
                | K::IdentifierDim
                | K::IdentifierDimEnd
                | K::IdentifierDescription
                | K::IdentifierAssignment
                | K::AssignmentLabel
                | K::AssignmentValue
                | K::AssignmentSystemData
                | K::IdentifierAssignmentEnd
                | K::IdentifierTableAssignmentColHead
                | K::IdentifierTableAssignmentRowHead
                | K::IdentifierTableAssignmentRow
                | K::CommaIdent
                | K::CommentBlock
        )
    })
}

/// For a `$if`/`$ifI`/`$ifE` line: the UTF-16 column where its new input line (the statement after
/// `[not] conditional_expression`) starts, if there is one and it is not a DCO. The conditional
/// expressions are those of the GAMS documentation (`UG_DollarControlOptions.html`, "Conditional
/// Expressions in Conditional Compilation").
fn if_statement_start(u: &[u16], tokens: &[Token]) -> Option<usize> {
    let t = tokens.first().filter(|t| t.kind == K::Dco && !t.error)?;
    let dco = slice16(u, t.start, t.len).to_ascii_lowercase();
    if !matches!(dco.as_str(), "$if" | "$ifi" | "$ife") {
        return None;
    }
    let blank = |c: u16| c == b' ' as u16 || c == b'\t' as u16;
    let mut i = (t.start + t.len) as usize;
    // one blank-separated item; quoted texts and (...) are kept together
    let item = |i: &mut usize| -> Option<(usize, usize)> {
        while *i < u.len() && blank(u[*i]) {
            *i += 1;
        }
        let s = *i;
        let mut depth = 0i32;
        while *i < u.len() {
            let c = u[*i];
            if c == b'"' as u16 || c == b'\'' as u16 {
                let close = u[*i + 1..].iter().position(|&x| x == c)?;
                *i += close + 2;
                continue;
            }
            if c == b'(' as u16 {
                depth += 1;
            } else if c == b')' as u16 {
                depth -= 1;
            } else if blank(c) && depth <= 0 {
                break;
            }
            *i += 1;
        }
        (*i > s).then_some((s, *i))
    };
    let word = |(a, b): (usize, usize)| String::from_utf16_lossy(&u[a..b]).to_ascii_lowercase();
    let mut first = item(&mut i)?;
    while word(first) == "not" {
        first = item(&mut i)?;
    }
    let w = word(first);
    const ONE_ARG: [&str; 30] = [
        "acrtype", "declared", "defined", "dexist", "equtype", "errorlevel", "exist", "filtype", "funtype",
        "gamsversion", "gdxequtype", "gdxpartype", "gdxsettype", "gdxsymexist", "gdxvartype", "mactype",
        "modtype", "onstate", "partype", "pretype", "readable", "set", "setenv", "setglobal", "setlocal",
        "settype", "solver", "uelexist", "vartype", "xxxtype",
    ];
    if w == "empty" {
        return None;
    } else if ONE_ARG.contains(&w.as_str()) {
        item(&mut i)?;
    } else if w == "dimension" || w == "gdxdimension" {
        item(&mut i)?;
        item(&mut i)?;
    } else if matches!(w.as_str(), "decla_ok" | "errorfree" | "putopen" | "warnings") {
    } else if !w.contains("==") {
        // `string1 == string2` (or `string`, `expr` for $ifE)
        let mut j = i;
        if let Some(op) = item(&mut j) {
            let o = word(op);
            if o == "==" {
                item(&mut j)?;
                i = j;
            } else if o.starts_with("==") {
                i = j;
            }
        }
    }
    while i < u.len() && blank(u[i]) {
        i += 1;
    }
    (i < u.len() && u[i] != b'$' as u16).then_some(i)
}

// ------------------------------------------------------------------ outline tree

/// A comment section header (`* Data ----------`). Level = number of leading `*`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommentSection {
    pub level: u32,
    pub name: String,
    pub line: u32,
    /// UTF-16 column / length of the name
    pub start: u32,
    pub len: u32,
}

/// Parses a header line `^(\*+)\s*(.*?)\s+-{3,}` with a non-empty name. The match is
/// done on the part after the stars: the name ends at the first blank run that is
/// followed by at least three dashes.
fn parse_header(text: &str) -> Option<(u32, String, usize, usize)> {
    let stars = text.bytes().take_while(|&b| b == b'*').count();
    if stars == 0 {
        return None;
    }
    let rest = &text[stars..];
    let blank = |c: char| c.is_whitespace();
    let mut idx = None;
    for (i, c) in rest.char_indices() {
        if blank(c) && rest[i..].trim_start_matches(blank).starts_with("---") {
            idx = Some(i);
            break;
        }
    }
    let idx = idx?;
    // a framed header `*---- Name ----`: the leading dashes are not part of the name
    let framed = rest.trim_start_matches(blank);
    let dashes = framed.bytes().take_while(|&b| b == b'-').count();
    let skip = if dashes >= 3 && rest.len() - framed.len() + dashes <= idx { rest.len() - framed.len() + dashes } else { 0 };
    let name_part = &rest[skip..idx];
    let name = name_part.trim();
    if name.is_empty() {
        return None;
    }
    let lead = skip + name_part.len() - name_part.trim_start().len();
    Some((stars as u32, name.to_string(), stars + lead, name.len()))
}

/// The comment section headers of a document: comment lines (`*` in column 1, as the
/// highlighter classifies them) matching `^(\*+)\s*(.*?)\s+-{3,}`. Headers inside
/// `$onText` blocks are not comment lines and are ignored.
pub fn comment_sections(lines: &[&str], infos: &[LineInfo]) -> Vec<CommentSection> {
    let mut out = Vec::new();
    for (ln, info) in infos.iter().enumerate() {
        let Some(t) = info.tokens.first() else { continue };
        if t.kind != K::CommentLine || t.start != 0 {
            continue;
        }
        let Some(text) = lines.get(ln) else { continue };
        if let Some((level, name, bstart, blen)) = parse_header(text) {
            let start = text[..bstart].encode_utf16().count() as u32;
            let len = text[bstart..bstart + blen].encode_utf16().count() as u32;
            out.push(CommentSection { level, name, line: ln as u32, start, len });
        }
    }
    out
}

/// The kinds of outline nodes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeKind {
    /// comment section header
    Section,
    /// declared symbol with its declaration keyword (`"Parameter"`)
    Declaration(String),
    MpsgeModel,
    MpsgeSection(SectionKind),
    MpsgeVariable(SectionKind),
}

/// A node of the document outline. Lines are 0-based, columns UTF-16.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlineNode {
    pub name: String,
    pub detail: Option<String>,
    pub kind: NodeKind,
    /// selection range: `line`, `start`, `len`
    pub line: u32,
    pub start: u32,
    pub len: u32,
    /// end of the full range (the range starts at the beginning of `line` for
    /// sections and at `start` for the others)
    pub end_line: u32,
    pub end_col: u32,
    pub children: Vec<OutlineNode>,
}

fn decl_node(d: &DeclaredSymbol) -> OutlineNode {
    let kw = match &d.type_prefix {
        Some(t) => format!("{t} {}", d.keyword),
        None => d.keyword.clone(),
    };
    OutlineNode {
        name: d.name.clone(),
        detail: Some(match &d.description {
            Some(x) if !x.is_empty() => format!("{kw} - {x}"),
            _ => kw,
        }),
        kind: NodeKind::Declaration(d.keyword.clone()),
        line: d.line,
        start: d.start,
        len: d.len,
        end_line: d.line,
        end_col: d.start + d.len,
        children: vec![],
    }
}

/// Last line of a section starting at `from` that ends before `next` (exclusive),
/// without trailing blank lines.
fn section_end(lines: &[&str], from: u32, next: u32) -> u32 {
    let mut e = next.saturating_sub(1).max(from);
    while e > from && lines.get(e as usize).is_none_or(|l| l.trim().is_empty()) {
        e -= 1;
    }
    e
}

/// Builds the outline: comment sections nest the declarations and MPSGE models below
/// them (a header of level n closes the open sections of level >= n); without section
/// headers the result is the flat list of declarations (plus MPSGE models).
pub fn build_outline(lines: &[&str], infos: &[LineInfo], decls: &[DeclaredSymbol]) -> Vec<OutlineNode> {
    enum Item<'a> {
        Header(usize),
        Decl(&'a DeclaredSymbol),
        Mpsge(OutlineNode),
    }
    let headers = comment_sections(lines, infos);
    let mut items: Vec<(u32, u8, Item)> = Vec::new();
    for (i, h) in headers.iter().enumerate() {
        items.push((h.line, 0, Item::Header(i)));
    }
    for d in decls {
        items.push((d.line, 1, Item::Decl(d)));
    }
    for b in mpsge::find_blocks(lines, infos) {
        items.push((b.model_line, 1, Item::Mpsge(mpsge::outline_node(lines, &b))));
    }
    items.sort_by_key(|(l, o, _)| (*l, *o));
    let n_lines = lines.len() as u32;
    // end line of each header: before the next header of the same or a lower level
    let ends: Vec<u32> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let next = headers[i + 1..].iter().find(|x| x.level <= h.level).map_or(n_lines, |x| x.line);
            section_end(lines, h.line, next)
        })
        .collect();
    // stack of open sections: (level, node)
    let mut stack: Vec<(u32, OutlineNode)> = Vec::new();
    let mut root: Vec<OutlineNode> = Vec::new();
    fn close(stack: &mut Vec<(u32, OutlineNode)>, root: &mut Vec<OutlineNode>) {
        if let Some((_, n)) = stack.pop() {
            match stack.last_mut() {
                Some((_, p)) => p.children.push(n),
                None => root.push(n),
            }
        }
    }
    for (_, _, item) in items {
        match item {
            Item::Header(i) => {
                let h = &headers[i];
                while stack.last().is_some_and(|(l, _)| *l >= h.level) {
                    close(&mut stack, &mut root);
                }
                let end_line = ends[i];
                stack.push((
                    h.level,
                    OutlineNode {
                        name: h.name.clone(),
                        detail: Some(format!("{} section", "*".repeat(h.level as usize))),
                        kind: NodeKind::Section,
                        line: h.line,
                        start: h.start,
                        len: h.len,
                        end_line,
                        end_col: lines.get(end_line as usize).map_or(0, |l| l.encode_utf16().count() as u32),
                        children: vec![],
                    },
                ));
            }
            Item::Decl(d) => match stack.last_mut() {
                Some((_, p)) => p.children.push(decl_node(d)),
                None => root.push(decl_node(d)),
            },
            Item::Mpsge(n) => match stack.last_mut() {
                Some((_, p)) => p.children.push(n),
                None => root.push(n),
            },
        }
    }
    while !stack.is_empty() {
        close(&mut stack, &mut root);
    }
    root
}

/// Folding ranges `(start line, end line)` of the comment sections (header line to the
/// last non-blank line before the next header of the same or a lower level) and of the
/// MPSGE sections.
pub fn section_folds(lines: &[&str], infos: &[LineInfo]) -> Vec<(u32, u32)> {
    let headers = comment_sections(lines, infos);
    let n_lines = lines.len() as u32;
    let mut out = Vec::new();
    for (i, h) in headers.iter().enumerate() {
        let next = headers[i + 1..].iter().find(|x| x.level <= h.level).map_or(n_lines, |x| x.line);
        let e = section_end(lines, h.line, next);
        if e > h.line {
            out.push((h.line, e));
        }
    }
    for b in mpsge::find_blocks(lines, infos) {
        out.extend(mpsge::fold_ranges(&b));
    }
    out
}
