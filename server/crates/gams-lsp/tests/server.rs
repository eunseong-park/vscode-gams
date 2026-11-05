// SPDX-License-Identifier: GPL-3.0-or-later
use gams_lsp::run;
use lsp_server::{Connection, Message, Notification, Request, RequestId};
use lsp_types::Uri;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::thread::JoinHandle;

/// GAMS system directory from `$GAMS_SYSDIR` (tests that need it call `sysdir_or_skip` first).
fn sysdir() -> String {
    std::env::var("GAMS_SYSDIR").unwrap_or_default()
}

/// canonicalize() without the Windows verbatim prefix (`\\?\`), like paths the client sends.
fn canon(p: PathBuf) -> PathBuf {
    let c = p.canonicalize().unwrap();
    let s = c.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(r) if !r.starts_with("UNC") => PathBuf::from(r),
        _ => c,
    }
}
fn fixtures() -> PathBuf {
    canon(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures"))
}
fn gdx_fixture() -> PathBuf {
    canon(Path::new(env!("CARGO_MANIFEST_DIR")).join("../gams-gdx/tests/fixtures/mini.gdx"))
}
/// file URI as VS Code sends it (`file:///C:/x` on Windows, `file:///x` elsewhere), percent-encoded.
fn uri(p: &Path) -> Uri {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut u = String::from("file://");
    if !s.starts_with('/') {
        u.push('/');
    }
    for &c in s.as_bytes() {
        if c.is_ascii_alphanumeric() || b"/-_.~:@!$&'()*+,;=".contains(&c) {
            u.push(c as char);
        } else {
            u.push_str(&format!("%{c:02X}"));
        }
    }
    Uri::from_str(&u).unwrap()
}

struct Client {
    c: Connection,
    next: i32,
    th: Option<JoinHandle<()>>,
}

impl Client {
    fn start(sysdir: Option<&str>) -> Client {
        Client::start_in(sysdir, &[])
    }
    fn start_in(sysdir: Option<&str>, folders: &[&Path]) -> Client {
        let (server, c) = Connection::memory();
        let th = std::thread::spawn(move || run(server).unwrap());
        let mut cl = Client { c, next: 1, th: Some(th) };
        let wf: Vec<Value> = folders.iter().map(|f| json!({ "uri": uri(f), "name": "w" })).collect();
        let r = cl.request(
            "initialize",
            json!({ "capabilities": {}, "initializationOptions": { "sysdir": sysdir }, "workspaceFolders": wf }),
        );
        assert!(r.get("capabilities").is_some());
        cl.notify("initialized", json!({}));
        cl
    }
    fn notify(&self, method: &str, params: Value) {
        self.c.sender.send(Message::Notification(Notification { method: method.into(), params })).unwrap();
    }
    fn try_request(&mut self, method: &str, params: Value) -> Result<Value, lsp_server::ResponseError> {
        let id = RequestId::from(self.next);
        self.next += 1;
        self.c.sender.send(Message::Request(Request { id: id.clone(), method: method.into(), params })).unwrap();
        loop {
            match self.c.receiver.recv_timeout(std::time::Duration::from_secs(30)).expect("response") {
                Message::Response(r) if r.id == id => return r.response_result,
                _ => {}
            }
        }
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.try_request(method, params).unwrap_or_else(|e| panic!("{method} failed: {}", e.message))
    }
    fn open(&self, path: &Path, lang: &str, text: &str) {
        self.notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": uri(path), "languageId": lang, "version": 1, "text": text } }),
        );
    }
    fn open_file(&self, path: &Path, lang: &str) {
        self.open(path, lang, &std::fs::read_to_string(path).unwrap());
    }
    fn shutdown(mut self) {
        self.request("shutdown", Value::Null);
        self.notify("exit", Value::Null);
        self.th.take().unwrap().join().unwrap();
    }
}

fn tdoc(p: &Path) -> Value {
    json!({ "uri": uri(p) })
}

/// (line, utf16 col) of the `nth` occurrence of `needle` in the file.
fn find(path: &Path, needle: &str, nth: usize) -> (u32, u32) {
    let t = std::fs::read_to_string(path).unwrap();
    let mut n = 0;
    for (i, l) in t.lines().enumerate() {
        let mut from = 0;
        while let Some(c) = l[from..].find(needle) {
            if n == nth {
                return (i as u32, (from + c) as u32);
            }
            n += 1;
            from += c + 1;
        }
    }
    panic!("{needle} not found");
}

fn gms() -> PathBuf {
    fixtures().join("mini.gms")
}

/// Copy of the gms in a directory without a .ref (the fixtures dir has one that would be auto-loaded).
fn plain_gms(tag: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("plain_{tag}"));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("mini.gms");
    std::fs::copy(gms(), &p).unwrap();
    p
}

fn with_ref(cl: &mut Client) {
    cl.open_file(&gms(), "gams");
    cl.notify("gams/refUpdated", json!({ "gmsUri": uri(&gms()), "refPath": fixtures().join("mini.ref") }));
}

#[test]
fn semantic_tokens_full_and_range() {
    let mut cl = Client::start(None);
    cl.open_file(&gms(), "gams");
    let r = cl.request("textDocument/semanticTokens/full", json!({ "textDocument": tdoc(&gms()) }));
    let data = r["data"].as_array().unwrap();
    assert!(data.len() > 50 && data.len().is_multiple_of(5));
    // first token: `$title` at 0:0 as gamsDco (Studio Syntax_dco, legend index 0)
    let first: Vec<u64> = data[..5].iter().map(|v| v.as_u64().unwrap()).collect();
    assert_eq!(&first[..4], &[0, 0, 6, 0]);
    let range = cl.request(
        "textDocument/semanticTokens/range",
        json!({ "textDocument": tdoc(&gms()), "range": { "start": {"line": 20, "character": 0}, "end": {"line": 22, "character": 0} } }),
    );
    let rd = range["data"].as_array().unwrap();
    assert!(!rd.is_empty() && rd.len() < data.len());
    assert!(rd[0].as_u64().unwrap() >= 20); // first delta line from line 0
    cl.shutdown();
}

#[test]
fn incremental_sync_updates_tokens() {
    let mut cl = Client::start(None);
    let p = Path::new("/tmp/none/x.gms");
    cl.open(p, "gams", "Set i / a /;\n");
    cl.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri(p), "version": 2 }, "contentChanges": [
            { "range": { "start": {"line": 0, "character": 4 }, "end": {"line": 0, "character": 5 } }, "text": "jjj" } ] }),
    );
    let r = cl.request("textDocument/documentSymbol", json!({ "textDocument": tdoc(p) }));
    assert_eq!(r[0]["name"], "jjj");
    cl.shutdown();
}

#[test]
fn document_symbols_and_folding() {
    let mut cl = Client::start(None);
    cl.open_file(&gms(), "gams");
    let r = cl.request("textDocument/documentSymbol", json!({ "textDocument": tdoc(&gms()) }));
    let names: Vec<&str> = r.as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    for n in ["d", "s", "stock", "need", "fee", "flow", "total", "obj", "cap", "dem", "ship"] {
        assert!(names.contains(&n), "{n} in {names:?}");
    }
    let i = &r[0];
    assert_eq!(i["name"], "d");
    assert!(i["detail"].as_str().unwrap().contains("depots"));
    let f = cl.request("textDocument/foldingRange", json!({ "textDocument": tdoc(&gms()) }));
    let (on, _) = find(&gms(), "$onText", 0);
    let (off, _) = find(&gms(), "$offText", 0);
    assert!(
        f.as_array().unwrap().iter().any(|r| r["startLine"] == on && r["endLine"] == off - 1 && r["kind"] == "comment"),
        "{f}"
    );
    cl.shutdown();
}

#[test]
fn hover_keyword_and_symbol() {
    let mut cl = Client::start(None);
    let g = plain_gms("hover");
    cl.open_file(&g, "gams");
    let (l, c) = find(&g, "Parameter", 0);
    let h = cl.request(
        "textDocument/hover",
        json!({ "textDocument": tdoc(&g), "position": { "line": l, "character": c + 2 } }),
    );
    assert!(h["contents"]["value"].as_str().unwrap().to_lowercase().contains("parameter"), "{h}");
    // declared-in-document fallback without a reference file
    let (l, c) = find(&g, "fee(d,s)", 0);
    let h = cl.request("textDocument/hover", json!({ "textDocument": tdoc(&g), "position": { "line": l, "character": c } }));
    assert!(h["contents"]["value"].as_str().unwrap().contains("cost per unit"), "{h}");
    cl.shutdown();
}

#[test]
fn reference_definition_references_hover_symbols() {
    let mut cl = Client::start(None);
    with_ref(&mut cl);
    // `d` in `stock(d)`: its first use (the 'stock(d)' parameter declaration)
    let (l, c) = find(&gms(), "stock(d)", 0);
    let pos = json!({ "line": l, "character": c + 6 });
    let d = cl.request("textDocument/definition", json!({ "textDocument": tdoc(&gms()), "position": pos }));
    let d = d.as_array().unwrap();
    // declared at line 6 (1-based), `d` at col 3..4 (0-based); /work/mini.gms is mapped to the open file
    assert_eq!(d[0]["uri"], uri(&gms()).as_str());
    assert_eq!(d[0]["range"]["start"], json!({ "line": 5, "character": 3 }));
    assert_eq!(d[0]["range"]["end"], json!({ "line": 5, "character": 4 }));
    let refs = cl.request(
        "textDocument/references",
        json!({ "textDocument": tdoc(&gms()), "position": pos, "context": { "includeDeclaration": true } }),
    );
    let n_all = refs.as_array().unwrap().len();
    assert!(n_all >= 10, "{n_all}");
    let refs2 = cl.request(
        "textDocument/references",
        json!({ "textDocument": tdoc(&gms()), "position": pos, "context": { "includeDeclaration": false } }),
    );
    assert!(refs2.as_array().unwrap().len() < n_all);
    // hover shows type, domain and text
    let (l, c) = find(&gms(), "fee(d,s)", 0);
    let h = cl.request("textDocument/hover", json!({ "textDocument": tdoc(&gms()), "position": { "line": l, "character": c } }));
    let v = h["contents"]["value"].as_str().unwrap();
    assert!(v.contains("Parameter fee(d,s)") && v.contains("cost per unit"), "{v}");
    // workspace symbols
    let ws = cl.request("workspace/symbol", json!({ "query": "dem" }));
    assert_eq!(ws[0]["name"], "dem");
    // custom tree request
    let rs = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&gms()) }));
    let syms = rs["symbols"].as_array().unwrap();
    let x = syms.iter().find(|s| s["name"] == "flow").unwrap();
    assert_eq!(x["type"], "Variable");
    assert_eq!(x["dim"], 2);
    assert_eq!(x["domain"], json!(["d", "s"]));
    assert!(!x["locations"]["declare"].as_array().unwrap().is_empty());
    assert!(!rs["refPath"].is_null());
    cl.shutdown();
}

#[test]
fn definition_without_ref_uses_declarations() {
    let mut cl = Client::start(None);
    let g = plain_gms("def");
    cl.open_file(&g, "gams");
    let (l, c) = find(&g, "stock(d)", 0);
    let d = cl.request("textDocument/definition", json!({ "textDocument": tdoc(&g), "position": { "line": l, "character": c } }));
    assert_eq!(d[0]["range"]["start"]["line"], l);
    let rs = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&g) }));
    assert!(rs["refPath"].is_null());
    cl.shutdown();
}

#[test]
fn autoload_ref_next_to_gms() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("autoload");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(gms(), dir.join("mini.gms")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(30));
    std::fs::copy(fixtures().join("mini.ref"), dir.join("mini.ref")).unwrap();
    let g = dir.join("mini.gms");
    let mut cl = Client::start(None);
    cl.open_file(&g, "gams");
    let rs = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&g) }));
    assert!(!rs["symbols"].as_array().unwrap().is_empty());
    cl.shutdown();
}

#[test]
fn lst_outline_and_links() {
    let lst = fixtures().join("mini.lst");
    let mut cl = Client::start(None);
    cl.open_file(&lst, "gams-lst");
    let r = cl.request("textDocument/documentSymbol", json!({ "textDocument": tdoc(&lst) }));
    let r = r.as_array().unwrap();
    assert!(r.len() >= 4, "{r:?}");
    assert_eq!(r[0]["name"], "C o m p i l a t i o n");
    assert_eq!(r[0]["range"]["start"]["line"], 7); // `B 8 ...` -> 0-based 7
    let eq = r.iter().find(|s| s["name"] == "Equation").expect("group");
    assert_eq!(eq["children"].as_array().unwrap().len(), 3);
    assert_eq!(eq["children"][0]["name"], "obj");
    let links = cl.request("textDocument/documentLink", json!({ "textDocument": tdoc(&lst) }));
    let links = links.as_array().unwrap();
    assert!(links.len() >= 25, "{}", links.len());
    let target = links.iter().find(|l| l["target"].as_str().unwrap().ends_with("mini.gms#L33")).expect("L33");
    assert_eq!(target["range"]["start"]["character"], 2);
    cl.shutdown();
}

#[test]
fn gdx_symbols_and_records() {
    let mut cl = Client::start(Some(sysdir().as_str()));
    let path = gdx_fixture();
    let s = cl.request("gams/gdxSymbols", json!({ "path": path }));
    let s = s["symbols"].as_array().unwrap();
    assert_eq!(s.len(), 10);
    assert_eq!(s[0]["name"], "d");
    assert_eq!(s[0]["kind"], "Set");
    assert_eq!(s[0]["index"], 1);
    assert_eq!(s[4]["name"], "fee");
    assert_eq!(s[4]["domain"], json!(["d", "s"]));
    assert_eq!(s[4]["records"], 4);
    assert_eq!(s[5]["subType"], "Positive");
    let r = cl.request("gams/gdxRecords", json!({ "path": path, "symbolIndex": 5, "offset": 2, "limit": 10 }));
    assert_eq!(r["total"], 4);
    assert_eq!(r["records"].as_array().unwrap().len(), 2);
    assert_eq!(r["records"][0]["values"].as_array().unwrap().len(), 1);
    let r = cl.request("gams/gdxRecords", json!({ "path": path, "symbolIndex": 1, "offset": 0, "limit": 10 }));
    assert_eq!(r["records"][0]["keys"], json!(["north"]));
    assert_eq!(r["records"][0]["values"][0], "Y"); // set element without text shows "Y" like Studio
    // equation: five fields, special values as strings
    let r = cl.request("gams/gdxRecords", json!({ "path": path, "symbolIndex": 9, "offset": 0, "limit": 10 }));
    assert_eq!(r["records"][0]["values"], json!([60.0, 0.0, "-INF", 90.0, 1.0]));
    let r = cl.request("gams/gdxRecords", json!({ "path": path, "symbolIndex": 10, "offset": 0, "limit": 10 }));
    assert_eq!(r["records"][0]["values"][3], "+INF");
    // EPS / NA / UNDF come from the self-written feat.gdx (variable `ship`, index 10)
    let feat = gdx_fixture().with_file_name("feat.gdx");
    let r = cl.request("gams/gdxRecords", json!({ "path": feat, "symbolIndex": 10, "offset": 0, "limit": 10 }));
    assert_eq!(r["records"][0]["values"], json!(["NA", "UNDF", "-INF", 5.0, 1.0]));
    assert_eq!(r["records"][2]["values"][0], "EPS");
    // errors
    let e = cl.try_request("gams/gdxSymbols", json!({ "path": "/nonexistent/x.gdx" })).unwrap_err();
    assert!(!e.message.is_empty());
    let e = cl.try_request("gams/gdxRecords", json!({ "path": path, "symbolIndex": 99, "offset": 0, "limit": 1 })).unwrap_err();
    assert!(!e.message.is_empty());
    cl.shutdown();
}

/// Number of open file descriptors of this process that point at `file` (Linux only).
#[cfg(target_os = "linux")]
fn open_fds(file: &Path) -> usize {
    std::fs::read_dir("/proc/self/fd")
        .unwrap()
        .flatten()
        .filter(|e| std::fs::read_link(e.path()).is_ok_and(|t| t == file))
        .count()
}

#[cfg(target_os = "linux")]
#[test]
fn gdx_release_closes_files() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gdx_release");
    std::fs::create_dir_all(&dir).unwrap();
    let (a, b) = (dir.join("a.gdx"), dir.join("b.gdx"));
    std::fs::copy(gdx_fixture(), &a).unwrap();
    std::fs::copy(gdx_fixture(), &b).unwrap();
    let (a, b) = (canon(a.to_path_buf()), canon(b.to_path_buf()));
    let mut cl = Client::start(Some(sysdir().as_str()));
    for p in [&a, &b] {
        cl.request("gams/gdxSymbols", json!({ "path": p }));
    }
    assert_eq!((open_fds(&a), open_fds(&b)), (1, 1));
    // release one
    assert_eq!(cl.request("gams/gdxRelease", json!({ "path": a })), Value::Null);
    assert_eq!((open_fds(&a), open_fds(&b)), (0, 1));
    // lazily reopened by the next request
    let r = cl.request("gams/gdxRecords", json!({ "path": a, "symbolIndex": 5, "offset": 0, "limit": 2 }));
    assert_eq!(r["records"].as_array().unwrap().len(), 2);
    assert_eq!(open_fds(&a), 1);
    // release all (params omitted / empty object)
    assert_eq!(cl.request("gams/gdxRelease", Value::Null), Value::Null);
    assert_eq!((open_fds(&a), open_fds(&b)), (0, 0));
    cl.request("gams/gdxSymbols", json!({ "path": b }));
    assert_eq!(cl.request("gams/gdxRelease", json!({})), Value::Null);
    assert_eq!(open_fds(&b), 0);
    // releasing something that is not open is fine
    assert_eq!(cl.request("gams/gdxRelease", json!({ "path": "/nonexistent.gdx" })), Value::Null);
    cl.shutdown();
}

#[test]
fn gdx_release_works_without_sysdir() {
    let mut cl = Client::start(None);
    assert_eq!(cl.request("gams/gdxRelease", json!({})), Value::Null);
    cl.shutdown();
}

#[test]
fn gdx_works_without_sysdir() {
    // GDX files are read by the pure Rust backend (gdx-rs): no GAMS installation needed
    let mut cl = Client::start(None);
    let r = cl.request("gams/gdxSymbols", json!({ "path": gdx_fixture() }));
    assert!(r.to_string().contains("stock"), "{r}");
    cl.shutdown();
}

fn opt_file(tag: &str, name: &str, text: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("opt_{tag}"));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, text).unwrap();
    p
}

fn diagnostics_for(cl: &Client, p: &Path) -> Vec<Value> {
    loop {
        match cl.c.receiver.recv_timeout(std::time::Duration::from_secs(10)).expect("diagnostics") {
            Message::Notification(n) if n.method == "textDocument/publishDiagnostics" && n.params["uri"] == json!(uri(p)) => {
                return n.params["diagnostics"].as_array().unwrap().clone();
            }
            _ => {}
        }
    }
}

#[test]
fn option_definitions_request_and_cache() {
    if gams_capi::testing::sysdir_or_skip("option_definitions_request_and_cache").is_none() {
        return; // needs the GAMS option library
    }
    let mut cl = Client::start(Some(sysdir().as_str()));
    for _ in 0..2 {
        let r = cl.request("gams/optionDefinitions", json!({ "def": "optgams.def" }));
        let opts = r["options"].as_array().unwrap();
        let reslim = opts.iter().find(|o| o["name"].as_str().unwrap().eq_ignore_ascii_case("reslim")).unwrap();
        assert_eq!(reslim["type"], 1);
        let lp = opts.iter().find(|o| o["name"] == "LP").unwrap();
        assert!(lp["enums"].as_array().unwrap().iter().any(|e| e["value"] == "CPLEX"));
        assert_eq!(lp["default"], "CPLEX");
    }
    assert!(cl.try_request("gams/optionDefinitions", json!({ "def": "../x.def" })).is_err());
    assert!(cl.try_request("gams/optionDefinitions", json!({ "def": "nope.def" })).is_err());
    cl.shutdown();
}

#[test]
fn opt_file_diagnostics_completion_hover() {
    if gams_capi::testing::sysdir_or_skip("opt_file_diagnostics_completion_hover").is_none() {
        return; // needs the GAMS option library
    }
    let mut cl = Client::start(Some(sysdir().as_str()));
    let good = opt_file("good", "cplex.opt", "lpmethod 4\nepgap 0.1 ! gap\n* comment\n\n");
    cl.open_file(&good, "gams-opt");
    assert!(diagnostics_for(&cl, &good).is_empty());
    let bad = opt_file("bad", "cplex.opt", "lpmethod 99\nbogusoption 1\nepgap abc\nlpmethod 2\n");
    cl.open_file(&bad, "gams-opt");
    let d = diagnostics_for(&cl, &bad);
    assert_eq!(d.len(), 3, "{d:?}");
    assert!(d[0]["message"].as_str().unwrap().contains("Unknown value"));
    assert!(d[1]["message"].as_str().unwrap().contains("Unknown option"));
    assert_eq!(d[1]["range"]["start"]["line"], 1);
    // completion: keys, then enum values
    let r = cl.request("textDocument/completion", json!({ "textDocument": tdoc(&bad), "position": { "line": 3, "character": 3 } }));
    assert!(r.as_array().unwrap().iter().any(|i| i["label"] == "lpmethod"));
    let r = cl.request("textDocument/completion", json!({ "textDocument": tdoc(&bad), "position": { "line": 3, "character": 9 } }));
    let labels: Vec<_> = r.as_array().unwrap().iter().map(|i| i["label"].as_str().unwrap().to_string()).collect();
    assert!(labels.contains(&"4".to_string()), "{labels:?}");
    // hover
    let h = cl.request("textDocument/hover", json!({ "textDocument": tdoc(&bad), "position": { "line": 2, "character": 2 } }));
    let v = h["contents"]["value"].as_str().unwrap();
    assert!(v.contains("epgap") && v.contains("Range: [0, 1]"), "{v}");
    // unknown solver file name -> info diagnostic only
    let unk = opt_file("unk", "nosuchsolver.opt", "a 1\n");
    cl.open_file(&unk, "gams-opt");
    assert_eq!(diagnostics_for(&cl, &unk)[0]["severity"], 3);
    // .op2 resolves to the same solver
    let op2 = opt_file("op2", "cplex.op2", "lpmethod 99\n");
    cl.open_file(&op2, "gams-opt");
    assert_eq!(diagnostics_for(&cl, &op2).len(), 1);
    cl.shutdown();
}

#[test]
fn edited_source_marks_reference_stale() {
    let mut cl = Client::start(None);
    with_ref(&mut cl);
    let (l, c) = find(&gms(), "fee(d,s)", 0);
    let hover = |cl: &mut Client, shift: u32| {
        let h = cl.request("textDocument/hover", json!({ "textDocument": tdoc(&gms()), "position": { "line": l + shift, "character": c } }));
        h["contents"]["value"].as_str().unwrap().to_string()
    };
    let r = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&gms()) }));
    assert_eq!(r["stale"], false);
    assert!(!hover(&mut cl, 0).contains("outdated"));
    // append a line at the end: the reference data is kept but flagged
    cl.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri(&gms()), "version": 2 }, "contentChanges": [
            { "range": { "start": {"line": 0, "character": 0 }, "end": {"line": 0, "character": 0 } }, "text": "* x\n" } ] }),
    );
    let r = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&gms()) }));
    assert_eq!(r["stale"], true);
    assert!(!r["symbols"].as_array().unwrap().is_empty());
    assert!(hover(&mut cl, 1).contains("reference data from last run"));
    // a new .ref clears the flag
    // (startedAt after the edit)
    let ms = |d: i64| (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 + d) as u64;
    cl.notify("gams/refUpdated", json!({ "gmsUri": uri(&gms()), "refPath": fixtures().join("mini.ref"), "startedAt": ms(1000) }));
    let r = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&gms()) }));
    assert_eq!(r["stale"], false);
    // compile started before the edit: stays stale
    cl.notify("gams/refUpdated", json!({ "gmsUri": uri(&gms()), "refPath": fixtures().join("mini.ref"), "startedAt": ms(-60_000) }));
    let r = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&gms()) }));
    assert_eq!(r["stale"], true);
    // missing ref: no panic, server still answers
    cl.notify("gams/refUpdated", json!({ "gmsUri": uri(&gms()), "refPath": "/nonexistent/x.ref" }));
    let r = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&gms()) }));
    assert_eq!(r["stale"], true);
    cl.shutdown();
}

/// Real GAMS 54.6 `$include` / `$batinclude` fixtures (mini_inc, mini_bat): the echoed lines of the
/// compilation listing carry global line numbers, which the `.ref` file tree maps back to the
/// right file and local line.
fn lst_links(stem: &str) -> Vec<String> {
    let dir = tmp_dir(&format!("lst_{stem}"));
    for e in ["gms", "lst"] {
        std::fs::copy(fixtures().join(format!("{stem}.{e}")), dir.join(format!("{stem}.{e}"))).unwrap();
    }
    // the recorded paths (/work/...) point at the copy so that the included files can be read
    let r = std::fs::read_to_string(fixtures().join(format!("{stem}.ref"))).unwrap();
    std::fs::write(dir.join(format!("{stem}.ref")), r.replace("/work/", &format!("{}/", dir.display()))).unwrap();
    for inc in ["mini_data.inc", "mini_rep.inc"] {
        std::fs::copy(fixtures().join(inc), dir.join(inc)).unwrap();
    }
    newer(&dir.join(format!("{stem}.ref")), 5); // the .ref must be newer than the .gms
    let lst = dir.join(format!("{stem}.lst"));
    let mut cl = Client::start(None);
    cl.open_file(&lst, "gams-lst");
    let links = cl.request("textDocument/documentLink", json!({ "textDocument": tdoc(&lst) }));
    cl.shutdown();
    // only the echoed source lines of the compilation section
    let text = std::fs::read_to_string(&lst).unwrap();
    let end = text.lines().position(|l| l == "Include File Summary").unwrap() as u64;
    links
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| l["range"]["start"]["line"].as_u64().unwrap() < end)
        .map(|l| l["target"].as_str().unwrap().rsplit('/').next().unwrap().to_string())
        .collect()
}

#[test]
fn lst_links_map_include_lines_with_ref() {
    let t = lst_links("mini_inc");
    let mut exp: Vec<String> = vec!["mini_inc.gms#L2".into(), "mini_inc.gms#L3".into(), "mini_inc.gms#L4".into()];
    exp.extend((1..=8).map(|n| format!("mini_data.inc#L{n}")));
    exp.extend((6..=19).map(|n| format!("mini_inc.gms#L{n}")));
    assert_eq!(t, exp);
}

#[test]
fn lst_links_map_batinclude_lines_with_ref() {
    let t = lst_links("mini_bat");
    let mut exp: Vec<String> = vec!["mini_bat.gms#L2".into(), "mini_bat.gms#L3".into(), "mini_bat.gms#L4".into()];
    exp.extend((1..=8).map(|n| format!("mini_data.inc#L{n}")));
    exp.extend((6..=18).map(|n| format!("mini_bat.gms#L{n}")));
    exp.extend((1..=4).map(|n| format!("mini_rep.inc#L{n}")));
    exp.push("mini_bat.gms#L20".into());
    assert_eq!(t, exp);
}

#[cfg(target_os = "linux")]
#[test]
fn gdx_index_and_find_release_files() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gdx_index");
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.gdx");
    std::fs::copy(gdx_fixture(), &a).unwrap();
    let a = canon(a.to_path_buf());
    let mut cl = Client::start(Some(sysdir().as_str()));
    let r = cl.request("gams/gdxIndex", json!({ "paths": [a] }));
    assert!(r["files"][0]["symbols"].as_array().unwrap().len() > 5);
    assert_eq!(open_fds(&a), 0, "index must not keep the file open");
    let r = cl.request("gams/gdxFindElement", json!({ "paths": [a], "label": "north" }));
    assert!(r["matches"].as_array().unwrap().iter().any(|m| m["symbol"] == "flow"));
    assert_eq!(open_fds(&a), 0, "find must not keep the file open");
    let e = cl.try_request("gams/gdxFindElement", json!({ "paths": [a], "label": "" })).unwrap_err();
    assert_eq!(e.code, -32602);
    // cancellation of an already finished / unknown request is harmless
    cl.notify("$/cancelRequest", json!({ "id": 9999 }));
    cl.request("gams/gdxIndex", json!({ "paths": [] }));
    cl.shutdown();
}

#[test]
fn gdx_index_works_without_sysdir() {
    let mut cl = Client::start(None);
    let r = cl.request("gams/gdxIndex", json!({ "paths": [gdx_fixture()] }));
    assert!(r.to_string().contains("stock"), "{r}");
    cl.shutdown();
}

// ---------------------------------------------------------------- .gms completion

fn completion_at(cl: &mut Client, p: &Path, line: u32, character: u32, trigger: Option<&str>) -> Value {
    let ctx = match trigger {
        Some(t) => json!({ "triggerKind": 2, "triggerCharacter": t }),
        None => json!({ "triggerKind": 1 }),
    };
    cl.request(
        "textDocument/completion",
        json!({ "textDocument": tdoc(p), "position": { "line": line, "character": character }, "context": ctx }),
    )
}

#[test]
fn gms_completion_dco_symbols_and_attributes() {
    let mut cl = Client::start(None);
    let p = plain_gms("completion");
    let text = "Set i 'plants' / a, b /;\nVariable x(i) 'shipment';\n$\nx.\ndisplay x.l, i;\n* x.\n";
    cl.open(&p, "gams", text);
    // `$` at the line start: DCOs with documentation, text edit replacing the `$`
    let r = completion_at(&mut cl, &p, 2, 1, Some("$"));
    let items = r.as_array().unwrap();
    assert!(items.len() > 200);
    let on_text = items.iter().find(|i| i["label"] == "$onText").unwrap();
    assert_eq!(on_text["kind"], 14); // Keyword
    assert_eq!(on_text["detail"], "dollar control option");
    assert!(!on_text["documentation"]["value"].as_str().unwrap().is_empty());
    assert_eq!(on_text["textEdit"]["range"]["start"], json!({ "line": 2, "character": 0 }));
    assert_eq!(on_text["textEdit"]["range"]["end"], json!({ "line": 2, "character": 1 }));
    assert_eq!(on_text["textEdit"]["newText"], "$onText");
    // `x.`: variable attributes (extension)
    let r = completion_at(&mut cl, &p, 3, 2, Some("."));
    let labels: Vec<&str> = r.as_array().unwrap().iter().map(|i| i["label"].as_str().unwrap()).collect();
    assert!(labels.contains(&"l") && labels.contains(&"lo") && labels.contains(&"prior"), "{labels:?}");
    assert_eq!(r[0]["kind"], 5); // Field
    // symbols of the document after `display `
    let r = completion_at(&mut cl, &p, 4, 8, None);
    let x = r.as_array().unwrap().iter().find(|i| i["label"] == "x").expect("x");
    assert_eq!(x["kind"], 6); // Variable
    assert_eq!(x["documentation"]["value"], "shipment");
    // nothing in comments; a typed blank / `=` (the .opt triggers) does not open the list
    assert!(completion_at(&mut cl, &p, 5, 4, Some(".")).as_array().unwrap().is_empty());
    assert!(completion_at(&mut cl, &p, 4, 8, Some(" ")).is_null());
    cl.shutdown();
}

#[test]
fn gms_completion_uses_reference_symbols() {
    let mut cl = Client::start(None);
    with_ref(&mut cl);
    let n = std::fs::read_to_string(gms()).unwrap().lines().count() as u32;
    // append a line `display c` to the document
    cl.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri(&gms()), "version": 2 },
                "contentChanges": [{ "range": { "start": { "line": n, "character": 0 }, "end": { "line": n, "character": 0 } }, "text": "display fee\n" }] }),
    );
    let r = completion_at(&mut cl, &gms(), n, 11, None);
    let c = r.as_array().unwrap().iter().find(|i| i["label"] == "fee").expect("fee");
    assert_eq!(c["detail"], "Parameter fee(d,s)");
    assert!(c["documentation"]["value"].as_str().unwrap().contains("cost per unit"));
    cl.shutdown();
}

#[test]
fn opt_completion_ignores_gms_triggers() {
    if gams_capi::testing::sysdir_or_skip("opt_completion_ignores_gms_triggers").is_none() {
        return; // needs the GAMS option library
    }
    let mut cl = Client::start(Some(sysdir().as_str()));
    let p = opt_file("trig", "cplex.opt", "lpmethod 4\nlp.\n");
    cl.open_file(&p, "gams-opt");
    let _ = diagnostics_for(&cl, &p);
    assert!(completion_at(&mut cl, &p, 1, 3, Some(".")).is_null());
    let r = completion_at(&mut cl, &p, 0, 3, None);
    assert!(r.as_array().unwrap().iter().any(|i| i["label"] == "lpmethod"));
    cl.shutdown();
}

#[test]
fn gdx_compare_requests() {
    let mut cl = Client::start(Some(sysdir().as_str()));
    let a = gdx_fixture();
    let diff = canon(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../client/test/fixtures/gdxdiff/diff.gdx"));
    // a file compared with itself: everything equal
    // the default summary is cheap: nothing is merged, statuses stay pending
    let r = cl.request("gams/gdxCompareSymbols", json!({ "pathA": a, "pathB": a }));
    assert!(r["symbols"].as_array().unwrap().iter().all(|s| s["status"] == "pending"), "{r}");
    let r = cl.request("gams/gdxCompareSymbols", json!({ "pathA": a, "pathB": a, "full": true }));
    let syms = r["symbols"].as_array().unwrap();
    assert_eq!(syms.len(), 10);
    assert!(syms.iter().all(|s| s["status"] == "equal"), "{r}");
    let r = cl.request("gams/gdxCompareRecords", json!({ "pathA": a, "pathB": a, "name": "fee", "limit": 3 }));
    assert_eq!((r["total"].as_u64(), r["records"].as_array().unwrap().len(), r["differences"].as_u64()), (Some(4), 3, Some(0)));
    // a 2.5 vs 2.5 pair compared with a tolerance still reports bad parameters
    let e = cl.try_request("gams/gdxCompareSymbols", json!({ "pathA": a, "pathB": a, "eps": -1 })).unwrap_err();
    assert!(e.message.contains("eps"), "{}", e.message);
    // the output of gdxdiff
    let r = cl.request("gams/gdxDiffFileSymbols", json!({ "path": diff }));
    assert_eq!(r["fileA"], "a.gdx");
    assert_eq!(r["symbols"].as_array().unwrap().len(), 3);
    let r = cl.request("gams/gdxDiffFileNext", json!({ "path": diff, "name": "d" }));
    assert_eq!(r["index"], 0);
    let e = cl.try_request("gams/gdxDiffFileSymbols", json!({ "path": a })).unwrap_err();
    assert!(e.message.contains("gdxdiff"), "{}", e.message);
    cl.shutdown();
}

#[cfg(target_os = "linux")]
#[test]
fn gdx_compare_holds_no_open_files() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gdx_compare");
    std::fs::create_dir_all(&dir).unwrap();
    let (a, b) = (dir.join("a.gdx"), dir.join("b.gdx"));
    std::fs::copy(gdx_fixture(), &a).unwrap();
    std::fs::copy(gdx_fixture(), &b).unwrap();
    let (a, b) = (canon(a.to_path_buf()), canon(b.to_path_buf()));
    let mut cl = Client::start(Some(sysdir().as_str()));
    cl.request("gams/gdxCompareSymbols", json!({ "pathA": a, "pathB": b }));
    cl.request("gams/gdxCompareRecords", json!({ "pathA": a, "pathB": b, "name": "fee" }));
    // GAMS may rewrite the files (Windows locks open handles): the worker keeps none between requests
    assert_eq!((open_fds(&a), open_fds(&b)), (0, 0));
    cl.shutdown();
}

const MPSGE_DOC: &str = "\
* Data ----------------------------------
Set g / x, y /;
Parameter y0(g) 'output';

** Model ---
$onText
$MODEL:tiny

$SECTORS:
   Y(g)   ! activity
$COMMODITIES:
   P(g)
$CONSUMERS:
   RA
$PROD:Y(g) s:1
   O:P(g)   Q:y0(g)
   I:P(g)   Q:1
$DEMAND:RA
   D:P(g)   Q:1
$offText
$sysInclude mpsgeset tiny

* Solve ----------------------------------
Scalar done;
";

#[test]
fn mpsge_semantic_tokens_outline_folding_hover_completion() {
    let mut cl = Client::start(None);
    let p = plain_gms("mpsge");
    cl.open(&p, "gams", MPSGE_DOC);
    let lines: Vec<&str> = MPSGE_DOC.lines().collect();
    let at = |needle: &str| lines.iter().position(|l| l.contains(needle)).unwrap() as u32;

    // semantic tokens: MPSGE types are in the legend and used inside the block only
    let caps = serde_json::to_value(gams_lsp::capabilities()).unwrap();
    let legend: Vec<String> = caps["semanticTokensProvider"]["legend"]["tokenTypes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(legend.contains(&"gamsMpsgeSection".to_string()) && legend.contains(&"gamsMpsgeField".to_string()));
    let r = cl.request("textDocument/semanticTokens/full", json!({ "textDocument": tdoc(&p) }));
    let data: Vec<u64> = r["data"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
    let (mut l, mut c) = (0u64, 0u64);
    let mut mp: Vec<(u64, String, u64, u64)> = Vec::new();
    for t in data.chunks(5) {
        l += t[0];
        c = if t[0] > 0 { t[1] } else { c + t[1] };
        mp.push((l, legend[t[3] as usize].clone(), c, t[2]));
    }
    let (on, off) = (at("$onText") as u64, at("$offText") as u64);
    assert!(mp.iter().any(|t| t.1 == "gamsMpsgeSection" && t.0 == at("$PROD:Y(g)") as u64 && t.2 == 0 && t.3 == 6));
    assert!(mp.iter().any(|t| t.1 == "gamsMpsgeField" && t.0 == at("O:P(g)") as u64));
    assert!(mp.iter().filter(|t| t.1.starts_with("gamsMpsge")).all(|t| t.0 > on && t.0 < off));
    assert!(mp.iter().any(|t| t.1 == "gamsDco" && t.0 == on));
    // the range request uses the same overlay
    let rr = cl.request(
        "textDocument/semanticTokens/range",
        json!({ "textDocument": tdoc(&p), "range": { "start": {"line": at("$PROD:Y(g)"), "character": 0 }, "end": {"line": at("$PROD:Y(g)"), "character": 5 } } }),
    );
    assert!(!rr["data"].as_array().unwrap().is_empty());

    // outline: nested comment sections, MPSGE model with sections
    let o = cl.request("textDocument/documentSymbol", json!({ "textDocument": tdoc(&p) }));
    let top: Vec<&str> = o.as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(top, ["Data", "Solve"]);
    let data_sec = &o[0];
    let kids: Vec<&str> = data_sec["children"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(kids, ["g", "y0", "Model"]);
    let model = &data_sec["children"][2];
    assert_eq!(model["children"][0]["name"], "tiny");
    let secs: Vec<&str> = model["children"][0]["children"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(secs, ["$SECTORS:", "$COMMODITIES:", "$CONSUMERS:", "$PROD:Y(g)", "$DEMAND:RA"]);
    assert_eq!(model["children"][0]["children"][0]["children"][0]["name"], "Y(g)");
    assert_eq!(o[1]["children"][0]["name"], "done");
    assert_eq!(data_sec["range"]["start"]["line"], 0);

    // folding: comment sections and MPSGE sections
    let f = cl.request("textDocument/foldingRange", json!({ "textDocument": tdoc(&p) }));
    let folds: Vec<(u64, u64)> = f.as_array().unwrap().iter().map(|r| (r["startLine"].as_u64().unwrap(), r["endLine"].as_u64().unwrap())).collect();
    assert!(folds.contains(&(0, at("$sysInclude") as u64)), "{folds:?}");
    assert!(folds.contains(&(at("** Model") as u64, at("$sysInclude") as u64)));
    assert!(folds.contains(&(at("$PROD:Y(g)") as u64, at("I:P(g)") as u64)));
    assert!(folds.contains(&(on, off - 1)));

    // hover
    let (hl, hc) = (at("$PROD:Y(g)"), 2);
    let h = cl.request("textDocument/hover", json!({ "textDocument": tdoc(&p), "position": { "line": hl, "character": hc } }));
    assert!(h["contents"]["value"].as_str().unwrap().contains("Production function"), "{h}");
    let qc = lines[at("O:P(g)") as usize].find("Q:").unwrap() as u32;
    let h = cl.request("textDocument/hover", json!({ "textDocument": tdoc(&p), "position": { "line": at("O:P(g)"), "character": qc } }));
    assert!(h["contents"]["value"].as_str().unwrap().contains("Reference quantity"), "{h}");

    // completion: field labels at the record start, section keywords after `$`
    cl.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri(&p), "version": 2 }, "contentChanges": [
            { "range": { "start": {"line": at("   D:P(g)"), "character": 0 }, "end": {"line": at("   D:P(g)"), "character": 0 } }, "text": "   \n$\n" } ] }),
    );
    let r = completion_at(&mut cl, &p, at("   D:P(g)"), 3, None);
    let labels: Vec<&str> = r.as_array().unwrap().iter().map(|i| i["label"].as_str().unwrap()).collect();
    assert_eq!(labels, ["D:", "E:"]);
    assert!(!r[0]["documentation"]["value"].as_str().unwrap().is_empty());
    let r = completion_at(&mut cl, &p, at("   D:P(g)") + 1, 1, Some("$"));
    let labels: Vec<&str> = r.as_array().unwrap().iter().map(|i| i["label"].as_str().unwrap()).collect();
    assert!(labels.contains(&"$SECTORS:") && labels.contains(&"$REPORT:") && !labels.contains(&"$onText"), "{labels:?}");
    assert_eq!(r[0]["textEdit"]["range"]["start"]["character"], 0);
    cl.shutdown();
}

#[test]
fn matching_parenthesis_request() {
    let mut cl = Client::start(None);
    let p = Path::new("/tmp/none/paren.gms");
    cl.open(p, "gams", "x = f(a,\n  b]);\n* (\n");
    let q = |cl: &mut Client, l: u32, c: u32| cl.request("gams/matchingParenthesis", json!({ "textDocument": tdoc(p), "position": { "line": l, "character": c } }));
    let r = q(&mut cl, 0, 5);
    assert_eq!(r["valid"], false); // `(` meets `]`
    assert_eq!(r["open"]["start"], json!({ "line": 0, "character": 5 }));
    assert_eq!(r["close"]["start"], json!({ "line": 1, "character": 3 }));
    let r = q(&mut cl, 1, 5); // after the final `)`: the nesting is already broken by `]`
    assert_eq!(r["origin"], "close");
    assert_eq!(r["valid"], false);
    assert!(q(&mut cl, 0, 0).is_null());
    assert!(q(&mut cl, 2, 3).is_null()); // inside a comment
    cl.shutdown();
}

#[test]
fn bracket_depths_request() {
    let mut cl = Client::start(None);
    let p = Path::new("/tmp/none/depths.gms");
    // the user's snippets: description brackets and `!` comments (with `$eolCom !`) are not reported
    let text = "$eolCom !\nparameters\n  flexiblePFX  Logical flag (1=flexible exchange rate) /1/,\n  m0(g)  Imports (cif)\n  ;\nmarket(g,\"m0\") = m0(g) + sum(s, s0(s,g));   ! Imports (cif)\ny = (a];\n";
    cl.open(p, "gams", text);
    let q = |cl: &mut Client, r: Value| cl.request("gams/bracketDepths", json!({ "textDocument": tdoc(p), "range": r }));
    let all = q(&mut cl, json!({ "start": { "line": 0, "character": 0 }, "end": { "line": 99, "character": 0 } }));
    let brackets: Vec<(u64, u64, u64, bool)> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|b| (b["range"]["start"]["line"].as_u64().unwrap(), b["range"]["start"]["character"].as_u64().unwrap(), b["depth"].as_u64().unwrap(), b["valid"].as_bool().unwrap()))
        .collect();
    let lines: Vec<u64> = brackets.iter().map(|b| b.0).collect();
    assert_eq!(lines, [3, 3, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6], "{brackets:?}");
    // `sum(s, s0(s,g))`: outer 0, inner 1; closers report the level of their opener
    let sum: Vec<u64> = brackets.iter().filter(|b| b.0 == 5).skip(4).map(|b| b.2).collect();
    assert_eq!(sum, [0, 1, 1, 0]);
    assert!(brackets.iter().filter(|b| b.0 < 6).all(|b| b.3));
    assert!(brackets.iter().filter(|b| b.0 == 6).all(|b| !b.3)); // `(a]` is mismatched
    assert_eq!(all[0]["range"]["end"], json!({ "line": 3, "character": 5 }));
    // only brackets starting inside the range, ends exclusive
    let part = q(&mut cl, json!({ "start": { "line": 5, "character": 0 }, "end": { "line": 5, "character": 7 } }));
    assert_eq!(part.as_array().unwrap().len(), 1);
    // a change invalidates the cache
    cl.notify("textDocument/didChange", json!({ "textDocument": { "uri": tdoc(p)["uri"], "version": 2 }, "contentChanges": [{ "text": "x = ((a));\n" }] }));
    let r = q(&mut cl, json!({ "start": { "line": 0, "character": 0 }, "end": { "line": 1, "character": 0 } }));
    assert_eq!(r.as_array().unwrap().iter().map(|b| b["depth"].as_u64().unwrap()).collect::<Vec<_>>(), [0, 1, 1, 0]);
    // not for other languages
    cl.open(Path::new("/tmp/none/x.opt"), "gams-opt", "(a)\n");
    let r = cl.request("gams/bracketDepths", json!({ "textDocument": tdoc(Path::new("/tmp/none/x.opt")), "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 1, "character": 0 } } }));
    assert!(r.as_array().unwrap().is_empty());
    cl.shutdown();
}

#[test]
fn gms_completion_quick_suggestions_and_blank_triggers() {
    let mut cl = Client::start(None);
    let p = plain_gms("completion_blank");
    let text = "Set i / a, b /;\nVariable x(i);\nParameter d(i);\nPar;\nd(i) = x;\nfoo.;\nPositive ;\nModel m /all/;\nsolve m ;\nsolve m using lp ;\noption ;\ndisplay ;\nsolve m using ;\n";
    cl.open(&p, "gams", text);
    #[track_caller]
    fn labels(r: &Value) -> Vec<String> {
        r.as_array().unwrap_or_else(|| panic!("null result {r}")).iter().map(|i| i["label"].as_str().unwrap().to_string()).collect()
    }
    // statement start: declaration keywords
    let l = labels(&completion_at(&mut cl, &p, 3, 3, None));
    assert!(l.iter().any(|x| x == "Parameter") && l.iter().any(|x| x == "Parameters"), "{l:?}");
    // expression: symbol
    let l = labels(&completion_at(&mut cl, &p, 4, 8, None));
    assert!(l.iter().any(|x| x == "x"), "{l:?}");
    // unknown name before a dot
    let r = completion_at(&mut cl, &p, 5, 4, Some("."));
    assert!(labels(&r).iter().any(|x| x == "l"));
    assert!(r[0]["detail"].as_str().unwrap().contains("not known yet"));
    // blank triggers
    let l = labels(&completion_at(&mut cl, &p, 6, 9, Some(" ")));
    assert!(l.iter().any(|x| x == "Variable"), "{l:?}");
    let l = labels(&completion_at(&mut cl, &p, 8, 8, Some(" ")));
    assert!(l.iter().any(|x| x == "using"), "{l:?}");
    let l = labels(&completion_at(&mut cl, &p, 9, 17, Some(" ")));
    assert!(l.iter().any(|x| x == "minimize"), "{l:?}");
    let l = labels(&completion_at(&mut cl, &p, 12, 14, Some(" ")));
    assert!(l.iter().any(|x| x == "LP"), "{l:?}");
    let l = labels(&completion_at(&mut cl, &p, 10, 7, Some(" ")));
    assert!(l.iter().any(|x| x == "LimRow"), "{l:?}");
    // blank elsewhere and `=`: null
    assert!(completion_at(&mut cl, &p, 11, 8, Some(" ")).is_null());
    assert!(completion_at(&mut cl, &p, 4, 8, Some("=")).is_null());
    cl.shutdown();
}

// ---------------------------------------------------------------- QA fixes

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(tag);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn fold_ranges(cl: &mut Client, p: &Path) -> Vec<(u64, u64)> {
    let f = cl.request("textDocument/foldingRange", json!({ "textDocument": tdoc(p) }));
    f.as_array().unwrap().iter().map(|r| (r["startLine"].as_u64().unwrap(), r["endLine"].as_u64().unwrap())).collect()
}

/// What VS Code needs: one range per start line, and ranges are nested or disjoint.
fn assert_fold_structure(f: &[(u64, u64)]) {
    for (i, a) in f.iter().enumerate() {
        assert!(a.0 < a.1, "{f:?}");
        for b in &f[i + 1..] {
            assert_ne!(a.0, b.0, "two ranges start on one line: {f:?}");
            let crossing = (a.0 < b.0 && b.0 <= a.1 && b.1 > a.1) || (b.0 < a.0 && a.0 <= b.1 && a.1 > b.1);
            assert!(!crossing, "crossing ranges {a:?} {b:?}: {f:?}");
        }
    }
}

#[test]
fn folding_keeps_outermost_range_per_line_and_nests() {
    let mut cl = Client::start(None);
    let p = tmp_dir("fold_nest").join("f.gms");
    cl.open(&p, "gams", "loop(i$(a and\n b and\n c),\n x=1;\n y=2;\n);\n");
    let f = fold_ranges(&mut cl, &p);
    assert_eq!(f, [(0, 4)], "outer loop fold, not the inner condition");
    // section headers inside a bracket never cross it
    let text = "loop(i,\n* Part A ----\n x=1;\n y=2;\n* Part B ----\n z=3;\n w=4;\n);\nx = 1;\n";
    cl.open(&p, "gams", text);
    let f = fold_ranges(&mut cl, &p);
    assert_fold_structure(&f);
    assert!(f.contains(&(0, 6)), "{f:?}");
    assert!(f.contains(&(1, 3)) && f.contains(&(4, 6)), "{f:?}");
    // a section that runs into a bracket ends before it
    let text = "* Sec ----\nx = 1;\nloop(i,\n* Inner ----\n y=1;\n z=2;\n);\n";
    cl.open(&p, "gams", text);
    let f = fold_ranges(&mut cl, &p);
    assert_fold_structure(&f);
    assert!(f.contains(&(2, 5)), "{f:?}");
    cl.shutdown();
}

#[test]
fn include_links_and_definition() {
    let dir = tmp_dir("inc_links");
    let sys = dir.join("sys");
    std::fs::create_dir_all(sys.join("inclib")).unwrap();
    std::fs::write(sys.join("mpsgeset.gms"), "").unwrap();
    std::fs::write(sys.join("inclib/lib1.gms"), "").unwrap();
    let w = |n: &str| {
        std::fs::create_dir_all(dir.join("sub dir")).unwrap();
        std::fs::write(dir.join(n), "x = 1;\n").unwrap();
    };
    w("inc1.gms");
    w("data.inc");
    w("sub dir/b.inc");
    w("y.yaml");
    let main = dir.join("main.gms");
    let text = "$include inc1\n$include \"data.inc\"\n$batInclude 'sub dir/b.inc' a b\n$include missing\n$sysInclude mpsgeset K\n$libInclude lib1 x\n\
                * $include inc1\n$onEmbeddedCode Connect: yamlFile=y.yaml\n- GAMSReader:\n$offEmbeddedCode\n";
    let mut cl = Client::start(sys.to_str());
    cl.open(&main, "gams", text);
    let links = cl.request("textDocument/documentLink", json!({ "textDocument": tdoc(&main) }));
    let got: Vec<(u64, u64, u64, String)> = links
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["range"]["start"]["line"].as_u64().unwrap(),
                l["range"]["start"]["character"].as_u64().unwrap(),
                l["range"]["end"]["character"].as_u64().unwrap(),
                l["target"].as_str().unwrap().rsplit('/').next().unwrap().replace("%20", " "),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            (0, 9, 13, "inc1.gms".into()),
            (1, 10, 18, "data.inc".into()),
            (2, 13, 26, "b.inc".into()),
            (4, 12, 20, "mpsgeset.gms".into()),
            (5, 12, 16, "lib1.gms".into()),
            (7, 34, 40, "y.yaml".into()),
        ]
    );
    // definition on the file name opens the file
    let d = cl.request("textDocument/definition", json!({ "textDocument": tdoc(&main), "position": { "line": 0, "character": 10 } }));
    assert!(d["uri"].as_str().unwrap().ends_with("/inc1.gms"), "{d}");
    // not on the command word
    let d = cl.request("textDocument/definition", json!({ "textDocument": tdoc(&main), "position": { "line": 0, "character": 2 } }));
    assert!(d.is_null(), "{d}");
    cl.shutdown();
}

#[test]
fn untitled_documents_serve_hover_definition_references() {
    let mut cl = Client::start(None);
    let u = "untitled:Untitled-1";
    let text = "Set i 'my set' / a, b /;\nParameter d(i) 'dist';\nd(i) = 1;\n* d is prose\n";
    cl.notify("textDocument/didOpen", json!({ "textDocument": { "uri": u, "languageId": "gams", "version": 1, "text": text } }));
    let at = |l: u32, c: u32| json!({ "textDocument": { "uri": u }, "position": { "line": l, "character": c } });
    let h = cl.request("textDocument/hover", at(1, 2));
    assert!(h["contents"]["value"].as_str().unwrap().to_lowercase().contains("parameter"), "{h}");
    let h = cl.request("textDocument/hover", at(2, 0));
    assert!(h["contents"]["value"].as_str().unwrap().contains("dist"), "{h}");
    let d = cl.request("textDocument/definition", at(2, 0));
    assert_eq!(d[0]["range"]["start"]["line"], 1, "{d}");
    assert_eq!(d[0]["uri"], u);
    let mut p = at(2, 0);
    p["context"] = json!({ "includeDeclaration": true });
    let r = cl.request("textDocument/references", p.clone());
    assert_eq!(r.as_array().unwrap().len(), 2, "declaration + use, not the comment: {r}");
    p["context"] = json!({ "includeDeclaration": false });
    let r = cl.request("textDocument/references", p);
    assert_eq!(r.as_array().unwrap().len(), 1, "{r}");
    // prose: no symbol lookup in the comment
    assert!(cl.request("textDocument/hover", at(3, 2)).is_null());
    assert!(cl.request("textDocument/definition", at(3, 2)).is_null());
    cl.shutdown();
}

#[test]
fn prose_words_are_not_symbol_references() {
    let mut cl = Client::start(None);
    with_ref(&mut cl);
    let g = gms();
    let n = std::fs::read_to_string(&g).unwrap().lines().count() as u32;
    // append after the referenced lines: comment, $onText block, description, string
    let add = "* stock and need\n$onText\nstock here\n$offText\nParameter zz 'the stock of x';\ndisplay 'stock';\n";
    cl.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri(&g), "version": 2 }, "contentChanges": [
            { "range": { "start": {"line": n, "character": 0 }, "end": {"line": n, "character": 0 } }, "text": add } ] }),
    );
    let pos = |l: u32, c: u32| json!({ "textDocument": tdoc(&g), "position": { "line": l, "character": c } });
    for (l, c) in [(n, 3), (n + 2, 1), (n + 4, 20), (n + 5, 10)] {
        assert!(cl.request("textDocument/hover", pos(l, c)).is_null(), "hover {l}:{c}");
        assert!(cl.request("textDocument/definition", pos(l, c)).is_null(), "definition {l}:{c}");
        let mut p = pos(l, c);
        p["context"] = json!({ "includeDeclaration": true });
        assert!(cl.request("textDocument/references", p).as_array().unwrap().is_empty(), "references {l}:{c}");
    }
    // still resolved in code
    let (l, c) = find(&g, "cap(d)..", 0);
    let h = cl.request("textDocument/hover", pos(l, c + 1));
    assert!(h["contents"]["value"].as_str().unwrap().contains("cap"), "{h}");
    cl.shutdown();
}

const INC_REF: &str = "1 1 a SETS declared 1 1 6 0 1 {D}/inc.gms\n\
    1 1 a SETS ref 2 2 4 0 1 {D}/inc.gms\n\
    0 1 t\n1 a SETS 0 0 0 0\n\
    0 2 t\n1 1 INPUT 0 1 {D}/main.gms\n2 1 INCLUDE 1 1 {D}/inc.gms\n";

fn newer(p: &Path, secs: u64) {
    let t = std::time::SystemTime::now() + std::time::Duration::from_secs(secs);
    std::fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
}

#[test]
fn include_file_opened_alone_finds_the_reference() {
    let dir = tmp_dir("inc_alone");
    let sub = dir.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(dir.join("main.gms"), "$include sub/inc\n").unwrap();
    std::fs::write(sub.join("inc.gms"), "Set a 'the a' / x /;\na(\"x\") = 1;\n").unwrap();
    let ref_path = dir.join("main.ref");
    std::fs::write(&ref_path, INC_REF.replace("{D}/inc", &format!("{}/sub/inc", dir.display())).replace("{D}", &dir.display().to_string())).unwrap();
    newer(&ref_path, 5);
    // a decoy that does not list the file
    std::fs::write(dir.join("other.ref"), "0 0\n0 1\n1 1 INPUT 0 1 /x/other.gms\n").unwrap();
    newer(&dir.join("other.ref"), 10);
    let inc = sub.join("inc.gms");
    let mut cl = Client::start_in(None, &[&dir]);
    cl.open_file(&inc, "gams");
    let h = cl.request("textDocument/hover", json!({ "textDocument": tdoc(&inc), "position": { "line": 1, "character": 0 } }));
    assert!(h["contents"]["value"].as_str().unwrap().contains("Set a"), "{h}");
    let r = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&inc) }));
    assert!(r["refPath"].as_str().unwrap().ends_with("main.ref"), "{r}");
    cl.shutdown();
}

#[test]
fn set_main_file_assigns_the_reference() {
    let dir = tmp_dir("set_main");
    let other = tmp_dir("set_main_inc");
    let inc = other.join("inc.gms");
    std::fs::write(&inc, "Set a 'the a' / x /;\n").unwrap();
    std::fs::write(dir.join("main.gms"), "$include ../set_main_inc/inc\n").unwrap();
    let ref_path = dir.join("main.ref");
    let txt = INC_REF.replace("{D}/inc", &format!("{}/inc", other.display())).replace("{D}", &dir.display().to_string());
    std::fs::write(&ref_path, txt).unwrap();
    newer(&ref_path, 5);
    let mut cl = Client::start(None);
    cl.open_file(&inc, "gams");
    let pos = json!({ "textDocument": tdoc(&inc), "position": { "line": 0, "character": 4 } });
    assert!(cl.request("gams/refSymbols", json!({ "gmsUri": uri(&inc) }))["refPath"].is_null());
    cl.notify("gams/setMainFile", json!({ "uri": uri(&inc), "mainUri": uri(&dir.join("main.gms")) }));
    let r = cl.request("gams/refSymbols", json!({ "gmsUri": uri(&inc) }));
    assert!(r["refPath"].as_str().unwrap().ends_with("main.ref"), "{r}");
    let h = cl.request("textDocument/hover", pos);
    assert!(h["contents"]["value"].as_str().unwrap().contains("Set a"), "{h}");
    cl.shutdown();
}

#[test]
fn stale_reference_does_not_duplicate_locations() {
    let dir = tmp_dir("stale_dup");
    let g = dir.join("m.gms");
    std::fs::write(&g, "Set a / x /;\n").unwrap();
    let r = dir.join("m.ref");
    let d = dir.display();
    // two records of `a` on the same line that resolve to the same text
    let txt = format!(
        "1 1 a SETS declared 1 1 6 0 1 {d}/m.gms\n1 1 a SETS define 1 1 7 0 1 {d}/m.gms\n1 1 a SETS ref 1 1 12 0 1 {d}/m.gms\n\
         0 1 t\n1 a SETS 0 0 0 0\n0 1 t\n1 1 INPUT 0 1 {d}/m.gms\n"
    );
    std::fs::write(&r, txt).unwrap();
    newer(&r, 5);
    let mut cl = Client::start(None);
    cl.open_file(&g, "gams");
    let mut p = json!({ "textDocument": tdoc(&g), "position": { "line": 0, "character": 4 } });
    let d = cl.request("textDocument/definition", p.clone());
    assert_eq!(d.as_array().unwrap().len(), 1, "{d}");
    p["context"] = json!({ "includeDeclaration": true });
    let refs = cl.request("textDocument/references", p);
    assert_eq!(refs.as_array().unwrap().len(), 1, "{refs}");
    cl.shutdown();
}

#[test]
fn lst_include_file_summary_rows_are_not_linked() {
    let dir = tmp_dir("lst_summary");
    std::fs::write(dir.join("t.gms"), "Set i;\nSet j;\n").unwrap();
    let lst = dir.join("t.lst");
    std::fs::write(
        &lst,
        "C o m p i l a t i o n\n\n   1  Set i;\n   2  Set j;\n\nGAMS 54.6.1  x  Page 3\nTitle\nInclude File Summary\n\n\
         \x20  SEQ   GLOBAL TYPE      PARENT   LOCAL  INCLVL  FILENAME\n\n     1        1 INPUT          0       0       0  /work/t.gms\n\n\
         COMPILATION TIME     = 0.001 SECONDS\n",
    )
    .unwrap();
    let mut cl = Client::start(None);
    cl.open_file(&lst, "gams-lst");
    let links = cl.request("textDocument/documentLink", json!({ "textDocument": tdoc(&lst) }));
    let t: Vec<u64> = links.as_array().unwrap().iter().map(|l| l["range"]["start"]["line"].as_u64().unwrap()).collect();
    assert_eq!(t, [2, 3]);
    cl.shutdown();
}

#[test]
fn opt_diagnostic_names_the_missing_sysdir() {
    let p = opt_file("nosys", "xyzzy.opt", "a 1\n");
    let cl = Client::start(None);
    cl.open_file(&p, "gams-opt");
    let d = diagnostics_for(&cl, &p);
    assert!(d[0]["message"].as_str().unwrap().contains("set gams.sysdir"), "{d:?}");
    cl.shutdown();
    if gams_capi::testing::sysdir_or_skip("opt_diagnostic_names_the_missing_sysdir (with sysdir)").is_none() {
        return; // second half needs the GAMS option library
    }
    let cl = Client::start(Some(sysdir().as_str()));
    cl.open_file(&p, "gams-opt");
    let d = diagnostics_for(&cl, &p);
    assert!(d[0]["message"].as_str().unwrap().contains("solver unknown"), "{d:?}");
    cl.shutdown();
}
