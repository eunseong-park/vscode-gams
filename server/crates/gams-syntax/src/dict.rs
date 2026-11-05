// SPDX-License-Identifier: GPL-3.0-or-later
//! Keyword dictionaries: port of `DictEntry`, `DictList` and
//! `SyntaxKeywordBase::findEnd` from Studio `src/syntax/syntaxdeclaration.{h,cpp}`.

use crate::chars::{is_keyword_char, is_lower, to_lower, to_upper, u, Line};

pub(crate) struct DictEntry {
    entry: Vec<u16>,
    invert_case: Vec<u16>,
    pub text: String,
}

impl DictEntry {
    fn new(text: String) -> Self {
        let entry: Vec<u16> = text.encode_utf16().collect();
        let invert_case = entry
            .iter()
            .map(|&c| {
                if is_lower(c) {
                    to_upper(c)
                } else {
                    to_lower(c)
                }
            })
            .collect();
        DictEntry {
            entry,
            invert_case,
            text,
        }
    }
    #[inline]
    fn is(&self, c: u16, i: usize) -> bool {
        self.entry[i] == c || self.invert_case[i] == c
    }
    #[inline]
    fn len(&self) -> usize {
        self.entry.len()
    }
}

/// A case-insensitively sorted keyword list (`DictList`).
pub(crate) struct DictList {
    entries: Vec<DictEntry>,
    descript: Vec<String>,
    equal_start: Vec<usize>,
}

/// `cmpStr`: `QString::compare(..., Qt::CaseInsensitive) < 0` (case folding,
/// i.e. compares lower-cased code units: `'_'` sorts before letters).
fn cmp_ci(a: &str, b: &str) -> std::cmp::Ordering {
    let la = a.encode_utf16().map(to_lower);
    let lb = b.encode_utf16().map(to_lower);
    la.cmp(lb)
}

impl DictList {
    /// `DictList(list, prefix)`; Studio uses `std::sort` (unstable) - a stable
    /// sort is used here, identical for the (duplicate free) GAMS data.
    pub fn new<S1: Into<String>, S2: Into<String>>(
        list: impl IntoIterator<Item = (S1, S2)>,
        prefix: &str,
    ) -> Self {
        let mut list: Vec<(String, String)> = list
            .into_iter()
            .map(|(a, b)| (a.into(), b.into()))
            .collect();
        list.sort_by(|a, b| cmp_ci(&a.0, &b.0));
        let mut entries = Vec::with_capacity(list.len());
        let mut descript = Vec::with_capacity(list.len());
        let mut equal_start = Vec::with_capacity(list.len());
        let mut prev: Vec<u16> = Vec::new();
        for (key, desc) in list {
            let s = format!("{prefix}{key}");
            let su: Vec<u16> = s.encode_utf16().collect();
            let mut eq = 0;
            while eq < su.len() && eq < prev.len() && to_upper(su[eq]) == to_upper(prev[eq]) {
                eq += 1;
            }
            equal_start.push(eq);
            prev = su;
            entries.push(DictEntry::new(s));
            descript.push(desc);
        }
        DictList {
            entries,
            descript,
            equal_start,
        }
    }

    pub fn count(&self) -> usize {
        self.entries.len()
    }
    pub fn entry(&self, i: usize) -> &str {
        &self.entries[i].text
    }
    pub fn doc(&self, i: usize) -> &str {
        &self.descript[i]
    }
    /// Index of an entry (case-insensitive), used to compute `mOtherKey`.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries
            .iter()
            .map(|e| e.text.as_str())
            .zip(self.descript.iter().map(|s| s.as_str()))
    }

    /// `SyntaxKeywordBase::findEnd`. Returns `(end, iKey)`; `end` is -1 when no
    /// keyword matches at `index`. `iKey` is returned even on failure because
    /// Studio callers read it unconditionally in one place.
    pub fn find_end(
        &self,
        extra: &[u16],
        line: &Line,
        index: isize,
        open_end: bool,
        mut relax_dot: bool,
    ) -> (isize, usize) {
        const RELAX: [u16; 5] = [u('-'), u('_'), u(' '), u('('), u(')')];
        let mut i_key = 0usize;
        let mut i_char = 0usize;
        let mut i_space = 0isize;
        let mut relax = false;
        let mut allow_digit = false;
        if self.entries.is_empty() {
            return (-1, 0);
        }
        loop {
            let d = &self.entries[i_key];
            let line_pos = i_char as isize + index + i_space;
            let lp_in = line_pos >= 0 && line_pos < line.len();
            let ch = line.at(line_pos);
            if (relax && lp_in && RELAX.contains(&ch))
                || (allow_digit && lp_in && (u('0')..=u('9')).contains(&ch))
            {
                i_space += 1;
            } else if !lp_in || !is_keyword_char(ch, extra) {
                if d.len() > i_char {
                    return (-1, i_key);
                }
                return (line_pos, i_key); // reached a valid end
            } else if i_char < d.len() && d.is(ch, i_char) {
                // character equals
                if relax_dot && ch == u('.') {
                    relax_dot = false;
                    relax = true;
                    allow_digit = true;
                } else {
                    allow_digit = false;
                }
                i_char += 1;
            } else if open_end && i_char == d.len() {
                return (line_pos, i_key); // reached a valid end of keyword-start
            } else {
                // different character at iChar: switch to next keyword
                i_key += 1;
                if i_key >= self.entries.len() {
                    break; // no more keywords
                }
                // next keyword starts with less equal characters than already matched
                if self.equal_start[i_key] < i_char {
                    break;
                }
            }
        }
        (-1, i_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chars::utf16;

    #[test]
    fn sorted_case_insensitive_with_underscore_first() {
        let d = DictList::new(
            [
                ("putclear", ""),
                ("put_utility", ""),
                ("Put", ""),
                ("put_utilities", ""),
            ],
            "",
        );
        let names: Vec<&str> = d.iter().map(|(k, _)| k).collect();
        assert_eq!(names, ["Put", "put_utilities", "put_utility", "putclear"]);
        assert_eq!(d.equal_start, vec![0, 3, 10, 3]);
    }

    #[test]
    fn find_end_matches_longest_and_case_insensitive() {
        let d = DictList::new([("Set", ""), ("Sets", ""), ("Scalar", "")], "");
        let ex = utf16("._");
        let l = utf16("  SETS i;");
        let (end, k) = d.find_end(&ex, &Line::new(&l), 2, false, false);
        assert_eq!(end, 6);
        assert_eq!(d.entry(k), "Sets");
        let l = utf16("Setx");
        assert_eq!(d.find_end(&ex, &Line::new(&l), 0, false, false).0, -1);
        let l = utf16("Setx");
        assert_eq!(d.find_end(&ex, &Line::new(&l), 0, true, false).0, 3);
    }
}
