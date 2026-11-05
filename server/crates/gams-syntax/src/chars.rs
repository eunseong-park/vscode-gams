// SPDX-License-Identifier: GPL-3.0-or-later
//! UTF-16 line access and the character predicates of `SyntaxAbstract`
//! (`syntaxformats.h`: `isWhitechar`, `isKeywordChar`, `charClass`).
//!
//! Studio works on `QString` (UTF-16 code units); this port does the same so
//! that all positions match Studio and the LSP default position encoding.
//! `QChar` predicates are approximated with Rust `char` predicates (exact for
//! ASCII); surrogate halves are treated like Qt does (neither letter nor digit).

pub(crate) const fn u(c: char) -> u16 {
    c as u16
}

fn to_char(c: u16) -> Option<char> {
    char::from_u32(c as u32)
}

/// `QChar::isLetterOrNumber`
pub(crate) fn is_letter_or_number(c: u16) -> bool {
    if c < 0x80 {
        return (c as u8).is_ascii_alphanumeric();
    }
    to_char(c).is_some_and(|c| c.is_alphanumeric())
}

/// `QChar::isLetter`
pub(crate) fn is_letter(c: u16) -> bool {
    if c < 0x80 {
        return (c as u8).is_ascii_alphabetic();
    }
    to_char(c).is_some_and(|c| c.is_alphabetic())
}

pub(crate) fn is_lower(c: u16) -> bool {
    to_char(c).is_some_and(|c| c.is_lowercase())
}

pub(crate) fn is_upper(c: u16) -> bool {
    to_char(c).is_some_and(|c| c.is_uppercase())
}

fn single_bmp(mut it: impl Iterator<Item = char>, orig: u16) -> u16 {
    match (it.next(), it.next()) {
        (Some(c), None) if (c as u32) <= 0xFFFF => c as u16,
        _ => orig,
    }
}

/// `QChar::toLower` (simple, single-unit mapping)
pub(crate) fn to_lower(c: u16) -> u16 {
    if c < 0x80 {
        return (c as u8).to_ascii_lowercase() as u16;
    }
    match to_char(c) {
        Some(ch) => single_bmp(ch.to_lowercase(), c),
        None => c,
    }
}

/// `QChar::toUpper` (simple, single-unit mapping)
pub(crate) fn to_upper(c: u16) -> u16 {
    if c < 0x80 {
        return (c as u8).to_ascii_uppercase() as u16;
    }
    match to_char(c) {
        Some(ch) => single_bmp(ch.to_uppercase(), c),
        None => c,
    }
}

/// `QChar::category() == Separator_Space || '\t' || '\n' || '\r'`
pub(crate) fn is_white_u16(c: u16) -> bool {
    matches!(
        c,
        0x20 | 0x09 | 0x0A | 0x0D | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x202F | 0x205F | 0x3000
    )
}

/// Case-insensitive equality (Qt::CaseInsensitive uses case folding; simple
/// lower-casing is equivalent for the ASCII keyword data).
pub(crate) fn eq_ci(a: &[u16], b: &[u16]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x == y || to_lower(*x) == to_lower(*y))
}

pub(crate) fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

pub(crate) fn lower_string(s: &[u16]) -> String {
    String::from_utf16_lossy(&s.iter().map(|c| to_lower(*c)).collect::<Vec<_>>())
}

/// A match of Studio's DCO regex `(^\$|\$\$)\s*([\w]+)`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DcoMatch {
    /// `capturedStart(1)`
    pub g1_start: isize,
    /// `capturedStart(2)`
    pub name_start: isize,
    /// `capturedEnd(2)` == `capturedEnd(0)`
    pub name_end: isize,
}

/// The DCO regex match starting exactly at `p` (PCRE without UCP: `\s`/`\w` are
/// ASCII; `^` only matches at position 0).
fn dco_match_at(t: &[u16], p: usize) -> Option<DcoMatch> {
    let pcre_space = |c: u16| matches!(c, 0x20 | 0x09 | 0x0A | 0x0B | 0x0C | 0x0D);
    let pcre_word = |c: u16| c < 0x80 && ((c as u8).is_ascii_alphanumeric() || c == u('_'));
    let at = |i: usize| t.get(i).copied().unwrap_or(0);
    let alts = [
        (p == 0 && at(0) == u('$')).then_some(1),
        (at(p) == u('$') && at(p + 1) == u('$')).then_some(p + 2),
    ];
    for after in alts.into_iter().flatten() {
        let mut q = after;
        while q < t.len() && pcre_space(t[q]) {
            q += 1;
        }
        let ns = q;
        while q < t.len() && pcre_word(t[q]) {
            q += 1;
        }
        if q > ns {
            return Some(DcoMatch {
                g1_start: p as isize,
                name_start: ns as isize,
                name_end: q as isize,
            });
        }
    }
    None
}

/// All positions where the DCO regex can match (precomputed once per line; Studio
/// re-runs the regex from the current index for every candidate test).
pub(crate) fn scan_dco_matches(t: &[u16]) -> Vec<DcoMatch> {
    (0..t.len())
        .filter(|&p| t[p] == u('$'))
        .filter_map(|p| dco_match_at(t, p))
        .collect()
}

/// A line of text as UTF-16 code units with bounds-safe access.
#[derive(Clone, Copy)]
pub(crate) struct Line<'a> {
    pub text: &'a [u16],
    dcos: Option<&'a [DcoMatch]>,
}

impl<'a> Line<'a> {
    pub fn new(text: &'a [u16]) -> Self {
        Line { text, dcos: None }
    }
    pub fn with_dco_matches(text: &'a [u16], dcos: &'a [DcoMatch]) -> Self {
        Line {
            text,
            dcos: Some(dcos),
        }
    }
    /// `QRegularExpression::match(line, index)` of the DCO regex.
    pub fn dco_match(&self, index: isize) -> Option<DcoMatch> {
        let index = index.max(0);
        match self.dcos {
            Some(list) => {
                let i = list.partition_point(|m| m.g1_start < index);
                list.get(i).copied()
            }
            None => (index as usize..self.text.len()).find_map(|p| dco_match_at(self.text, p)),
        }
    }
    #[inline]
    pub fn len(&self) -> isize {
        self.text.len() as isize
    }
    /// Character at `i`, or 0 if out of range (Studio always checks bounds
    /// before `QString::at`; returning 0 keeps the port panic-free).
    #[inline]
    pub fn at(&self, i: isize) -> u16 {
        if i >= 0 && (i as usize) < self.text.len() {
            self.text[i as usize]
        } else {
            0
        }
    }
    /// `SyntaxAbstract::isWhitechar(line, index)`
    #[inline]
    pub fn white(&self, i: isize) -> bool {
        i >= 0 && i < self.len() && is_white_u16(self.text[i as usize])
    }
    /// `SyntaxAbstract::isKeywordChar(line, index)`: letter/number, '_' or '.'
    #[inline]
    pub fn kw(&self, i: isize) -> bool {
        if i < 0 || i >= self.len() {
            return false;
        }
        let c = self.text[i as usize];
        is_letter_or_number(c) || c == u('_') || c == u('.')
    }
    pub fn slice(&self, from: isize, to: isize) -> &'a [u16] {
        let len = self.text.len() as isize;
        let a = from.clamp(0, len) as usize;
        let b = to.clamp(0, len) as usize;
        if a >= b {
            &[]
        } else {
            &self.text[a..b]
        }
    }
    /// `QString::indexOf(ch, from)`
    pub fn index_of(&self, ch: u16, from: isize) -> isize {
        let start = from.max(0) as usize;
        if start >= self.text.len() {
            return -1;
        }
        self.text[start..]
            .iter()
            .position(|c| *c == ch)
            .map(|p| (p + start) as isize)
            .unwrap_or(-1)
    }
}

/// `SyntaxAbstract::isKeywordChar(ch, extraChars)`
#[inline]
pub(crate) fn is_keyword_char(c: u16, extra: &[u16]) -> bool {
    is_letter_or_number(c) || extra.contains(&c)
}

pub(crate) const CC_OTHER: i32 = 0;
pub(crate) const CC_SPECIAL: i32 = 1;
pub(crate) const CC_ALPHA: i32 = 2;

/// `SyntaxAbstract::cSpecialCharacters`
const SPECIAL_CHARS: [u16; 5] = [u('"'), u('$'), u('\''), u('.'), u(';')];

/// `SyntaxAbstract::charClass`
#[inline]
pub(crate) fn char_class(ch: u16, prev: &mut i32, more_special: &[u16]) -> i32 {
    if ch < u('"') || ch > u('z') {
        *prev = CC_OTHER;
    } else if ch >= u('a') || (u('A')..=u('Z')).contains(&ch) || ch == u('_') {
        *prev = CC_ALPHA;
    } else if (u('0')..=u('9')).contains(&ch) {
        if *prev != CC_ALPHA {
            *prev = CC_OTHER;
        }
    } else {
        *prev = if SPECIAL_CHARS.contains(&ch) || more_special.contains(&ch) {
            CC_SPECIAL
        } else {
            CC_OTHER
        };
    }
    *prev
}
