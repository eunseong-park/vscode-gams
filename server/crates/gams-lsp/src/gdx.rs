// SPDX-License-Identifier: GPL-3.0-or-later
//! GDX protocol (`gams/gdxSymbols`, `gams/gdxRecords`, `gams/gdxLabels`, `gams/gdxTable`, `gams/gdxDefaults`).
//!
//! `GdxFile` is `Send` but not `Sync`, so all files live on one dedicated worker thread
//! that owns a cache `path -> (mtime, GdxFile)`; an entry is dropped and reopened when the
//! file's modification time (or size) changes, when it is released (`gams/gdxRelease`), when
//! more than `MAX_OPEN` files are open (LRU) or after `IDLE_TIMEOUT` without use.
use crossbeam_channel::{unbounded, RecvTimeoutError, Sender};
use gams_gdx::query::{self, FilterMode, LabelFilter, Pivot, Query, Sort, ValueFilter};
use gams_gdx::{GdxFile, RawTable, SymbolInfo, SymbolKind, Value};
use gams_ref::path_key;
use lsp_server::{Message, RequestId, Response, ResponseError};
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime};

/// LSP `RequestFailed`.
pub const REQUEST_FAILED: i32 = -32803;

/// At most this many GDX files stay open (least recently used is closed first).
pub const MAX_OPEN: usize = 8;
/// A file not used for this long is closed (open handles block GAMS from rewriting the file
/// on Windows; Studio releases files before runs, `GdxViewer::releaseFile`).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

pub enum Job {
    Symbols { path: String },
    /// With a non-empty `query` the records are the sorted / filtered view of the whole symbol.
    Records { path: String, symbol_index: usize, offset: usize, limit: usize, query: QuerySpec },
    /// `gams/gdxLabels`: unique labels of key column `column` (first-seen order).
    Labels { path: String, symbol_index: usize, column: usize },
    /// `gams/gdxTable`: a window of the pivot (table) view.
    Table(Box<TableSpec>),
    /// `gams/gdxDefaults`: per value column, whether every record holds the default value
    /// (`{ allDefault: [bool; 5] }`, empty for symbols other than variables / equations).
    Defaults { path: String, symbol_index: usize },
    /// `gams/gdxRelease`: close `path` (compared like all paths, see `gams_ref::path_key`), or
    /// every open file if `None`. Later requests reopen lazily.
    Release { path: Option<String> },
    /// Test hook: a job that panics inside the worker.
    #[cfg(test)]
    Panic,
}

/// A parsed `Query` plus a canonical string used as cache key.
#[derive(Clone, Debug, Default)]
pub struct QuerySpec {
    pub query: Query,
    pub key: String,
}

#[derive(Debug)]
pub struct TableSpec {
    pub path: String,
    pub symbol_index: usize,
    pub row_dims: Option<Vec<usize>>,
    pub col_dims: Option<Vec<usize>>,
    pub value_field: usize,
    pub row_offset: usize,
    pub row_limit: usize,
    pub col_offset: usize,
    pub col_limit: usize,
    pub query: QuerySpec,
}

struct Msg {
    id: RequestId,
    job: Job,
    out: Sender<Message>,
}

pub struct GdxWorker {
    tx: Sender<Msg>,
}

impl GdxWorker {
    pub fn spawn(sysdir: Option<PathBuf>) -> GdxWorker {
        Self::spawn_with(sysdir, MAX_OPEN, IDLE_TIMEOUT)
    }

    pub fn spawn_with(sysdir: Option<PathBuf>, max_open: usize, idle: Duration) -> GdxWorker {
        let (tx, rx) = unbounded::<Msg>();
        std::thread::Builder::new()
            .name("gdx".into())
            .spawn(move || {
                let mut cache: Cache<GdxFile> = Cache::new(max_open, idle);
                let mut derived = Derived::default();
                loop {
                    let m = match cache.next_deadline() {
                        None => match rx.recv() {
                            Ok(m) => m,
                            Err(_) => break,
                        },
                        Some(d) => match rx.recv_timeout(d.saturating_duration_since(Instant::now())) {
                            Ok(m) => m,
                            Err(RecvTimeoutError::Timeout) => {
                                cache.evict_idle(Instant::now());
                                derived.evict_idle(Instant::now(), idle);
                                continue;
                            }
                            Err(RecvTimeoutError::Disconnected) => break,
                        },
                    };
                    cache.evict_idle(Instant::now());
                    derived.evict_idle(Instant::now(), idle);
                    let res = match (&m.job, &sysdir) {
                        (Job::Release { path }, _) => {
                            match path {
                                Some(p) => {
                                    cache.remove(&path_key(p));
                                    derived.remove_path(&path_key(p));
                                }
                                None => {
                                    cache.clear();
                                    derived.clear();
                                }
                            }
                            Ok(Json::Null)
                        }
                        // GDX files are read by gdx-rs: no GAMS system directory is needed
                        (_, sd) => {
                            let sd = sd.as_deref().unwrap_or(Path::new(""));
                            let r = crate::gdx_index::guarded(|| handle(sd, &mut cache, &mut derived, m.job));
                            match r {
                                Ok(r) => r,
                                Err(e) => {
                                    // open files / derived tables may be inconsistent after a panic
                                    cache.clear();
                                    derived.clear();
                                    Err(e)
                                }
                            }
                        }
                    };
                    let resp = Response {
                        id: m.id,
                        response_result: res.map_err(|message| ResponseError { code: REQUEST_FAILED, message, data: None }),
                    };
                    let _ = m.out.send(Message::Response(resp));
                }
            })
            .expect("spawn gdx thread");
        GdxWorker { tx }
    }

    /// Queue a job; the worker sends the response on `out` when done.
    pub fn submit(&self, id: RequestId, job: Job, out: Sender<Message>) {
        if let Err(e) = self.tx.send(Msg { id, job, out }) {
            // the worker thread is gone: answer instead of leaving the client waiting forever
            let m = e.into_inner();
            let resp = Response {
                id: m.id,
                response_result: Err(ResponseError { code: REQUEST_FAILED, message: "GDX worker is not running".into(), data: None }),
            };
            let _ = m.out.send(Message::Response(resp));
        }
    }
}

#[derive(PartialEq, Clone, Copy, Debug)]
struct Stamp(Option<SystemTime>, u64);

fn stamp(p: &Path) -> Result<Stamp, String> {
    let m = std::fs::metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(Stamp(m.modified().ok(), m.len()))
}

struct Entry<T> {
    stamp: Stamp,
    last_used: Instant,
    val: T,
}

/// Open files keyed by `path_key`: LRU-capped, dropped when idle or when the file's
/// modification time / size changes. `GdxFile` is `Send` but not `Sync`, so the cache lives on
/// the worker thread. Generic and clock-injected so the policy is unit-testable without GDX.
struct Cache<T> {
    map: HashMap<String, Entry<T>>,
    max_open: usize,
    idle: Duration,
}

impl<T> Cache<T> {
    fn new(max_open: usize, idle: Duration) -> Self {
        Cache { map: HashMap::new(), max_open: max_open.max(1), idle }
    }

    /// Is a still-valid entry cached? A stale one (changed stamp) is dropped. Marks it used.
    fn touch_valid(&mut self, key: &str, st: Stamp, now: Instant) -> bool {
        match self.map.get_mut(key) {
            Some(e) if e.stamp == st => {
                e.last_used = now;
                true
            }
            Some(_) => {
                self.map.remove(key);
                false
            }
            None => false,
        }
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        self.map.get_mut(key).map(|e| &mut e.val)
    }

    /// Insert, first closing least-recently-used entries so that at most `max_open` remain.
    fn insert(&mut self, key: String, st: Stamp, val: T, now: Instant) {
        self.map.remove(&key);
        self.make_room();
        self.map.insert(key, Entry { stamp: st, last_used: now, val });
    }

    /// Make room for one more entry (call before opening a new file, so the old handle is
    /// closed first and never more than `max_open` are open at once).
    fn make_room(&mut self) {
        while self.map.len() >= self.max_open {
            let Some(lru) = self.map.iter().min_by_key(|(_, e)| e.last_used).map(|(k, _)| k.clone()) else { break };
            self.map.remove(&lru);
        }
    }

    fn remove(&mut self, key: &str) {
        self.map.remove(key);
    }

    fn clear(&mut self) {
        self.map.clear();
    }

    /// Drop entries unused for `idle`. Returns how many were closed.
    fn evict_idle(&mut self, now: Instant) -> usize {
        let idle = self.idle;
        let before = self.map.len();
        self.map.retain(|_, e| now.saturating_duration_since(e.last_used) < idle);
        before - self.map.len()
    }

    /// When the next entry becomes idle (`None` if the cache is empty).
    fn next_deadline(&self) -> Option<Instant> {
        self.map.values().map(|e| e.last_used + self.idle).min()
    }
}

/// Small LRU keyed by string (front = oldest).
struct Lru<V> {
    cap: usize,
    items: Vec<(String, Instant, V)>,
}

impl<V: Clone> Lru<V> {
    fn new(cap: usize) -> Self {
        Lru { cap, items: Vec::new() }
    }
    fn get(&mut self, key: &str) -> Option<V> {
        let i = self.items.iter().position(|(k, _, _)| k == key)?;
        let mut e = self.items.remove(i);
        e.1 = Instant::now();
        let v = e.2.clone();
        self.items.push(e);
        Some(v)
    }
    fn put(&mut self, key: String, v: V) {
        self.items.retain(|(k, _, _)| *k != key);
        if self.items.len() >= self.cap {
            self.items.remove(0);
        }
        self.items.push((key, Instant::now(), v));
    }
}

/// Per-(file, symbol[, query]) derived data kept for paging: all raw records, the sorted /
/// filtered index and pivots. Keys start with `path_key|<stamp>|` so a changed file never hits.
struct Derived {
    raws: Lru<Rc<RawTable>>,
    orders: Lru<Rc<Vec<u32>>>,
    pivots: Lru<Rc<Pivot>>,
}

impl Default for Derived {
    fn default() -> Self {
        Derived { raws: Lru::new(2), orders: Lru::new(8), pivots: Lru::new(2) }
    }
}

impl Derived {
    fn clear(&mut self) {
        *self = Derived::default();
    }
    fn remove_path(&mut self, pk: &str) {
        let pre = format!("{pk}|");
        self.raws.items.retain(|(k, _, _)| !k.starts_with(&pre));
        self.orders.items.retain(|(k, _, _)| !k.starts_with(&pre));
        self.pivots.items.retain(|(k, _, _)| !k.starts_with(&pre));
    }
    fn evict_idle(&mut self, now: Instant, idle: Duration) {
        self.raws.items.retain(|e| now.saturating_duration_since(e.1) < idle);
        self.orders.items.retain(|e| now.saturating_duration_since(e.1) < idle);
        self.pivots.items.retain(|e| now.saturating_duration_since(e.1) < idle);
    }
}

fn open<'a>(sysdir: &Path, cache: &'a mut Cache<GdxFile>, path: &str) -> Result<&'a mut GdxFile, String> {
    let p = PathBuf::from(path);
    let st = stamp(&p)?;
    let key = path_key(path);
    let now = Instant::now();
    if !cache.touch_valid(&key, st, now) {
        cache.make_room();
        let f = GdxFile::open(sysdir, &p).map_err(|e| e.to_string())?;
        cache.insert(key.clone(), st, f, now);
    }
    Ok(cache.get_mut(&key).expect("just inserted"))
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

/// `gmsVarTypeText` (gclgms.h).
const VAR_TYPES: [&str; 10] =
    ["Unknown", "Binary", "Integer", "Positive", "Negative", "Free", "Sos1", "Sos2", "Semicont", "Semiint"];
/// `GMS_EQUTYPE_*` order E G L N X C B.
const EQU_TYPES: [&str; 7] = ["=e=", "=g=", "=l=", "=n=", "=x=", "=c=", "=b="];

fn sub_type(k: SymbolKind, st: i32) -> Option<&'static str> {
    match k {
        SymbolKind::Variable => VAR_TYPES.get(usize::try_from(st).ok()?).copied(),
        SymbolKind::Equation => EQU_TYPES.get(usize::try_from(st).ok()?).copied(),
        SymbolKind::Set if st == 1 => Some("Singleton"),
        _ => None,
    }
}

fn value_json(g: &GdxFile, v: Value) -> Json {
    match v {
        Value::Num(x) => json!(x),
        Value::Acronym(x) => json!(g.acronym_name(x)),
        other => json!(other.special_name().unwrap_or("UNDF")),
    }
}

/// Cache key prefix of a file: `path_key|stamp|`.
fn file_key(path: &str) -> Result<String, String> {
    let st = stamp(Path::new(path))?;
    Ok(format!("{}|{:?}|", path_key(path), st))
}

/// Resolve an alias to the aliased set (Studio shows the aliased set's records).
fn resolve(g: &GdxFile, symbol_index: usize) -> Result<Option<(usize, gams_gdx::SymbolInfo)>, String> {
    let mut info = g.symbol(symbol_index).map_err(|e| e.to_string())?;
    let mut idx = symbol_index;
    if info.kind == SymbolKind::Alias {
        let target = usize::try_from(info.user_info).unwrap_or(0);
        if target == 0 {
            return Ok(None);
        }
        idx = target;
        info = g.symbol(idx).map_err(|e| e.to_string())?;
    }
    Ok(Some((idx, info)))
}

/// Memory guards for the whole-symbol paths (sort / filter / labels / pivot / defaults load every
/// record into a [`RawTable`]; unsorted paging does not). Overridable with the environment
/// variables `GAMS_GDX_MAX_QUERY_MB` (raw table size, default 512) and
/// `GAMS_GDX_MAX_PIVOT_RECORDS` (records entering a pivot, default 10 000 000).
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_raw_bytes: u64,
    pub max_pivot_records: u64,
}

impl Limits {
    pub fn from_env() -> Limits {
        let get = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(d);
        Limits { max_raw_bytes: get("GAMS_GDX_MAX_QUERY_MB", 512) * 1024 * 1024, max_pivot_records: get("GAMS_GDX_MAX_PIVOT_RECORDS", 10_000_000) }
    }
}

fn limits() -> Limits {
    static L: std::sync::OnceLock<Limits> = std::sync::OnceLock::new();
    *L.get_or_init(Limits::from_env)
}

/// Bytes of a [`RawTable`] for `records` records: `dim` i32 keys + `stride` f64 values each.
pub fn raw_bytes(records: usize, dim: usize, stride: usize) -> u64 {
    records as u64 * (dim as u64 * 4 + stride as u64 * 8)
}

/// Error for a request that needs the whole symbol in memory but exceeds the guard. The
/// "[limit]" prefix lets the client tell it from other failures (it then drops sort / filters).
fn check_raw_limit(info: &SymbolInfo, lim: &Limits) -> Result<(), String> {
    let stride = match info.kind {
        SymbolKind::Variable | SymbolKind::Equation => 5,
        _ => 1,
    };
    let bytes = raw_bytes(info.records, info.dim, stride);
    if bytes > lim.max_raw_bytes {
        return Err(format!(
            "[limit] {} has {} records (about {} MB in memory); sorting, filtering, the table view and label lists are limited to {} MB \
             (environment variable GAMS_GDX_MAX_QUERY_MB). Unsorted paging in the list view still works.",
            info.name,
            info.records,
            bytes / (1024 * 1024),
            lim.max_raw_bytes / (1024 * 1024)
        ));
    }
    Ok(())
}

fn raw_table(g: &mut GdxFile, d: &mut Derived, fk: &str, idx: usize) -> Result<Rc<RawTable>, String> {
    let key = format!("{fk}raw{idx}");
    if let Some(t) = d.raws.get(&key) {
        return Ok(t);
    }
    check_raw_limit(&g.symbol(idx).map_err(|e| e.to_string())?, &limits())?;
    let t = Rc::new(g.read_all(idx).map_err(|e| e.to_string())?);
    d.raws.put(key, t.clone());
    Ok(t)
}

/// The sorted / filtered record order of a symbol, cached per query.
fn ordered(
    g: &mut GdxFile,
    d: &mut Derived,
    fk: &str,
    idx: usize,
    q: &QuerySpec,
) -> Result<(Rc<RawTable>, Rc<Vec<u32>>), String> {
    let t = raw_table(g, d, fk, idx)?;
    let key = format!("{fk}ord{idx}|{}", q.key);
    if let Some(o) = d.orders.get(&key) {
        return Ok((t, o));
    }
    let g = std::cell::RefCell::new(&mut *g);
    let o = query::apply(&t, &q.query, &mut |u| g.borrow_mut().uel(u), &mut |n| g.borrow().element_text(n));
    let o = Rc::new(o);
    d.orders.put(key, o.clone());
    Ok((t, o))
}

fn cell_json(g: &GdxFile, t: &RawTable, rec: usize, slot: usize) -> Json {
    if t.is_set {
        json!(g.element_text(t.val(rec, 0) as i32))
    } else {
        value_json(g, t.value(rec, slot))
    }
}

fn handle(sysdir: &Path, cache: &mut Cache<GdxFile>, derived: &mut Derived, job: Job) -> Result<Json, String> {
    match job {
        #[cfg(test)]
        Job::Panic => panic!("injected panic"),
        Job::Symbols { path } => {
            let g = open(sysdir, cache, &path)?;
            let syms: Vec<Json> = g
                .symbols()
                .into_iter()
                .map(|s| {
                    let mut o = json!({
                        "index": s.index, "name": s.name, "dim": s.dim, "kind": kind_name(s.kind),
                        "records": s.records, "text": s.explanatory_text, "domain": s.domain,
                    });
                    if let Some(t) = sub_type(s.kind, s.sub_type) {
                        o["subType"] = json!(t);
                    }
                    if s.kind == SymbolKind::Alias {
                        // aliased set (needed by the Excel / Connect export)
                        if let Ok(t) = g.symbol(usize::try_from(s.user_info).unwrap_or(0)) {
                            o["aliasOf"] = json!(t.name);
                        }
                    }
                    o
                })
                .collect();
            Ok(json!({ "symbols": syms }))
        }
        Job::Release { .. } => Ok(Json::Null), // handled by the worker loop
        Job::Records { path, symbol_index, offset, limit, query } => {
            let fk = file_key(&path)?;
            let g = open(sysdir, cache, &path)?;
            let Some((idx, info)) = resolve(g, symbol_index)? else {
                return Ok(json!({ "total": 0, "records": [] }));
            };
            if !query.query.is_empty() {
                // whole-symbol sorted / filtered view, paged from the cached order
                let (t, order) = ordered(g, derived, &fk, idx, &query)?;
                let end = offset.saturating_add(limit).min(order.len());
                let page = order.get(offset.min(order.len())..end).unwrap_or(&[]);
                let n_vals = t.stride;
                let out: Vec<Json> = page
                    .iter()
                    .map(|&r| {
                        let r = r as usize;
                        let keys: Vec<String> = (0..t.dim).map(|d| g.uel(t.key(r, d))).collect();
                        let values: Vec<Json> = if t.is_set {
                            vec![cell_json(g, &t, r, 0)]
                        } else {
                            (0..n_vals).map(|i| value_json(g, t.value(r, i))).collect()
                        };
                        let mut rec = json!({ "keys": keys, "values": values });
                        if t.is_set {
                            // the text "Y" in `values` is a placeholder for elements without text: `hasText` tells them apart
                            rec["hasText"] = json!(t.val(r, 0) as i32 > 0);
                        }
                        rec
                    })
                    .collect();
                return Ok(json!({ "total": order.len(), "unfiltered": t.len(), "records": out }));
            }
            let recs = g.records(idx, offset, limit).map_err(|e| e.to_string())?;
            let n_vals = match info.kind {
                SymbolKind::Variable | SymbolKind::Equation => 5,
                _ => 1,
            };
            let mut out = Vec::with_capacity(recs.len());
            for r in recs {
                let mut has_text = None;
                let values: Vec<Json> = if info.kind == SymbolKind::Set {
                    let nr = match r.values[0] {
                        Value::Num(x) => x as i64,
                        _ => 0,
                    };
                    has_text = Some(nr > 0);
                    // text number <= 0 (no element text) shows "Y" (Studio gdxsymboltablemodel.cpp)
                    vec![json!(g.element_text(nr as i32))]
                } else {
                    r.values[..n_vals].iter().map(|v| value_json(g, *v)).collect()
                };
                let mut rec = json!({ "keys": r.keys, "values": values });
                if let Some(h) = has_text {
                    rec["hasText"] = json!(h);
                }
                out.push(rec);
            }
            Ok(json!({ "total": info.records, "unfiltered": info.records, "records": out }))
        }
        Job::Labels { path, symbol_index, column } => {
            let fk = file_key(&path)?;
            let g = open(sysdir, cache, &path)?;
            let Some((idx, info)) = resolve(g, symbol_index)? else { return Ok(json!({ "labels": [] })) };
            if column >= info.dim {
                return Err(format!("column {column} is not a key column of {}", info.name));
            }
            let t = raw_table(g, derived, &fk, idx)?;
            let labels: Vec<String> = query::unique_uels(&t, column).into_iter().map(|u| g.uel(u)).collect();
            Ok(json!({ "labels": labels }))
        }
        Job::Defaults { path, symbol_index } => {
            let fk = file_key(&path)?;
            let g = open(sysdir, cache, &path)?;
            let Some((idx, info)) = resolve(g, symbol_index)? else { return Ok(json!({ "allDefault": [] })) };
            let is_var = match info.kind {
                SymbolKind::Variable => true,
                SymbolKind::Equation => false,
                _ => return Ok(json!({ "allDefault": [] })),
            };
            let t = raw_table(g, derived, &fk, idx)?;
            Ok(json!({ "allDefault": query::default_columns(&t, is_var, info.sub_type) }))
        }
        Job::Table(spec) => {
            let TableSpec { path, symbol_index, row_dims, col_dims, value_field, row_offset, row_limit, col_offset, col_limit, query } =
                *spec;
            let fk = file_key(&path)?;
            let g = open(sysdir, cache, &path)?;
            let Some((idx, info)) = resolve(g, symbol_index)? else {
                return Ok(json!({ "rowCount": 0, "colCount": 0, "rowHeaders": [], "colHeaders": [], "cells": [] }));
            };
            let dim = info.dim;
            // default (Studio initTableView): one column dimension (the last), rest are rows
            let (row_dims, col_dims) = match (row_dims, col_dims) {
                (None, None) => ((0..dim.saturating_sub(1)).collect::<Vec<_>>(), (dim.saturating_sub(1)..dim).collect()),
                (r, c) => {
                    let r = r.unwrap_or_default();
                    let c = c.unwrap_or_else(|| (0..dim).filter(|d| !r.contains(d)).collect());
                    (r, c)
                }
            };
            let mut all: Vec<usize> = row_dims.iter().chain(col_dims.iter()).copied().collect();
            all.sort_unstable();
            if all != (0..dim).collect::<Vec<_>>() {
                return Err(format!("rowDims and colDims must partition the {dim} dimensions of {}", info.name));
            }
            let slots = match info.kind {
                SymbolKind::Variable | SymbolKind::Equation => 5,
                _ => 1,
            };
            if value_field >= slots {
                return Err(format!("valueField {value_field} out of range (0..{slots})"));
            }
            // pivot depends on the filters (not the sort) and the dimension split
            let mut fq = query.clone();
            fq.query.sort = None;
            let (t, order) = ordered(g, derived, &fk, idx, &fq)?;
            if order.len() as u64 > limits().max_pivot_records {
                return Err(format!(
                    "[limit] The table view of {} would pivot {} records; it is limited to {} (environment variable GAMS_GDX_MAX_PIVOT_RECORDS). Apply label filters or use the list view.",
                    info.name,
                    order.len(),
                    limits().max_pivot_records
                ));
            }
            let pkey = format!("{fk}piv{idx}|{:?}|{:?}|{}", row_dims, col_dims, fq.key);
            let pv = match derived.pivots.get(&pkey) {
                Some(p) => p,
                None => {
                    let p = Rc::new(query::pivot(&t, &order, &row_dims, &col_dims));
                    derived.pivots.put(pkey, p.clone());
                    p
                }
            };
            let r0 = row_offset.min(pv.rows.len());
            let r1 = row_offset.saturating_add(row_limit).min(pv.rows.len());
            let c0 = col_offset.min(pv.cols.len());
            let c1 = col_offset.saturating_add(col_limit).min(pv.cols.len());
            let hdr = |g: &mut GdxFile, h: &[i32]| -> Vec<String> { h.iter().map(|&u| g.uel(u)).collect() };
            let row_headers: Vec<Vec<String>> = pv.rows[r0..r1].iter().map(|h| hdr(g, h)).collect();
            let col_headers: Vec<Vec<String>> = pv.cols[c0..c1].iter().map(|h| hdr(g, h)).collect();
            let mut cells: Vec<Vec<Json>> = Vec::with_capacity(r1 - r0);
            for r in r0..r1 {
                cells.push(
                    (c0..c1)
                        .map(|c| match pv.cells.get(&(r as u32, c as u32)) {
                            Some(&rec) => cell_json(g, &t, rec as usize, value_field),
                            None => Json::Null, // missing cell stays blank (Studio)
                        })
                        .collect(),
                );
            }
            let mut out = json!({
                "rowCount": pv.rows.len(), "colCount": pv.cols.len(), "rowOffset": r0, "colOffset": c0,
                "rowDims": row_dims, "colDims": col_dims,
                "rowHeaders": row_headers, "colHeaders": col_headers, "cells": cells,
            });
            if t.is_set {
                // per row one char per cell: `1` element with text, `0` element without text (its cell shows the
                // placeholder `Y`), `-` no element (blank cell)
                let marks: Vec<String> = (r0..r1)
                    .map(|r| {
                        (c0..c1)
                            .map(|c| match pv.cells.get(&(r as u32, c as u32)) {
                                Some(&rec) if t.val(rec as usize, 0) as i32 > 0 => '1',
                                Some(_) => '0',
                                None => '-',
                            })
                            .collect()
                    })
                    .collect();
                out["hasText"] = json!(marks);
            }
            Ok(out)
        }
    }
}

// ---------------------------------------------------------------- request parsing

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SortP {
    column: usize,
    #[serde(default = "yes")]
    ascending: bool,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FilterP {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    regex: Option<String>,
    #[serde(default)]
    case_sensitive: bool,
}

fn yes() -> bool {
    true
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValueFilterP {
    column: usize,
    min: Option<f64>,
    max: Option<f64>,
    #[serde(default)]
    exclude: bool,
    /// default for all special-value flags
    show_special: Option<bool>,
    show_undef: Option<bool>,
    #[serde(rename = "showNA")]
    show_na: Option<bool>,
    #[serde(rename = "showPInf")]
    show_pinf: Option<bool>,
    #[serde(rename = "showMInf")]
    show_minf: Option<bool>,
    show_eps: Option<bool>,
    show_acronym: Option<bool>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct QueryP {
    sort: Option<SortP>,
    #[serde(default)]
    filters: std::collections::BTreeMap<String, FilterP>,
    value_filter: Option<serde_json::Value>,
}

/// Parse the optional `sort` / `filters` / `valueFilter` members of a request.
pub fn parse_query(p: &Json) -> Result<QuerySpec, String> {
    let q: QueryP = serde_json::from_value(p.clone()).map_err(|e| e.to_string())?;
    let mut out = Query { sort: q.sort.map(|s| Sort { column: s.column, ascending: s.ascending }), ..Default::default() };
    for (k, f) in &q.filters {
        let column: usize = k.parse().map_err(|_| format!("filter key {k:?} is not a column number"))?;
        let mode = match f.mode.as_deref() {
            None | Some("include") => FilterMode::Include,
            Some("exclude") => FilterMode::Exclude,
            Some(m) => return Err(format!("unknown filter mode {m:?}")),
        };
        let regex = match &f.regex {
            Some(r) if !r.is_empty() => Some(
                regex::Regex::new(&format!("{}{r}", if f.case_sensitive { "" } else { "(?i)" }))
                    .map_err(|e| format!("invalid regex: {e}"))?,
            ),
            _ => None,
        };
        out.label_filters.push(LabelFilter { column, mode, labels: f.labels.iter().cloned().collect(), regex });
    }
    let vfs: Vec<ValueFilterP> = match &q.value_filter {
        None | Some(Json::Null) => vec![],
        Some(v @ Json::Array(_)) => serde_json::from_value(v.clone()).map_err(|e| e.to_string())?,
        Some(v) => vec![serde_json::from_value(v.clone()).map_err(|e| e.to_string())?],
    };
    for v in vfs {
        let d = v.show_special.unwrap_or(true);
        let mut f = ValueFilter::new(v.column);
        f.min = v.min.unwrap_or(f64::NEG_INFINITY);
        f.max = v.max.unwrap_or(f64::INFINITY);
        f.exclude = v.exclude;
        f.show_undef = v.show_undef.unwrap_or(d);
        f.show_na = v.show_na.unwrap_or(d);
        f.show_pinf = v.show_pinf.unwrap_or(d);
        f.show_minf = v.show_minf.unwrap_or(d);
        f.show_eps = v.show_eps.unwrap_or(d);
        f.show_acronym = v.show_acronym.unwrap_or(d);
        out.value_filters.push(f);
    }
    // canonical cache key: the request members that define the query
    let key = serde_json::to_string(&json!({ "s": p.get("sort"), "f": p.get("filters"), "v": p.get("valueFilter") }))
        .map_err(|e| e.to_string())?;
    Ok(QuerySpec { query: out, key })
}

/// Parse the params of `gams/gdxRecords`, `gams/gdxLabels` and `gams/gdxTable`.
pub fn parse_job(method: &str, p: Json) -> Result<Job, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        path: String,
        #[serde(default)]
        symbol_index: usize,
        #[serde(default)]
        offset: usize,
        #[serde(default = "default_limit")]
        limit: usize,
        #[serde(default)]
        column: usize,
        row_dims: Option<Vec<usize>>,
        col_dims: Option<Vec<usize>>,
        #[serde(default)]
        value_field: usize,
        #[serde(default)]
        row_offset: usize,
        #[serde(default = "default_limit")]
        row_limit: usize,
        #[serde(default)]
        col_offset: usize,
        #[serde(default = "default_limit")]
        col_limit: usize,
    }
    fn default_limit() -> usize {
        1000
    }
    let q = parse_query(&p)?;
    let r: P = serde_json::from_value(p).map_err(|e| e.to_string())?;
    Ok(match method {
        "gams/gdxSymbols" => Job::Symbols { path: r.path },
        "gams/gdxDefaults" => Job::Defaults { path: r.path, symbol_index: r.symbol_index },
        "gams/gdxLabels" => Job::Labels { path: r.path, symbol_index: r.symbol_index, column: r.column },
        "gams/gdxTable" => Job::Table(Box::new(TableSpec {
            path: r.path,
            symbol_index: r.symbol_index,
            row_dims: r.row_dims,
            col_dims: r.col_dims,
            value_field: r.value_field,
            row_offset: r.row_offset,
            row_limit: r.row_limit,
            col_offset: r.col_offset,
            col_limit: r.col_limit,
            query: q,
        })),
        _ => Job::Records { path: r.path, symbol_index: r.symbol_index, offset: r.offset, limit: r.limit, query: q },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(n: u64) -> Stamp {
        Stamp(None, n)
    }

    #[test]
    fn lru_cap_evicts_least_recently_used() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut c: Cache<u32> = Cache::new(3, Duration::from_secs(300));
        for (i, k) in ["a", "b", "c"].iter().enumerate() {
            c.make_room();
            c.insert(k.to_string(), st(1), i as u32, at(i as u64));
        }
        assert!(c.touch_valid("a", st(1), at(10))); // a is now the most recent
        c.make_room(); // evicts b (oldest)
        c.insert("d".into(), st(1), 3, at(11));
        let mut keys: Vec<_> = c.map.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["a", "c", "d"]);
    }

    #[test]
    fn stale_stamp_drops_entry() {
        let now = Instant::now();
        let mut c: Cache<u32> = Cache::new(8, Duration::from_secs(300));
        c.insert("a".into(), st(1), 7, now);
        assert!(c.touch_valid("a", st(1), now));
        assert!(!c.touch_valid("a", st(2), now));
        assert!(c.get_mut("a").is_none());
    }

    #[test]
    fn idle_eviction_and_deadline() {
        let t0 = Instant::now();
        let mut c: Cache<u32> = Cache::new(8, Duration::from_secs(300));
        assert_eq!(c.next_deadline(), None);
        c.insert("a".into(), st(1), 1, t0);
        c.insert("b".into(), st(1), 2, t0 + Duration::from_secs(200));
        assert_eq!(c.next_deadline(), Some(t0 + Duration::from_secs(300)));
        assert_eq!(c.evict_idle(t0 + Duration::from_secs(299)), 0);
        assert_eq!(c.evict_idle(t0 + Duration::from_secs(300)), 1); // a idle
        assert!(c.get_mut("a").is_none() && c.get_mut("b").is_some());
        assert_eq!(c.evict_idle(t0 + Duration::from_secs(500)), 1);
        assert!(c.map.is_empty());
    }

    #[test]
    fn release_one_or_all() {
        let now = Instant::now();
        let mut c: Cache<u32> = Cache::new(8, Duration::from_secs(300));
        c.insert("a".into(), st(1), 1, now);
        c.insert("b".into(), st(1), 2, now);
        c.remove("a");
        assert!(c.get_mut("a").is_none() && c.get_mut("b").is_some());
        c.clear();
        assert!(c.map.is_empty());
    }

    fn sysdir() -> PathBuf {
        std::env::var("GAMS_SYSDIR").expect("GAMS_SYSDIR").into()
    }
    fn fixture() -> String {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../gams-gdx/tests/fixtures/mini.gdx").to_string_lossy().into_owned()
    }
    fn call(c: &mut Cache<GdxFile>, d: &mut Derived, method: &str, p: Json) -> Json {
        let mut p = p;
        p["path"] = json!(fixture());
        let job = parse_job(method, p).expect("parse");
        handle(&sysdir(), c, d, job).expect("handle")
    }

    #[test]
    fn records_query_pages_consistently() {
        if gams_capi::testing::sysdir_or_skip("records_query_pages_consistently").is_none() {
            return;
        }
        let mut c: Cache<GdxFile> = Cache::new(2, Duration::from_secs(60));
        let mut d = Derived::default();
        // fee(d,s) sorted by value descending, then paged 2 + 2
        let q = json!({"symbolIndex": 5, "sort": {"column": 2, "ascending": false}});
        let mut p1 = q.clone();
        p1["offset"] = json!(0);
        p1["limit"] = json!(2);
        let a = call(&mut c, &mut d, "gams/gdxRecords", p1);
        let mut p2 = q.clone();
        p2["offset"] = json!(2);
        p2["limit"] = json!(2);
        let b = call(&mut c, &mut d, "gams/gdxRecords", p2);
        assert_eq!(a["total"], 4);
        let all: Vec<f64> = a["records"].as_array().unwrap().iter().chain(b["records"].as_array().unwrap()).map(|r| r["values"][0].as_f64().unwrap()).collect();
        assert_eq!(all.len(), 4);
        assert!(all.windows(2).all(|w| w[0] >= w[1]), "{all:?}");
        assert_eq!(d.orders.items.len(), 1); // second page hit the cached order
        // filter changes total
        let f = json!({"symbolIndex": 5, "filters": {"1": {"mode": "include", "labels": ["west"]}}});
        let r = call(&mut c, &mut d, "gams/gdxRecords", f);
        assert_eq!((r["total"].as_u64(), r["unfiltered"].as_u64()), (Some(2), Some(4)));
        assert!(r["records"].as_array().unwrap().iter().all(|x| x["keys"][1] == "west"));
        // value filter (single object) + regex label filter
        let f = json!({"symbolIndex": 5, "valueFilter": {"column": 2, "min": 2.0}, "filters": {"0": {"mode": "exclude", "regex": "^SOU"}}});
        let r = call(&mut c, &mut d, "gams/gdxRecords", f);
        assert_eq!(r["total"], 1); // north.east 2.5
        // no query: legacy cursor path still works
        let r = call(&mut c, &mut d, "gams/gdxRecords", json!({"symbolIndex": 5, "offset": 0, "limit": 100}));
        assert_eq!(r["records"].as_array().unwrap().len(), 4);
        // sets keep element text, "Y" for no text
        let r = call(&mut c, &mut d, "gams/gdxRecords", json!({"symbolIndex": 1, "sort": {"column": 0, "ascending": true}}));
        assert_eq!(r["records"][0]["values"][0], "Y");
    }

    #[test]
    fn set_records_tell_no_text_from_the_text_y() {
        if gams_capi::testing::sysdir_or_skip("set_records_tell_no_text_from_the_text_y").is_none() {
            return;
        }
        use gams_gdx::write::{write_gdx, WriteSymbol};
        let path = std::env::temp_dir().join(format!("gams-gdx-hastext-{}.gdx", std::process::id()));
        let (x, y, z): (&[&str], &[&str], &[&str]) = (&["x"], &["y"], &["z"]);
        write_gdx(&sysdir(), &path, &[WriteSymbol::set_with_text("t", 1, &[(x, ""), (y, "Y"), (z, "text")])]).unwrap();
        let mut c: Cache<GdxFile> = Cache::new(2, Duration::from_secs(60));
        let mut d = Derived::default();
        let mut call_t = |p: Json| {
            let mut p = p;
            p["path"] = json!(path.to_string_lossy());
            handle(&sysdir(), &mut c, &mut d, parse_job("gams/gdxRecords", p).unwrap()).unwrap()
        };
        let want = |r: &Json| -> Vec<(String, String, bool)> {
            r["records"].as_array().unwrap().iter().map(|x| (x["keys"][0].as_str().unwrap().into(), x["values"][0].as_str().unwrap().into(), x["hasText"].as_bool().unwrap())).collect()
        };
        let expect = vec![("x".to_string(), "Y".to_string(), false), ("y".into(), "Y".into(), true), ("z".into(), "text".into(), true)];
        // cursor path and sorted / cached path report the same
        assert_eq!(want(&call_t(json!({"symbolIndex": 1, "limit": 10}))), expect);
        let sorted = want(&call_t(json!({"symbolIndex": 1, "sort": {"column": 0, "ascending": true}})));
        assert_eq!(sorted, expect);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn labels_and_table() {
        if gams_capi::testing::sysdir_or_skip("labels_and_table").is_none() {
            return;
        }
        let mut c: Cache<GdxFile> = Cache::new(2, Duration::from_secs(60));
        let mut d = Derived::default();
        let r = call(&mut c, &mut d, "gams/gdxLabels", json!({"symbolIndex": 5, "column": 0}));
        assert_eq!(r["labels"], json!(["north", "south"]));
        let t = call(&mut c, &mut d, "gams/gdxTable", json!({"symbolIndex": 5}));
        assert_eq!((t["rowCount"].as_u64(), t["colCount"].as_u64()), (Some(2), Some(2)));
        assert_eq!(t["cells"].as_array().unwrap().len(), 2);
        assert_eq!(t["rowHeaders"][0], json!(["north"]));
        // variable: marginal attribute, transposed, windowed
        let t = call(
            &mut c,
            &mut d,
            "gams/gdxTable",
            json!({"symbolIndex": 6, "rowDims": [1], "colDims": [0], "valueField": 1, "rowOffset": 1, "rowLimit": 1}),
        );
        assert_eq!((t["rowCount"].as_u64(), t["colCount"].as_u64()), (Some(2), Some(2)));
        assert_eq!(t["cells"].as_array().unwrap().len(), 1);
        assert_eq!(t["rowOffset"], 1);
        // filters restrict the pivot
        let t = call(&mut c, &mut d, "gams/gdxTable", json!({"symbolIndex": 5, "filters": {"0": {"labels": ["north"]}}}));
        assert_eq!(t["rowCount"], 1);
        // bad partition and bad field are errors
        let mut p = json!({"symbolIndex": 5, "rowDims": [0, 0]});
        p["path"] = json!(fixture());
        assert!(handle(&sysdir(), &mut c, &mut d, parse_job("gams/gdxTable", p).unwrap()).is_err());
        let mut p = json!({"symbolIndex": 5, "valueField": 3});
        p["path"] = json!(fixture());
        assert!(handle(&sysdir(), &mut c, &mut d, parse_job("gams/gdxTable", p).unwrap()).is_err());
    }

    #[test]
    fn raw_limit_message() {
        let info = gams_gdx::SymbolInfo {
            index: 1, name: "big".into(), dim: 2, kind: SymbolKind::Variable, records: 20_000_000,
            explanatory_text: String::new(), domain: vec![], user_info: 0, sub_type: 5,
        };
        // 20M variable records, 2 dims: (2*4 + 5*8) * 20M = 960 MB > default 512 MB
        let l = Limits { max_raw_bytes: 512 << 20, max_pivot_records: 10_000_000 };
        let e = check_raw_limit(&info, &l).unwrap_err();
        assert!(e.starts_with("[limit]") && e.contains("big"), "{e}");
        assert!(check_raw_limit(&SymbolInfo { records: 1000, ..info }, &l).is_ok());
        assert_eq!(raw_bytes(10, 1, 1), 120);
    }

    #[test]
    fn worker_survives_panic_and_dead_worker_replies() {
        if gams_capi::testing::sysdir_or_skip("worker_survives_panic_and_dead_worker_replies").is_none() {
            return;
        }
        let w = GdxWorker::spawn(Some(sysdir()));
        let (otx, orx) = crossbeam_channel::unbounded();
        w.submit(RequestId::from(1), Job::Panic, otx.clone());
        w.submit(RequestId::from(2), Job::Release { path: None }, otx.clone());
        let t = Duration::from_secs(20);
        let Message::Response(r1) = orx.recv_timeout(t).unwrap() else { panic!() };
        assert!(r1.response_result.unwrap_err().message.contains("injected panic"));
        let Message::Response(r2) = orx.recv_timeout(t).unwrap() else { panic!() };
        assert!(r2.response_result.is_ok());
        let (tx, rx) = unbounded::<Msg>();
        drop(rx);
        let dead = GdxWorker { tx };
        dead.submit(RequestId::from(3), Job::Panic, otx);
        let Message::Response(r3) = orx.recv_timeout(t).unwrap() else { panic!() };
        assert!(r3.response_result.is_err());
    }

    #[test]
    fn defaults_request() {
        if gams_capi::testing::sysdir_or_skip("defaults_request").is_none() {
            return;
        }
        let mut c: Cache<GdxFile> = Cache::new(2, Duration::from_secs(60));
        let mut d = Derived::default();
        // flow(d,s) is a positive variable with solved levels / marginals: lower bound 0 and scale 1 are default
        let r = call(&mut c, &mut d, "gams/gdxDefaults", json!({"symbolIndex": 6}));
        let a = r["allDefault"].as_array().unwrap();
        assert_eq!(a.len(), 5);
        assert_eq!(a[0], false); // level
        assert_eq!(a[2], true); // lower
        assert_eq!(a[4], true); // scale
        // parameters have no default columns
        let r = call(&mut c, &mut d, "gams/gdxDefaults", json!({"symbolIndex": 5}));
        assert_eq!(r["allDefault"], json!([]));
    }

    #[test]
    fn worker_reads_gdx_without_sysdir() {
        // GDX files are read by the pure Rust backend: no GAMS installation needed
        let w = GdxWorker::spawn(None);
        let (otx, orx) = crossbeam_channel::unbounded();
        w.submit(RequestId::from(1), parse_job("gams/gdxSymbols", json!({"path": fixture()})).unwrap(), otx);
        let Message::Response(r) = orx.recv_timeout(Duration::from_secs(20)).unwrap() else { panic!() };
        let v = r.response_result.expect("symbols without sysdir");
        assert!(v.to_string().contains("stock"), "{v}");
    }

    #[test]
    fn query_parse_errors() {
        assert!(parse_job("gams/gdxRecords", json!({"path": "x", "filters": {"a": {}}})).is_err());
        assert!(parse_job("gams/gdxRecords", json!({"path": "x", "filters": {"0": {"regex": "("}}})).is_err());
        assert!(parse_job("gams/gdxRecords", json!({"path": "x", "filters": {"0": {"mode": "zz"}}})).is_err());
    }
}
