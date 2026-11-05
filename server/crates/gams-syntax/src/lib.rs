// SPDX-License-Identifier: GPL-3.0-or-later
//! `gams-syntax`: a pure-Rust port of the GAMS Studio syntax highlighter.
//!
//! - [`highlight_line`] / [`highlight_document`]: Studio's line-based state machine
//!   (`src/syntax/syntaxhighlighter.cpp` and the syntax classes it drives).
//! - [`generated::syntaxdata`]: keyword tables generated from
//!   `$GAMS_SYSDIR/apifiles/C++/api/syntaxdata.h` (`cargo run -p gams-syntax --bin gen_tables`).
//! - [`semantic`]: mapping to LSP semantic tokens.
//! - [`outline`]: declared symbols for a document outline (plus comment sections).
//! - [`mpsge`]: MPSGE blocks inside `$onText` (extension, not in Studio).
//! - [`completion`]: Studio's code completer (`src/editors/codecompleter.cpp`).
//!
//! All columns are UTF-16 code units.

mod chars;
pub mod completion;
mod dict;
pub mod generated {
    #[rustfmt::skip]
    pub mod syntaxdata;
}
mod highlighter;
mod kind;
pub mod mpsge;
pub mod outline;
pub mod semantic;
mod syntax;

pub use highlighter::{
    highlight_document, highlight_document_info, highlight_line, highlight_line_info,
    highlight_line_utf16, highlight_lines, rehighlight, rehighlight_change, split_lines, KeywordDoc, LineInfo, LineState, Nesting, ParenPos, Token,
};
pub use kind::{flavor, ColorSlot, SyntaxKind};
pub use completion::{completions, completions_in_line, completions_with, Candidate, Casing, Category, SymbolCategory, UserSymbol};
pub use outline::{
    build_outline, comment_sections, declarations, declarations_from, section_folds, CommentSection, DeclaredSymbol, NodeKind,
    OutlineNode,
};
pub use semantic::{
    encode_sem_tokens, encode_semantic_tokens, semantic_line_tokens, semantic_token_legend, semantic_token_type, semantic_tokens,
    semantic_tokens_data, semantic_tokens_edit,
    SemToken,
};

/// Keyword documentation `(keyword, description)` at a UTF-16 column of a line,
/// as Studio's `syntaxDocAt` would show it.
pub fn keyword_doc_at(info: &LineInfo, col: u32) -> Option<&KeywordDoc> {
    info.docs
        .iter()
        .rev()
        .find(|d| d.start <= col && col < d.end)
}
