// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
//! Compact string list (one allocation for all bytes) with the lookup semantics of
//! `TXStrHashList` (`src/gdlib/strhash.hpp`): `IndexOf` is ASCII case-insensitive (case-
//! sensitive for `TXCSStrHashList`) and, because `HashAll` pushes every entry to the front of
//! its bucket chain, finds the *last* stored duplicate.
use std::collections::HashMap;

#[derive(Debug, Default, Clone)]
pub(crate) struct StrPool {
    data: Vec<u8>,
    ends: Vec<usize>,
}

impl StrPool {
    pub fn with_capacity(n: usize, bytes: usize) -> Self {
        StrPool { data: Vec::with_capacity(bytes), ends: Vec::with_capacity(n) }
    }
    pub fn len(&self) -> usize {
        self.ends.len()
    }
    /// Append; returns the 0-based index.
    pub fn push(&mut self, s: &[u8]) -> usize {
        self.data.extend_from_slice(s);
        self.ends.push(self.data.len());
        self.ends.len() - 1
    }
    /// 0-based access.
    pub fn get(&self, i: usize) -> Option<&[u8]> {
        let end = *self.ends.get(i)?;
        let start = if i == 0 { 0 } else { self.ends[i - 1] };
        Some(&self.data[start..end])
    }
    pub fn iter(&self) -> impl Iterator<Item = &[u8]> {
        (0..self.len()).map(move |i| self.get(i).unwrap_or_default())
    }
    /// Lookup table: key -> 0-based index of the last entry with that key.
    pub fn build_index(&self, case_insensitive: bool) -> HashMap<Box<[u8]>, u32> {
        let mut m = HashMap::with_capacity(self.len());
        for (i, s) in self.iter().enumerate() {
            let k: Box<[u8]> = if case_insensitive { crate::upper_key(s) } else { s.into() };
            m.insert(k, i as u32);
        }
        m
    }
}
