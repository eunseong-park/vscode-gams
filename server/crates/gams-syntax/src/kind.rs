// SPDX-License-Identifier: GPL-3.0-or-later
//! `SyntaxKind`, flavor constants and color slots.
//!
//! Ported from GAMS Studio `src/syntax/syntaxformats.h` (enum `SyntaxKind`,
//! `FlavorFlag`, `DcoFlavor`, `cFlavorChars`) and the `initKind` color-slot
//! assignment in `src/syntax/syntaxhighlighter.cpp`.

/// The kinds of syntax recognized by the Studio highlighter, in Studio order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u16)]
pub enum SyntaxKind {
    Standard,
    Dco,
    /// text following the DCO
    DcoBody,
    /// a DCO body formatted as comment
    DcoComment,
    /// a DCO body formatted as title
    Title,
    String,
    Formula,
    Assignment,
    SubDCO,
    UserCompileAttrib,
    SystemCompileAttrib,
    SystemCompileAttribR,
    SystemRunAttrib,

    CommentLine,
    CommentBlock,
    CommentEndline,
    /// Declared in Studio but no syntax is registered for it (never produced).
    CommentInline,
    IgnoredHead,
    IgnoredBlock,

    Semicolon,
    CommaIdent,
    /// must be followed by Declaration
    DeclarationSetType,
    /// must be followed by Declaration
    DeclarationVariableType,
    /// uses flavor bits > 1
    Declaration,

    Identifier,
    /// dimension started with '(' or '[' - uses flavor bit 1
    IdentifierDim,
    /// dimension end with ')' or ']' - uses flavor bit 1
    IdentifierDimEnd,
    IdentifierDescription,

    IdentifierAssignment,
    AssignmentLabel,
    AssignmentValue,
    AssignmentSystemData,
    /// after assignment to keep declaration-level
    IdentifierAssignmentEnd,

    IdentifierTableAssignmentColHead,
    IdentifierTableAssignmentRowHead,
    /// after assignment to keep declaration-level
    IdentifierTableAssignmentRow,

    Embedded,
    EmbeddedBody,
    EmbeddedEnd,
    Reserved,
    Abort,
    AbortKey,
    Solve,
    SolveBody,
    SolveKey,
    Option,
    OptionBody,
    OptionKey,
    Execute,
    ExecuteBody,
    ExecuteKey,
    ExecuteTool,
    ExecuteToolKey,
    Put,
    /// Formula that allows SystemRunAttrib
    PutFormula,
}

impl SyntaxKind {
    /// All kinds in declaration order (`KindCount` excluded).
    pub const ALL: [SyntaxKind; 55] = {
        use SyntaxKind as K;
        [
            K::Standard,
            K::Dco,
            K::DcoBody,
            K::DcoComment,
            K::Title,
            K::String,
            K::Formula,
            K::Assignment,
            K::SubDCO,
            K::UserCompileAttrib,
            K::SystemCompileAttrib,
            K::SystemCompileAttribR,
            K::SystemRunAttrib,
            K::CommentLine,
            K::CommentBlock,
            K::CommentEndline,
            K::CommentInline,
            K::IgnoredHead,
            K::IgnoredBlock,
            K::Semicolon,
            K::CommaIdent,
            K::DeclarationSetType,
            K::DeclarationVariableType,
            K::Declaration,
            K::Identifier,
            K::IdentifierDim,
            K::IdentifierDimEnd,
            K::IdentifierDescription,
            K::IdentifierAssignment,
            K::AssignmentLabel,
            K::AssignmentValue,
            K::AssignmentSystemData,
            K::IdentifierAssignmentEnd,
            K::IdentifierTableAssignmentColHead,
            K::IdentifierTableAssignmentRowHead,
            K::IdentifierTableAssignmentRow,
            K::Embedded,
            K::EmbeddedBody,
            K::EmbeddedEnd,
            K::Reserved,
            K::Abort,
            K::AbortKey,
            K::Solve,
            K::SolveBody,
            K::SolveKey,
            K::Option,
            K::OptionBody,
            K::OptionKey,
            K::Execute,
            K::ExecuteBody,
            K::ExecuteKey,
            K::ExecuteTool,
            K::ExecuteToolKey,
            K::Put,
            K::PutFormula,
        ]
    };

    /// Studio's `syntaxKindName` (the enum identifier).
    pub fn name(self) -> &'static str {
        use SyntaxKind as K;
        match self {
            K::Standard => "Standard",
            K::Dco => "Dco",
            K::DcoBody => "DcoBody",
            K::DcoComment => "DcoComment",
            K::Title => "Title",
            K::String => "String",
            K::Formula => "Formula",
            K::Assignment => "Assignment",
            K::SubDCO => "SubDCO",
            K::UserCompileAttrib => "UserCompileAttrib",
            K::SystemCompileAttrib => "SystemCompileAttrib",
            K::SystemCompileAttribR => "SystemCompileAttribR",
            K::SystemRunAttrib => "SystemRunAttrib",
            K::CommentLine => "CommentLine",
            K::CommentBlock => "CommentBlock",
            K::CommentEndline => "CommentEndline",
            K::CommentInline => "CommentInline",
            K::IgnoredHead => "IgnoredHead",
            K::IgnoredBlock => "IgnoredBlock",
            K::Semicolon => "Semicolon",
            K::CommaIdent => "CommaIdent",
            K::DeclarationSetType => "DeclarationSetType",
            K::DeclarationVariableType => "DeclarationVariableType",
            K::Declaration => "Declaration",
            K::Identifier => "Identifier",
            K::IdentifierDim => "IdentifierDim",
            K::IdentifierDimEnd => "IdentifierDimEnd",
            K::IdentifierDescription => "IdentifierDescription",
            K::IdentifierAssignment => "IdentifierAssignment",
            K::AssignmentLabel => "AssignmentLabel",
            K::AssignmentValue => "AssignmentValue",
            K::AssignmentSystemData => "AssignmentSystemData",
            K::IdentifierAssignmentEnd => "IdentifierAssignmentEnd",
            K::IdentifierTableAssignmentColHead => "IdentifierTableAssignmentColHead",
            K::IdentifierTableAssignmentRowHead => "IdentifierTableAssignmentRowHead",
            K::IdentifierTableAssignmentRow => "IdentifierTableAssignmentRow",
            K::Embedded => "Embedded",
            K::EmbeddedBody => "EmbeddedBody",
            K::EmbeddedEnd => "EmbeddedEnd",
            K::Reserved => "Reserved",
            K::Abort => "Abort",
            K::AbortKey => "AbortKey",
            K::Solve => "Solve",
            K::SolveBody => "SolveBody",
            K::SolveKey => "SolveKey",
            K::Option => "Option",
            K::OptionBody => "OptionBody",
            K::OptionKey => "OptionKey",
            K::Execute => "Execute",
            K::ExecuteBody => "ExecuteBody",
            K::ExecuteKey => "ExecuteKey",
            K::ExecuteTool => "ExecuteTool",
            K::ExecuteToolKey => "ExecuteToolKey",
            K::Put => "Put",
            K::PutFormula => "PutFormula",
        }
    }

    /// The Studio theme color slot assigned in `SyntaxHighlighter::SyntaxHighlighter`
    /// (`initKind(..., Theme::Syntax_*)`). `None` for `CommentInline`, which has no
    /// registered syntax.
    pub fn color_slot(self) -> Option<ColorSlot> {
        use ColorSlot as C;
        use SyntaxKind as K;
        Some(match self {
            K::Standard => C::Undefined,
            K::Dco | K::SubDCO => C::Dco,
            K::DcoBody | K::IgnoredHead => C::DcoBody,
            K::DcoComment | K::CommentLine | K::CommentBlock | K::CommentEndline => C::Comment,
            K::Title => C::Title,
            K::Formula | K::PutFormula | K::Assignment => C::Formula,
            K::SolveBody
            | K::OptionBody
            | K::ExecuteBody
            | K::IgnoredBlock
            | K::Semicolon
            | K::CommaIdent => C::Neutral,
            K::SystemRunAttrib
            | K::SystemCompileAttrib
            | K::SystemCompileAttribR
            | K::UserCompileAttrib
            | K::EmbeddedBody => C::Embedded,
            K::String
            | K::IdentifierAssignment
            | K::AssignmentLabel
            | K::IdentifierAssignmentEnd
            | K::AssignmentSystemData => C::AssignLabel,
            K::AssignmentValue | K::IdentifierTableAssignmentRow => C::AssignValue,
            K::AbortKey
            | K::ExecuteKey
            | K::ExecuteToolKey
            | K::SolveKey
            | K::OptionKey
            | K::Reserved
            | K::Abort
            | K::Execute
            | K::ExecuteTool
            | K::Solve
            | K::Option
            | K::Put
            | K::Embedded
            | K::EmbeddedEnd => C::Keyword,
            K::DeclarationSetType | K::DeclarationVariableType | K::Declaration => C::Declaration,
            K::Identifier | K::IdentifierDim | K::IdentifierDimEnd => C::Identifier,
            K::IdentifierDescription => C::Description,
            K::IdentifierTableAssignmentColHead | K::IdentifierTableAssignmentRowHead => {
                C::TableHeader
            }
            K::CommentInline => return None,
        })
    }

    /// True for kinds that are popped from the state at the end of a line
    /// (`mSingleLineKinds` in `syntaxhighlighter.cpp`).
    pub fn is_single_line(self) -> bool {
        use SyntaxKind as K;
        matches!(
            self,
            K::Dco
                | K::DcoBody
                | K::SubDCO
                | K::Title
                | K::CommentEndline
                | K::CommentLine
                | K::String
                | K::SystemRunAttrib
                | K::SystemCompileAttrib
                | K::SystemCompileAttribR
                | K::UserCompileAttrib
        )
    }

    /// True for the comment kinds (`mPostKindBlocker`).
    pub fn is_comment(self) -> bool {
        use SyntaxKind as K;
        matches!(
            self,
            K::CommentLine | K::CommentBlock | K::CommentEndline | K::CommentInline
        )
    }
}

/// Studio theme color slots used by the GAMS highlighter (`Theme::Syntax_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ColorSlot {
    Undefined,
    Neutral,
    Dco,
    DcoBody,
    Comment,
    Title,
    Formula,
    Embedded,
    AssignLabel,
    AssignValue,
    Keyword,
    Declaration,
    Identifier,
    Description,
    TableHeader,
}

/// `FlavorFlag` and `DcoFlavor` from `syntaxformats.h`.
pub mod flavor {
    pub const QUOTE1: i32 = 1;
    pub const QUOTE2: i32 = 2;
    pub const BRACE: i32 = QUOTE1 + QUOTE2;
    pub const QUOTE_PART: i32 = BRACE;
    pub const TABLE: i32 = 4;
    pub const MODEL: i32 = 8;
    pub const PRE_TABLE: i32 = 16;
    pub const BIND_LABEL: i32 = 32;
    pub const EXEC_DOT: i32 = 4;
    pub const ABORT_CMD: i32 = 64;

    pub const TEXT1: i32 = 1;
    pub const TEXT0: i32 = 2;
    pub const ECHO1: i32 = 3;
    pub const ECHO0: i32 = 4;
    pub const PUT1: i32 = 5;
    pub const PUT0: i32 = 6;
    pub const EX_IN1: i32 = 7;
    pub const EX_IN0: i32 = 8;
    pub const EX_OUT1: i32 = 9;
    pub const EX_OUT0: i32 = 10;
    pub const IF1: i32 = 11;
    pub const IF0: i32 = 12;
    pub const FOLD1: i32 = 13;
    pub const FOLD0: i32 = 14;
    pub const INC: i32 = 15;
    pub const ABORT: i32 = 16;
    pub const CALL: i32 = 17;
    pub const SAVE: i32 = 18;
    pub const EVAL: i32 = 19;
    pub const EMBED1: i32 = 21;
    pub const EMBED0: i32 = 22;

    /// `cFlavorChars`: nesting characters for DCO flavors 1..=14
    pub const FLAVOR_CHARS: &[u8; 14] = b"TtCcPpIiOoFfUu";

    /// `BlockCode` stores the flavor in 9 bits (`qBound(0, flavor, b2-1)`).
    pub const MAX_STORED: i32 = 511;
}
