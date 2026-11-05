// SPDX-License-Identifier: GPL-3.0-or-later
//! Workspace-wide GDX search (extension addition, not part of GAMS Studio):
//! `gams/gdxIndex {paths}` -> per file symbol metadata, and
//! `gams/gdxFindElement {paths, label, regex?, caseSensitive?}` -> symbols whose records use a label.
//!
//! Runs on its own worker thread, separate from the viewer cache in `gdx.rs`. Files are opened
//! only for the duration of one file's work and closed again before the next one starts, so GAMS
//! can overwrite them at any time. Index results are cached by `(path, mtime, size)`. Element
//! search first matches the label against the file's UEL table (cheap) and scans the keys of a
//! symbol's records only for files that contain a matching UEL. Requests honour a time budget and
//! `$/cancelRequest`; a partial result is flagged with `truncated: true`.
use crossbeam_channel::{unbounded, Sender};
use gams_gdx::{GdxFile, SymbolInfo, SymbolKind};
use gams_ref::path_key;
use lsp_server::{Message, RequestId, Response, ResponseError};
use serde_json::{json, Value as Json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// LSP `RequestCancelled`.
pub const REQUEST_CANCELLED: i32 = -32800;
/// Error message of a cancelled request (prefix-matched by the workers).
pub const CANCELLED: &str = "[cancelled]";
/// Prefix of the error message of a request that ran out of time.
pub const TIMEOUT: &str = "[timeout]";
/// Wall-clock budget of one request.
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(60);
/// Files whose index is kept in memory.
const MAX_CACHED_FILES: usize = 5000;
/// Matches returned by one `gams/gdxFindElement` request.
const MAX_MATCHES: usize = 10_000;
/// Records between two cancellation / deadline checks while scanning keys.
const CHECK_EVERY: usize = 1 << 14;

pub enum IndexJob {
    Index { paths: Vec<String> },
    /// Test hook: a job that panics inside the worker.
    #[cfg(test)]
    Panic,
    Find(FindSpec),
}

#[derive(Clone, Debug)]
pub struct FindSpec {
    pub paths: Vec<String>,
    pub label: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub max_matches: usize,
}

pub fn parse_job(method: &str, p: Json) -> Result<IndexJob, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        #[serde(default)]
        paths: Vec<String>,
        #[serde(default)]
        label: String,
        #[serde(default)]
        regex: bool,
        #[serde(default)]
        case_sensitive: bool,
        max_matches: Option<usize>,
    }
    let r: P = serde_json::from_value(p).map_err(|e| e.to_string())?;
    if method == "gams/gdxIndex" {
        return Ok(IndexJob::Index { paths: r.paths });
    }
    if r.label.is_empty() {
        return Err("label must not be empty".into());
    }
    Ok(IndexJob::Find(FindSpec {
        paths: r.paths,
        label: r.label,
        regex: r.regex,
        case_sensitive: r.case_sensitive,
        max_matches: r.max_matches.unwrap_or(MAX_MATCHES).min(MAX_MATCHES),
    }))
}

#[derive(Default)]
struct Shared {
    pending: HashSet<RequestId>,
    cancelled: HashSet<RequestId>,
}

struct Msg {
    id: RequestId,
    job: IndexJob,
    out: Sender<Message>,
}

pub struct GdxIndexWorker {
    tx: Sender<Msg>,
    shared: Arc<Mutex<Shared>>,
}

impl GdxIndexWorker {
    pub fn spawn(sysdir: Option<PathBuf>) -> GdxIndexWorker {
        Self::spawn_with(sysdir, DEFAULT_BUDGET)
    }

    pub fn spawn_with(sysdir: Option<PathBuf>, budget: Duration) -> GdxIndexWorker {
        let (tx, rx) = unbounded::<Msg>();
        let shared = Arc::new(Mutex::new(Shared::default()));
        let sh = shared.clone();
        std::thread::Builder::new()
            .name("gdx-index".into())
            .spawn(move || {
                let mut cache = IndexCache::default();
                for m in rx {
                    let is_cancelled = || sh.lock().map(|s| s.cancelled.contains(&m.id)).unwrap_or(false);
                    let ctl = Ctl { deadline: Instant::now() + budget, cancelled: &is_cancelled };
                    // GDX files are read by gdx-rs: no GAMS system directory is needed
                    let sd = sysdir.as_deref().unwrap_or(Path::new(""));
                    let res = {
                        let r = guarded(|| match &m.job {
                            IndexJob::Index { paths } => index(sd, &mut cache, paths, &ctl),
                            IndexJob::Find(spec) => find_element(sd, spec, &ctl),
                            #[cfg(test)]
                            IndexJob::Panic => panic!("injected panic"),
                        });
                        match r {
                            Err(e) => {
                                // state may be inconsistent after a panic: start over
                                cache = IndexCache::default();
                                Err((crate::gdx::REQUEST_FAILED, e))
                            }
                            Ok(_) if is_cancelled() => Err((REQUEST_CANCELLED, "cancelled".to_string())),
                            Ok(r) => Ok(r),
                        }
                    };
                    if let Ok(mut s) = sh.lock() {
                        s.pending.remove(&m.id);
                        s.cancelled.remove(&m.id);
                    }
                    let resp = Response {
                        id: m.id,
                        response_result: res.map_err(|(code, message)| ResponseError { code, message, data: None }),
                    };
                    let _ = m.out.send(Message::Response(resp));
                }
            })
            .expect("spawn gdx-index thread");
        GdxIndexWorker { tx, shared }
    }

    pub fn submit(&self, id: RequestId, job: IndexJob, out: Sender<Message>) {
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
                response_result: Err(ResponseError { code: crate::gdx::REQUEST_FAILED, message: "GDX index worker is not running".into(), data: None }),
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

/// Run one worker job; a panic becomes an error message (the worker keeps serving requests).
pub fn guarded<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).map_err(|p| {
        let what = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "unknown".into());
        format!("internal error while reading GDX files: {what}")
    })
}

pub struct Ctl<'a> {
    pub deadline: Instant,
    pub cancelled: &'a dyn Fn() -> bool,
}

impl Ctl<'_> {
    /// `Err` with a `[cancelled]` / `[timeout]` message once the request is cancelled or out of time.
    pub fn check(&self) -> Result<(), String> {
        if (self.cancelled)() {
            return Err(CANCELLED.to_string());
        }
        if Instant::now() >= self.deadline {
            return Err(format!("{TIMEOUT} The request exceeded its time budget."));
        }
        Ok(())
    }

    pub fn stop(&self) -> bool {
        (self.cancelled)() || Instant::now() >= self.deadline
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Stamp(Option<SystemTime>, u64);

fn stamp(p: &Path) -> Result<Stamp, String> {
    let m = std::fs::metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(Stamp(m.modified().ok(), m.len()))
}

fn mtime_ms(s: Stamp) -> i64 {
    s.0.and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Default)]
struct IndexCache {
    files: HashMap<String, (Stamp, Arc<Json>)>,
    /// Number of times a file was actually opened (tests).
    opened: usize,
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

fn symbol_json(s: &SymbolInfo) -> Json {
    json!({ "name": s.name, "type": kind_name(s.kind), "dim": s.dim, "records": s.records,
            "text": s.explanatory_text, "domain": s.domain })
}

/// `{ files: [{path, mtime, size, symbols} | {path, error}], truncated }`
fn index(sysdir: &Path, cache: &mut IndexCache, paths: &[String], ctl: &Ctl) -> Json {
    let mut out = Vec::with_capacity(paths.len());
    let mut truncated = false;
    for path in paths {
        if ctl.stop() {
            truncated = true;
            break;
        }
        let st = match stamp(Path::new(path)) {
            Ok(s) => s,
            Err(e) => {
                out.push(json!({ "path": path, "error": e }));
                continue;
            }
        };
        let key = path_key(path);
        let syms = match cache.files.get(&key) {
            Some((s, v)) if *s == st => v.clone(),
            _ => {
                cache.opened += 1;
                match GdxFile::open(sysdir, Path::new(path)) {
                    Ok(g) => {
                        let v = Arc::new(Json::Array(g.symbols().iter().map(symbol_json).collect()));
                        drop(g); // release the file before anything else happens
                        if cache.files.len() >= MAX_CACHED_FILES {
                            cache.files.clear();
                        }
                        cache.files.insert(key, (st, v.clone()));
                        v
                    }
                    Err(e) => {
                        cache.files.remove(&key);
                        out.push(json!({ "path": path, "error": e.to_string() }));
                        continue;
                    }
                }
            }
        };
        out.push(json!({ "path": path, "mtime": mtime_ms(st), "size": st.1, "symbols": *syms }));
    }
    json!({ "files": out, "truncated": truncated })
}

enum Matcher {
    Exact { label: String, cs: bool },
    Re(regex::Regex),
}

impl Matcher {
    fn new(spec: &FindSpec) -> Result<Matcher, String> {
        if spec.regex {
            let src = if spec.case_sensitive { spec.label.clone() } else { format!("(?i){}", spec.label) };
            regex::Regex::new(&src).map(Matcher::Re).map_err(|e| format!("invalid regular expression: {e}"))
        } else {
            Ok(Matcher::Exact { label: spec.label.clone(), cs: spec.case_sensitive })
        }
    }

    /// UEL numbers of `g` that match.
    fn uels(&self, g: &mut GdxFile, ctl: &Ctl) -> Option<HashSet<i32>> {
        let mut set = HashSet::new();
        match self {
            Matcher::Exact { label, cs } => {
                // GDX UEL lookup is case-insensitive; labels are unique ignoring case
                if let Some(nr) = g.find_uel(label) {
                    if !*cs || g.uel(nr) == *label {
                        set.insert(nr);
                    }
                }
            }
            Matcher::Re(re) => {
                for nr in 1..=g.uel_count() as i32 {
                    if nr % 4096 == 0 && ctl.stop() {
                        return None;
                    }
                    if re.is_match(&g.uel(nr)) {
                        set.insert(nr);
                    }
                }
            }
        }
        Some(set)
    }
}

/// `{ matches: [{path, symbol, type, dim, dims, labels}], filesWithLabel, truncated, errors }`
/// `dims` are the 0-based key positions in which a matching label occurs.
fn find_element(sysdir: &Path, spec: &FindSpec, ctl: &Ctl) -> Json {
    let m = match Matcher::new(spec) {
        Ok(m) => m,
        Err(e) => return json!({ "matches": [], "filesWithLabel": 0, "truncated": false, "error": e }),
    };
    let mut matches: Vec<Json> = Vec::new();
    let mut errors: Vec<Json> = Vec::new();
    let (mut truncated, mut with_label) = (false, 0usize);
    'files: for path in &spec.paths {
        if ctl.stop() {
            truncated = true;
            break;
        }
        let mut g = match GdxFile::open(sysdir, Path::new(path)) {
            Ok(g) => g,
            Err(e) => {
                errors.push(json!({ "path": path, "error": e.to_string() }));
                continue;
            }
        };
        let Some(uels) = m.uels(&mut g, ctl) else {
            truncated = true;
            break;
        };
        if uels.is_empty() {
            continue; // not in the UEL table: no symbol can use it
        }
        with_label += 1;
        for s in g.symbols() {
            if s.dim == 0 || s.records == 0 || s.kind == SymbolKind::Alias {
                continue;
            }
            let mut dims = vec![false; s.dim];
            let mut hit: Vec<i32> = Vec::new();
            let (mut n, mut stopped) = (0usize, false);
            let done = g.scan_keys(s.index, |keys| {
                n += 1;
                if n % CHECK_EVERY == 0 && ctl.stop() {
                    stopped = true;
                    return false;
                }
                for (d, k) in keys.iter().enumerate() {
                    if uels.contains(k) {
                        dims[d] = true;
                        if hit.len() < 5 && !hit.contains(k) {
                            hit.push(*k);
                        }
                    }
                }
                true
            });
            if let Err(e) = done {
                errors.push(json!({ "path": path, "symbol": s.name, "error": e.to_string() }));
                continue;
            }
            if stopped {
                truncated = true;
            }
            if hit.is_empty() {
                if stopped {
                    break 'files;
                }
                continue;
            }
            let labels: Vec<String> = hit.iter().map(|u| g.uel(*u)).collect();
            matches.push(json!({
                "path": path, "symbol": s.name, "type": kind_name(s.kind), "dim": s.dim,
                "dims": dims.iter().enumerate().filter(|(_, b)| **b).map(|(i, _)| i).collect::<Vec<_>>(),
                "labels": labels,
            }));
            if matches.len() >= spec.max_matches {
                truncated = true;
                break 'files;
            }
            if stopped {
                break 'files;
            }
        }
        // `g` is dropped here: the file is released before the next one is opened
    }
    json!({ "matches": matches, "filesWithLabel": with_label, "truncated": truncated, "errors": errors })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sysdir() -> PathBuf {
        std::env::var("GAMS_SYSDIR").expect("GAMS_SYSDIR").into()
    }
    fn fx(name: &str) -> String {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../gams-gdx/tests/fixtures").join(name).to_string_lossy().into_owned()
    }
    fn never() -> bool {
        false
    }
    fn ctl() -> Ctl<'static> {
        Ctl { deadline: Instant::now() + Duration::from_secs(30), cancelled: &never }
    }
    fn spec(paths: &[String], label: &str) -> FindSpec {
        FindSpec { paths: paths.to_vec(), label: label.into(), regex: false, case_sensitive: false, max_matches: 100 }
    }
    fn names(r: &Json) -> Vec<String> {
        r["matches"].as_array().unwrap().iter().map(|m| m["symbol"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn worker_survives_panic_and_dead_worker_replies() {
        if gams_capi::testing::sysdir_or_skip("worker_survives_panic_and_dead_worker_replies").is_none() {
            return;
        }
        let w = GdxIndexWorker::spawn(Some(sysdir()));
        let (otx, orx) = crossbeam_channel::unbounded();
        w.submit(RequestId::from(1), IndexJob::Panic, otx.clone());
        w.submit(RequestId::from(2), IndexJob::Index { paths: vec![fx("mini.gdx")] }, otx.clone());
        let t = Duration::from_secs(20);
        let Message::Response(r1) = orx.recv_timeout(t).unwrap() else { panic!() };
        assert!(r1.response_result.unwrap_err().message.contains("injected panic"));
        let Message::Response(r2) = orx.recv_timeout(t).unwrap() else { panic!() };
        assert!(r2.response_result.is_ok());
        // a worker whose thread is gone answers immediately
        let (tx, rx) = unbounded::<Msg>();
        drop(rx);
        let dead = GdxIndexWorker { tx, shared: Arc::new(Mutex::new(Shared::default())) };
        dead.submit(RequestId::from(3), IndexJob::Panic, otx);
        let Message::Response(r3) = orx.recv_timeout(t).unwrap() else { panic!() };
        assert!(r3.response_result.is_err());
    }

    #[test]
    fn index_lists_symbols() {
        if gams_capi::testing::sysdir_or_skip("index_lists_symbols").is_none() {
            return;
        }
        let mut c = IndexCache::default();
        let r = index(&sysdir(), &mut c, &[fx("mini.gdx"), "/nonexistent/x.gdx".into()], &ctl());
        let f = &r["files"][0];
        let syms = f["symbols"].as_array().unwrap();
        assert!(syms.iter().any(|s| s["name"] == "flow" && s["type"] == "Variable" && s["dim"] == 2));
        assert!(syms.iter().any(|s| s["name"] == "d" && s["type"] == "Set" && s["records"] == 2));
        assert!(f["mtime"].as_i64().unwrap() > 0);
        assert!(r["files"][1]["error"].is_string());
    }

    #[test]
    fn index_cache_invalidates_by_stamp() {
        if gams_capi::testing::sysdir_or_skip("index_cache_invalidates_by_stamp").is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("gdx_index_cache_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("c.gdx").to_string_lossy().into_owned();
        std::fs::copy(fx("mini.gdx"), &p).unwrap();
        let mut c = IndexCache::default();
        let a = index(&sysdir(), &mut c, std::slice::from_ref(&p), &ctl());
        index(&sysdir(), &mut c, std::slice::from_ref(&p), &ctl());
        assert_eq!(c.opened, 1, "second call is served from the cache");
        // replace with a different file (different size and mtime)
        std::fs::copy(fx("stats.gdx"), &p).unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
        drop(f);
        let b = index(&sysdir(), &mut c, std::slice::from_ref(&p), &ctl());
        assert_eq!(c.opened, 2);
        assert_ne!(a["files"][0]["symbols"], b["files"][0]["symbols"]);
        assert_ne!(a["files"][0]["mtime"], b["files"][0]["mtime"]);
        // same size, only mtime changes
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_modified(SystemTime::now() + Duration::from_secs(50)).unwrap();
        drop(f);
        index(&sysdir(), &mut c, &[p], &ctl());
        assert_eq!(c.opened, 3);
    }

    #[test]
    fn find_exact_and_case() {
        if gams_capi::testing::sysdir_or_skip("find_exact_and_case").is_none() {
            return;
        }
        let t = fx("mini.gdx");
        let r = find_element(&sysdir(), &spec(std::slice::from_ref(&t), "NORTH"), &ctl());
        assert_eq!(r["filesWithLabel"], 1);
        let n = names(&r);
        assert!(n.contains(&"d".to_string()) && n.contains(&"flow".to_string()) && n.contains(&"stock".to_string()), "{n:?}");
        assert!(!n.contains(&"s".to_string()));
        let m = r["matches"].as_array().unwrap().iter().find(|m| m["symbol"] == "flow").unwrap();
        assert_eq!(m["dims"], json!([0]));
        let m = r["matches"].as_array().unwrap().iter().find(|m| m["symbol"] == "fee").unwrap();
        assert_eq!(m["dims"], json!([0]));
        // case-sensitive: "NORTH" does not match "north"
        let mut s = spec(std::slice::from_ref(&t), "NORTH");
        s.case_sensitive = true;
        assert_eq!(find_element(&sysdir(), &s, &ctl())["filesWithLabel"], 0);
        s.label = "north".into();
        assert!(names(&find_element(&sysdir(), &s, &ctl())).contains(&"flow".to_string()));
        // absent label
        let r = find_element(&sysdir(), &spec(&[t], "nowhere"), &ctl());
        assert_eq!((r["filesWithLabel"].clone(), names(&r).len()), (json!(0), 0));
    }

    #[test]
    fn find_regex() {
        if gams_capi::testing::sysdir_or_skip("find_regex").is_none() {
            return;
        }
        let t = fx("mini.gdx");
        let mut s = spec(&[t], "^(ea|so)");
        s.regex = true;
        let r = find_element(&sysdir(), &s, &ctl());
        let m = r["matches"].as_array().unwrap().iter().find(|m| m["symbol"] == "flow").unwrap();
        assert_eq!(m["dims"], json!([0, 1]));
        assert_eq!(m["labels"].as_array().unwrap().len(), 2); // south, east
        s.label = "(".into();
        assert!(find_element(&sysdir(), &s, &ctl())["error"].is_string());
    }

    #[test]
    fn find_cancel_and_budget() {
        if gams_capi::testing::sysdir_or_skip("find_cancel_and_budget").is_none() {
            return;
        }
        let t = fx("mini.gdx");
        let yes = || true;
        let c = Ctl { deadline: Instant::now() + Duration::from_secs(30), cancelled: &yes };
        let r = find_element(&sysdir(), &spec(&[t.clone(), t.clone()], "north"), &c);
        assert_eq!(r["truncated"], true);
        assert!(r["matches"].as_array().unwrap().is_empty());
        let c = Ctl { deadline: Instant::now(), cancelled: &never };
        let mut cache = IndexCache::default();
        let r = index(&sysdir(), &mut cache, &[t], &c);
        assert_eq!(r["truncated"], true);
        assert_eq!(cache.opened, 0);
    }

    #[test]
    fn match_cap() {
        if gams_capi::testing::sysdir_or_skip("match_cap").is_none() {
            return;
        }
        let mut s = spec(&[fx("mini.gdx")], "north");
        s.max_matches = 1;
        let r = find_element(&sysdir(), &s, &ctl());
        assert_eq!(r["matches"].as_array().unwrap().len(), 1);
        assert_eq!(r["truncated"], true);
    }

    #[test]
    fn parse_errors() {
        assert!(parse_job("gams/gdxFindElement", json!({ "paths": [] })).is_err());
        assert!(parse_job("gams/gdxIndex", json!({ "paths": ["a"] })).is_ok());
    }
}
