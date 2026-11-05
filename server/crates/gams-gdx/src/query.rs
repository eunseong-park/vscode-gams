// SPDX-License-Identifier: GPL-3.0-or-later
//! Whole-symbol sort / filter / pivot over a [`RawTable`] (all records of one symbol).
//!
//! Semantics ported from Studio `GdxSymbol::sort`, `GdxSymbol::filterRows`
//! (`src/gdxviewer/gdxsymbol.cpp`), `LabelFilter`, `ValueFilter` (`labelfilter.h`,
//! `valuefilter.h`) and `TableViewModel::initTableView` (`tableviewmodel.cpp`).
//! Column numbering is Studio's: columns `0..dim` are the key columns, `dim + i` is value slot `i`.
//! Everything here is independent of the GDX library: labels / element texts are supplied
//! by closures so the logic can be unit-tested with fake data.
use crate::Value;
use gdx_rs::{SV_ACR, SV_EPS, SV_MINF, SV_NA, SV_PINF, SV_UNDEF};
use std::collections::{BTreeSet, HashMap, HashSet};

/// All records of a symbol in file order. `keys` has `dim` UELs per record, `vals` has
/// `stride` doubles per record (1 for sets/parameters, 5 for variables/equations).
#[derive(Debug, Clone, Default)]
pub struct RawTable {
    pub dim: usize,
    pub stride: usize,
    pub is_set: bool,
    pub keys: Vec<i32>,
    pub vals: Vec<f64>,
}

impl RawTable {
    pub fn len(&self) -> usize {
        self.vals.len().checked_div(self.stride).unwrap_or(0)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn key(&self, rec: usize, d: usize) -> i32 {
        self.keys[rec * self.dim + d]
    }
    pub fn val(&self, rec: usize, i: usize) -> f64 {
        self.vals[rec * self.stride + i]
    }
    pub fn value(&self, rec: usize, i: usize) -> Value {
        Value::from_f64(self.val(rec, i))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterMode {
    Include,
    Exclude,
}

/// Label filter of one key column: `Include` shows only records whose label is listed (in
/// `labels` or matching `regex`), `Exclude` hides them (Studio `LabelFilter::isUelShown` with
/// the dialog's regex / invert options folded in).
#[derive(Debug, Clone)]
pub struct LabelFilter {
    pub column: usize,
    pub mode: FilterMode,
    pub labels: HashSet<String>,
    /// Additional pattern: a label also counts as listed if it matches (unanchored).
    pub regex: Option<regex::Regex>,
}

impl LabelFilter {
    fn listed(&self, label: &str) -> bool {
        self.labels.contains(label) || self.regex.as_ref().is_some_and(|r| r.is_match(label))
    }
}

/// Numeric column filter (Studio `ValueFilter`).
#[derive(Debug, Clone, PartialEq)]
pub struct ValueFilter {
    /// Unified column number (`dim + value slot`).
    pub column: usize,
    pub min: f64,
    pub max: f64,
    pub exclude: bool,
    pub show_undef: bool,
    pub show_na: bool,
    pub show_pinf: bool,
    pub show_minf: bool,
    pub show_eps: bool,
    pub show_acronym: bool,
}

impl ValueFilter {
    pub fn new(column: usize) -> Self {
        ValueFilter {
            column,
            min: f64::NEG_INFINITY,
            max: f64::INFINITY,
            exclude: false,
            show_undef: true,
            show_na: true,
            show_pinf: true,
            show_minf: true,
            show_eps: true,
            show_acronym: true,
        }
    }
    /// True if the record value is removed (the test in `GdxSymbol::filterRows`).
    pub fn rejects(&self, val: f64) -> bool {
        if val < SV_UNDEF {
            (!self.exclude && (val < self.min || val > self.max)) || (self.exclude && val >= self.min && val <= self.max)
        } else {
            (!self.show_undef && val == SV_UNDEF)
                || (!self.show_na && val == SV_NA)
                || (!self.show_pinf && val == SV_PINF)
                || (!self.show_minf && val == SV_MINF)
                || (!self.show_eps && val == SV_EPS)
                || (!self.show_acronym && val >= SV_ACR)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sort {
    pub column: usize,
    pub ascending: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Query {
    pub sort: Option<Sort>,
    pub label_filters: Vec<LabelFilter>,
    pub value_filters: Vec<ValueFilter>,
}

impl Query {
    pub fn is_empty(&self) -> bool {
        self.sort.is_none() && self.label_filters.is_empty() && self.value_filters.is_empty()
    }
}

/// `GdxSymbol::specVal2SortVal`.
pub fn spec_val_2_sort_val(v: f64) -> f64 {
    if v == SV_UNDEF {
        5e300
    } else if v == SV_NA {
        4e300
    } else if v == SV_PINF {
        3e300
    } else if v == SV_MINF {
        -f64::MAX
    } else if v == SV_EPS {
        4.94e-324
    } else {
        v
    }
}

/// Resolve a set of strings to dense ranks (equal strings share a rank).
fn rank_strings(items: Vec<(i32, String)>) -> HashMap<i32, f64> {
    let mut v = items;
    v.sort_by(|a, b| a.1.cmp(&b.1));
    let mut out = HashMap::with_capacity(v.len());
    let mut rank = 0f64;
    for (i, (k, s)) in v.iter().enumerate() {
        if i > 0 && *s != v[i - 1].1 {
            rank += 1.0;
        }
        out.insert(*k, rank);
    }
    out
}

/// Filter then (stable) sort the records of `t`; returns record indices in display order.
/// `label(uel)` gives the UEL label, `text(nr)` the set element text.
pub fn apply(
    t: &RawTable,
    q: &Query,
    label: &mut dyn FnMut(i32) -> String,
    text: &mut dyn FnMut(i32) -> String,
) -> Vec<u32> {
    let n = t.len();
    // --- filter
    let mut allowed: Vec<(usize, HashMap<i32, bool>, &LabelFilter)> = Vec::new();
    for f in &q.label_filters {
        if f.column < t.dim {
            allowed.push((f.column, HashMap::new(), f));
        }
    }
    let vfs: Vec<&ValueFilter> =
        q.value_filters.iter().filter(|v| !t.is_set && v.column >= t.dim && v.column - t.dim < t.stride).collect();
    let mut idx: Vec<u32> = Vec::with_capacity(n);
    'rec: for r in 0..n {
        for (col, memo, f) in allowed.iter_mut() {
            let u = t.key(r, *col);
            let shown = *memo.entry(u).or_insert_with(|| {
                (f.mode == FilterMode::Include) == f.listed(&label(u))
            });
            if !shown {
                continue 'rec;
            }
        }
        for vf in &vfs {
            if vf.rejects(t.val(r, vf.column - t.dim)) {
                continue 'rec;
            }
        }
        idx.push(r as u32);
    }
    // --- sort
    let Some(s) = q.sort else { return idx };
    let keyed: Vec<f64> = if s.column < t.dim {
        // case-insensitive label rank (Studio `labelCompIdx`)
        let uels: BTreeSet<i32> = idx.iter().map(|&r| t.key(r as usize, s.column)).collect();
        let ranks = rank_strings(uels.into_iter().map(|u| (u, label(u).to_lowercase())).collect());
        idx.iter().map(|&r| ranks[&t.key(r as usize, s.column)]).collect()
    } else if s.column - t.dim < t.stride {
        let i = s.column - t.dim;
        if t.is_set {
            // set text: case-sensitive string compare of the element text
            let nrs: BTreeSet<i32> = idx.iter().map(|&r| t.val(r as usize, 0) as i32).collect();
            let ranks = rank_strings(nrs.into_iter().map(|u| (u, if u <= 0 { "Y".to_string() } else { text(u) })).collect());
            idx.iter().map(|&r| ranks[&(t.val(r as usize, 0) as i32)]).collect()
        } else {
            idx.iter().map(|&r| spec_val_2_sort_val(t.val(r as usize, i))).collect()
        }
    } else {
        return idx;
    };
    let mut pairs: Vec<(f64, u32)> = keyed.into_iter().zip(idx).collect();
    // stable in both directions (Studio: std::stable_sort with `<` / `>`)
    if s.ascending {
        pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    } else {
        pairs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    }
    pairs.into_iter().map(|p| p.1).collect()
}

/// Unique labels of key column `col` in first-seen (file) order (Studio `uelsInColumn`).
pub fn unique_uels(t: &RawTable, col: usize) -> Vec<i32> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    if col < t.dim {
        for r in 0..t.len() {
            let u = t.key(r, col);
            if seen.insert(u) {
                out.push(u);
            }
        }
    }
    out
}

/// Pivot structure: sorted unique row / column header tuples (UEL numbers, numeric order as in
/// Studio's `std::stable_sort` of UEL lists) and the record behind each filled cell.
#[derive(Debug, Clone, Default)]
pub struct Pivot {
    pub rows: Vec<Vec<i32>>,
    pub cols: Vec<Vec<i32>>,
    pub cells: HashMap<(u32, u32), u32>,
}

/// Build the pivot of the records `recs` (indices into `t`). `row_dims` and `col_dims` must be
/// a partition of `0..dim`. With no row (column) dims there is a single empty header tuple.
pub fn pivot(t: &RawTable, recs: &[u32], row_dims: &[usize], col_dims: &[usize]) -> Pivot {
    let tuple = |r: usize, dims: &[usize]| -> Vec<i32> { dims.iter().map(|&d| t.key(r, d)).collect() };
    let mut rs: BTreeSet<Vec<i32>> = BTreeSet::new();
    let mut cs: BTreeSet<Vec<i32>> = BTreeSet::new();
    for &r in recs {
        rs.insert(tuple(r as usize, row_dims));
        cs.insert(tuple(r as usize, col_dims));
    }
    let rows: Vec<Vec<i32>> = rs.into_iter().collect();
    let cols: Vec<Vec<i32>> = cs.into_iter().collect();
    let rpos: HashMap<&Vec<i32>, u32> = rows.iter().enumerate().map(|(i, k)| (k, i as u32)).collect();
    let cpos: HashMap<&Vec<i32>, u32> = cols.iter().enumerate().map(|(i, k)| (k, i as u32)).collect();
    let mut cells = HashMap::with_capacity(recs.len());
    for &r in recs {
        let ri = rpos[&tuple(r as usize, row_dims)];
        let ci = cpos[&tuple(r as usize, col_dims)];
        cells.insert((ri, ci), r);
    }
    Pivot { rows, cols, cells }
}

/// `gmsDefRecVar` (gclgms.h): default record per variable type (.l .m .lo .ub .scale).
const DEF_REC_VAR: [[f64; 5]; 10] = [
    [0.0, 0.0, 0.0, 0.0, 1.0],
    [0.0, 0.0, 0.0, 1.0, 1.0],
    [0.0, 0.0, 0.0, SV_PINF, 1.0],
    [0.0, 0.0, 0.0, SV_PINF, 1.0],
    [0.0, 0.0, SV_MINF, 0.0, 1.0],
    [0.0, 0.0, SV_MINF, SV_PINF, 1.0],
    [0.0, 0.0, 0.0, SV_PINF, 1.0],
    [0.0, 0.0, 0.0, SV_PINF, 1.0],
    [0.0, 0.0, 1.0, SV_PINF, 1.0],
    [0.0, 0.0, 1.0, SV_PINF, 1.0],
];

/// `gmsDefRecEqu` (gclgms.h): default record per equation type (=e= =g= =l= =n= =x= =c= =b=).
const DEF_REC_EQU: [[f64; 5]; 7] = [
    [0.0, 0.0, 0.0, 0.0, 1.0],
    [0.0, 0.0, 0.0, SV_PINF, 1.0],
    [0.0, 0.0, SV_MINF, 0.0, 1.0],
    [0.0, 0.0, SV_MINF, SV_PINF, 1.0],
    [0.0, 0.0, 0.0, 0.0, 1.0],
    [0.0, 0.0, 0.0, SV_PINF, 1.0],
    [0.0, 0.0, 0.0, 0.0, 1.0],
];

/// Default record (level, marginal, lower, upper, scale) of a variable (`is_var`) / equation type.
pub fn default_record(is_var: bool, sub_type: i32) -> Option<[f64; 5]> {
    let i = usize::try_from(sub_type).ok()?;
    if is_var { DEF_REC_VAR.get(i).copied() } else { DEF_REC_EQU.get(i).copied() }
}

/// Which value columns of a variable / equation hold the default value in every record
/// (`GdxSymbol::calcDefaultColumns`; used by the viewer's "Squeeze Defaults"). `sub_type` is the
/// variable / equation type; an empty table or unknown type yields all `false`.
pub fn default_columns(t: &RawTable, is_var: bool, sub_type: i32) -> [bool; 5] {
    let mut out = [false; 5];
    let def = usize::try_from(sub_type).ok().and_then(|i| if is_var { DEF_REC_VAR.get(i) } else { DEF_REC_EQU.get(i) });
    let Some(def) = def else { return out };
    if t.stride < 5 || t.is_empty() {
        return out;
    }
    for (i, o) in out.iter_mut().enumerate() {
        *o = (0..t.len()).all(|r| t.val(r, i) == def[i]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> RawTable {
        // dim 1, par: b=2, A=EPS, c=-1, a=1e300 (UNDF)
        RawTable { dim: 1, stride: 1, is_set: false, keys: vec![1, 2, 3, 4], vals: vec![2.0, SV_EPS, -1.0, SV_UNDEF] }
    }
    fn lab(u: i32) -> String {
        ["", "b", "A", "c", "a"][u as usize].to_string()
    }

    #[test]
    fn key_sort_is_case_insensitive_and_stable() {
        let t = table();
        let q = Query { sort: Some(Sort { column: 0, ascending: true }), ..Default::default() };
        // labels lower: b A c a -> A(2) and a(4) tie (stable: 2 then 4), b(1), c(3) -> a/A, b, c
        let r = apply(&t, &q, &mut lab, &mut |_| String::new());
        assert_eq!(r, [1, 3, 0, 2]);
        let q = Query { sort: Some(Sort { column: 0, ascending: false }), ..Default::default() };
        let r = apply(&t, &q, &mut lab, &mut |_| String::new());
        assert_eq!(r, [2, 0, 1, 3]); // ties keep original order
    }

    #[test]
    fn value_sort_special_order() {
        let t = table();
        let q = Query { sort: Some(Sort { column: 1, ascending: true }), ..Default::default() };
        let r = apply(&t, &q, &mut lab, &mut |_| String::new());
        // -1 < EPS(tiny >0) < 2 < UNDF(5e300 after sort mapping)
        assert_eq!(r, [2, 1, 0, 3]);
    }

    #[test]
    fn label_and_value_filters() {
        let t = table();
        let inc = LabelFilter {
            column: 0,
            mode: FilterMode::Include,
            labels: ["b", "c"].iter().map(|s| s.to_string()).collect(),
            regex: None,
        };
        let q = Query { label_filters: vec![inc.clone()], ..Default::default() };
        assert_eq!(apply(&t, &q, &mut lab, &mut |_| String::new()), [0, 2]);
        let exc = LabelFilter { mode: FilterMode::Exclude, ..inc.clone() };
        let q = Query { label_filters: vec![exc], ..Default::default() };
        assert_eq!(apply(&t, &q, &mut lab, &mut |_| String::new()), [1, 3]);
        let re = LabelFilter { labels: HashSet::new(), regex: regex::Regex::new("(?i)^a$").ok(), ..inc.clone() };
        let q = Query { label_filters: vec![re], ..Default::default() };
        assert_eq!(apply(&t, &q, &mut lab, &mut |_| String::new()), [1, 3]); // A and a
        let mut vf = ValueFilter::new(1);
        vf.min = 0.0;
        vf.max = 10.0;
        vf.show_undef = false;
        let q = Query { value_filters: vec![vf.clone()], ..Default::default() };
        // -1 out of range; UNDF hidden; EPS shown; 2 in range
        assert_eq!(apply(&t, &q, &mut lab, &mut |_| String::new()), [0, 1]);
        vf.exclude = true;
        let q = Query { value_filters: vec![vf], ..Default::default() };
        assert_eq!(apply(&t, &q, &mut lab, &mut |_| String::new()), [1, 2]);
    }

    #[test]
    fn pivot_headers_numeric_order() {
        let t = RawTable { dim: 2, stride: 1, is_set: false, keys: vec![2, 1, 1, 1, 2, 2], vals: vec![10.0, 20.0, 30.0] };
        let p = pivot(&t, &[0, 1, 2], &[0], &[1]);
        assert_eq!(p.rows, [vec![1], vec![2]]);
        assert_eq!(p.cols, [vec![1], vec![2]]);
        assert_eq!(p.cells[&(1, 0)], 0);
        assert_eq!(p.cells[&(0, 0)], 1);
        assert_eq!(p.cells[&(1, 1)], 2);
        assert!(!p.cells.contains_key(&(0, 1)));
        let s = pivot(&t, &[0, 1, 2], &[0, 1], &[]);
        assert_eq!((s.rows.len(), s.cols.len()), (3, 1));
    }

    #[test]
    fn default_columns_detection() {
        // free variable (type 5): defaults l=0 m=0 lo=-inf ub=+inf scale=1
        let t = RawTable {
            dim: 1,
            stride: 5,
            is_set: false,
            keys: vec![1, 2],
            vals: vec![0.0, 0.5, SV_MINF, SV_PINF, 1.0, 0.0, 0.0, SV_MINF, SV_PINF, 2.0],
        };
        assert_eq!(default_columns(&t, true, 5), [true, false, true, true, false]);
        // the same table as a positive variable: lower bound -inf is not the default 0
        assert_eq!(default_columns(&t, true, 3), [true, false, false, true, false]);
        assert_eq!(default_columns(&t, true, 99), [false; 5]);
        assert_eq!(default_columns(&RawTable { stride: 5, ..Default::default() }, true, 5), [false; 5]);
        assert!(default_columns(&t, false, 3)[3]); // =n=: ub +inf
    }
}
