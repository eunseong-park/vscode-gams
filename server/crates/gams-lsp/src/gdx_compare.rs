// SPDX-License-Identifier: GPL-3.0-or-later
//! GDX compare (extension addition; the comparison semantics follow the `gdxdiff` tool of the GAMS
//! system directory, see docs/dev/sources.md):
//!
//! * `gams/gdxCompareSymbols {pathA, pathB, eps?, relEps?, ignoreSetText?, fields?, cmpDefaults?, cmpDomains?}` -> per symbol
//!   status (`onlyA` / `onlyB` / `equal` / `different`) and row counts,
//! * `gams/gdxCompareRecords {.., name, offset, limit, onlyDiff?, statuses?}` -> a page of the merged,
//!   key-aligned record stream of one symbol (A and B values, absolute / relative differences),
//! * `gams/gdxCompareNext {.., name, from, backward?}` -> index of the next / previous differing row,
//! * `gams/gdxDiffFileSymbols|Records|Next {path, ..}` -> the same views for the output file of
//!   `gdxdiff` (symbols with an extra last dimension `dif1` / `dif2` / `ins1` / `ins2`, plus the set
//!   `FilesCompared`), so a colored diff view can reuse the compare grids.
//!
//! Runs on its own worker thread. GDX files are opened only for the duration of one request (so GAMS
//! can overwrite them any time); the merged tables are kept in a small in-memory LRU keyed by the
//! files' `(mtime, size)` and the options.
use crossbeam_channel::{unbounded, Sender};
use gams_gdx::query::default_record;
use gams_gdx::{GdxFile, RawTable, SymbolInfo, SymbolKind};
use gams_ref::path_key;
use lsp_server::{Message, RequestId, Response, ResponseError};
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use crate::gdx_index::{Ctl, CANCELLED, DEFAULT_BUDGET, REQUEST_CANCELLED};

const SV_UNDEF: f64 = gams_capi::gdx::GMS_SV_UNDEF;
const SV_NA: f64 = gams_capi::gdx::GMS_SV_NA;
const SV_PINF: f64 = gams_capi::gdx::GMS_SV_PINF;
const SV_MINF: f64 = gams_capi::gdx::GMS_SV_MINF;
const SV_EPS: f64 = gams_capi::gdx::GMS_SV_EPS;
const SV_ACR: f64 = gams_capi::gdx::GMS_SV_ACR;

/// Merged tables kept for paging (at most; the byte budget usually bites first).
const CACHE_TABLES: usize = 6;
/// Rows between two cancellation / deadline checks while merging.
const CHECK_EVERY: usize = 1 << 14;
const NONE: u32 = u32::MAX;

// ---------------------------------------------------------------- comparison rules

/// Row status in a merged table.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum RowStatus {
    Equal = 0,
    Changed = 1,
    /// only in file A (gdxdiff label `ins1`)
    Removed = 2,
    /// only in file B (gdxdiff label `ins2`)
    Added = 3,
}

impl RowStatus {
    fn from_u8(v: u8) -> RowStatus {
        match v {
            1 => RowStatus::Changed,
            2 => RowStatus::Removed,
            3 => RowStatus::Added,
            _ => RowStatus::Equal,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            RowStatus::Equal => "equal",
            RowStatus::Changed => "changed",
            RowStatus::Removed => "removed",
            RowStatus::Added => "added",
        }
    }
    fn parse(s: &str) -> Option<RowStatus> {
        match s {
            "equal" => Some(RowStatus::Equal),
            "changed" => Some(RowStatus::Changed),
            "removed" => Some(RowStatus::Removed),
            "added" => Some(RowStatus::Added),
            _ => None,
        }
    }
}

/// Options of a comparison (the `Eps`, `RelEps`, `Field`, `SetDesc`, `CmpDefaults` and `CmpDomains`
/// options of gdxdiff; `IgnoreOrder` only shrinks gdxdiff's output file and has no counterpart here).
#[derive(Clone, Debug, PartialEq)]
pub struct Opts {
    pub eps: f64,
    pub rel_eps: f64,
    pub ignore_set_text: bool,
    /// Var / Equ fields (level, marginal, lower, upper, scale) that decide whether a record differs.
    pub fields: [bool; 5],
    /// `CmpDefaults`: a parameter / variable record that exists in one file only counts as a
    /// difference even if it equals the default record. Without it such a record is ignored, as if
    /// the other file held the default (gdxdiff: "Enables the comparison of default values").
    pub cmp_defaults: bool,
    /// `CmpDomains`: symbols whose domains differ are different (and their data is not compared).
    pub cmp_domains: bool,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { eps: 0.0, rel_eps: 0.0, ignore_set_text: false, fields: [true; 5], cmp_defaults: false, cmp_domains: false }
    }
}

/// Are two GDX values the same? `gdxdiff` semantics (GAMS docs, tool GDXDIFF, "Criterion for
/// comparing numeric Values"; special-value behaviour checked against the shipped gdxdiff):
/// identical bit patterns (including every special value) are equal; otherwise the absolute test
/// `|a-b| <= eps` (EPS counts as 0 here) and the relative test `|a-b| / (1+min(|a|,|b|)) <= relEps`
/// apply to ordinary numbers only. Without tolerances EPS differs from 0.
pub fn values_equal(a: f64, b: f64, eps: f64, rel_eps: f64) -> bool {
    if a == b {
        return true;
    }
    if eps > 0.0 {
        let x = if a == SV_EPS { 0.0 } else { a };
        let y = if b == SV_EPS { 0.0 } else { b };
        if x < SV_UNDEF && y < SV_UNDEF && (x - y).abs() <= eps {
            return true;
        }
    }
    if rel_eps > 0.0 && a < SV_UNDEF && b < SV_UNDEF {
        let d = (a - b).abs();
        if d / (1.0 + a.abs().min(b.abs())) <= rel_eps {
            return true;
        }
    }
    false
}

/// Numeric value for differences (EPS = 0); `None` for the other special values.
fn numeric(v: f64) -> Option<f64> {
    if v < SV_UNDEF {
        Some(v)
    } else if v == SV_EPS {
        Some(0.0)
    } else {
        None
    }
}

/// `b - a` (absolute) and `(b - a) / |a|` (relative, only for a nonzero `a`).
pub fn differences(a: f64, b: f64) -> (Option<f64>, Option<f64>) {
    match (numeric(a), numeric(b)) {
        (Some(x), Some(y)) => {
            let d = y - x;
            (Some(d), if x != 0.0 { Some(d / x.abs()) } else { None })
        }
        _ => (None, None),
    }
}

fn val_json(v: f64, acr: &HashMap<u64, String>) -> Json {
    if v < SV_UNDEF {
        json!(v)
    } else if v == SV_UNDEF {
        json!("UNDF")
    } else if v == SV_NA {
        json!("NA")
    } else if v == SV_PINF {
        json!("+INF")
    } else if v == SV_MINF {
        json!("-INF")
    } else if v == SV_EPS {
        json!("EPS")
    } else {
        json!(acr.get(&v.to_bits()).cloned().unwrap_or_else(|| "ACRONYM".into()))
    }
}

// ---------------------------------------------------------------- merged table

/// The key-aligned records of one symbol in A and B (or the records of a gdxdiff output symbol).
/// Values stay in the two raw tables; rows only hold record numbers.
pub struct DiffTable {
    pub name: String,
    pub kind: SymbolKind,
    pub sub_type: i32,
    pub dim: usize,
    pub domain: Vec<String>,
    pub text: String,
    /// number of value slots shown (1, or 5 for variables / equations)
    pub slots: usize,
    pub is_set: bool,
    a: Rc<RawTable>,
    b: Rc<RawTable>,
    /// `dim` label ids per row; `labels[id]` is the label
    keys: Vec<u32>,
    labels: Vec<String>,
    /// (record in A, record in B) per row, `NONE` when absent
    rows: Vec<(u32, u32)>,
    status: Vec<u8>,
    /// bit i: value slot i differs
    mask: Vec<u8>,
    /// rows whose status is not `Equal`
    diff_rows: Vec<u32>,
    texts_a: HashMap<i32, String>,
    texts_b: HashMap<i32, String>,
    acronyms: HashMap<u64, String>,
    /// value used for the missing side of a changed row (gdxdiff output omits default values)
    defaults: [f64; 5],
    /// types / dimensions of the two symbols disagree
    pub mismatch: Option<String>,
    pub counts: [usize; 4],
    pub a_records: Option<usize>,
    pub b_records: Option<usize>,
}

fn raw_mem(t: &RawTable) -> u64 {
    t.keys.len() as u64 * 4 + t.vals.len() as u64 * 8
}

impl DiffTable {
    /// Bytes held by the table (both raw tables, merged keys, rows, statuses, labels and texts).
    pub fn mem_bytes(&self) -> u64 {
        let mut b = raw_mem(&self.a);
        if !Rc::ptr_eq(&self.a, &self.b) {
            b += raw_mem(&self.b);
        }
        b += self.keys.len() as u64 * 4 + self.rows.len() as u64 * 8 + self.status.len() as u64 + self.mask.len() as u64 + self.diff_rows.len() as u64 * 4;
        b += self.labels.iter().map(|l| 24 + l.len() as u64).sum::<u64>();
        b += self.texts_a.values().chain(self.texts_b.values()).chain(self.acronyms.values()).map(|t| 64 + t.len() as u64).sum::<u64>();
        b
    }

    pub fn status_of(&self, row: usize) -> RowStatus {
        RowStatus::from_u8(self.status[row])
    }
    pub fn diff_count(&self) -> usize {
        self.diff_rows.len()
    }

    fn side(&self, row: usize, b_side: bool, slot: usize) -> Option<f64> {
        let (ra, rb) = self.rows[row];
        let (rec, t) = if b_side { (rb, &self.b) } else { (ra, &self.a) };
        if rec == NONE {
            // a gdxdiff row of status "changed" with one side missing: that side holds the default
            return (self.status[row] == RowStatus::Changed as u8).then_some(self.defaults[slot.min(4)]);
        }
        Some(t.val(rec as usize, slot.min(t.stride.saturating_sub(1))))
    }

    fn text(&self, row: usize, b_side: bool) -> Option<String> {
        let (ra, rb) = self.rows[row];
        let (rec, t, texts) = if b_side { (rb, &self.b, &self.texts_b) } else { (ra, &self.a, &self.texts_a) };
        if rec == NONE {
            return None;
        }
        let n = t.val(rec as usize, 0) as i32;
        Some(texts.get(&n).cloned().unwrap_or_else(|| if n <= 0 { "Y".into() } else { String::new() }))
    }

    /// The element of a set row has no text (shown as the placeholder `Y`, like Studio does).
    fn no_text(&self, row: usize, b_side: bool) -> bool {
        let (ra, rb) = self.rows[row];
        let (rec, t) = if b_side { (rb, &self.b) } else { (ra, &self.a) };
        rec != NONE && t.val(rec as usize, 0) as i32 <= 0
    }

    /// JSON of one merged row.
    pub fn record_json(&self, row: usize) -> Json {
        let keys: Vec<&str> = (0..self.dim).map(|d| self.labels[self.keys[row * self.dim + d] as usize].as_str()).collect();
        let st = self.status_of(row);
        let mask = self.mask[row];
        if self.is_set {
            let (a, b) = (self.text(row, false), self.text(row, true));
            // `aNoText` / `bNoText`: the text shown is the placeholder `Y` of an element without text
            return json!({
                "keys": keys, "status": st.name(), "a": a.map(|t| vec![t]), "b": b.map(|t| vec![t]), "diff": [mask & 1 != 0],
                "aNoText": self.no_text(row, false), "bNoText": self.no_text(row, true),
            });
        }
        let vals = |b_side: bool| -> Option<Vec<Json>> {
            self.side(row, b_side, 0)?;
            Some((0..self.slots).filter_map(|i| self.side(row, b_side, i)).map(|v| val_json(v, &self.acronyms)).collect())
        };
        let (mut abs, mut rel) = (Vec::new(), Vec::new());
        let both = (0..self.slots).all(|i| self.side(row, false, i).is_some() && self.side(row, true, i).is_some());
        if both {
            for i in 0..self.slots {
                let (d, r) = differences(self.side(row, false, i).unwrap_or(0.0), self.side(row, true, i).unwrap_or(0.0));
                abs.push(d.map_or(Json::Null, |x| json!(x)));
                rel.push(r.map_or(Json::Null, |x| json!(x)));
            }
        }
        let diff: Vec<bool> = (0..self.slots).map(|i| mask & (1 << i) != 0).collect();
        json!({
            "keys": keys, "status": st.name(), "a": vals(false), "b": vals(true),
            "abs": if both { json!(abs) } else { Json::Null }, "rel": if both { json!(rel) } else { Json::Null },
            "diff": diff,
        })
    }

    fn info_json(&self) -> Json {
        json!({
            "name": self.name, "kind": kind_name(self.kind), "dim": self.dim, "domain": self.domain, "text": self.text,
            "slots": self.slots, "rows": self.rows.len(), "differences": self.diff_rows.len(),
            "changed": self.counts[RowStatus::Changed as usize], "added": self.counts[RowStatus::Added as usize],
            "removed": self.counts[RowStatus::Removed as usize], "equal": self.counts[RowStatus::Equal as usize],
            "mismatch": self.mismatch, "subType": self.sub_type,
        })
    }
}

fn kind_name(k: SymbolKind) -> &'static str {
    match k {
        SymbolKind::Set => "Set",
        SymbolKind::Parameter => "Parameter",
        SymbolKind::Variable => "Variable",
        SymbolKind::Equation => "Equation",
        SymbolKind::Alias => "Alias",
    }
}

fn slots_of(k: SymbolKind) -> usize {
    match k {
        SymbolKind::Variable | SymbolKind::Equation => 5,
        _ => 1,
    }
}

// ---------------------------------------------------------------- building

/// An alias is compared like the set it stands for (gdxdiff reads the aliased set's records; an
/// alias of the universe `*` has one record per UEL). The result keeps the alias' own name and is
/// of kind `Set`; `index` is the symbol to read (0 = the universe).
fn resolved_info(g: &GdxFile, mut info: SymbolInfo) -> Result<SymbolInfo, String> {
    if info.kind != SymbolKind::Alias {
        return Ok(info);
    }
    let t = usize::try_from(info.user_info).unwrap_or(0);
    if t == 0 {
        info.index = 0;
        info.kind = SymbolKind::Set;
        info.dim = 1;
        info.records = g.uel_count();
        info.domain = vec!["*".into()];
        info.sub_type = 0;
        return Ok(info);
    }
    let mut target = g.symbol(t).map_err(|e| e.to_string())?;
    // an alias of an alias is resolved by GDX itself; one more step is enough for well-formed files
    if target.kind == SymbolKind::Alias {
        return resolved_info(g, SymbolInfo { name: info.name.clone(), ..target });
    }
    target.name = info.name;
    target.explanatory_text = info.explanatory_text;
    Ok(target)
}

fn resolve_symbol(g: &GdxFile, name: &str) -> Result<Option<(usize, SymbolInfo)>, String> {
    let Some(i) = g.find_symbol(name) else { return Ok(None) };
    let info = resolved_info(g, g.symbol(i).map_err(|e| e.to_string())?)?;
    Ok(Some((info.index, info)))
}

fn read_symbol(g: &mut GdxFile, idx: usize) -> Result<RawTable, String> {
    if idx == 0 {
        Ok(g.read_universe())
    } else {
        g.read_all(idx).map_err(|e| e.to_string())
    }
}

/// Why two symbols of one name cannot be compared (kind / dimension; with `CmpDomains` also the domain).
fn symbol_mismatch(x: &SymbolInfo, y: &SymbolInfo, o: &Opts) -> Option<String> {
    if x.kind != y.kind {
        Some(format!("{} in A, {} in B", kind_name(x.kind), kind_name(y.kind)))
    } else if x.dim != y.dim {
        Some(format!("dimension {} in A, {} in B", x.dim, y.dim))
    } else if o.cmp_domains && (x.domain.len() != y.domain.len() || x.domain.iter().zip(&y.domain).any(|(p, q)| !p.eq_ignore_ascii_case(q))) {
        Some(format!("domain ({}) in A, ({}) in B", x.domain.join(","), y.domain.join(",")))
    } else {
        None
    }
}

fn limit_error(name: &str, bytes: u64, max: u64) -> String {
    format!(
        "[limit] Comparing {name} needs about {} MB in memory for both files; the compare view is limited to {} MB \
         (environment variable GAMS_GDX_MAX_QUERY_MB).",
        bytes / (1024 * 1024),
        max / (1024 * 1024)
    )
}

fn sorted_order(keys: &[u32], dim: usize, n: usize) -> Vec<u32> {
    let mut ord: Vec<u32> = (0..n as u32).collect();
    let key = |i: u32| &keys[i as usize * dim..(i as usize + 1) * dim];
    if !ord.windows(2).all(|w| key(w[0]) <= key(w[1])) {
        ord.sort_unstable_by(|&x, &y| key(x).cmp(key(y)));
    }
    ord
}

/// Merge symbol `name` of two files. A symbol present in one file only yields all rows `Removed`/`Added`.
pub fn build_file_table(ga: &mut GdxFile, gb: &mut GdxFile, name: &str, o: &Opts, max_bytes: u64, ctl: &Ctl) -> Result<DiffTable, String> {
    ctl.check()?;
    let sa = resolve_symbol(ga, name)?;
    let sb = resolve_symbol(gb, name)?;
    let (Some(first), _) = (sa.as_ref().or(sb.as_ref()), 0) else {
        return Err(format!("symbol {name} not found in either file"));
    };
    let info = first.1.clone();
    let mismatch = match (&sa, &sb) {
        (Some((_, x)), Some((_, y))) => symbol_mismatch(x, y, o),
        _ => None,
    };
    let dim = info.dim;
    let slots = slots_of(info.kind);
    let is_set = info.kind == SymbolKind::Set;
    let empty = || RawTable { dim, stride: slots, is_set, ..Default::default() };
    let mut table = DiffTable {
        name: info.name.clone(),
        kind: info.kind,
        sub_type: info.sub_type,
        dim,
        domain: info.domain.clone(),
        text: info.explanatory_text.clone(),
        slots,
        is_set,
        a: Rc::new(empty()),
        b: Rc::new(empty()),
        keys: Vec::new(),
        labels: Vec::new(),
        rows: Vec::new(),
        status: Vec::new(),
        mask: Vec::new(),
        diff_rows: Vec::new(),
        texts_a: HashMap::new(),
        texts_b: HashMap::new(),
        acronyms: HashMap::new(),
        defaults: [0.0; 5],
        mismatch,
        counts: [0; 4],
        a_records: sa.as_ref().map(|x| x.1.records),
        b_records: sb.as_ref().map(|x| x.1.records),
    };
    if table.mismatch.is_some() {
        return Ok(table);
    }
    let recs = |s: &Option<(usize, SymbolInfo)>| s.as_ref().map_or(0, |x| x.1.records);
    let bytes = merge_bytes(recs(&sa), recs(&sb), dim, slots);
    if bytes > max_bytes {
        return Err(limit_error(name, bytes, max_bytes));
    }
    let ra = match &sa {
        Some((i, _)) => read_symbol(ga, *i)?,
        None => empty(),
    };
    let rb = match &sb {
        Some((i, _)) => read_symbol(gb, *i)?,
        None => empty(),
    };
    ctl.check()?;
    let (na, nb) = (ra.len(), rb.len());

    // common label ids: the UEL numbers of A; labels only in B get ids behind them
    let uels_a = ga.uel_count() as u32;
    let mut extra: Vec<String> = Vec::new();
    let mut extra_ids: HashMap<String, u32> = HashMap::new();
    let mut map_b = vec![0u32; gb.uel_count() + 1];
    let mut kb: Vec<u32> = Vec::with_capacity(rb.keys.len());
    for (n, &u) in rb.keys.iter().enumerate() {
        if n % CHECK_EVERY == 0 {
            ctl.check()?;
        }
        let ui = u.max(0) as usize;
        if ui >= map_b.len() {
            map_b.resize(ui + 1, 0);
        }
        if map_b[ui] == 0 {
            let label = gb.uel(u);
            map_b[ui] = match ga.find_uel(&label) {
                Some(ua) if ua > 0 => ua as u32,
                _ => {
                    let next = uels_a + 1 + extra_ids.len() as u32;
                    let id = *extra_ids.entry(label.clone()).or_insert(next);
                    if id == next {
                        extra.push(label);
                    }
                    id
                }
            };
        }
        kb.push(map_b[ui]);
    }
    let ka: Vec<u32> = ra.keys.iter().map(|&u| u.max(0) as u32).collect();
    let oa = sorted_order(&ka, dim, na);
    let ob = sorted_order(&kb, dim, nb);

    // sets compare element texts; fetch the texts lazily. "No text" (number <= 0) is not the same as
    // the text "Y" (gdxdiff reports an element without text against one with the text "Y").
    let text_of = |g: &GdxFile, cache: &mut HashMap<i32, String>, n: i32| -> Option<String> {
        let t = cache.entry(n).or_insert_with(|| g.element_text(n)).clone();
        (n > 0).then_some(t)
    };
    // records of a parameter / variable that exist in one file only and equal the default record
    // (within the tolerances, on the compared fields) are no difference unless `CmpDefaults`; sets
    // and equations are always reported (checked against gdxdiff)
    let default_of = |s: &Option<(usize, SymbolInfo)>| -> Option<[f64; 5]> {
        let info = &s.as_ref()?.1;
        match info.kind {
            SymbolKind::Parameter => Some([0.0; 5]),
            SymbolKind::Variable => default_record(true, info.sub_type),
            _ => None,
        }
    };
    let (def_a, def_b) = if o.cmp_defaults { (None, None) } else { (default_of(&sa), default_of(&sb)) };
    let is_default = |t: &RawTable, rec: u32, def: [f64; 5]| -> bool {
        (0..slots).all(|s| (slots > 1 && !o.fields[s]) || values_equal(t.val(rec as usize, s), def[s], o.eps, o.rel_eps))
    };
    let (mut texts_a, mut texts_b) = (HashMap::new(), HashMap::new());
    let mut acr: HashMap<u64, String> = HashMap::new();
    let mut note_acr = |g: &GdxFile, v: f64| {
        if v >= SV_ACR {
            acr.entry(v.to_bits()).or_insert_with(|| g.acronym_name(v));
        }
    };

    fn kt(keys: &[u32], dim: usize, rec: u32) -> &[u32] {
        &keys[rec as usize * dim..(rec as usize + 1) * dim]
    }
    let (mut i, mut j) = (0usize, 0usize);
    let mut next_check = 0usize;
    let mut used = vec![false; uels_a as usize + 1 + extra.len()];
    while i < na || j < nb {
        if i + j >= next_check {
            ctl.check()?;
            next_check = i + j + CHECK_EVERY;
        }
        let ord = match (i < na, j < nb) {
            (true, true) => kt(&ka, dim, oa[i]).cmp(kt(&kb, dim, ob[j])),
            (true, false) => std::cmp::Ordering::Less,
            _ => std::cmp::Ordering::Greater,
        };
        let (ia, ib, key): (u32, u32, &[u32]) = match ord {
            std::cmp::Ordering::Less => {
                let r = oa[i];
                i += 1;
                (r, NONE, kt(&ka, dim, r))
            }
            std::cmp::Ordering::Greater => {
                let r = ob[j];
                j += 1;
                (NONE, r, kt(&kb, dim, r))
            }
            std::cmp::Ordering::Equal => {
                let (r, s) = (oa[i], ob[j]);
                i += 1;
                j += 1;
                (r, s, kt(&ka, dim, r))
            }
        };
        let (status, mask) = if ia == NONE {
            if def_b.is_some_and(|d| is_default(&rb, ib, d)) { (RowStatus::Equal, 0u8) } else { (RowStatus::Added, 0u8) }
        } else if ib == NONE {
            if def_a.is_some_and(|d| is_default(&ra, ia, d)) { (RowStatus::Equal, 0u8) } else { (RowStatus::Removed, 0u8) }
        } else if is_set {
            let ta = text_of(ga, &mut texts_a, ra.val(ia as usize, 0) as i32);
            let tb = text_of(gb, &mut texts_b, rb.val(ib as usize, 0) as i32);
            if o.ignore_set_text || ta == tb { (RowStatus::Equal, 0) } else { (RowStatus::Changed, 1) }
        } else {
            let mut m = 0u8;
            for s in 0..slots {
                let (x, y) = (ra.val(ia as usize, s), rb.val(ib as usize, s));
                note_acr(ga, x);
                note_acr(gb, y);
                let fld = slots == 1 || o.fields[s];
                if fld && !values_equal(x, y, o.eps, o.rel_eps) {
                    m |= 1 << s;
                }
            }
            if m == 0 { (RowStatus::Equal, 0) } else { (RowStatus::Changed, m) }
        };
        if is_set {
            // make sure the texts of one-sided rows are known as well
            if ia != NONE {
                text_of(ga, &mut texts_a, ra.val(ia as usize, 0) as i32);
            }
            if ib != NONE {
                text_of(gb, &mut texts_b, rb.val(ib as usize, 0) as i32);
            }
        } else {
            for s in 0..slots {
                if ia != NONE {
                    note_acr(ga, ra.val(ia as usize, s));
                }
                if ib != NONE {
                    note_acr(gb, rb.val(ib as usize, s));
                }
            }
        }
        for &k in key {
            used[k as usize] = true;
        }
        table.keys.extend_from_slice(key);
        table.rows.push((ia, ib));
        table.status.push(status as u8);
        table.mask.push(mask);
        table.counts[status as usize] += 1;
        if status != RowStatus::Equal {
            table.diff_rows.push(table.rows.len() as u32 - 1);
        }
    }
    table.labels = used
        .iter()
        .enumerate()
        .map(|(id, &u)| {
            if !u || id == 0 {
                String::new()
            } else if id <= uels_a as usize {
                ga.uel(id as i32)
            } else {
                extra[id - uels_a as usize - 1].clone()
            }
        })
        .collect();
    table.a = Rc::new(ra);
    table.b = Rc::new(rb);
    table.texts_a = texts_a;
    table.texts_b = texts_b;
    table.acronyms = acr;
    Ok(table)
}

/// Peak memory of merging two symbols: both raw tables, the key copies and sort orders used
/// while merging, and the merged rows (keys, record pairs, status, mask, difference list) for the
/// worst case that no key matches.
fn merge_bytes(na: usize, nb: usize, dim: usize, slots: usize) -> u64 {
    let (n, d) = ((na + nb) as u64, dim as u64);
    let raw = crate::gdx::raw_bytes(na, dim, slots) + crate::gdx::raw_bytes(nb, dim, slots);
    let work = n * (d * 4 + 4);
    let merged = n * (d * 4 + 8 + 1 + 1 + 4);
    raw + work + merged
}

/// Memory of a gdxdiff-output table with `n` raw records.
fn diff_bytes(n: usize, dim: usize, slots: usize) -> u64 {
    let (nn, d) = (n as u64, dim as u64);
    crate::gdx::raw_bytes(n, dim, slots) + nn * (d * 4 + 8 + 1 + 1 + 4)
}

// ---- gdxdiff output files

/// Labels gdxdiff appends as the last dimension.
fn diff_tag(label: &str) -> Option<RowStatus> {
    match label.to_ascii_lowercase().as_str() {
        "dif1" | "dif2" => Some(RowStatus::Changed),
        "ins1" => Some(RowStatus::Removed),
        "ins2" => Some(RowStatus::Added),
        _ => None,
    }
}

/// The two file names of the set `FilesCompared` (`None` if the file is no gdxdiff output).
pub fn files_compared(g: &mut GdxFile) -> Option<(String, String)> {
    let i = g.find_symbol("FilesCompared")?;
    let info = g.symbol(i).ok()?;
    if info.kind != SymbolKind::Set || info.dim != 1 {
        return None;
    }
    let recs = g.records(i, 0, 10).ok()?;
    let mut out = (String::new(), String::new());
    let mut found = 0;
    for r in recs {
        let text = g.element_text(match r.values[0] {
            gams_gdx::Value::Num(x) => x as i32,
            _ => 0,
        });
        match r.keys[0].to_ascii_lowercase().as_str() {
            "file1" => { out.0 = text; found += 1; }
            "file2" => { out.1 = text; found += 1; }
            _ => {}
        }
    }
    (found == 2).then_some(out)
}

/// Pair the `dif1`/`dif2`/`ins1`/`ins2` records of a gdxdiff output symbol into rows.
pub fn build_diff_file_table(g: &mut GdxFile, name: &str, max_bytes: u64, ctl: &Ctl) -> Result<DiffTable, String> {
    ctl.check()?;
    let Some((idx, info)) = resolve_symbol(g, name)? else { return Err(format!("symbol {name} not found")) };
    if info.dim == 0 {
        return Err(format!("{name} is not a gdxdiff difference symbol (no tag dimension)"));
    }
    let bytes = diff_bytes(info.records, info.dim, slots_of(info.kind));
    if bytes > max_bytes {
        return Err(limit_error(name, bytes, max_bytes));
    }
    let raw = Rc::new(g.read_all(idx).map_err(|e| e.to_string())?);
    ctl.check()?;
    let kd = info.dim - 1;
    let slots = slots_of(info.kind);
    let is_set = info.kind == SymbolKind::Set;
    let is_var = info.kind == SymbolKind::Variable;
    let defaults = if slots == 5 { default_record(is_var, info.sub_type).unwrap_or([0.0, 0.0, 0.0, 0.0, 1.0]) } else { [0.0; 5] };
    let mut table = DiffTable {
        name: info.name.clone(),
        kind: info.kind,
        sub_type: info.sub_type,
        dim: kd,
        domain: info.domain.iter().take(kd).cloned().collect(),
        text: info.explanatory_text.clone(),
        slots,
        is_set,
        a: raw.clone(),
        b: raw.clone(),
        keys: Vec::new(),
        labels: Vec::new(),
        rows: Vec::new(),
        status: Vec::new(),
        mask: Vec::new(),
        diff_rows: Vec::new(),
        texts_a: HashMap::new(),
        texts_b: HashMap::new(),
        acronyms: HashMap::new(),
        defaults,
        mismatch: None,
        counts: [0; 4],
        a_records: None,
        b_records: None,
    };
    let n = raw.len();
    let mut tags: HashMap<i32, Option<(RowStatus, bool)>> = HashMap::new(); // tag uel -> (status, is second file)
    let mut used = vec![false; g.uel_count() + 1];
    let mut acr = HashMap::new();
    let mut r = 0;
    let mut next_check = 0usize;
    while r < n {
        if r >= next_check {
            ctl.check()?;
            next_check = r + CHECK_EVERY;
        }
        let prefix = |k: usize| &raw.keys[k * info.dim..k * info.dim + kd];
        let mut e = r + 1;
        while e < n && prefix(e) == prefix(r) {
            e += 1;
        }
        let (mut ia, mut ib) = (NONE, NONE);
        let mut status = RowStatus::Changed;
        for k in r..e {
            let tag_uel = raw.key(k, kd);
            let tag = *tags.entry(tag_uel).or_insert_with(|| {
                let l = g.uel(tag_uel);
                diff_tag(&l).map(|s| (s, l.to_ascii_lowercase().ends_with('2')))
            });
            let Some((st, second)) = tag else {
                return Err(format!("{name}: unexpected label {:?} in the last dimension (not a gdxdiff difference symbol)", g.uel(tag_uel)));
            };
            if st != RowStatus::Changed {
                status = st;
            }
            if second { ib = k as u32 } else { ia = k as u32 }
        }
        let mut mask = 0u8;
        if is_set {
            if let (true, true) = (ia != NONE, ib != NONE) {
                mask = 1;
            }
            for (rec, texts) in [(ia, &mut table.texts_a), (ib, &mut table.texts_b)] {
                if rec != NONE {
                    let t = raw.val(rec as usize, 0) as i32;
                    texts.entry(t).or_insert_with(|| g.element_text(t));
                }
            }
            if status == RowStatus::Changed && (ia == NONE || ib == NONE) {
                mask = 1;
            }
        } else {
            for (s, &def) in defaults.iter().enumerate().take(slots) {
                let x = if ia == NONE { def } else { raw.val(ia as usize, s) };
                let y = if ib == NONE { def } else { raw.val(ib as usize, s) };
                for v in [x, y] {
                    if v >= SV_ACR {
                        acr.entry(v.to_bits()).or_insert_with(|| g.acronym_name(v));
                    }
                }
                if status == RowStatus::Changed && x != y {
                    mask |= 1 << s;
                }
            }
        }
        for d in 0..kd {
            used[raw.key(r, d).max(0) as usize] = true;
            table.keys.push(raw.key(r, d).max(0) as u32);
        }
        table.rows.push((ia, ib));
        table.status.push(status as u8);
        table.mask.push(mask);
        table.counts[status as usize] += 1;
        table.diff_rows.push(table.rows.len() as u32 - 1);
        r = e;
    }
    table.labels = used.iter().enumerate().map(|(id, &u)| if u && id > 0 { g.uel(id as i32) } else { String::new() }).collect();
    table.acronyms = acr;
    Ok(table)
}

// ---------------------------------------------------------------- jobs

#[derive(Clone, Debug)]
pub enum Source {
    Files { a: String, b: String },
    DiffFile { path: String },
}

#[derive(Clone, Debug)]
pub enum Op {
    /// `full`: merge every symbol for exact statuses and counts; otherwise only the symbols in
    /// `names` are merged and the others get the status `pending` (or what the symbol tables alone tell).
    Symbols { full: bool, names: Vec<String> },
    Records { name: String, offset: usize, limit: usize, vis: Vis },
    /// Test hook: panics inside the worker.
    #[cfg(test)]
    Panic,
    Next { name: String, from: Option<usize>, backward: bool, vis: Vis },
}

/// Which rows a request sees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vis {
    All,
    /// every row that is not `Equal`
    Diff,
    /// bit mask over `RowStatus as u8`
    Mask(u8),
}

#[derive(Clone, Debug)]
pub struct CompareJob {
    pub source: Source,
    pub opts: Opts,
    pub op: Op,
}

pub fn parse_job(method: &str, p: Json) -> Result<CompareJob, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        path_a: Option<String>,
        path_b: Option<String>,
        path: Option<String>,
        #[serde(default)]
        eps: f64,
        #[serde(default)]
        rel_eps: f64,
        #[serde(default)]
        ignore_set_text: bool,
        #[serde(default)]
        cmp_defaults: bool,
        #[serde(default)]
        cmp_domains: bool,
        /// value slots deciding whether a variable / equation record differs (default all)
        fields: Option<Vec<usize>>,
        #[serde(default)]
        name: String,
        #[serde(default)]
        offset: usize,
        #[serde(default = "default_limit")]
        limit: usize,
        #[serde(default)]
        only_diff: bool,
        statuses: Option<Vec<String>>,
        from: Option<usize>,
        #[serde(default)]
        backward: bool,
        #[serde(default)]
        full: bool,
        #[serde(default)]
        names: Vec<String>,
    }
    fn default_limit() -> usize {
        200
    }
    let r: P = serde_json::from_value(p).map_err(|e| e.to_string())?;
    let source = if method.starts_with("gams/gdxDiffFile") {
        Source::DiffFile { path: r.path.ok_or("missing path")? }
    } else {
        Source::Files { a: r.path_a.ok_or("missing pathA")?, b: r.path_b.ok_or("missing pathB")? }
    };
    if !(r.eps >= 0.0 && r.rel_eps >= 0.0) || !r.eps.is_finite() || !r.rel_eps.is_finite() {
        return Err("eps and relEps must be finite numbers >= 0".into());
    }
    let mut fields = [true; 5];
    if let Some(f) = &r.fields {
        fields = [false; 5];
        for &i in f {
            *fields.get_mut(i).ok_or_else(|| format!("field {i} out of range (0..4)"))? = true;
        }
        if !fields.iter().any(|&x| x) {
            return Err("at least one field has to be selected".into());
        }
    }
    let vis = match &r.statuses {
        Some(list) => {
            let mut m = 0u8;
            for s in list {
                m |= 1 << RowStatus::parse(s).ok_or_else(|| format!("unknown status {s:?}"))? as u8;
            }
            Vis::Mask(m)
        }
        None if r.only_diff => Vis::Diff,
        None => Vis::All,
    };
    let op = if method.ends_with("Symbols") {
        Op::Symbols { full: r.full, names: r.names }
    } else if method.ends_with("Next") {
        Op::Next { name: r.name, from: r.from, backward: r.backward, vis }
    } else {
        Op::Records { name: r.name, offset: r.offset, limit: r.limit.min(100_000), vis }
    };
    Ok(CompareJob { source, opts: Opts { eps: r.eps, rel_eps: r.rel_eps, ignore_set_text: r.ignore_set_text, fields, cmp_defaults: r.cmp_defaults, cmp_domains: r.cmp_domains }, op })
}

struct Msg {
    id: RequestId,
    job: CompareJob,
    out: Sender<Message>,
}

#[derive(Default)]
struct Shared {
    pending: std::collections::HashSet<RequestId>,
    cancelled: std::collections::HashSet<RequestId>,
}

pub struct CompareWorker {
    tx: Sender<Msg>,
    shared: Arc<Mutex<Shared>>,
}

impl CompareWorker {
    pub fn spawn(sysdir: Option<PathBuf>) -> CompareWorker {
        Self::spawn_with(sysdir, DEFAULT_BUDGET, TableCache::default)
    }

    pub fn spawn_with(sysdir: Option<PathBuf>, budget: Duration, new_cache: fn() -> TableCache) -> CompareWorker {
        let (tx, rx) = unbounded::<Msg>();
        let shared = Arc::new(Mutex::new(Shared::default()));
        let sh = shared.clone();
        std::thread::Builder::new()
            .name("gdx-compare".into())
            .spawn(move || {
                let mut cache = new_cache();
                for m in rx {
                    let is_cancelled = || sh.lock().map(|s| s.cancelled.contains(&m.id)).unwrap_or(false);
                    let ctl = Ctl { deadline: Instant::now() + budget, cancelled: &is_cancelled };
                    // GDX files are read by gdx-rs: no GAMS system directory is needed
                    let sd = sysdir.as_deref().unwrap_or(Path::new(""));
                    let res = match crate::gdx_index::guarded(|| handle(sd, &mut cache, &m.job, &ctl)) {
                        Ok(r) => r,
                        Err(e) => {
                            // the cached tables may be inconsistent after a panic
                            cache = new_cache();
                            Err(e)
                        }
                    };
                    if let Ok(mut s) = sh.lock() {
                        s.pending.remove(&m.id);
                        s.cancelled.remove(&m.id);
                    }
                    let code = if res.as_ref().err().is_some_and(|e| e.starts_with(CANCELLED)) { REQUEST_CANCELLED } else { crate::gdx::REQUEST_FAILED };
                    let resp = Response { id: m.id, response_result: res.map_err(|message| ResponseError { code, message, data: None }) };
                    let _ = m.out.send(Message::Response(resp));
                }
            })
            .expect("spawn gdx-compare thread");
        CompareWorker { tx, shared }
    }

    pub fn submit(&self, id: RequestId, job: CompareJob, out: Sender<Message>) {
        if let Ok(mut s) = self.shared.lock() {
            s.pending.insert(id.clone());
        }
        if let Err(e) = self.tx.send(Msg { id, job, out }) {
            // the worker thread is gone: answer instead of leaving the client waiting forever
            let m = e.into_inner();
            if let Ok(mut s) = self.shared.lock() {
                s.pending.remove(&m.id);
            }
            let resp = Response {
                id: m.id,
                response_result: Err(ResponseError { code: crate::gdx::REQUEST_FAILED, message: "GDX compare worker is not running".into(), data: None }),
            };
            let _ = m.out.send(Message::Response(resp));
        }
    }

    /// `$/cancelRequest`: ignored for ids that are not (or no longer) pending here.
    pub fn cancel(&self, id: &RequestId) {
        if let Ok(mut s) = self.shared.lock() {
            if s.pending.contains(id) {
                s.cancelled.insert(id.clone());
            }
        }
    }
}

/// Merged tables, oldest first, limited by count and by their total (estimated) bytes.
pub struct TableCache {
    items: Vec<(String, Rc<DiffTable>)>,
    max_bytes: u64,
}

impl Default for TableCache {
    fn default() -> Self {
        TableCache::with_budget(max_cache_bytes())
    }
}

impl TableCache {
    pub fn with_budget(max_bytes: u64) -> TableCache {
        TableCache { items: Vec::new(), max_bytes }
    }
    fn total_bytes(&self) -> u64 {
        self.items.iter().map(|(_, t)| t.mem_bytes()).sum()
    }
    fn get(&mut self, key: &str) -> Option<Rc<DiffTable>> {
        let i = self.items.iter().position(|(k, _)| k == key)?;
        let e = self.items.remove(i);
        let v = e.1.clone();
        self.items.push(e);
        Some(v)
    }
    fn put(&mut self, key: String, t: Rc<DiffTable>) {
        self.items.retain(|(k, _)| *k != key);
        if t.mem_bytes() > self.max_bytes {
            return; // too big to keep: it is rebuilt on the next request
        }
        self.items.push((key, t));
        while self.items.len() > CACHE_TABLES || (self.items.len() > 1 && self.total_bytes() > self.max_bytes) {
            self.items.remove(0);
        }
    }
}

/// Total bytes of merged tables kept for paging: `GAMS_GDX_MAX_CACHE_MB` (default 1024).
fn max_cache_bytes() -> u64 {
    std::env::var("GAMS_GDX_MAX_CACHE_MB").ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(1024) * 1024 * 1024
}

fn stamp(p: &str) -> Result<(Option<SystemTime>, u64), String> {
    let m = std::fs::metadata(Path::new(p)).map_err(|e| format!("{p}: {e}"))?;
    Ok((m.modified().ok(), m.len()))
}

fn table_key(src: &Source, o: &Opts, name: &str) -> Result<String, String> {
    Ok(match src {
        Source::Files { a, b } => format!("{}|{:?}|{}|{:?}|{}|{o:?}|{}", path_key(a), stamp(a)?, path_key(b), stamp(b)?, 0, name.to_lowercase()),
        Source::DiffFile { path } => format!("{}|{:?}|diff|{}", path_key(path), stamp(path)?, name.to_lowercase()),
    })
}

fn open(sd: &Path, p: &str) -> Result<GdxFile, String> {
    GdxFile::open(sd, Path::new(p)).map_err(|e| e.to_string())
}

fn max_bytes() -> u64 {
    static L: std::sync::OnceLock<crate::gdx::Limits> = std::sync::OnceLock::new();
    L.get_or_init(crate::gdx::Limits::from_env).max_raw_bytes
}

fn table_for(sd: &Path, cache: &mut TableCache, job: &CompareJob, name: &str, ctl: &Ctl) -> Result<Rc<DiffTable>, String> {
    let key = table_key(&job.source, &job.opts, name)?;
    if let Some(t) = cache.get(&key) {
        return Ok(t);
    }
    let t = match &job.source {
        Source::Files { a, b } => {
            let (mut ga, mut gb) = (open(sd, a)?, open(sd, b)?);
            build_file_table(&mut ga, &mut gb, name, &job.opts, max_bytes(), ctl)?
        }
        Source::DiffFile { path } => {
            let mut g = open(sd, path)?;
            build_diff_file_table(&mut g, name, max_bytes(), ctl)?
        }
    };
    let t = Rc::new(t);
    cache.put(key, t.clone());
    Ok(t)
}

fn visible(t: &DiffTable, vis: Vis) -> Option<Vec<u32>> {
    match vis {
        Vis::All => None,
        Vis::Diff => Some(t.diff_rows.clone()),
        Vis::Mask(m) => Some((0..t.rows.len() as u32).filter(|&r| m & (1 << t.status[r as usize]) != 0).collect()),
    }
}

fn symbol_summary(t: &DiffTable, status: &str, extra: Json) -> Json {
    let mut j = t.info_json();
    j["status"] = json!(status);
    j["aRecords"] = json!(t.a_records);
    j["bRecords"] = json!(t.b_records);
    if let Some(o) = extra.as_object() {
        for (k, v) in o {
            j[k] = v.clone();
        }
    }
    j
}

fn handle(sd: &Path, cache: &mut TableCache, job: &CompareJob, ctl: &Ctl) -> Result<Json, String> {
    ctl.check()?;
    match &job.op {
        #[cfg(test)]
        Op::Panic => panic!("injected panic"),
        Op::Symbols { full, names } => match &job.source {
            Source::Files { a, b } => files_summary(sd, cache, job, (a, b), (*full, names), ctl),
            Source::DiffFile { path } => diff_file_summary(sd, cache, job, path, ctl),
        },
        Op::Records { name, offset, limit, vis } => {
            let t = table_for(sd, cache, job, name, ctl)?;
            let list = visible(&t, *vis);
            let total = list.as_ref().map_or(t.rows.len(), Vec::len);
            let end = offset.saturating_add(*limit).min(total);
            let from = (*offset).min(end);
            let recs: Vec<Json> = (from..end).map(|i| t.record_json(list.as_ref().map_or(i, |l| l[i] as usize))).collect();
            Ok(json!({ "total": total, "rows": t.rows.len(), "differences": t.diff_rows.len(), "offset": from, "records": recs, "mismatch": t.mismatch }))
        }
        Op::Next { name, from, backward, vis } => {
            let t = table_for(sd, cache, job, name, ctl)?;
            // positions are indices into the visible rows; the next *difference* is searched
            let list = visible(&t, *vis);
            let total = list.as_ref().map_or(t.rows.len(), Vec::len);
            let row_at = |i: usize| list.as_ref().map_or(i, |l| l[i] as usize);
            let is_diff = |i: usize| t.status[row_at(i)] != RowStatus::Equal as u8;
            let found = if total == 0 {
                None
            } else if *backward {
                let start = from.map_or(total, |f| f.min(total));
                (0..start).rev().find(|&i| is_diff(i))
            } else {
                let start = from.map_or(0, |f| f.saturating_add(1));
                (start..total).find(|&i| is_diff(i))
            };
            Ok(json!({ "index": found, "total": total, "differences": t.diff_rows.len() }))
        }
    }
}

/// Summary row of a symbol that is not merged: what the two symbol tables tell.
fn light_row(name: &str, a: Option<&SymbolInfo>, b: Option<&SymbolInfo>, status: &str, note: Option<String>, o: &Opts) -> Json {
    let info = a.or(b);
    let mismatch = match (a, b) {
        (Some(x), Some(y)) => symbol_mismatch(x, y, o),
        _ => None,
    };
    // a symbol present in one file only: every record is added / removed
    let one_sided = |n: usize, key: &str| {
        let mut j = json!({ "rows": n, "differences": n, "changed": 0, "added": 0, "removed": 0, "equal": 0 });
        j[key] = json!(n);
        j
    };
    let counts = match (a, b) {
        (Some(x), None) => one_sided(x.records, "removed"),
        (None, Some(y)) => one_sided(y.records, "added"),
        _ => json!({ "rows": null, "differences": null, "changed": null, "added": null, "removed": null, "equal": null }),
    };
    let mut j = json!({
        "name": info.map_or(name, |s| s.name.as_str()), "kind": info.map(|s| kind_name(s.kind)), "dim": info.map(|s| s.dim),
        "domain": info.map(|s| s.domain.clone()), "text": info.map(|s| s.explanatory_text.clone()), "slots": info.map(|s| slots_of(s.kind)),
        "subType": info.map(|s| s.sub_type), "status": status, "mismatch": mismatch,
        "aRecords": a.map(|s| s.records), "bRecords": b.map(|s| s.records),
    });
    if let Some(n) = note {
        j["note"] = json!(n);
    }
    for (k, v) in counts.as_object().into_iter().flatten() {
        j[k] = v.clone();
    }
    j
}

fn files_summary(sd: &Path, cache: &mut TableCache, job: &CompareJob, (pa, pb): (&str, &str), (full, wanted): (bool, &[String]), ctl: &Ctl) -> Result<Json, String> {
    let (mut ga, mut gb) = (open(sd, pa)?, open(sd, pb)?);
    // aliases take part like the sets they stand for (gdxdiff compares them by name as well)
    let resolve_all = |g: &GdxFile| -> Result<Vec<SymbolInfo>, String> { g.symbols().into_iter().map(|s| resolved_info(g, s)).collect() };
    let (sa, sb) = (resolve_all(&ga)?, resolve_all(&gb)?);
    let by_name = |v: &[SymbolInfo]| -> HashMap<String, usize> { v.iter().enumerate().map(|(i, s)| (s.name.to_lowercase(), i)).collect() };
    let (ia, ib) = (by_name(&sa), by_name(&sb));
    let mut names: Vec<&str> = sa.iter().map(|s| s.name.as_str()).collect();
    names.extend(sb.iter().filter(|s| !ia.contains_key(&s.name.to_lowercase())).map(|s| s.name.as_str()));
    let wanted: std::collections::HashSet<String> = wanted.iter().map(|n| n.to_lowercase()).collect();
    let mut out = Vec::new();
    let mut truncated = false;
    for n in names {
        ctl.check()?;
        let lc = n.to_lowercase();
        let (a, b) = (ia.get(&lc).map(|&i| &sa[i]), ib.get(&lc).map(|&i| &sb[i]));
        let one_sided = a.is_none() || b.is_none();
        let mismatch = matches!((a, b), (Some(x), Some(y)) if symbol_mismatch(x, y, &job.opts).is_some());
        if one_sided || mismatch || !(full || wanted.contains(&lc)) {
            // known from the symbol tables; both sides empty and of one type: nothing to merge
            let empty = matches!((a, b), (Some(x), Some(y)) if x.records == 0 && y.records == 0) && !mismatch;
            let status = match (a, b) {
                (_, None) => "onlyA",
                (None, _) => "onlyB",
                _ if mismatch => "different",
                _ if empty => "equal",
                _ => "pending",
            };
            let mut j = light_row(n, a, b, status, None, &job.opts);
            if empty {
                j["rows"] = json!(0);
                j["differences"] = json!(0);
                for k in ["changed", "added", "removed", "equal"] {
                    j[k] = json!(0);
                }
            }
            out.push(j);
            continue;
        }
        match build_file_table(&mut ga, &mut gb, n, &job.opts, max_bytes(), ctl) {
            Ok(t) => {
                let status = if t.mismatch.is_some() || t.diff_count() > 0 { "different" } else { "equal" };
                let key = table_key(&job.source, &job.opts, n)?;
                let j = symbol_summary(&t, status, Json::Null);
                cache.put(key, Rc::new(t));
                out.push(j);
            }
            Err(e) if e.starts_with(CANCELLED) => return Err(e),
            Err(e) if e.starts_with(crate::gdx_index::TIMEOUT) => {
                // out of time: report what is known, the rest stays pending
                truncated = true;
                out.push(light_row(n, a, b, "pending", Some(e), &job.opts));
            }
            // too large to merge: report the symbol without counts
            Err(e) => out.push(light_row(n, a, b, "unknown", Some(e), &job.opts)),
        }
    }
    Ok(json!({ "symbols": out, "truncated": truncated }))
}

fn diff_file_summary(sd: &Path, cache: &mut TableCache, job: &CompareJob, path: &str, ctl: &Ctl) -> Result<Json, String> {
    let mut g = open(sd, path)?;
    let Some((fa, fb)) = files_compared(&mut g) else {
        return Err("This GDX file is not the output of gdxdiff (the set FilesCompared is missing).".into());
    };
    let mut out = Vec::new();
    for s in g.symbols() {
        if s.kind == SymbolKind::Alias || s.name.eq_ignore_ascii_case("FilesCompared") {
            continue;
        }
        match build_diff_file_table(&mut g, &s.name, max_bytes(), ctl) {
            Ok(t) => {
                let mode = if t.text.starts_with("Differences Only") {
                    "diffOnly"
                } else if t.text.starts_with("Differences Field") {
                    "fieldOnly"
                } else {
                    "normal"
                };
                let key = table_key(&job.source, &job.opts, &s.name)?;
                out.push(symbol_summary(&t, "different", json!({ "mode": mode })));
                cache.put(key, Rc::new(t));
            }
            Err(e) if e.starts_with(CANCELLED) || e.starts_with(crate::gdx_index::TIMEOUT) => return Err(e),
            Err(e) => out.push(json!({
                "name": s.name, "kind": kind_name(s.kind), "dim": s.dim.saturating_sub(1), "domain": s.domain, "text": s.explanatory_text,
                "status": "unknown", "note": e, "rows": null, "differences": null, "changed": null, "added": null, "removed": null, "equal": null,
            })),
        }
    }
    Ok(json!({ "fileA": fa, "fileB": fb, "symbols": out }))
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use gams_gdx::write::{write_gdx, WriteSymbol};

    const INF: f64 = SV_PINF;

    fn sysdir() -> PathBuf {
        std::env::var("GAMS_SYSDIR").expect("GAMS_SYSDIR").into()
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gams-cmp-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.join(name)
    }

    fn pair(a: Vec<WriteSymbol>, b: Vec<WriteSymbol>, tag: &str) -> (String, String) {
        let (pa, pb) = (tmp(&format!("{tag}_a.gdx")), tmp(&format!("{tag}_b.gdx")));
        write_gdx(&sysdir(), &pa, &a).unwrap();
        write_gdx(&sysdir(), &pb, &b).unwrap();
        (pa.to_string_lossy().into_owned(), pb.to_string_lossy().into_owned())
    }

    fn never() -> bool {
        false
    }
    fn handle_t(sd: &Path, c: &mut TableCache, j: &CompareJob) -> Result<Json, String> {
        handle(sd, c, j, &Ctl { deadline: Instant::now() + Duration::from_secs(60), cancelled: &never })
    }

    fn job(a: &str, b: &str, extra: Json, method: &str) -> CompareJob {
        let mut p = json!({ "pathA": a, "pathB": b });
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        parse_job(method, p).unwrap()
    }

    fn call(c: &mut TableCache, a: &str, b: &str, extra: Json, method: &str) -> Json {
        handle_t(&sysdir(), c, &job(a, b, extra, method)).unwrap()
    }

    fn sym<'a>(r: &'a Json, name: &str) -> &'a Json {
        r["symbols"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap()
    }

    #[test]
    fn tolerance_semantics_match_gdxdiff() {
        // checked against the shipped gdxdiff (see docs/dev/sources.md)
        assert!(values_equal(1.0, 1.0, 0.0, 0.0));
        assert!(!values_equal(1.0, 1.000001, 0.0, 0.0));
        assert!(values_equal(1.0, 1.000001, 1e-5, 0.0));
        assert!(!values_equal(1000.0, 1000.5, 1e-5, 0.0));
        assert!(values_equal(1000.0, 1000.5, 0.0, 1e-3)); // 0.5 / 1001 < 1e-3
        assert!(!values_equal(1000.0, 1000.5, 0.0, 1e-4));
        // specials compare by identity
        assert!(values_equal(SV_NA, SV_NA, 0.0, 0.0));
        assert!(values_equal(INF, INF, 0.0, 0.0));
        assert!(!values_equal(SV_NA, SV_UNDEF, 1.0, 1.0));
        assert!(!values_equal(SV_MINF, INF, 0.0, 0.0));
        assert!(!values_equal(SV_NA, 5.0, 0.6, 0.6));
        assert!(!values_equal(INF, 5.0, 1e9, 1e9));
        // EPS is not 0 without an absolute tolerance, but is 0 within one
        assert!(!values_equal(SV_EPS, 0.0, 0.0, 0.0));
        assert!(!values_equal(SV_EPS, 1e-12, 0.0, 0.0));
        assert!(values_equal(SV_EPS, 1e-12, 1e-5, 0.0));
        assert!(values_equal(SV_EPS, 0.0, 1e-5, 0.0));
        assert!(!values_equal(SV_EPS, 0.0, 0.0, 1e-3)); // relative test sees the raw EPS
    }

    #[test]
    fn differences_values() {
        assert_eq!(differences(2.0, 3.0), (Some(1.0), Some(0.5)));
        assert_eq!(differences(0.0, 3.0), (Some(3.0), None));
        assert_eq!(differences(SV_EPS, 3.0), (Some(3.0), None));
        assert_eq!(differences(SV_NA, 3.0), (None, None));
        assert_eq!(differences(-2.0, -1.0), (Some(1.0), Some(0.5)));
    }

    fn sample() -> (String, String) {
        static S: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
        S.get_or_init(sample_files).clone()
    }

    fn sample_files() -> (String, String) {
        let e = SV_EPS;
        pair(
            vec![
                WriteSymbol::set("i", 1, &[&["north"], &["south"], &["hub_a"]]),
                WriteSymbol::parameter("d", 2, &[(&["north", "east"], 2.5), (&["north", "west"], 1.7), (&["south", "east"], 2.5), (&["south", "west"], SV_NA)]),
                WriteSymbol::parameter("onlya", 1, &[(&["x"], 1.0)]),
                WriteSymbol::parameter("same", 1, &[(&["x"], 1.0), (&["y"], e)]),
                WriteSymbol::var_or_equ("x", 2, false, 3, &[(&["north", "east"], [50.0, 0.0, 0.0, INF, 1.0]), (&["north", "west"], [300.0, 0.0, 0.0, INF, 1.0])]),
            ],
            vec![
                WriteSymbol::set("i", 1, &[&["north"], &["south"], &["hub_b"]]),
                WriteSymbol::parameter("d", 2, &[(&["north", "east"], 2.5), (&["north", "west"], 1.8), (&["south", "east"], 2.5), (&["hub_b", "east"], 9.0), (&["south", "west"], 3.0)]),
                WriteSymbol::parameter("onlyb", 1, &[(&["x"], 1.0)]),
                WriteSymbol::parameter("same", 1, &[(&["x"], 1.0), (&["y"], e)]),
                WriteSymbol::var_or_equ("x", 2, false, 3, &[(&["north", "east"], [50.0, 0.5, 0.0, INF, 1.0]), (&["north", "west"], [301.0, 0.0, 0.0, INF, 1.0])]),
            ],
            "sample",
        )
    }

    #[test]
    fn symbol_statuses_and_counts() {
        if gams_capi::testing::sysdir_or_skip("symbol_statuses_and_counts").is_none() {
            return;
        }
        let (a, b) = sample();
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        let st = |n: &str| sym(&r, n)["status"].as_str().unwrap().to_string();
        assert_eq!(st("onlya"), "onlyA");
        assert_eq!(st("onlyb"), "onlyB");
        assert_eq!(st("same"), "equal");
        assert_eq!(st("d"), "different");
        assert_eq!(st("i"), "different");
        let d = sym(&r, "d");
        // north.west 1.7 -> 1.8 and south.west NA -> 3 changed; hub_b.east added; north.east/south.east equal
        assert_eq!((d["changed"].as_u64(), d["added"].as_u64(), d["removed"].as_u64(), d["equal"].as_u64()), (Some(2), Some(1), Some(0), Some(2)));
        let i = sym(&r, "i");
        assert_eq!((i["added"].as_u64(), i["removed"].as_u64(), i["equal"].as_u64()), (Some(1), Some(1), Some(2)));
        assert_eq!(sym(&r, "onlya")["removed"], 1);
        assert_eq!(sym(&r, "onlyb")["added"], 1);
    }

    #[test]
    fn records_are_key_aligned_with_diffs() {
        if gams_capi::testing::sysdir_or_skip("records_are_key_aligned_with_diffs").is_none() {
            return;
        }
        let (a, b) = sample();
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({"name": "d", "limit": 100}), "gams/gdxCompareRecords");
        assert_eq!(r["total"], 5);
        let recs = r["records"].as_array().unwrap();
        let by_key = |k: [&str; 2]| recs.iter().find(|x| x["keys"] == json!(k)).unwrap();
        let sc = by_key(["north", "west"]);
        assert_eq!(sc["status"], "changed");
        assert_eq!((sc["a"][0].as_f64(), sc["b"][0].as_f64()), (Some(1.7), Some(1.8)));
        assert!((sc["abs"][0].as_f64().unwrap() - 0.1).abs() < 1e-12);
        assert!((sc["rel"][0].as_f64().unwrap() - 0.1 / 1.7).abs() < 1e-12);
        assert_eq!(sc["diff"], json!([true]));
        let na = by_key(["south", "west"]);
        assert_eq!((na["a"][0].as_str(), na["b"][0].as_f64()), (Some("NA"), Some(3.0)));
        assert_eq!(na["abs"][0], Json::Null); // special values have no difference
        let boston = by_key(["hub_b", "east"]);
        assert_eq!(boston["status"], "added");
        assert_eq!(boston["a"], Json::Null);
        assert_eq!(boston["b"][0], 9.0);
        assert_eq!(by_key(["north", "east"])["status"], "equal");
        // onlyDiff drops the two equal rows; paging works on the visible rows
        let r = call(&mut c, &a, &b, json!({"name": "d", "onlyDiff": true, "limit": 2}), "gams/gdxCompareRecords");
        assert_eq!((r["total"].as_u64(), r["records"].as_array().unwrap().len(), r["differences"].as_u64()), (Some(3), 2, Some(3)));
        assert!(r["records"].as_array().unwrap().iter().all(|x| x["status"] != "equal"));
        let r2 = call(&mut c, &a, &b, json!({"name": "d", "onlyDiff": true, "offset": 2, "limit": 2}), "gams/gdxCompareRecords");
        assert_eq!(r2["records"].as_array().unwrap().len(), 1);
        // status filter
        let r = call(&mut c, &a, &b, json!({"name": "d", "statuses": ["added"]}), "gams/gdxCompareRecords");
        assert_eq!(r["total"], 1);
        // the merged stream is cached
        assert!(!c.items.is_empty());
        // sets compare element membership (and text, tested below)
        let r = call(&mut c, &a, &b, json!({"name": "i"}), "gams/gdxCompareRecords");
        let st: Vec<_> = r["records"].as_array().unwrap().iter().map(|x| (x["keys"][0].as_str().unwrap().to_string(), x["status"].as_str().unwrap().to_string())).collect();
        assert!(st.contains(&("hub_a".into(), "removed".into())) && st.contains(&("hub_b".into(), "added".into())));
    }

    #[test]
    fn next_previous_difference() {
        if gams_capi::testing::sysdir_or_skip("next_previous_difference").is_none() {
            return;
        }
        let (a, b) = sample();
        let mut c = TableCache::default();
        let all = call(&mut c, &a, &b, json!({"name": "d", "limit": 100}), "gams/gdxCompareRecords");
        let diff_idx: Vec<usize> = all["records"].as_array().unwrap().iter().enumerate().filter(|(_, r)| r["status"] != "equal").map(|(i, _)| i).collect();
        assert_eq!(diff_idx.len(), 3);
        let mut n = |from: Option<usize>, back: bool| {
            let mut e = json!({"name": "d", "backward": back});
            if let Some(f) = from {
                e["from"] = json!(f);
            }
            call(&mut c, &a, &b, e, "gams/gdxCompareNext")["index"].as_u64().map(|x| x as usize)
        };
        assert_eq!(n(None, false), Some(diff_idx[0]));
        assert_eq!(n(Some(diff_idx[0]), false), Some(diff_idx[1]));
        assert_eq!(n(Some(diff_idx[2]), false), None);
        assert_eq!(n(Some(diff_idx[1]), true), Some(diff_idx[0]));
        assert_eq!(n(None, true), Some(diff_idx[2]));
        assert_eq!(n(Some(diff_idx[0]), true), None);
    }

    #[test]
    fn tolerances_and_specials_in_records() {
        if gams_capi::testing::sysdir_or_skip("tolerances_and_specials_in_records").is_none() {
            return;
        }
        let (e, na, un) = (SV_EPS, SV_NA, SV_UNDEF);
        let (a, b) = pair(
            vec![WriteSymbol::parameter("p", 1, &[
                (&["close"], 1.0), (&["close_rel"], 1000.0), (&["eps_zero"], e), (&["na_na"], na), (&["inf"], INF),
                (&["na_undf"], na), (&["undf_undf"], un), (&["eps_eps"], e),
            ])],
            vec![WriteSymbol::parameter("p", 1, &[
                (&["close"], 1.000001), (&["close_rel"], 1000.5), (&["eps_zero"], 1e-12), (&["na_na"], na), (&["inf"], INF),
                (&["na_undf"], un), (&["undf_undf"], un), (&["eps_eps"], e),
            ])],
            "tol",
        );
        let mut c = TableCache::default();
        let status = |c: &mut TableCache, extra: Json| -> Vec<(String, String)> {
            let mut e = json!({"name": "p", "limit": 100});
            for (k, v) in extra.as_object().unwrap() {
                e[k] = v.clone();
            }
            let r = call(c, &a, &b, e, "gams/gdxCompareRecords");
            r["records"].as_array().unwrap().iter().filter(|x| x["status"] != "equal").map(|x| (x["keys"][0].as_str().unwrap().into(), x["status"].as_str().unwrap().into())).collect()
        };
        let keys = |v: Vec<(String, String)>| -> Vec<String> { v.into_iter().map(|x| x.0).collect() };
        assert_eq!(keys(status(&mut c, json!({}))), ["close", "close_rel", "eps_zero", "na_undf"]);
        assert_eq!(keys(status(&mut c, json!({"eps": 1e-5}))), ["close_rel", "na_undf"]);
        assert_eq!(keys(status(&mut c, json!({"relEps": 1e-3}))), ["eps_zero", "na_undf"]);
        assert_eq!(keys(status(&mut c, json!({"eps": 0.6}))), ["na_undf"]);
        // NA vs UNDEF is never within a tolerance; identical specials are equal
        let r = call(&mut c, &a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        assert_eq!(sym(&r, "p")["changed"], 4);
    }

    #[test]
    fn variable_field_selection() {
        if gams_capi::testing::sysdir_or_skip("variable_field_selection").is_none() {
            return;
        }
        let (mi, pi) = (SV_MINF, INF);
        let (a, b) = pair(
            vec![
                WriteSymbol::var_or_equ("v", 1, false, 5, &[(&["a"], [1.0, 2.0, mi, pi, 1.0]), (&["b"], [1.0, 0.0, mi, pi, 1.0]), (&["c"], [5.0, 0.0, mi, pi, 1.0])]),
                WriteSymbol::var_or_equ("e", 1, true, 0, &[(&["s"], [1.0, 2.0, 0.0, 0.0, 1.0])]),
            ],
            vec![
                WriteSymbol::var_or_equ("v", 1, false, 5, &[(&["a"], [1.0, 3.0, mi, pi, 1.0]), (&["b"], [1.0, 0.0, mi, pi, 1.0]), (&["c"], [6.0, 0.0, mi, pi, 1.0])]),
                WriteSymbol::var_or_equ("e", 1, true, 0, &[(&["s"], [1.0, 2.0, 0.0, 0.0, 1.0])]),
            ],
            "fld",
        );
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        assert_eq!((sym(&r, "v")["changed"].as_u64(), sym(&r, "v")["equal"].as_u64()), (Some(2), Some(1)));
        assert_eq!(sym(&r, "e")["status"], "equal");
        assert_eq!(sym(&r, "v")["slots"], 5);
        // only the marginal decides: c (level only) becomes equal
        let r = call(&mut c, &a, &b, json!({"fields": [1], "full": true}), "gams/gdxCompareSymbols");
        assert_eq!((sym(&r, "v")["changed"].as_u64(), sym(&r, "v")["equal"].as_u64()), (Some(1), Some(2)));
        // level only: a (marginal) becomes equal
        let r = call(&mut c, &a, &b, json!({"fields": [0], "full": true}), "gams/gdxCompareSymbols");
        assert_eq!(sym(&r, "v")["changed"], 1);
        // the per-field flags and 5 values per row
        let r = call(&mut c, &a, &b, json!({"name": "v", "limit": 10}), "gams/gdxCompareRecords");
        let rec = &r["records"][0];
        assert_eq!(rec["keys"], json!(["a"]));
        assert_eq!(rec["diff"], json!([false, true, false, false, false]));
        assert_eq!(rec["a"].as_array().unwrap().len(), 5);
        assert_eq!(rec["a"][2], "-INF");
        assert_eq!(rec["abs"][1], 1.0);
        assert_eq!(rec["abs"][2], Json::Null);
        assert!(parse_job("gams/gdxCompareSymbols", json!({"pathA": "a", "pathB": "b", "fields": [7]})).is_err());
        assert!(parse_job("gams/gdxCompareSymbols", json!({"pathA": "a", "pathB": "b", "fields": []})).is_err());
        assert!(parse_job("gams/gdxCompareSymbols", json!({"pathA": "a", "pathB": "b", "eps": -1})).is_err());
    }

    #[test]
    fn set_text_and_type_mismatch() {
        if gams_capi::testing::sysdir_or_skip("set_text_and_type_mismatch").is_none() {
            return;
        }
        let mut sa = WriteSymbol::set("s", 1, &[&["a"]]);
        let mut sb = WriteSymbol::set("s", 1, &[&["a"]]);
        sa.records[0].1[0] = 0.0;
        sb.records[0].1[0] = 0.0;
        let (a, b) = pair(
            vec![sa, WriteSymbol::parameter("t", 1, &[(&["a"], 1.0)]), WriteSymbol::parameter("u", 1, &[(&["a"], 1.0)])],
            vec![sb, WriteSymbol::set("t", 1, &[&["a"]]), WriteSymbol::parameter("u", 2, &[(&["a", "b"], 1.0)])],
            "mismatch",
        );
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        assert_eq!(sym(&r, "s")["status"], "equal");
        assert_eq!(sym(&r, "t")["status"], "different");
        assert!(sym(&r, "t")["mismatch"].as_str().unwrap().contains("Parameter"));
        assert!(sym(&r, "u")["mismatch"].as_str().unwrap().contains("dimension"));
        let rec = call(&mut c, &a, &b, json!({"name": "t"}), "gams/gdxCompareRecords");
        assert_eq!(rec["total"], 0);
    }

    fn ctl() -> Ctl<'static> {
        Ctl { deadline: Instant::now() + Duration::from_secs(60), cancelled: &never }
    }

    #[test]
    fn size_guard_reports_limit() {
        if gams_capi::testing::sysdir_or_skip("size_guard_reports_limit").is_none() {
            return;
        }
        let (a, b) = sample();
        let mut ga = open(&sysdir(), &a).unwrap();
        let mut gb = open(&sysdir(), &b).unwrap();
        let e = build_file_table(&mut ga, &mut gb, "d", &Opts::default(), 10, &ctl()).err().unwrap();
        assert!(e.starts_with("[limit]") && e.contains('d'), "{e}");
        assert!(build_file_table(&mut ga, &mut gb, "d", &Opts::default(), 1 << 20, &ctl()).is_ok());
    }

    #[test]
    fn symbol_in_one_file_lists_all_rows() {
        if gams_capi::testing::sysdir_or_skip("symbol_in_one_file_lists_all_rows").is_none() {
            return;
        }
        let (a, b) = sample();
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({"name": "onlya"}), "gams/gdxCompareRecords");
        assert_eq!(r["total"], 1);
        assert_eq!(r["records"][0]["status"], "removed");
        assert_eq!(r["records"][0]["b"], Json::Null);
        let r = call(&mut c, &a, &b, json!({"name": "onlyb"}), "gams/gdxCompareRecords");
        assert_eq!(r["records"][0]["status"], "added");
    }

    /// The committed output of the real `gdxdiff` (client/test/fixtures/gdxdiff/diff.gdx, produced from
    /// the pair written by `examples/write_pair.rs`).
    #[test]
    fn real_gdxdiff_output_is_paired() {
        if gams_capi::testing::sysdir_or_skip("real_gdxdiff_output_is_paired").is_none() {
            return;
        }
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../client/test/fixtures/gdxdiff/diff.gdx");
        let p = p.to_string_lossy().into_owned();
        let mut c = TableCache::default();
        let job = |extra: Json, m: &str| {
            let mut e = json!({ "path": p });
            for (k, v) in extra.as_object().unwrap() {
                e[k] = v.clone();
            }
            parse_job(m, e).unwrap()
        };
        let r = handle_t(&sysdir(), &mut c, &job(json!({}), "gams/gdxDiffFileSymbols")).unwrap();
        assert_eq!((r["fileA"].as_str(), r["fileB"].as_str()), (Some("a.gdx"), Some("b.gdx")));
        let names: Vec<_> = r["symbols"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["d", "i", "x"]);
        let d = sym(&r, "d");
        assert_eq!((d["dim"].as_u64(), d["changed"].as_u64(), d["added"].as_u64(), d["removed"].as_u64()), (Some(2), Some(2), Some(1), Some(0)));
        assert_eq!(d["mode"], "normal");
        let rec = handle_t(&sysdir(), &mut c, &job(json!({"name": "d"}), "gams/gdxDiffFileRecords")).unwrap();
        let recs = rec["records"].as_array().unwrap();
        assert_eq!(recs.len(), 3);
        let sd = recs.iter().find(|x| x["keys"] == json!(["south", "west"])).unwrap();
        assert_eq!((sd["status"].as_str(), sd["a"][0].as_str(), sd["b"][0].as_f64()), (Some("changed"), Some("NA"), Some(3.0)));
        let boston = recs.iter().find(|x| x["status"] == "added").unwrap();
        assert_eq!(boston["keys"], json!(["hub_b", "east"]));
        assert_eq!(boston["b"][0], 9.0);
        // variable x: dif1 / dif2 rows carry all fields; marginal changed on north.east
        let rec = handle_t(&sysdir(), &mut c, &job(json!({"name": "x"}), "gams/gdxDiffFileRecords")).unwrap();
        let sn = rec["records"].as_array().unwrap().iter().find(|x| x["keys"] == json!(["north", "east"])).unwrap();
        assert_eq!(sn["diff"], json!([false, true, false, false, false]));
        assert_eq!((sn["a"][1].as_f64(), sn["b"][1].as_f64()), (Some(0.0), Some(0.5)));
        // sets: ins1 = only in A, ins2 = only in B
        let rec = handle_t(&sysdir(), &mut c, &job(json!({"name": "i"}), "gams/gdxDiffFileRecords")).unwrap();
        let st: Vec<_> = rec["records"].as_array().unwrap().iter().map(|x| (x["keys"][0].as_str().unwrap(), x["status"].as_str().unwrap())).collect();
        assert_eq!(st, [("hub_a", "removed"), ("hub_b", "added")]);
        // the symbol list fixture used by the TypeScript detection test matches this file
        let g = open(&sysdir(), &p).unwrap();
        let fx: Json = serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../client/test/fixtures/gdxdiff/diff.symbols.json")).unwrap()).unwrap();
        let want: Vec<(String, u64, String, u64, String)> = fx["symbols"].as_array().unwrap().iter().map(|s| (
            s["name"].as_str().unwrap().into(), s["dim"].as_u64().unwrap(), s["kind"].as_str().unwrap().into(), s["records"].as_u64().unwrap(), s["text"].as_str().unwrap().into())).collect();
        let got: Vec<(String, u64, String, u64, String)> = g.symbols().iter().map(|s| (s.name.clone(), s.dim as u64, kind_name(s.kind).into(), s.records as u64, s.explanatory_text.clone())).collect();
        assert_eq!(got, want);
        // a non-diff file is rejected with a clear message
        let other = Path::new(env!("CARGO_MANIFEST_DIR")).join("../gams-gdx/tests/fixtures/mini.gdx");
        let j = parse_job("gams/gdxDiffFileSymbols", json!({"path": other.to_string_lossy()})).unwrap();
        assert!(handle_t(&sysdir(), &mut c, &j).unwrap_err().contains("not the output of gdxdiff"));
    }

    #[test]
    fn lazy_summary_merges_only_requested_symbols() {
        if gams_capi::testing::sysdir_or_skip("lazy_summary_merges_only_requested_symbols").is_none() {
            return;
        }
        let (a, b) = sample();
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({}), "gams/gdxCompareSymbols");
        assert!(c.items.is_empty(), "nothing merged for the default summary");
        assert_eq!(sym(&r, "onlya")["status"], "onlyA");
        assert_eq!(sym(&r, "onlya")["removed"], 1);
        assert_eq!(sym(&r, "onlyb")["status"], "onlyB");
        assert_eq!(sym(&r, "d")["status"], "pending");
        assert_eq!(sym(&r, "d")["aRecords"], 4);
        assert!(sym(&r, "d")["changed"].is_null());
        assert_eq!(r["truncated"], false);
        let r = call(&mut c, &a, &b, json!({"names": ["D"]}), "gams/gdxCompareSymbols");
        assert_eq!(sym(&r, "d")["status"], "different");
        assert_eq!(sym(&r, "d")["changed"], 2);
        assert_eq!(sym(&r, "same")["status"], "pending");
        assert_eq!(c.items.len(), 1);
    }

    #[test]
    fn mismatch_is_known_without_merging() {
        if gams_capi::testing::sysdir_or_skip("mismatch_is_known_without_merging").is_none() {
            return;
        }
        let (a, b) = pair(
            vec![WriteSymbol::parameter("u", 1, &[(&["a"], 1.0)])],
            vec![WriteSymbol::parameter("u", 2, &[(&["a", "b"], 1.0)])],
            "lazymm",
        );
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({}), "gams/gdxCompareSymbols");
        assert_eq!(sym(&r, "u")["status"], "different");
        assert!(sym(&r, "u")["mismatch"].as_str().unwrap().contains("dimension"));
        assert!(c.items.is_empty());
    }

    #[test]
    fn cancellation_and_deadline_give_clear_errors() {
        if gams_capi::testing::sysdir_or_skip("cancellation_and_deadline_give_clear_errors").is_none() {
            return;
        }
        let (a, b) = sample();
        let mut c = TableCache::default();
        let j = job(&a, &b, json!({"name": "d"}), "gams/gdxCompareRecords");
        let yes = || true;
        let e = handle(&sysdir(), &mut c, &j, &Ctl { deadline: Instant::now() + Duration::from_secs(60), cancelled: &yes }).unwrap_err();
        assert!(e.starts_with(CANCELLED), "{e}");
        let e = handle(&sysdir(), &mut c, &j, &Ctl { deadline: Instant::now(), cancelled: &never }).unwrap_err();
        assert!(e.starts_with(crate::gdx_index::TIMEOUT), "{e}");
        // full summary with an expired deadline fails the same way, not silently
        let j = job(&a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        assert!(handle(&sysdir(), &mut c, &j, &Ctl { deadline: Instant::now(), cancelled: &never }).is_err());
        assert!(c.items.is_empty());
    }

    #[test]
    fn cancel_is_routed_to_the_worker() {
        if gams_capi::testing::sysdir_or_skip("cancel_is_routed_to_the_worker").is_none() {
            return;
        }
        let (a, b) = sample();
        let w = CompareWorker::spawn(Some(sysdir()));
        let (otx, orx) = crossbeam_channel::unbounded();
        // a zero budget is exercised above; here an unknown id must be ignored and a known one answered
        w.cancel(&RequestId::from(99));
        w.submit(RequestId::from(1), job(&a, &b, json!({"name": "d"}), "gams/gdxCompareRecords"), otx.clone());
        let Message::Response(r) = orx.recv_timeout(Duration::from_secs(20)).unwrap() else { panic!() };
        assert!(r.response_result.is_ok());
        let w0 = CompareWorker::spawn_with(Some(sysdir()), Duration::ZERO, TableCache::default);
        w0.submit(RequestId::from(2), job(&a, &b, json!({"name": "d"}), "gams/gdxCompareRecords"), otx);
        let Message::Response(r) = orx.recv_timeout(Duration::from_secs(20)).unwrap() else { panic!() };
        assert!(r.response_result.unwrap_err().message.starts_with("[timeout]"));
    }

    #[test]
    fn worker_survives_panic_and_dead_worker_replies() {
        if gams_capi::testing::sysdir_or_skip("worker_survives_panic_and_dead_worker_replies").is_none() {
            return;
        }
        let w = CompareWorker::spawn(Some(sysdir()));
        let (otx, orx) = crossbeam_channel::unbounded();
        let mut j = job("a", "b", json!({}), "gams/gdxCompareSymbols");
        j.op = Op::Panic;
        w.submit(RequestId::from(1), j.clone(), otx.clone());
        let (a, b) = sample();
        w.submit(RequestId::from(2), job(&a, &b, json!({"name": "d"}), "gams/gdxCompareRecords"), otx.clone());
        let t = Duration::from_secs(20);
        let Message::Response(r1) = orx.recv_timeout(t).unwrap() else { panic!() };
        assert!(r1.response_result.unwrap_err().message.contains("injected panic"));
        let Message::Response(r2) = orx.recv_timeout(t).unwrap() else { panic!() };
        assert!(r2.response_result.is_ok());
        let (tx, rx) = unbounded::<Msg>();
        drop(rx);
        let dead = CompareWorker { tx, shared: Arc::new(Mutex::new(Shared::default())) };
        dead.submit(RequestId::from(3), j, otx);
        let Message::Response(r3) = orx.recv_timeout(t).unwrap() else { panic!() };
        assert!(r3.response_result.is_err());
    }

    #[test]
    fn cache_respects_total_byte_budget() {
        if gams_capi::testing::sysdir_or_skip("cache_respects_total_byte_budget").is_none() {
            return;
        }
        let (a, b) = sample();
        let mut ga = open(&sysdir(), &a).unwrap();
        let mut gb = open(&sysdir(), &b).unwrap();
        let mk = |n: &str, g1: &mut GdxFile, g2: &mut GdxFile| Rc::new(build_file_table(g1, g2, n, &Opts::default(), 1 << 20, &ctl()).unwrap());
        let (td, ti) = (mk("d", &mut ga, &mut gb), mk("i", &mut ga, &mut gb));
        assert!(td.mem_bytes() >= td.keys.len() as u64 * 4 + td.rows.len() as u64 * 8);
        // budget fits one table but not two: the older one is evicted
        let mut c = TableCache::with_budget(td.mem_bytes().max(ti.mem_bytes()) + 1);
        c.put("d".into(), td.clone());
        c.put("i".into(), ti.clone());
        assert_eq!(c.items.len(), 1);
        assert_eq!(c.items[0].0, "i");
        assert!(c.total_bytes() <= c.max_bytes);
        // a table above the whole budget is not kept
        let mut c = TableCache::with_budget(1);
        c.put("d".into(), td);
        assert!(c.items.is_empty());
        // the pre-build estimate accounts for keys and rows, not only the raw values
        assert!(merge_bytes(10, 10, 2, 1) > crate::gdx::raw_bytes(10, 2, 1) * 2);
    }

    // ---- gdxdiff semantics of records that exist in one file only (checked against the shipped gdxdiff)

    fn row<'a>(r: &'a Json, keys: &[&str]) -> &'a Json {
        r["records"].as_array().unwrap().iter().find(|x| x["keys"] == json!(keys)).unwrap()
    }

    fn counts(r: &Json, name: &str) -> (u64, u64, u64, u64, String) {
        let s = sym(r, name);
        let g = |k: &str| s[k].as_u64().unwrap();
        (g("changed"), g("added"), g("removed"), g("equal"), s["status"].as_str().unwrap().to_string())
    }

    #[test]
    fn one_sided_default_records_are_ignored_unless_cmp_defaults() {
        if gams_capi::testing::sysdir_or_skip("one_sided_default_records_are_ignored_unless_cmp_defaults").is_none() {
            return;
        }
        let (e, free_def, pos_def) = (SV_EPS, [0.0, 0.0, SV_MINF, INF, 1.0], [0.0, 0.0, 0.0, INF, 1.0]);
        let mut changed_marginal = pos_def;
        changed_marginal[1] = 2.0;
        let (a, b) = pair(
            vec![
                // p(x=1,y=0) vs p(x=1): the explicit 0 is the default
                WriteSymbol::parameter("pzero", 1, &[(&["x"], 1.0), (&["y"], 0.0)]),
                WriteSymbol::parameter("peps", 1, &[(&["x"], 1.0), (&["y"], e)]),
                WriteSymbol::parameter("ptiny", 1, &[(&["x"], 1.0), (&["y"], 1e-12)]),
                WriteSymbol::parameter("pone", 1, &[(&["x"], 1.0), (&["y"], 3.0)]),
                WriteSymbol::var_or_equ("vdef", 1, false, 5, &[(&["x"], free_def)]),
                WriteSymbol::var_or_equ("vmarg", 1, false, 3, &[(&["x"], changed_marginal)]),
                // equations are always reported (gdxdiff)
                WriteSymbol::var_or_equ("edef", 1, true, 0, &[(&["x"], [0.0, 0.0, 0.0, 0.0, 1.0])]),
                WriteSymbol::set("s", 1, &[&["x"]]),
            ],
            vec![
                WriteSymbol::parameter("pzero", 1, &[(&["x"], 1.0)]),
                WriteSymbol::parameter("peps", 1, &[(&["x"], 1.0)]),
                WriteSymbol::parameter("ptiny", 1, &[(&["x"], 1.0)]),
                WriteSymbol::parameter("pone", 1, &[(&["x"], 1.0)]),
                WriteSymbol::var_or_equ("vdef", 1, false, 5, &[]),
                WriteSymbol::var_or_equ("vmarg", 1, false, 3, &[]),
                WriteSymbol::var_or_equ("edef", 1, true, 0, &[]),
                WriteSymbol::set("s", 1, &[]),
            ],
            "defaults",
        );
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        for n in ["pzero", "vdef"] {
            assert_eq!(counts(&r, n).4, "equal", "{n}");
        }
        assert_eq!(counts(&r, "pzero"), (0, 0, 0, 2, "equal".into()));
        for n in ["peps", "ptiny", "pone", "vmarg", "edef", "s"] {
            assert_eq!(counts(&r, n).4, "different", "{n}");
        }
        // the ignored record is still listed (A only), as an equal row
        let rows = call(&mut c, &a, &b, json!({"name": "pzero"}), "gams/gdxCompareRecords");
        let y = row(&rows, &["y"]);
        assert_eq!((y["status"].as_str(), y["a"][0].as_f64(), y["b"].is_null()), (Some("equal"), Some(0.0), true));
        // tolerances apply to the default test: |1e-12 - 0| <= Eps, EPS counts as 0 for Eps only (not RelEps)
        let r = call(&mut c, &a, &b, json!({"full": true, "eps": 1e-10}), "gams/gdxCompareSymbols");
        assert_eq!(counts(&r, "ptiny").4, "equal");
        assert_eq!(counts(&r, "peps").4, "equal");
        let r = call(&mut c, &a, &b, json!({"full": true, "relEps": 0.01}), "gams/gdxCompareSymbols");
        assert_eq!(counts(&r, "ptiny").4, "equal");
        assert_eq!(counts(&r, "peps").4, "different");
        // only the compared fields decide: a marginal different from the default is no difference for Field=l
        let r = call(&mut c, &a, &b, json!({"full": true, "fields": [0]}), "gams/gdxCompareSymbols");
        assert_eq!(counts(&r, "vmarg").4, "equal");
        let r = call(&mut c, &a, &b, json!({"full": true, "fields": [1]}), "gams/gdxCompareSymbols");
        assert_eq!(counts(&r, "vmarg").4, "different");
        // CmpDefaults: everything one-sided is a difference
        let r = call(&mut c, &a, &b, json!({"full": true, "cmpDefaults": true}), "gams/gdxCompareSymbols");
        assert_eq!(counts(&r, "pzero"), (0, 0, 1, 1, "different".into()));
        assert_eq!(counts(&r, "vdef").4, "different");
        // the default is the one of the variable type: a Positive default record is not the default of a Free variable
        let (a, b) = pair(
            vec![WriteSymbol::var_or_equ("vfree", 1, false, 5, &[(&["x"], pos_def)])],
            vec![WriteSymbol::var_or_equ("vfree", 1, false, 5, &[])],
            "defaults2",
        );
        let r = call(&mut c, &a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        assert_eq!(counts(&r, "vfree").4, "different");
    }

    #[test]
    fn aliases_compare_like_their_sets() {
        if gams_capi::testing::sysdir_or_skip("aliases_compare_like_their_sets").is_none() {
            return;
        }
        let (a, b) = pair(
            vec![
                WriteSymbol::set("i", 1, &[&["x"], &["y"]]),
                WriteSymbol::set("s1", 1, &[&["x"]]),
                WriteSymbol::set("a1", 1, &[&["x"], &["y"]]),
                WriteSymbol::alias("a2", "i"),
                WriteSymbol::alias("u1", "*"),
                WriteSymbol::alias("onlya", "i"),
            ],
            vec![
                WriteSymbol::set("i", 1, &[&["x"], &["y"]]),
                WriteSymbol::alias("s1", "i"), // set {x} in A, alias of {x, y} in B: "Keys are different"
                WriteSymbol::alias("a1", "i"),
                WriteSymbol::alias("a2", "i"),
                WriteSymbol::alias("u1", "*"),
            ],
            "alias",
        );
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        let s1 = sym(&r, "s1");
        assert_eq!(s1["status"], "different");
        assert_eq!(s1["kind"], "Set");
        assert_eq!((s1["added"].as_u64(), s1["equal"].as_u64()), (Some(1), Some(1)));
        assert_eq!(counts(&r, "a1").4, "equal"); // set vs alias with the same records
        assert_eq!(counts(&r, "a2").4, "equal");
        // the universe is {x, y} on both sides; an alias of the universe has one record per UEL
        assert_eq!(counts(&r, "u1"), (0, 0, 0, 2, "equal".into()));
        assert_eq!(sym(&r, "onlya")["status"], "onlyA");
        let rows = call(&mut c, &a, &b, json!({"name": "s1"}), "gams/gdxCompareRecords");
        assert_eq!(row(&rows, &["y"])["status"], "added");
        // an alias of the universe against a set
        let (a2, b2) = pair(
            vec![WriteSymbol::set("q", 1, &[&["x"], &["y"]]), WriteSymbol::alias("u", "*")],
            vec![WriteSymbol::set("q", 1, &[&["x"], &["y"], &["z"]]), WriteSymbol::set("u", 1, &[&["x"], &["y"]])],
            "alias2",
        );
        let r = call(&mut c, &a2, &b2, json!({"full": true}), "gams/gdxCompareSymbols");
        // universe of A is {x, y}; set u of B holds {x, y}
        assert_eq!(counts(&r, "u").4, "equal");
        assert_eq!(counts(&r, "q").4, "different");
    }

    #[test]
    fn cmp_domains_makes_domain_differences_visible() {
        if gams_capi::testing::sysdir_or_skip("cmp_domains_makes_domain_differences_visible").is_none() {
            return;
        }
        let mut pa = WriteSymbol::parameter("p1", 1, &[(&["x"], 1.0)]);
        pa.domain = vec!["i".into()];
        let mut pb = WriteSymbol::parameter("p1", 1, &[(&["x"], 1.0)]);
        pb.domain = vec!["j".into()];
        let mut qa = WriteSymbol::parameter("p2", 1, &[(&["x"], 1.0)]);
        qa.domain = vec!["i".into()];
        let mut qb = WriteSymbol::parameter("p2", 1, &[(&["x"], 1.0)]);
        qb.domain = vec!["I".into()]; // case-insensitive
        let (a, b) = pair(vec![pa, qa], vec![pb, qb], "domains");
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        assert_eq!(counts(&r, "p1").4, "equal");
        let r = call(&mut c, &a, &b, json!({"full": true, "cmpDomains": true}), "gams/gdxCompareSymbols");
        assert_eq!(sym(&r, "p1")["status"], "different");
        assert!(sym(&r, "p1")["mismatch"].as_str().unwrap().starts_with("domain (i) in A, (j) in B"));
        assert_eq!(counts(&r, "p2").4, "equal");
        // without a full merge (pending symbols) the mismatch is known from the symbol tables
        let r = call(&mut c, &a, &b, json!({"cmpDomains": true}), "gams/gdxCompareSymbols");
        assert_eq!(sym(&r, "p1")["status"], "different");
    }

    #[test]
    fn set_text_none_differs_from_the_text_y() {
        if gams_capi::testing::sysdir_or_skip("set_text_none_differs_from_the_text_y").is_none() {
            return;
        }
        let (x, y): (&[&str], &[&str]) = (&["x"], &["y"]);
        let (a, b) = pair(
            vec![
                WriteSymbol::set_with_text("t1", 1, &[(x, ""), (y, "")]),
                WriteSymbol::set_with_text("t2", 1, &[(x, "Y")]),
                WriteSymbol::set_with_text("t3", 1, &[(x, "Y")]),
            ],
            vec![
                WriteSymbol::set_with_text("t1", 1, &[(x, "Y"), (y, "")]),
                WriteSymbol::set_with_text("t2", 1, &[(x, "")]),
                WriteSymbol::set_with_text("t3", 1, &[(x, "Y")]),
            ],
            "texts",
        );
        let mut c = TableCache::default();
        let r = call(&mut c, &a, &b, json!({"full": true}), "gams/gdxCompareSymbols");
        assert_eq!(counts(&r, "t1").4, "different");
        assert_eq!(counts(&r, "t2").4, "different");
        assert_eq!(counts(&r, "t3").4, "equal");
        let r = call(&mut c, &a, &b, json!({"full": true, "ignoreSetText": true}), "gams/gdxCompareSymbols");
        assert_eq!(counts(&r, "t1").4, "equal");
        // the compared texts: placeholder `Y` is flagged, the genuine `Y` is not
        let rows = call(&mut c, &a, &b, json!({"name": "t1"}), "gams/gdxCompareRecords");
        let x = row(&rows, &["x"]);
        assert_eq!((x["a"][0].as_str(), x["aNoText"].as_bool(), x["b"][0].as_str(), x["bNoText"].as_bool()), (Some("Y"), Some(true), Some("Y"), Some(false)));
    }
}
