// SPDX-License-Identifier: GPL-3.0-or-later
//! Incremental re-highlighting through the server: after random edits (`didChange`) the semantic
//! tokens, bracket depths, symbols and folding ranges equal those of a freshly opened document;
//! and (`--ignored`, asserted in release builds) the time of one keystroke on a 60k-line document.
use gams_lsp::run;
use lsp_server::{Connection, Message, Notification, Request, RequestId};
use serde_json::{json, Value};
use std::time::{Duration, Instant};


struct Client {
    c: Connection,
    next: i32,
    th: Option<std::thread::JoinHandle<()>>,
}

impl Client {
    fn start() -> Client {
        let (server, c) = Connection::memory();
        let th = std::thread::spawn(move || run(server).unwrap());
        let mut cl = Client { c, next: 1, th: Some(th) };
        cl.request("initialize", json!({ "capabilities": {}, "initializationOptions": {} }));
        cl.notify("initialized", json!({}));
        cl
    }
    fn notify(&self, method: &str, params: Value) {
        self.c.sender.send(Message::Notification(Notification { method: method.into(), params })).unwrap();
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = RequestId::from(self.next);
        self.next += 1;
        self.c.sender.send(Message::Request(Request { id: id.clone(), method: method.into(), params })).unwrap();
        loop {
            match self.c.receiver.recv_timeout(Duration::from_secs(60)).expect("response") {
                Message::Response(r) if r.id == id => return r.response_result.unwrap_or_else(|e| panic!("{method} failed: {}", e.message)),
                _ => {}
            }
        }
    }
    fn open(&self, uri: &str, text: &str) {
        self.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "gams", "version": 1, "text": text } }));
    }
    fn close(&self, uri: &str) {
        self.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }));
    }
    fn change(&self, uri: &str, range: Value, text: &str) {
        self.notify(
            "textDocument/didChange",
            json!({ "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "range": range, "text": text }] }),
        );
    }
    /// Everything that depends on the highlighting of the whole document.
    fn snapshot(&mut self, uri: &str, lines: u32) -> Vec<Value> {
        let td = json!({ "uri": uri });
        vec![
            self.request("textDocument/semanticTokens/full", json!({ "textDocument": td }))["data"].clone(),
            self.request("gams/bracketDepths", json!({ "textDocument": td, "range": { "start": { "line": 0, "character": 0 }, "end": { "line": lines + 1, "character": 0 } } })),
            self.request("textDocument/documentSymbol", json!({ "textDocument": td })),
            self.request("textDocument/foldingRange", json!({ "textDocument": td })),
        ]
    }
    fn shutdown(mut self) {
        self.request("shutdown", Value::Null);
        self.notify("exit", Value::Null);
        self.th.take().unwrap().join().unwrap();
    }
}

/// Small deterministic PRNG (xorshift).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// LSP position (UTF-16) of a char offset.
fn pos_of(text: &[char], off: usize) -> Value {
    let (mut line, mut col) = (0u32, 0u32);
    let mut i = 0;
    while i < off {
        let c = text[i];
        if c == '\r' && text.get(i + 1) == Some(&'\n') && i + 1 < off {
            i += 2;
            line += 1;
            col = 0;
            continue;
        }
        if c == '\n' || c == '\r' {
            line += 1;
            col = 0;
        } else {
            col += c.len_utf16() as u32;
        }
        i += 1;
    }
    json!({ "line": line, "character": col })
}

fn models() -> Vec<std::path::PathBuf> {
    let Some(sysdir) = std::env::var_os("GAMS_SYSDIR") else { return vec![] };
    let Ok(rd) = std::fs::read_dir(std::path::Path::new(&sysdir).join("gamslib_ml")) else { return vec![] };
    let mut v: Vec<_> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.to_string_lossy().bytes().all(|b| b.is_ascii_digit())))
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.len() < 60_000))
        .collect();
    v.sort();
    v
}

const SNIPS: [&str; 29] = [
    "(", ")", "[", "]", "{", "}", "/", "'", "\"", ";", "\n", "\r\n", "*", "$onText\n", "$offText\n", "\u{fc}", "\u{1F600}", " ",
    "set i /a,b/;\n", "$eolCom //\n", "// (x)", "!! (y", "Table t(i,j)\n", "$onEmbeddedCode Python:\n", "$offEmbeddedCode\n", "x",
    "\t", "parameter p(i) \"d (x)\" / a 1 /;\n", "abort$(x > 1 and\n",
];

#[test]
fn incremental_edits_equal_fresh_open() {
    let files = models();
    if files.is_empty() {
        eprintln!("gamslib not found, skipping");
        return;
    }
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut c = Client::start();
    for it in 0..12 {
        let f = &files[rng.below(files.len())];
        let mut text: Vec<char> = String::from_utf8_lossy(&std::fs::read(f).unwrap()).chars().collect();
        let uri = format!("file:///x/fuzz{it}.gms");
        c.open(&uri, &text.iter().collect::<String>());
        let _ = c.snapshot(&uri, 0); // highlight once, so later changes are incremental
        for step in 0..30 {
            let ok = |t: &[char], o: usize| !(o > 0 && o < t.len() && t[o - 1] == '\r' && t[o] == '\n');
            let mut a = rng.below(text.len() + 1);
            while !ok(&text, a) {
                a = rng.below(text.len() + 1);
            }
            let mut b = (a + [0, 0, 0, 1, 2, 5, 40][rng.below(7)]).min(text.len());
            while !ok(&text, b) {
                b += 1;
            }
            let ins = if rng.below(10) < 8 { SNIPS[rng.below(SNIPS.len())] } else { "" };
            let range = json!({ "start": pos_of(&text, a), "end": pos_of(&text, b) });
            text.splice(a..b, ins.chars());
            c.change(&uri, range, ins);
            if step % 10 == 9 {
                let s: String = text.iter().collect();
                let n = s.lines().count() as u32;
                let inc = c.snapshot(&uri, n);
                c.open("file:///x/fresh.gms", &s);
                let fresh = c.snapshot("file:///x/fresh.gms", n);
                c.close("file:///x/fresh.gms");
                assert!(inc == fresh, "{} step {step}: incremental result differs from a fresh open", f.display());
            }
        }
        c.close(&uri);
    }
    c.shutdown();
}

/// `cargo test --release -p gams-lsp --test keystroke -- --ignored --nocapture`
#[test]
#[ignore]
fn keystroke_on_60k_lines() {
    let files = models();
    if files.is_empty() {
        eprintln!("gamslib not found, skipping");
        return;
    }
    let mut parts = Vec::new();
    let mut n = 0;
    for f in &files {
        let t = String::from_utf8_lossy(&std::fs::read(f).unwrap()).into_owned();
        n += t.lines().count();
        parts.push(t);
        if n > 60_000 {
            break;
        }
    }
    let text = parts.join("\n");
    let lines = text.lines().count() as u32;
    let mut c = Client::start();
    let uri = "file:///x/big.gms";
    c.open(uri, &text);
    let t0 = Instant::now();
    let snap = c.snapshot(uri, lines);
    let mut prev = c.request("textDocument/semanticTokens/full", json!({ "textDocument": { "uri": uri } }))["resultId"].clone();
    drop(snap);
    eprintln!("{lines} lines; first highlight + requests {:?}", t0.elapsed());
    let mid = lines / 2;
    let td = json!({ "uri": uri });
    let at = |l: u32| json!({ "line": l, "character": 0 });
    let mut times: Vec<(Duration, [Duration; 6])> = Vec::new();
    for k in 0..9 {
        let t = Instant::now();
        c.change(uri, json!({ "start": at(mid), "end": at(mid) }), if k % 2 == 0 { "y" } else { "(" });
        let mut d = [Duration::ZERO; 6];
        let mut lap = Instant::now();
        // as VS Code: a delta against the previous result
        let r = c.request("textDocument/semanticTokens/full/delta", json!({ "textDocument": td, "previousResultId": prev }));
        assert!(r.get("edits").is_some());
        prev = r["resultId"].clone();
        d[0] = lap.elapsed();
        lap = Instant::now();
        let mut step = |i: usize, c: &mut Client, m: &str, p: Value| {
            c.request(m, p);
            d[i] = lap.elapsed();
            lap = Instant::now();
        };
        step(1, &mut c, "gams/bracketDepths", json!({ "textDocument": td, "range": { "start": at(mid), "end": at(mid + 120) } }));
        step(2, &mut c, "textDocument/documentSymbol", json!({ "textDocument": td }));
        step(3, &mut c, "textDocument/foldingRange", json!({ "textDocument": td }));
        step(4, &mut c, "gams/matchingParenthesis", json!({ "textDocument": td, "position": at(mid) }));
        step(5, &mut c, "textDocument/hover", json!({ "textDocument": td, "position": { "line": mid, "character": 2 } }));
        times.push((t.elapsed(), d));
    }
    times.sort_by_key(|t| t.0);
    let (total, d) = times[times.len() / 2];
    eprintln!(
        "per keystroke (median) {total:?}: semanticTokens/full/delta {:?}, bracketDepths {:?}, documentSymbol {:?}, foldingRange {:?}, matchingParenthesis {:?}, hover {:?}",
        d[0], d[1], d[2], d[3], d[4], d[5]
    );
    c.shutdown();
    // the requests of every keystroke (VS Code debounces outline and folding requests)
    let critical = d[0] + d[1] + d[4];
    eprintln!("didChange + semantic delta + bracketDepths + matchingParenthesis: {critical:?}");
    if !cfg!(debug_assertions) {
        assert!(critical < Duration::from_millis(20), "{critical:?}");
    }
}
