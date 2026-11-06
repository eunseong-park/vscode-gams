// SPDX-License-Identifier: GPL-3.0-or-later
//! The line-by-line highlighting state machine.
//!
//! Port of `SyntaxHighlighter::highlightBlock`, `getCode`, `purgeCode` and
//! `scanParentheses` (Studio `src/syntax/syntaxhighlighter.cpp`), `BlockCode`
//! (`blockcode.h`) and `NestingData` (`blockdata.{h,cpp}`).
//!
//! Studio stores the syntax stack of each line as an index into a global list of
//! `CodeRelation`s (kind, flavor, flags, parent index). Here the stack is stored by
//! value in [`LineState`], which also carries the eol-comment configuration (see
//! `syntax.rs`). Positions are UTF-16 code units, like `QString` and LSP.

use crate::chars::{is_white_u16, scan_dco_matches, u, Line};
use crate::kind::flavor::{FLAVOR_CHARS, MAX_STORED};
use crate::kind::SyntaxKind as K;
use crate::semantic::{semantic_token_type, trim_blank, SemToken};
use crate::syntax::{
    find, is_registered, next_kinds, registry, valid_tail, Block, EolState, Shift, SyntaxState,
};

/// A highlighted range of a line. `start`/`len` are UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
    pub start: u32,
    pub len: u32,
    pub kind: K,
    /// Studio renders these with the error format (red wave underline) instead of
    /// the kind's format.
    pub error: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Frame {
    kind: K,
    flavor: i32,
    suffix: Option<Vec<u16>>,
}

/// The state carried from one line to the next (Studio: the block's user state).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct LineState {
    frames: Vec<Frame>,
    eol: EolState,
}

impl Default for LineState {
    fn default() -> Self {
        LineState {
            frames: vec![Frame {
                kind: K::Standard,
                flavor: 0,
                suffix: None,
            }],
            eol: EolState::default(),
        }
    }
}

impl LineState {
    /// The innermost active kind (e.g. `CommentBlock` inside `$onText`).
    pub fn top_kind(&self) -> K {
        self.frames.last().map(|f| f.kind).unwrap_or(K::Standard)
    }
    pub fn top_flavor(&self) -> i32 {
        self.frames.last().map(|f| f.flavor).unwrap_or(0)
    }
    /// The kind stack from outermost (always `Standard`) to innermost.
    pub fn kinds(&self) -> Vec<K> {
        self.frames.iter().map(|f| f.kind).collect()
    }
    /// True if any kind of the stack satisfies `f` (like `kinds().iter().any(..)`, without allocating).
    pub fn has_kind(&self, f: impl Fn(K) -> bool) -> bool {
        self.frames.iter().any(|fr| f(fr.kind))
    }
    /// Active block suffix name flag (`flagSuffixName`), e.g. `"c"` for `$onEcho`.
    pub fn suffix_name(&self) -> Option<String> {
        self.frames
            .last()
            .and_then(|f| f.suffix.as_ref())
            .map(|s| String::from_utf16_lossy(s))
    }
    /// Current end-of-line comment characters (default `!!`).
    pub fn eol_comment(&self) -> String {
        String::from_utf16_lossy(&self.eol.endline)
    }

    /// `SyntaxHighlighter::getCode`
    fn apply(&mut self, shift: Shift, block: &Block) {
        let frame = |kind: K| Frame {
            kind,
            flavor: block.state.flavor.clamp(0, MAX_STORED),
            suffix: block.state.suffix.clone(),
        };
        match shift {
            Shift::Skip => {}
            Shift::Out => {
                if self.frames.len() > 1 {
                    self.frames.pop();
                }
            }
            Shift::In => self.frames.push(frame(block.next)),
            Shift::Shift => {
                let f = frame(block.syntax.unwrap_or(K::Standard));
                // the root code is its own parent: shifting it keeps it as parent
                if self.frames.len() > 1 {
                    self.frames.pop();
                }
                self.frames.push(f);
            }
            Shift::Reset => {
                while self.frames.len() > 1 && self.top_kind() != K::Standard {
                    self.frames.pop();
                }
            }
        }
    }

    /// `SyntaxHighlighter::purgeCode`
    fn purge(&mut self) {
        while self.frames.len() > 1
            && self.top_kind().is_single_line()
            && self.top_kind() != K::Standard
        {
            self.frames.pop();
        }
    }
}

/// A parenthesis or block marker of a line (`ParenthesesPos`). Block markers use
/// Studio's letters: `T`/`t` $onText/$offText, `C`/`c` echo, `P`/`p` put, `I`/`i`
/// external input, `O`/`o` external output, `F`/`f` $ifThen/$endIf, `U`/`u` fold,
/// `M`/`m` $onEmbeddedCode/$offEmbeddedCode, `E`/`e` embeddedCode/endEmbeddedCode,
/// `/`/`\` data block of an assignment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParenPos {
    pub ch: char,
    pub pos: u32,
    pub opener: bool,
}

/// `NestingData`
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Nesting {
    pub impact: i32,
    pub max_depth: i32,
    pub parentheses: Vec<ParenPos>,
}

impl Nesting {
    fn add_opener(&mut self, ch: u16, pos: isize) {
        self.parentheses.push(ParenPos {
            ch: to_ch(ch),
            pos: pos.max(0) as u32,
            opener: true,
        });
        self.impact += 1;
    }
    fn add_closer(&mut self, ch: u16, pos: isize) {
        self.parentheses.push(ParenPos {
            ch: to_ch(ch),
            pos: pos.max(0) as u32,
            opener: false,
        });
        self.impact -= 1;
        if self.impact < self.max_depth {
            self.max_depth = self.impact;
        }
    }
    /// `NestingData::leftOpen`
    pub fn left_open(&self) -> i32 {
        self.max_depth
    }
    /// `NestingData::rightOpen`
    pub fn right_open(&self) -> i32 {
        self.impact - self.max_depth
    }
}

fn to_ch(c: u16) -> char {
    char::from_u32(c as u32).unwrap_or('\u{FFFD}')
}

/// Keyword documentation for a highlighted range (`docForLastRequest`), usable for hover.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeywordDoc {
    pub start: u32,
    pub end: u32,
    pub keyword: String,
    pub description: &'static str,
}

/// Full result of highlighting one line.
#[derive(Clone, Debug)]
pub struct LineInfo {
    pub tokens: Vec<Token>,
    /// The semantic tokens of the line: `tokens` mapped by [`crate::semantic_token_type`] and
    /// trimmed to their non-blank part (without the MPSGE overlay, see
    /// [`crate::semantic_line_tokens`]). Computed with the line so re-highlighting keeps it current.
    pub sem: Vec<SemToken>,
    pub nesting: Nesting,
    pub docs: Vec<KeywordDoc>,
    pub state: LineState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Fmt {
    kind: K,
    error: bool,
}

const INVALID_PARENTHESES_SYNTAX: [K; 17] = [
    K::Dco,
    K::DcoBody,
    K::DcoComment,
    K::Title,
    K::String,
    K::Assignment,
    K::CommentLine,
    K::CommentBlock,
    K::CommentEndline,
    K::CommentInline,
    K::IgnoredBlock,
    K::DeclarationSetType,
    K::DeclarationVariableType,
    K::Declaration,
    K::IdentifierDescription,
    K::Embedded,
    K::EmbeddedEnd,
];

/// `SyntaxHighlighter::scanParentheses`
///
/// `macro_body`: the block belongs to the body of a `$macro` (see the deviation below).
fn scan_parentheses(text: &Line, block: &Block, pre_kind: K, macro_body: bool, nesting: &mut Nesting) {
    let Some(kind) = block.syntax else { return };
    let start = block.start;
    let len = block.len();
    let flavor = block.state.flavor;
    let post_kind = block.next;
    if kind == K::Embedded {
        nesting.add_opener(u('E'), start);
        return;
    } else if kind == K::Dco && post_kind == K::EmbeddedBody {
        nesting.add_opener(u('M'), start);
        return;
    } else if kind == K::EmbeddedEnd {
        nesting.add_closer(u('e'), start);
        return;
    } else if pre_kind == K::EmbeddedBody && kind == K::Dco {
        nesting.add_closer(u('m'), start);
        return;
    } else if kind == K::Dco && flavor > 0 && flavor as usize <= FLAVOR_CHARS.len() {
        let c = FLAVOR_CHARS[(flavor - 1) as usize] as u16;
        if flavor % 2 != 0 {
            nesting.add_opener(c, start);
        } else {
            nesting.add_closer(c, start);
        }
        return;
    }
    // DEVIATION: the body of `$macro name(args) body` is GAMS code; its continuation lines (after
    // a trailing `\`) are highlighted as code by Studio, so list the brackets of the first line too
    // (Studio formats it as `DcoBody` and lists none, leaving the brackets of the continuation
    // lines unbalanced).
    if INVALID_PARENTHESES_SYNTAX.contains(&kind) && !(macro_body && kind == K::DcoBody) {
        return;
    }
    const VALID: [u16; 7] = [u('{'), u('['), u('('), u('}'), u(']'), u(')'), u('/')];
    let mut in_block = false;
    let mut i = start;
    while i < start + len {
        if i >= text.len() {
            break;
        }
        let c = text.at(i);
        match VALID.iter().position(|v| *v == c) {
            Some(6) => {
                if kind == K::IdentifierAssignmentEnd {
                    nesting.add_closer(u('\\'), i);
                } else if kind == K::IdentifierAssignment {
                    nesting.add_opener(u('/'), i);
                }
            }
            Some(p) if p < 3 => nesting.add_opener(c, i),
            Some(_) => nesting.add_closer(c, i),
            None => {}
        }
        // cSpecialBlocks = "\"'\"'"
        let block_kind = if c == u('"') {
            Some(0)
        } else if c == u('\'') {
            Some(1)
        } else {
            None
        };
        if let (false, Some(bk)) = (in_block, block_kind) {
            let close = if bk == 0 { u('"') } else { u('\'') };
            let i_end = text.index_of(close, i + 1);
            i = if i_end > 0 { i_end - 1 } else { text.len() - 1 };
            in_block = true;
        } else {
            in_block = false;
        }
        i += 1;
    }
}

fn is_macro_name(name: &[u16]) -> bool {
    name.len() == 5 && name.iter().zip("macro".bytes()).all(|(c, m)| (*c | 0x20) == m as u16)
}

/// Extension (not in Studio): the brackets `( [ {` / `) ] }` of a line rest the highlighter drops
/// (no syntax matches, Studio's "mark error" branch), as GAMS reads them in code: quoted texts are
/// skipped and an active end-of-line comment (after `$onEolCom`/`$eolCom`) ends the scan.
fn scan_dropped_parentheses(text: &Line, from: isize, eol: &EolState, nesting: &mut Nesting) {
    let mut i = from.max(0);
    while i < text.len() {
        let c = text.at(i);
        if c == u('"') || c == u('\'') {
            let e = text.index_of(c, i + 1);
            if e < 0 {
                return;
            }
            i = e + 1;
            continue;
        }
        if eol.dyn_char.is_some() && eol.check_endline(text, i) {
            return;
        }
        if [u('('), u('['), u('{')].contains(&c) {
            nesting.add_opener(c, i);
        } else if [u(')'), u(']'), u('}')].contains(&c) {
            nesting.add_closer(c, i);
        }
        i += 1;
    }
}

/// Post-highlight syntaxes (`mPostSyntax`), applied to `%...%` outside comments.
const POST_SYNTAX: [K; 3] = [
    K::SystemCompileAttrib,
    K::SystemCompileAttribR,
    K::UserCompileAttrib,
];

fn set_format(fmt: &mut [Option<Fmt>], start: isize, len: isize, f: Fmt) {
    let n = fmt.len() as isize;
    let a = start.clamp(0, n) as usize;
    let b = (start + len).clamp(0, n) as usize;
    for x in &mut fmt[a..b] {
        *x = Some(f);
    }
}

fn push_doc(docs: &mut Vec<KeywordDoc>, block: &Block, len: isize) {
    if let Some(d) = block.doc {
        if let Some((keyword, description)) = registry().resolve_doc(d) {
            docs.push(KeywordDoc {
                start: block.start.clamp(0, len) as u32,
                end: block.end.clamp(0, len) as u32,
                keyword,
                description,
            });
        }
    }
}

/// `SyntaxHighlighter::highlightBlock` for one line given as UTF-16.
pub fn highlight_line_utf16(prev: &LineState, text: &[u16]) -> LineInfo {
    highlight_impl(prev, text, None)
}

/// The block syntax of a line as Studio's `SyntaxHighlighter::scanSyntax` collects it
/// (`mScannedBlockSyntax`): end position of each block -> (kind, flavor); key 0 holds
/// the code active at the line start. Used by the code completer.
pub(crate) type ScanMap = std::collections::BTreeMap<isize, (K, i32)>;

/// Highlights a line and also returns its [`ScanMap`] (`scanSyntax`).
pub(crate) fn scan_line_utf16(prev: &LineState, text: &[u16]) -> (LineInfo, ScanMap) {
    let mut scan = ScanMap::new();
    let info = highlight_impl(prev, text, Some(&mut scan));
    (info, scan)
}

fn highlight_impl(prev: &LineState, text: &[u16], mut scan: Option<&mut ScanMap>) -> LineInfo {
    if let Some(m) = scan.as_deref_mut() {
        m.insert(0, (prev.top_kind(), prev.top_flavor()));
    }
    let dco_matches = scan_dco_matches(text);
    let line = Line::with_dco_matches(text, &dco_matches);
    let len = line.len();
    let mut st = prev.clone();
    let mut fmt: Vec<Option<Fmt>> = vec![None; text.len()];
    let mut post: Vec<(isize, isize)> = vec![(0, len - 1)];
    let mut empty_line_kinds = true;
    let mut nesting = Nesting::default();
    let mut docs = Vec::new();
    let mut index: isize = 0;
    let mut macro_body = false;

    while index < len {
        let top = st.frames.last().cloned().expect("root frame");
        let skind = top.kind;
        if !is_registered(skind) {
            break; // Studio: "no Syntax for ..." and return
        }
        let mut state = SyntaxState {
            flavor: top.flavor,
            suffix: top.suffix.clone(),
        };
        let mut has_content = true;
        // detect end of valid trailing characters for current syntax
        let mut tail = valid_tail(skind, &line, index, &state, &mut has_content, &st.eol);
        if has_content {
            empty_line_kinds = false;
        }
        if tail.is_valid() {
            state = tail.state.clone();
        }

        let mut next = Block::none();
        let mut eol_comment = Block::none();
        for &nk in next_kinds(skind, empty_line_kinds) {
            if !is_registered(nk) {
                continue;
            }
            let tb = find(nk, skind, &state, &line, index, &mut st.eol);
            if nk == K::CommentEndline && tb.is_valid() {
                eol_comment = tb.clone();
            }
            if tb.is_valid() && (!next.is_valid() || next.start > tb.start) {
                next = tb;
            }
        }
        // DEVIATION: blocks that begin with their leading blanks (e.g. the `/` data block after a
        // declaration) start before an end-of-line comment that follows the same blanks, so Studio
        // reads `Parameter p(i) // text (x)` with `$eolCom //` as an empty data block `//` and colors
        // the comment as code. GAMS reads it as a comment: an end-of-line comment that follows only
        // blanks wins, once end-of-line comments are on (`$onEolCom`/`$eolCom`).
        if eol_comment.is_valid()
            && st.eol.dyn_char.is_some()
            && next.syntax != Some(K::CommentEndline)
            && next.start < eol_comment.start
            && (next.start..eol_comment.start).all(|i| is_white_u16(text[i as usize]))
        {
            next = eol_comment;
        }
        if !next.is_valid() {
            if !tail.is_valid() {
                // no valid characters found, mark error
                // DEVIATION: Studio lists no parentheses for the rest of the line it drops after
                // `abort`/`execute`/`executeTool` (e.g. `abort$(a>1 and`, `execute$(x) 'ls');`). It
                // only shows a mismatch near the cursor, but our bracket nesting colors are always
                // visible, so list the brackets of that rest as code (the syntax kinds stay Studio's).
                if matches!(
                    skind,
                    K::Abort | K::AbortKey | K::Execute | K::ExecuteKey | K::ExecuteTool | K::ExecuteToolKey | K::AssignmentValue | K::AssignmentLabel
                ) {
                    scan_dropped_parentheses(&line, index, &st.eol, &mut nesting);
                }
                index = len;
                st.apply(Shift::Reset, &tail);
                continue;
            }
            next = tail;
        } else {
            empty_line_kinds = false;
            if tail.is_valid() {
                if next.start < tail.end {
                    tail.end = next.start;
                }
                if tail.is_valid() {
                    if tail.syntax != Some(K::Standard) {
                        let k = tail.syntax.unwrap_or(K::Standard);
                        set_format(
                            &mut fmt,
                            tail.start,
                            tail.len(),
                            Fmt {
                                kind: k,
                                error: false,
                            },
                        );
                        scan_parentheses(&line, &tail, skind, macro_body, &mut nesting);
                    }
                    st.apply(tail.shift, &tail);
                }
            }
        }

        let nkind = next.syntax.unwrap_or(K::Standard);
        if next.error && next.len() > 0 {
            set_format(
                &mut fmt,
                next.start,
                next.len(),
                Fmt {
                    kind: nkind,
                    error: true,
                },
            );
            push_doc(&mut docs, &next, len);
        } else if nkind != K::Standard {
            if nkind.is_comment() {
                if let Some(last) = post.last_mut() {
                    if last.1 > next.start {
                        last.1 = next.start;
                        if nkind == K::CommentInline {
                            post.push((next.end, len - 1));
                        }
                    }
                }
            }
            set_format(
                &mut fmt,
                next.start,
                next.len(),
                Fmt {
                    kind: nkind,
                    error: false,
                },
            );
            push_doc(&mut docs, &next, len);
            if nkind == K::Semicolon {
                empty_line_kinds = true;
            }
        }
        if nkind == K::Dco && !next.error {
            macro_body = line.dco_match(next.start).is_some_and(|m| {
                m.g1_start == next.start && is_macro_name(&text[m.name_start as usize..m.name_end as usize])
            });
        }
        scan_parentheses(&line, &next, skind, macro_body, &mut nesting);
        let new_index = next.end;
        st.apply(next.shift, &next);
        if let Some(m) = scan.as_deref_mut() {
            // `if (scanBlock)` in highlightBlock: record the block end and extend the
            // previous entry up to the start of this block
            m.insert(next.end, (nkind, next.state.flavor));
            if next.end > 0 {
                let prev_entry = m.range(..next.end).next_back().map(|(k, v)| (*k, *v));
                if let Some((pk, pv)) = prev_entry {
                    if pk < next.start {
                        m.insert(next.start, pv);
                        if pk > 0 {
                            m.remove(&pk);
                        }
                    }
                }
            }
        }
        // Guard (not in Studio): every valid block ends after `index`, so this never
        // triggers; it only protects against endless loops.
        index = if new_index > index { new_index } else { len };
    }

    // check post highlights
    for &(x, y) in &post {
        let mut i = x;
        while i <= y {
            if line.at(i) == u('%') {
                for &k in &POST_SYNTAX {
                    let b = find(
                        k,
                        K::Standard,
                        &SyntaxState::default(),
                        &line,
                        i,
                        &mut st.eol,
                    );
                    if b.is_valid() {
                        if let Some(m) = scan.as_deref_mut() {
                            let inner: Vec<isize> =
                                m.range(b.start + 1..b.end.max(b.start + 1)).map(|(key, _)| *key).collect();
                            for key in inner {
                                m.remove(&key);
                            }
                            m.insert(b.end, (k, b.state.flavor));
                        }
                        set_format(
                            &mut fmt,
                            b.start,
                            b.len(),
                            Fmt {
                                kind: k,
                                error: false,
                            },
                        );
                        push_doc(&mut docs, &b, len);
                        i = b.end - 1;
                        break;
                    }
                }
            }
            i += 1;
        }
    }

    st.purge();

    // compress the per-character formats into tokens
    let mut tokens = Vec::new();
    let mut i = 0usize;
    while i < fmt.len() {
        if let Some(f) = fmt[i] {
            let s = i;
            while i < fmt.len() && fmt[i] == Some(f) {
                i += 1;
            }
            tokens.push(Token {
                start: s as u32,
                len: (i - s) as u32,
                kind: f.kind,
                error: f.error,
            });
        } else {
            i += 1;
        }
    }
    docs.sort_by_key(|d| d.start);
    let sem = tokens
        .iter()
        .filter_map(|t| {
            let (ty, mods) = semantic_token_type(t.kind)?;
            let (start, len) = trim_blank(text, t.start, t.len)?;
            Some(SemToken { start, len, ty, mods })
        })
        .collect();
    LineInfo {
        tokens,
        sem,
        nesting,
        docs,
        state: st,
    }
}

/// Highlights one line (without line terminator).
pub fn highlight_line_info(prev: &LineState, line: &str) -> LineInfo {
    let u: Vec<u16> = line.encode_utf16().collect();
    highlight_line_utf16(prev, &u)
}

/// Highlights one line (without line terminator) and returns its tokens and the
/// state for the next line.
pub fn highlight_line(prev: &LineState, line: &str) -> (Vec<Token>, LineState) {
    let info = highlight_line_info(prev, line);
    (info.tokens, info.state)
}

/// Splits text into lines at `\r\n`, `\n` or `\r` (the LSP line definition).
pub fn split_lines(text: &str) -> Vec<&str> {
    if !text.as_bytes().contains(&b'\r') {
        // fast path (memchr): `\n` only
        return text.split('\n').collect();
    }
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\n' => {
                out.push(&text[start..i]);
                start = i + 1;
            }
            b'\r' => {
                out.push(&text[start..i]);
                if i + 1 < b.len() && b[i + 1] == b'\n' {
                    i += 1;
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(&text[start..]);
    out
}

/// Highlights a whole document; one token list per line.
pub fn highlight_document(text: &str) -> Vec<Vec<Token>> {
    highlight_document_info(text)
        .into_iter()
        .map(|l| l.tokens)
        .collect()
}

/// Highlights a whole document returning the full per-line information.
pub fn highlight_document_info(text: &str) -> Vec<LineInfo> {
    highlight_lines(&split_lines(text))
}

/// Highlights the lines of a document (see [`split_lines`]).
pub fn highlight_lines(lines: &[&str]) -> Vec<LineInfo> {
    let mut state = LineState::default();
    let mut out = Vec::with_capacity(lines.len());
    for l in lines {
        let info = highlight_line_info(&state, l);
        state.clone_from(&info.state);
        out.push(info);
    }
    out
}

/// Re-highlights a document incrementally after an edit (extension; Studio re-highlights the
/// changed blocks through `QSyntaxHighlighter`, which does the same: re-run from the first changed
/// block until a block's end state equals its previous end state).
///
/// `infos` must be the highlighting of `old_lines` (e.g. from [`highlight_document_info`]); on
/// return it is the highlighting of `new_lines`, identical to a full re-highlight. The changed lines
/// are found by comparing the line texts (common prefix and suffix), then lines are re-highlighted
/// from the first changed one until the state at the start of an unchanged line equals the old one.
/// Returns the range of `new_lines` that were highlighted again.
pub fn rehighlight(infos: &mut Vec<LineInfo>, old_lines: &[&str], new_lines: &[&str]) -> std::ops::Range<usize> {
    if infos.len() != old_lines.len() {
        *infos = highlight_lines(new_lines);
        return 0..new_lines.len();
    }
    let (old_len, new_len) = (old_lines.len(), new_lines.len());
    let p = old_lines.iter().zip(new_lines).take_while(|(a, b)| a == b).count();
    let max_s = old_len.min(new_len) - p;
    let s = old_lines.iter().rev().zip(new_lines.iter().rev()).take(max_s).take_while(|(a, b)| a == b).count();
    let (old_count, new_count) = (old_len - p - s, new_len - p - s);
    if old_count == 0 && new_count == 0 {
        return p..p;
    }
    rehighlight_window(infos, new_lines, p, old_count, new_count)
}

/// [`rehighlight`] for a single edit given as an LSP change: the old lines `start_line..=end_line`
/// were replaced by `inserted` (which made `new_lines`). Avoids comparing the line texts; falls back
/// to [`highlight_lines`] when the line counts do not fit (e.g. an edit joining `\r` and `\n`).
pub fn rehighlight_change(
    infos: &mut Vec<LineInfo>,
    new_lines: &[&str],
    start_line: usize,
    end_line: usize,
    inserted: &str,
) -> std::ops::Range<usize> {
    let old_len = infos.len();
    let b = inserted.as_bytes();
    let breaks = b.iter().enumerate().filter(|&(i, &c)| c == b'\n' || (c == b'\r' && b.get(i + 1) != Some(&b'\n'))).count();
    // one more line on both sides: a line break may join its neighbor (`\r` + `\n`)
    let p = start_line.saturating_sub(1);
    let old_end = (end_line + 2).min(old_len);
    if start_line > end_line || end_line >= old_len {
        *infos = highlight_lines(new_lines);
        return 0..new_lines.len();
    }
    let old_count = old_end - p;
    let new_count = (old_count + breaks).checked_sub(end_line - start_line);
    match new_count {
        Some(n) if old_len - old_count + n == new_lines.len() => rehighlight_window(infos, new_lines, p, old_count, n),
        _ => {
            *infos = highlight_lines(new_lines);
            0..new_lines.len()
        }
    }
}

/// Old lines `p..p+old_count` became new lines `p..p+new_count`; the others are unchanged.
fn rehighlight_window(
    infos: &mut Vec<LineInfo>,
    new_lines: &[&str],
    p: usize,
    old_count: usize,
    new_count: usize,
) -> std::ops::Range<usize> {
    let new_len = new_lines.len();
    let default = LineState::default();
    let mut state = if p == 0 { default.clone() } else { infos[p - 1].state.clone() };
    let mut fresh = Vec::new();
    let mut i = p;
    while i < new_len {
        if i >= p + new_count {
            // new line `i` is old line `j`, unchanged: stop when it starts in the same state
            let j = i + old_count - new_count;
            let before = if j == 0 { &default } else { &infos[j - 1].state };
            if *before == state {
                break;
            }
        }
        let info = highlight_line_info(&state, new_lines[i]);
        state.clone_from(&info.state);
        fresh.push(info);
        i += 1;
    }
    let old_end = i + old_count - new_count;
    infos.splice(p..old_end, fresh);
    p..i
}
