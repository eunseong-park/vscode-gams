// SPDX-License-Identifier: GPL-3.0-or-later
//! Mapping of Studio syntax kinds to LSP semantic tokens.
//!
//! Studio colors every syntax kind through a theme color slot
//! (`initKind(..., Theme::Syntax_*)` in `syntaxhighlighter.cpp`, see
//! [`SyntaxKind::color_slot`]); kinds sharing a slot always share a color. We emit
//! one custom semantic token type per Studio slot (`gamsComment`,
//! `gamsDescription`, ...). The client contributes these types in `package.json`
//! with standard super types, so ordinary VS Code themes color them, and kinds in
//! the same Studio slot (e.g. `Positive` and `Variable`) can never diverge.
//! Slots Studio paints neutral (`Neutral`, `Undefined`, `Formula`) get no semantic
//! token so the TextMate base layer stays visible there.
//!
//! EXTENSION: inside MPSGE blocks ([`crate::mpsge`]) the lines of the `$onText`
//! comment are re-tokenized with the extra types `gamsMpsgeSection` and
//! `gamsMpsgeField` (and `gamsIdentifier`, `gamsAssignValue`, `gamsAssignLabel`,
//! `gamsComment`, `gamsDescription`). Text outside MPSGE blocks is unchanged.

use crate::highlighter::{highlight_document_info, split_lines, LineInfo, Token};
use crate::kind::{ColorSlot, SyntaxKind};
use crate::mpsge::{self, MKind};

/// Token types of the legend, in legend order (one per Studio color slot).
pub const TOKEN_TYPES: &[&str] = &[
    "gamsDco",
    "gamsDcoBody",
    "gamsComment",
    "gamsTitle",
    "gamsEmbedded",
    "gamsAssignLabel",
    "gamsAssignValue",
    "gamsKeyword",
    "gamsDeclaration",
    "gamsIdentifier",
    "gamsDescription",
    "gamsTableHeader",
    // extension: MPSGE blocks (not Studio slots)
    "gamsMpsgeSection",
    "gamsMpsgeField",
];

/// Legend index of `gamsMpsgeSection` (Studio colors: the declaration slot).
pub const MPSGE_SECTION: u32 = 12;
/// Legend index of `gamsMpsgeField` (Studio colors: the keyword slot).
pub const MPSGE_FIELD: u32 = 13;
/// Token modifiers of the legend (none are used; Studio has no modifiers).
pub const TOKEN_MODIFIERS: &[&str] = &[];

/// The semantic token legend `(token types, token modifiers)`.
pub fn semantic_token_legend() -> (&'static [&'static str], &'static [&'static str]) {
    (TOKEN_TYPES, TOKEN_MODIFIERS)
}

/// Legend index of the token type for a Studio color slot, `None` for neutral slots.
pub fn slot_token_type(slot: ColorSlot) -> Option<u32> {
    use ColorSlot as C;
    Some(match slot {
        C::Dco => 0,
        C::DcoBody => 1,
        C::Comment => 2,
        C::Title => 3,
        C::Embedded => 4,
        C::AssignLabel => 5,
        C::AssignValue => 6,
        C::Keyword => 7,
        C::Declaration => 8,
        C::Identifier => 9,
        C::Description => 10,
        C::TableHeader => 11,
        C::Undefined | C::Neutral | C::Formula => return None,
    })
}

/// `(token type index, modifier bits)` for a kind, or `None` if the kind is not
/// reported as a semantic token. Derived solely from the kind's Studio color slot.
///
/// DEVIATION: `EmbeddedBody` (the code between `$onEmbeddedCode`/`embeddedCode` and its end) gets no
/// token although Studio paints it with its embedded slot: the TextMate grammar embeds the
/// language of the block (`source.python`, Connect YAML), and one token per body line would hide
/// that coloring. The block's brackets stay listed like in Studio.
pub fn semantic_token_type(kind: SyntaxKind) -> Option<(u32, u32)> {
    if kind == SyntaxKind::EmbeddedBody {
        return None;
    }
    // `IdentifierDimEnd` shares Studio's identifier slot but only covers the closing
    // `)`, which Studio paints with the identifier color too; keep it.
    slot_token_type(kind.color_slot()?).map(|t| (t, 0))
}

/// A semantic token of a line (UTF-16 columns), `ty` an index into [`TOKEN_TYPES`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SemToken {
    pub start: u32,
    pub len: u32,
    pub ty: u32,
    pub mods: u32,
}

fn mpsge_type(k: MKind) -> u32 {
    match k {
        MKind::Section => MPSGE_SECTION,
        MKind::Field => MPSGE_FIELD,
        MKind::Identifier => 9,  // gamsIdentifier
        MKind::Value => 6,       // gamsAssignValue
        MKind::Label => 5,       // gamsAssignLabel
        MKind::Comment => 2,     // gamsComment
        MKind::Description => 10, // gamsDescription
    }
}

/// Semantic tokens per line from the highlighter output; MPSGE block lines are replaced
/// by the MPSGE tokenization. Lines of the block that carry no MPSGE token keep none
/// (the base `$onText` comment token is dropped).
///
/// The tokens are trimmed to their non-blank part (see [`encode_sem_tokens`]).
pub fn semantic_line_tokens(lines: &[&str], infos: &[LineInfo]) -> Vec<Vec<SemToken>> {
    let mut out: Vec<Vec<SemToken>> = infos.iter().map(|inf| inf.sem.clone()).collect();
    for (ln, toks) in mpsge_overlay(lines, infos) {
        out[ln] = toks;
    }
    out
}

/// The MPSGE token lines `(line, tokens)` replacing the Studio tokens, trimmed.
fn mpsge_overlay(lines: &[&str], infos: &[LineInfo]) -> Vec<(usize, Vec<SemToken>)> {
    let mut out = Vec::new();
    for b in mpsge::find_blocks(lines, infos) {
        for ln in b.model_line..=b.last_line {
            let text: Vec<u16> = lines.get(ln as usize).map(|t| t.encode_utf16().collect()).unwrap_or_default();
            let toks = b
                .line_tokens(ln)
                .iter()
                .filter_map(|t| {
                    let (start, len) = trim_blank(&text, t.start, t.len)?;
                    Some(SemToken { start, len, ty: mpsge_type(t.kind), mods: 0 })
                })
                .collect();
            out.push((ln as usize, toks));
        }
    }
    out
}

/// The encoded LSP semantic token data (see [`encode_sem_tokens`]) of a highlighted document,
/// including the MPSGE overlay; with `lines = Some((first, last))` only the tokens of those lines.
/// Equals `encode_sem_tokens(&semantic_line_tokens(lines, infos), lines)` (restricted to the lines)
/// without re-encoding the lines.
pub fn semantic_tokens_data(lines: &[&str], infos: &[LineInfo], range: Option<(u32, u32)>) -> Vec<u32> {
    let overlay = mpsge_overlay(lines, infos);
    let (first, last) = range.map_or((0, usize::MAX), |(a, b)| (a as usize, b as usize));
    let mut out = Vec::new();
    let (mut prev_line, mut prev_start) = (0u32, 0u32);
    let mut ov = overlay.iter().peekable();
    for (ln, inf) in infos.iter().enumerate().take(last.saturating_add(1)).skip(first) {
        while ov.peek().is_some_and(|(l, _)| *l < ln) {
            ov.next();
        }
        let toks = match ov.peek() {
            Some((l, t)) if *l == ln => t,
            _ => &inf.sem,
        };
        for t in toks {
            let line = ln as u32;
            let dl = line - prev_line;
            let ds = if dl == 0 { t.start - prev_start } else { t.start };
            out.extend_from_slice(&[dl, ds, t.len, t.ty, t.mods]);
            prev_line = line;
            prev_start = t.start;
        }
    }
    out
}

/// `[start, start+len)` of `text` without blanks at both ends (`None` if nothing is left); with an
/// empty `text` the range is kept.
pub(crate) fn trim_blank(text: &[u16], start: u32, len: u32) -> Option<(u32, u32)> {
    let (mut s, mut e) = (start as usize, (start + len) as usize);
    if !text.is_empty() {
        e = e.min(text.len());
        while s < e && is_ws(text[s]) {
            s += 1;
        }
        while e > s && is_ws(text[e - 1]) {
            e -= 1;
        }
    }
    (e > s).then(|| (s as u32, (e - s) as u32))
}

/// Encodes tokens of consecutive lines (line 0 first) as LSP relative semantic token
/// data `[deltaLine, deltaStart, length, tokenType, tokenModifiers]*`; see
/// [`encode_semantic_tokens`].
pub fn encode_sem_tokens(lines: &[Vec<SemToken>], texts: &[&str]) -> Vec<u32> {
    let mut out = Vec::new();
    let mut prev_line = 0u32;
    let mut prev_start = 0u32;
    for (ln, toks) in lines.iter().enumerate() {
        let text: Vec<u16> = texts.get(ln).map(|t| t.encode_utf16().collect()).unwrap_or_default();
        for t in toks {
            let Some((s, len)) = trim_blank(&text, t.start, t.len) else { continue };
            let line = ln as u32;
            let dl = line - prev_line;
            let ds = if dl == 0 { s - prev_start } else { s };
            out.extend_from_slice(&[dl, ds, len, t.ty, t.mods]);
            prev_line = line;
            prev_start = s;
        }
    }
    out
}

/// Encodes tokens of consecutive lines (line 0 first) as LSP relative semantic token
/// data `[deltaLine, deltaStart, length, tokenType, tokenModifiers]*`.
/// Columns are UTF-16 code units (the LSP default position encoding). Tokens made
/// only of whitespace are trimmed to their non-white part or dropped.
pub fn encode_semantic_tokens(lines: &[Vec<Token>], texts: &[&str]) -> Vec<u32> {
    let sem: Vec<Vec<SemToken>> = lines
        .iter()
        .map(|ts| {
            ts.iter()
                .filter_map(|t| semantic_token_type(t.kind).map(|(ty, mods)| SemToken { start: t.start, len: t.len, ty, mods }))
                .collect()
        })
        .collect();
    encode_sem_tokens(&sem, texts)
}

fn is_ws(c: u16) -> bool {
    c == b' ' as u16 || c == b'\t' as u16
}

/// Highlights `text` and returns the encoded LSP semantic token data (including the
/// MPSGE overlay).
pub fn semantic_tokens(text: &str) -> Vec<u32> {
    let lines = split_lines(text);
    let infos = highlight_document_info(text);
    semantic_tokens_data(&lines, &infos, None)
}

/// The single edit `(start, delete_count, insert)` turning the encoded token data `old` into `new`
/// (common prefix and suffix, whole tokens of 5 numbers), for `semanticTokens/full/delta`.
pub fn semantic_tokens_edit<'a>(old: &[u32], new: &'a [u32]) -> (usize, usize, &'a [u32]) {
    let n = old.len().min(new.len());
    let mut p = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    p -= p % 5;
    let mut s = old.iter().rev().zip(new.iter().rev()).take(n - p).take_while(|(a, b)| a == b).count();
    s -= s % 5;
    (p, old.len() - p - s, &new[p..new.len() - s])
}
