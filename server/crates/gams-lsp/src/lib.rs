#![allow(clippy::mutable_key_type)]
// SPDX-License-Identifier: GPL-3.0-or-later
//! `gams-lsp`: language server for GAMS built on `gams-syntax`, `gams-ref`, `gams-lst`, `gams-gdx`.
//!
//! Standard features: text sync (incremental), semantic tokens (full + range), document
//! symbols, folding ranges, hover, definition, references, workspace symbols, document links
//! (for `.lst`). Custom protocol (see `docs/lsp-protocol.md`-style summary in `README` of the
//! repo notes): `gams/refUpdated` (notification), `gams/refSymbols`, `gams/gdxSymbols`,
//! `gams/gdxRecords` (requests).
mod completion;
mod gdx;
mod gdx_compare;
mod gdx_index;
mod includes;
mod lst;
mod opts;
mod parens;
mod refs;
mod text;

use gams_ref::{locate_in_line, paths_equal, Location as RefLoc, RefKind, Symbol as RefSymbol, SymbolType};
use gams_syntax::{
    build_outline, declarations_from, highlight_document_info, keyword_doc_at, mpsge, rehighlight, rehighlight_change, section_folds,
    semantic_token_legend, semantic_tokens_data, semantic_tokens_edit, split_lines, DeclaredSymbol, LineInfo, NodeKind, OutlineNode,
};
use lsp_server::{Connection, ErrorCode, Message, Notification, Request, RequestId, Response, ResponseError};
use lsp_types::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use text::*;

type Res = Result<Value, ResponseError>;

/// A new semantic tokens result id (unique within the server run).
fn next_result_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed).to_string()
}

fn err(code: i32, message: impl Into<String>) -> ResponseError {
    ResponseError { code, message: message.into(), data: None }
}

fn params<T: DeserializeOwned>(v: Value) -> Result<T, ResponseError> {
    serde_json::from_value(v).map_err(|e| err(ErrorCode::InvalidParams as i32, e.to_string()))
}

fn ok<T: serde::Serialize>(v: T) -> Res {
    serde_json::to_value(v).map_err(|e| err(ErrorCode::InternalError as i32, e.to_string()))
}

struct Doc {
    text: String,
    lang: String,
    infos: Option<Rc<Vec<LineInfo>>>,
    decls: Option<Rc<Vec<DeclaredSymbol>>>,
    /// Nesting levels of the brackets of the whole document (`gams/bracketDepths`); reset on every change.
    brackets: Option<Rc<Vec<parens::Bracket>>>,
    /// The last full semantic token data sent, with its result id (`semanticTokens/full/delta`).
    sem: Option<(String, Vec<u32>)>,
}

impl Doc {
    fn infos(&mut self) -> Rc<Vec<LineInfo>> {
        let t = &self.text;
        self.infos.get_or_insert_with(|| Rc::new(highlight_document_info(t))).clone()
    }
    fn brackets(&mut self) -> Rc<Vec<parens::Bracket>> {
        if self.brackets.is_none() {
            let infos = self.infos();
            self.brackets = Some(Rc::new(parens::bracket_depths(&infos)));
        }
        self.brackets.clone().expect("set above")
    }
    fn decls(&mut self) -> Rc<Vec<DeclaredSymbol>> {
        if self.decls.is_none() {
            let infos = self.infos();
            self.decls = Some(Rc::new(declarations_from(&split_lines(&self.text), &infos)));
        }
        self.decls.clone().expect("set above")
    }
    fn is_lst(&self) -> bool {
        self.lang == "gams-lst"
    }
}

/// Lazily read lines of files (open documents win over the disk) for one request.
struct Lines<'a> {
    docs: &'a HashMap<Uri, Doc>,
    cache: HashMap<String, Option<Vec<String>>>,
}

impl<'a> Lines<'a> {
    fn new(docs: &'a HashMap<Uri, Doc>) -> Self {
        Lines { docs, cache: HashMap::new() }
    }
    fn line(&mut self, file: &str, line0: usize) -> Option<&str> {
        let docs = self.docs;
        let v = self.cache.entry(file.to_string()).or_insert_with(|| {
            let p = Path::new(file);
            let t = docs
                .iter()
                .find(|(u, _)| uri_to_path(u).is_some_and(|q| same_path(&q, p)))
                .map(|(_, d)| d.text.clone())
                .or_else(|| std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned()))?;
            Some(split_lines(&t).into_iter().map(String::from).collect())
        });
        v.as_ref()?.get(line0).map(String::as_str)
    }
    /// Range of the name `name` for a ref record (see `gams_ref::locate_in_line`).
    fn range(&mut self, name: &str, loc: &RefLoc) -> Range {
        let line0 = (loc.line - 1).max(0) as usize;
        let l = line0 as u32;
        if let Some(text) = self.line(&loc.file, line0) {
            if let Some((a, b)) = locate_in_line(name, loc.col, text) {
                return Range::new(Position::new(l, char_to_utf16(text, a)), Position::new(l, char_to_utf16(text, b)));
            }
        }
        let len = name.chars().count() as i32;
        let c = (loc.col - 1 - len).max(0) as u32;
        Range::new(Position::new(l, c), Position::new(l, c + len as u32))
    }
}

fn lsp_symbol_kind(t: SymbolType) -> SymbolKind {
    match t {
        SymbolType::Set => SymbolKind::ENUM,
        SymbolType::Parameter | SymbolType::Acronym => SymbolKind::CONSTANT,
        SymbolType::Variable => SymbolKind::VARIABLE,
        SymbolType::Equation | SymbolType::Funct => SymbolKind::FUNCTION,
        SymbolType::Model => SymbolKind::MODULE,
        SymbolType::File => SymbolKind::FILE,
        SymbolType::Macro => SymbolKind::OPERATOR,
        SymbolType::Unknown => SymbolKind::OBJECT,
    }
}

/// Symbol kind of a declaration keyword (`Set`, `Parameters`, `Table`, ...).
fn decl_kind(keyword: &str) -> SymbolKind {
    let k = keyword.to_ascii_lowercase();
    if k.starts_with("set") || k.starts_with("alias") {
        SymbolKind::ENUM
    } else if k.starts_with("par") || k.starts_with("scal") || k.starts_with("tab") || k.starts_with("acr") {
        SymbolKind::CONSTANT
    } else if k.starts_with("var") {
        SymbolKind::VARIABLE
    } else if k.starts_with("equ") {
        SymbolKind::FUNCTION
    } else if k.starts_with("mod") {
        SymbolKind::MODULE
    } else if k.starts_with("file") {
        SymbolKind::FILE
    } else {
        SymbolKind::OBJECT
    }
}

/// LSP symbol kind of an outline node.
fn node_kind(k: &NodeKind) -> SymbolKind {
    use gams_syntax::mpsge::SectionKind as S;
    match k {
        NodeKind::Section => SymbolKind::NAMESPACE,
        NodeKind::Declaration(kw) => decl_kind(kw),
        NodeKind::MpsgeModel => SymbolKind::MODULE,
        NodeKind::MpsgeSection(S::Prod | S::Demand) => SymbolKind::METHOD,
        NodeKind::MpsgeSection(S::Constraint) => SymbolKind::OPERATOR,
        NodeKind::MpsgeSection(_) => SymbolKind::NAMESPACE,
        NodeKind::MpsgeVariable(S::Sectors) => SymbolKind::FUNCTION,
        NodeKind::MpsgeVariable(S::Commodities) => SymbolKind::VARIABLE,
        NodeKind::MpsgeVariable(S::Consumers) => SymbolKind::OBJECT,
        NodeKind::MpsgeVariable(_) => SymbolKind::FIELD,
    }
}

/// Document symbol of an outline node. Sections and MPSGE nodes span their whole
/// extent; declarations span their name.
fn outline_symbol(n: &OutlineNode) -> DocumentSymbol {
    let selection = Range::new(Position::new(n.line, n.start), Position::new(n.line, n.start + n.len));
    let from = match n.kind {
        NodeKind::Declaration(_) | NodeKind::MpsgeVariable(_) => selection.start,
        _ => Position::new(n.line, 0),
    };
    let range = Range::new(from, Position::new(n.end_line, n.end_col.max(if n.end_line == n.line { n.start + n.len } else { 0 })));
    #[allow(deprecated)]
    DocumentSymbol {
        name: n.name.clone(),
        detail: n.detail.clone(),
        kind: node_kind(&n.kind),
        tags: None,
        deprecated: None,
        range,
        selection_range: selection,
        children: (!n.children.is_empty()).then(|| n.children.iter().map(outline_symbol).collect()),
    }
}

const OPT_LANG: &str = "gams-opt";

pub struct Server {
    out: crossbeam_channel::Sender<Message>,
    docs: HashMap<Uri, Doc>,
    refs: Vec<refs::RefEntry>,
    /// Wall-clock time of the last edit of each open document.
    edited: HashMap<PathBuf, std::time::SystemTime>,
    sysdir: Option<PathBuf>,
    /// Workspace folders of the client (bound the search for the `.ref` of an include file).
    roots: Vec<PathBuf>,
    /// Include file -> main file, from `gams/setMainFile`.
    main_of: HashMap<PathBuf, PathBuf>,
    ref_scan: refs::IncludeScan,
    gdx: gdx::GdxWorker,
    gdx_index: gdx_index::GdxIndexWorker,
    gdx_compare: gdx_compare::CompareWorker,
    opts: opts::Opts,
}

pub fn capabilities() -> ServerCapabilities {
    let (types, mods) = semantic_token_legend();
    ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::INCREMENTAL)),
        semantic_tokens_provider: Some(SemanticTokensServerCapabilities::SemanticTokensOptions(SemanticTokensOptions {
            legend: SemanticTokensLegend {
                token_types: types.iter().map(|s| SemanticTokenType::new(s)).collect(),
                token_modifiers: mods.iter().map(|s| SemanticTokenModifier::new(s)).collect(),
            },
            range: Some(true),
            full: Some(SemanticTokensFullOptions::Delta { delta: Some(true) }),
            work_done_progress_options: Default::default(),
        })),
        document_symbol_provider: Some(OneOf::Left(true)),
        folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
        hover_provider: Some(HoverProviderCapability::Simple(true)),
        definition_provider: Some(OneOf::Left(true)),
        references_provider: Some(OneOf::Left(true)),
        workspace_symbol_provider: Some(OneOf::Left(true)),
        completion_provider: Some(CompletionOptions {
            // " " "=" for .opt files, "$" "." "%" for .gms (completion::GMS_TRIGGERS; " " only in constrained contexts)
            trigger_characters: Some([" ", "=", "$", ".", "%"].iter().map(|s| s.to_string()).collect()),
            ..Default::default()
        }),
        document_link_provider: Some(DocumentLinkOptions { resolve_provider: Some(false), work_done_progress_options: Default::default() }),
        ..Default::default()
    }
}

/// Runs the server on `conn` until `shutdown`/`exit`.
pub fn run(conn: Connection) -> Result<(), Box<dyn Error + Sync + Send>> {
    let (id, init) = conn.initialize_start()?;
    let sysdir = init
        .get("initializationOptions")
        .and_then(|o| o.get("sysdir"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let mut roots: Vec<PathBuf> = init
        .get("workspaceFolders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| f.get("uri")?.as_str())
        .chain(init.get("rootUri").and_then(Value::as_str))
        .filter_map(|u| uri_to_path(&u.parse::<Uri>().ok()?))
        .collect();
    roots.dedup();
    eprintln!("[gams-lsp] initialize, sysdir = {sysdir:?}");
    conn.initialize_finish(
        id,
        json!({ "capabilities": capabilities(), "serverInfo": { "name": "gams-lsp", "version": env!("CARGO_PKG_VERSION") } }),
    )?;
    let mut s = Server {
        out: conn.sender.clone(),
        docs: HashMap::new(),
        refs: Vec::new(),
        edited: HashMap::new(),
        roots,
        main_of: HashMap::new(),
        ref_scan: refs::IncludeScan::default(),
        gdx: gdx::GdxWorker::spawn(sysdir.clone()),
        gdx_index: gdx_index::GdxIndexWorker::spawn(sysdir.clone()),
        gdx_compare: gdx_compare::CompareWorker::spawn(sysdir.clone()),
        opts: opts::Opts::new(sysdir.clone()),
        sysdir,
    };
    for msg in &conn.receiver {
        match msg {
            Message::Request(req) => {
                if conn.handle_shutdown(&req)? {
                    return Ok(());
                }
                s.on_request(req);
            }
            Message::Notification(n) => {
                if n.method == "exit" {
                    return Ok(());
                }
                s.on_notification(n);
            }
            Message::Response(_) => {}
        }
    }
    Ok(())
}

impl Server {
    fn reply(&self, id: RequestId, r: Res) {
        let resp = Response { id, response_result: r };
        let _ = self.out.send(Message::Response(resp));
    }

    fn on_request(&mut self, req: Request) {
        let Request { id, method, params: p } = req;
        // GDX requests are answered by the worker thread.
        match method.as_str() {
            "gams/gdxIndex" | "gams/gdxFindElement" => {
                match gdx_index::parse_job(&method, p) {
                    Ok(job) => self.gdx_index.submit(id, job, self.out.clone()),
                    Err(m) => self.reply(id, Err(err(-32602, m))),
                }
                return;
            }
            "gams/gdxCompareSymbols" | "gams/gdxCompareRecords" | "gams/gdxCompareNext" | "gams/gdxDiffFileSymbols" | "gams/gdxDiffFileRecords" | "gams/gdxDiffFileNext" => {
                match gdx_compare::parse_job(&method, p) {
                    Ok(job) => self.gdx_compare.submit(id, job, self.out.clone()),
                    Err(m) => self.reply(id, Err(err(-32602, m))),
                }
                return;
            }
            "gams/gdxSymbols" | "gams/gdxRecords" | "gams/gdxLabels" | "gams/gdxTable" | "gams/gdxDefaults" | "gams/gdxRelease" => {
                let job = match self.gdx_job(&method, p) {
                    Ok(j) => j,
                    Err(e) => return self.reply(id, Err(e)),
                };
                self.gdx.submit(id, job, self.out.clone());
                return;
            }
            _ => {}
        }
        let r = match method.as_str() {
            "textDocument/semanticTokens/full" => self.semantic_tokens(p, false),
            "textDocument/semanticTokens/range" => self.semantic_tokens(p, true),
            "textDocument/semanticTokens/full/delta" => self.semantic_tokens_delta(p),
            "textDocument/documentSymbol" => self.document_symbol(p),
            "textDocument/foldingRange" => self.folding_range(p),
            "textDocument/hover" => self.hover(p),
            "textDocument/definition" => self.definition(p),
            "textDocument/references" => self.references(p),
            "textDocument/documentLink" => self.document_link(p),
            "workspace/symbol" => self.workspace_symbol(p),
            "gams/refSymbols" => self.ref_symbols(p),
            "gams/optionDefinitions" => self.option_definitions(p),
            "gams/matchingParenthesis" => self.matching_parenthesis(p),
            "gams/bracketDepths" => self.bracket_depths(p),
            "textDocument/completion" => self.completion(p),
            _ => Err(err(ErrorCode::MethodNotFound as i32, format!("unsupported request {method}"))),
        };
        self.reply(id, r);
    }

    fn on_notification(&mut self, n: Notification) {
        match n.method.as_str() {
            "$/cancelRequest" => {
                if let Ok(p) = serde_json::from_value::<CancelParams>(n.params) {
                    let id = match p.id {
                        NumberOrString::Number(i) => RequestId::from(i),
                        NumberOrString::String(s) => RequestId::from(s),
                    };
                    self.gdx_index.cancel(&id);
                    self.gdx_compare.cancel(&id);
                }
            }
            "textDocument/didOpen" => {
                if let Ok(p) = serde_json::from_value::<DidOpenTextDocumentParams>(n.params) {
                    let td = p.text_document;
                    self.docs.insert(td.uri.clone(), Doc { text: td.text, lang: td.language_id, infos: None, decls: None, brackets: None, sem: None });
                    self.autoload_ref(&td.uri);
                    self.publish_opt_diagnostics(&td.uri);
                }
            }
            "textDocument/didChange" => {
                if let Ok(p) = serde_json::from_value::<DidChangeTextDocumentParams>(n.params) {
                    if let Some(d) = self.docs.get_mut(&p.text_document.uri) {
                        // re-highlight only from the first changed line until the line states agree again
                        let single = match &p.content_changes[..] {
                            [c] => c.range.map(|r| (r.start.line as usize, r.end.line as usize, c.text.clone())),
                            _ => None,
                        };
                        let old = (d.infos.is_some() && single.is_none()).then(|| d.text.clone());
                        for c in p.content_changes {
                            match c.range {
                                Some(r) => apply_change(&mut d.text, r, &c.text),
                                None => d.text = c.text,
                            }
                        }
                        if let Some(infos) = d.infos.as_mut() {
                            let new_lines = split_lines(&d.text);
                            match (single, old) {
                                (Some((a, b, t)), _) => rehighlight_change(Rc::make_mut(infos), &new_lines, a, b, &t),
                                (_, Some(old)) => rehighlight(Rc::make_mut(infos), &split_lines(&old), &new_lines),
                                _ => 0..0,
                            };
                        }
                        d.decls = None;
                        d.brackets = None;
                    }
                    if let Some(path) = uri_to_path(&p.text_document.uri) {
                        self.edited.insert(path, std::time::SystemTime::now());
                    }
                    self.mark_refs_stale(&p.text_document.uri);
                    self.publish_opt_diagnostics(&p.text_document.uri);
                }
            }
            "textDocument/didClose" => {
                if let Ok(p) = serde_json::from_value::<DidCloseTextDocumentParams>(n.params) {
                    if self.docs.remove(&p.text_document.uri).is_some_and(|d| d.lang == OPT_LANG) {
                        self.send_diagnostics(p.text_document.uri, vec![]);
                    }
                }
            }
            "gams/refUpdated" => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct P {
                    gms_uri: Uri,
                    ref_path: String,
                    /// Optional: ms since epoch when the compile started; edits after it keep the data stale.
                    #[serde(default)]
                    started_at: Option<u64>,
                }
                match serde_json::from_value::<P>(n.params) {
                    Ok(p) => {
                        if let Some(gms) = uri_to_path(&p.gms_uri) {
                            self.load_ref(gms, PathBuf::from(p.ref_path), p.started_at);
                        }
                    }
                    Err(e) => eprintln!("[gams-lsp] bad gams/refUpdated: {e}"),
                }
            }
            "gams/setMainFile" => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct P {
                    uri: Uri,
                    /// The main `.gms` the file is part of; `null` clears the assignment.
                    #[serde(default)]
                    main_uri: Option<Uri>,
                }
                match serde_json::from_value::<P>(n.params) {
                    Ok(p) => self.set_main_file(&p.uri, p.main_uri.as_ref()),
                    Err(e) => eprintln!("[gams-lsp] bad gams/setMainFile: {e}"),
                }
            }
            _ => {}
        }
    }

    // ---------------------------------------------------------------- references (M3)

    /// `gams/setMainFile`: `uri` is an include file of `main_uri` (whose `.ref` is used for it).
    fn set_main_file(&mut self, uri: &Uri, main_uri: Option<&Uri>) {
        let Some(path) = uri_to_path(uri) else { return };
        let Some(main) = main_uri.and_then(uri_to_path) else {
            self.main_of.remove(&path);
            return;
        };
        self.main_of.insert(path, main.clone());
        if !self.refs.iter().any(|r| same_path(&r.gms, &main)) {
            let r = main.with_extension("ref");
            if r.is_file() {
                self.load_ref(main, r, None);
            }
        }
    }

    fn load_ref(&mut self, gms: PathBuf, ref_path: PathBuf, started_at_ms: Option<u64>) {
        match refs::load(&gms, &ref_path) {
            Ok(mut e) => {
                let since = started_at_ms
                    .map(|ms| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms))
                    .or_else(|| std::fs::metadata(&ref_path).and_then(|m| m.modified()).ok());
                if let Some(t) = since {
                    e.stale = refs::edited_since(&e, &self.edited, t);
                }
                eprintln!("[gams-lsp] loaded {} ({} symbols)", ref_path.display(), e.reference.symbols.len());
                self.refs.retain(|x| !same_path(&x.gms, &gms));
                self.refs.push(e);
            }
            Err(m) => eprintln!("[gams-lsp] cannot load reference: {m}"),
        }
    }

    /// Editing the main `.gms` or a file of the reference's files-used list makes the data outdated.
    fn mark_refs_stale(&mut self, uri: &Uri) {
        let Some(path) = uri_to_path(uri) else { return };
        for i in self.entry_for(&path) {
            self.refs[i].stale = true;
        }
    }

    /// Opening a `.gms` loads `<stem>.ref` next to it when it is at least as new as the `.gms`.
    fn autoload_ref(&mut self, uri: &Uri) {
        let Some(path) = uri_to_path(uri) else { return };
        if self.docs.get(uri).is_none_or(|d| d.lang != "gams") || self.refs.iter().any(|r| same_path(&r.gms, &path)) {
            return;
        }
        let r = path.with_extension("ref");
        let mt = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        if let (Some(rm), Some(gm)) = (mt(&r), mt(&path)) {
            if rm >= gm {
                self.load_ref(path, r, None);
                return;
            }
        }
        // an include file opened alone: a `.ref` of a run that used it (nearest directory, newest first)
        if self.entry_for(&path).is_empty() {
            if let Some((gms, ref_path)) = refs::find_for_include(&mut self.ref_scan, &path, &self.roots) {
                if !self.refs.iter().any(|x| same_path(&x.gms, &gms)) {
                    self.load_ref(gms, ref_path, None);
                }
            }
        }
    }

    fn entry_for(&self, path: &Path) -> Vec<usize> {
        let f = path.to_string_lossy();
        let main = self.main_of.get(path);
        (0..self.refs.len())
            .filter(|&i| {
                same_path(&self.refs[i].gms, path)
                    || main.is_some_and(|m| same_path(&self.refs[i].gms, m))
                    || self.refs[i].reference.files_used.iter().any(|u| paths_equal(u, &f))
            })
            .collect()
    }

    /// Is the word at `pos` code? Comments, `$onText` blocks, descriptions, strings, titles and
    /// embedded code are prose: their words are no symbol references.
    fn is_code_at(&mut self, uri: &Uri, pos: Position, line: &str) -> bool {
        let Some(doc) = self.docs.get_mut(uri) else { return false };
        if doc.lang != "gams" {
            return true;
        }
        let col = word_at(line, pos.character).map_or(pos.character, |(a, _, _)| a);
        let infos = doc.infos();
        let Some(info) = infos.get(pos.line as usize) else { return true };
        !info.tokens.iter().rev().find(|t| t.start <= col && col < t.start + t.len).is_some_and(|t| is_prose_kind(t.kind))
    }

    /// Symbols at a position: record hits first, else (`by_name`, code only) the identifier looked up by name.
    fn symbols_at(&self, path: Option<&Path>, pos: Position, line: &str, by_name: bool) -> Vec<(usize, i32)> {
        let Some(path) = path else { return vec![] };
        let file = path.to_string_lossy();
        let entries = self.entry_for(path);
        let ci = utf16_to_char(line, pos.character) as i32;
        for &e in &entries {
            for col in [ci + 1, ci] {
                if col < 1 {
                    continue;
                }
                let hits = self.refs[e].reference.references_at_in_text(&file, pos.line as i32 + 1, col, line);
                if !hits.is_empty() {
                    let mut seen = HashSet::new();
                    return hits.iter().filter(|h| seen.insert(h.symbol.id)).map(|h| (e, h.symbol.id)).collect();
                }
            }
        }
        if by_name {
            if let Some((_, _, w)) = word_at(line, pos.character) {
                for &e in &entries {
                    if let Some(s) = self.refs[e].reference.symbol(&w) {
                        return vec![(e, s.id)];
                    }
                }
            }
        }
        vec![]
    }

    fn line_of(&self, uri: &Uri, line: u32) -> Option<String> {
        let d = self.docs.get(uri)?;
        split_lines(&d.text).get(line as usize).map(|s| s.to_string())
    }

    fn sym(&self, e: usize, id: i32) -> &RefSymbol {
        self.refs[e].reference.symbol_by_id(id).expect("symbol id from this reference")
    }

    fn loc_json(lines: &mut Lines, name: &str, l: &RefLoc) -> Value {
        json!({ "uri": path_to_uri(Path::new(&l.file)), "range": lines.range(name, l) })
    }

    fn ref_symbols(&mut self, p: Value) -> Res {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct P {
            gms_uri: Uri,
        }
        let p: P = params(p)?;
        let path = uri_to_path(&p.gms_uri).ok_or_else(|| err(ErrorCode::InvalidParams as i32, "not a file URI"))?;
        let Some(&e) = self.entry_for(&path).first() else {
            return Ok(json!({ "refPath": null, "symbols": [], "files": [] }));
        };
        let entry = &self.refs[e];
        let r = &entry.reference;
        let mut lines = Lines::new(&self.docs);
        let kinds = [
            ("declare", RefKind::Declare),
            ("define", RefKind::Define),
            ("assign", RefKind::Assign),
            ("implicitAssign", RefKind::ImplicitAssign),
            ("reference", RefKind::Reference),
            ("control", RefKind::Control),
            ("index", RefKind::Index),
        ];
        let symbols: Vec<Value> = r
            .symbols
            .iter()
            .map(|s| {
                let mut locs = serde_json::Map::new();
                for (k, kind) in kinds {
                    let v: Vec<Value> = s.locations(kind).iter().map(|l| Self::loc_json(&mut lines, &s.name, l)).collect();
                    locs.insert(k.to_string(), Value::Array(v));
                }
                json!({
                    "id": s.id, "name": s.name, "type": refs::type_name(s.ty), "dim": s.dim,
                    "domain": r.domain_names(s), "text": s.text, "numElements": s.num_elements,
                    "unused": s.is_unused(), "locations": locs,
                })
            })
            .collect();
        let files: Vec<Value> = r
            .file_tree
            .iter()
            .map(|f| json!({ "id": f.id, "parentId": f.parent_id, "type": f.ref_type, "globalLine": f.global_line,
                "localLine": f.local_line, "uri": path_to_uri(Path::new(&f.location)) }))
            .collect();
        Ok(json!({ "refPath": entry.ref_path.to_string_lossy(), "stale": entry.stale, "symbols": symbols, "files": files }))
    }

    fn definition(&mut self, p: Value) -> Res {
        let p: GotoDefinitionParams = params(p)?;
        let tdp = p.text_document_position_params;
        let (uri, pos) = (tdp.text_document.uri, tdp.position);
        let path = uri_to_path(&uri);
        let Some(line) = self.line_of(&uri, pos.line) else { return Ok(Value::Null) };
        // the file name of an `$include`-style command
        if let Some((_, file)) = self.includes_on_line(&uri, pos.line).into_iter().find(|(i, _)| i.start <= pos.character && pos.character <= i.end) {
            return ok(GotoDefinitionResponse::Scalar(Location::new(path_to_uri(&file), Range::default())));
        }
        let code = self.is_code_at(&uri, pos, &line);
        let mut out: Vec<Location> = Vec::new();
        let syms = self.symbols_at(path.as_deref(), pos, &line, code);
        {
            let mut lines = Lines::new(&self.docs);
            let mut seen = HashSet::new();
            for (e, id) in syms {
                let s = self.sym(e, id);
                // declared location first, then the defining statements
                for l in s.declare.iter().chain(s.define.iter()) {
                    let loc = Location::new(path_to_uri(Path::new(&l.file)), lines.range(&s.name, l));
                    // a stale reference can map several records to the same text
                    if seen.insert((loc.uri.as_str().to_string(), loc.range)) {
                        out.push(loc);
                    }
                }
            }
        }
        if out.is_empty() && code {
            if let Some((_, _, w)) = word_at(&line, pos.character) {
                // no reference data: fall back to the declarations of the current document
                let decls = self.docs.get_mut(&uri).map(|d| d.decls()).unwrap_or_default();
                for d in decls.iter().filter(|d| d.name.eq_ignore_ascii_case(&w)) {
                    out.push(Location::new(uri.clone(), Range::new(Position::new(d.line, d.start), Position::new(d.line, d.start + d.len))));
                }
            }
        }
        if out.is_empty() {
            return Ok(Value::Null);
        }
        ok(GotoDefinitionResponse::Array(out))
    }

    fn references(&mut self, p: Value) -> Res {
        let p: ReferenceParams = params(p)?;
        let (uri, pos) = (p.text_document_position.text_document.uri, p.text_document_position.position);
        let path = uri_to_path(&uri);
        let Some(line) = self.line_of(&uri, pos.line) else { return Ok(Value::Null) };
        let code = self.is_code_at(&uri, pos, &line);
        let syms = self.symbols_at(path.as_deref(), pos, &line, code);
        let mut out = Vec::new();
        if syms.is_empty() {
            if code {
                out = self.local_references(&uri, &line, pos, p.context.include_declaration);
            }
            return ok(out);
        }
        let mut lines = Lines::new(&self.docs);
        let mut seen = HashSet::new();
        for (e, id) in syms {
            let s = self.sym(e, id);
            for kind in RefKind::ALL {
                if !p.context.include_declaration && matches!(kind, RefKind::Declare | RefKind::Define) {
                    continue;
                }
                for l in s.locations(kind) {
                    let loc = Location::new(path_to_uri(Path::new(&l.file)), lines.range(&s.name, l));
                    if seen.insert((id, loc.uri.as_str().to_string(), loc.range)) {
                        out.push(loc);
                    }
                }
            }
        }
        ok(out)
    }

    /// Without reference data: the code occurrences of the word at `pos` in this document.
    fn local_references(&mut self, uri: &Uri, line: &str, pos: Position, include_declaration: bool) -> Vec<Location> {
        let Some((_, _, w)) = word_at(line, pos.character) else { return vec![] };
        let Some(doc) = self.docs.get_mut(uri) else { return vec![] };
        let infos = doc.infos();
        let decls = doc.decls();
        let is_decl = |l: u32, a: u32| decls.iter().any(|d| d.line == l && d.start == a && d.name.eq_ignore_ascii_case(&w));
        let mut out = Vec::new();
        for (ln, text) in split_lines(&doc.text).iter().enumerate() {
            if !text.to_ascii_lowercase().contains(&w.to_ascii_lowercase()) {
                continue;
            }
            let ln = ln as u32;
            let mut col = 0;
            while let Some((a, b, found)) = next_word(text, col) {
                col = b;
                if !found.eq_ignore_ascii_case(&w) {
                    continue;
                }
                let prose = infos.get(ln as usize).is_some_and(|i| i.tokens.iter().rev().find(|t| t.start <= a && a < t.start + t.len).is_some_and(|t| is_prose_kind(t.kind)));
                if prose || (!include_declaration && is_decl(ln, a)) {
                    continue;
                }
                out.push(Location::new(uri.clone(), Range::new(Position::new(ln, a), Position::new(ln, b))));
            }
        }
        out
    }

    fn workspace_symbol(&mut self, p: Value) -> Res {
        let p: WorkspaceSymbolParams = params(p)?;
        let q = p.query.to_lowercase();
        let mut lines = Lines::new(&self.docs);
        let mut out: Vec<SymbolInformation> = Vec::new();
        let mut seen = HashSet::new();
        for e in &self.refs {
            for s in &e.reference.symbols {
                if !q.is_empty() && !s.name.to_lowercase().contains(&q) {
                    continue;
                }
                let Some(l) = s.declare.first().or(s.define.first()) else { continue };
                if !seen.insert((s.name.to_lowercase(), l.file.clone(), l.line)) {
                    continue;
                }
                #[allow(deprecated)]
                out.push(SymbolInformation {
                    name: s.name.clone(),
                    kind: lsp_symbol_kind(s.ty),
                    tags: None,
                    deprecated: None,
                    location: Location::new(path_to_uri(Path::new(&l.file)), lines.range(&s.name, l)),
                    container_name: Some(refs::type_name(s.ty).to_string()),
                });
            }
        }
        ok(out)
    }

    // ---------------------------------------------------------------- hover

    fn hover(&mut self, p: Value) -> Res {
        let p: HoverParams = params(p)?;
        let (uri, pos) = (p.text_document_position_params.text_document.uri, p.text_document_position_params.position);
        let path = uri_to_path(&uri);
        let Some(line) = self.line_of(&uri, pos.line) else { return Ok(Value::Null) };
        let md = |s: String, range: Option<Range>| {
            ok(Hover { contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value: s }), range })
        };
        if self.docs.get(&uri).is_some_and(|d| d.lang == OPT_LANG) {
            return self.opt_hover(&uri, pos, &line);
        }
        // extension: documentation inside MPSGE blocks
        if let Some(doc) = self.docs.get_mut(&uri) {
            if !doc.is_lst() && doc.lang != OPT_LANG {
                let infos = doc.infos();
                let lines = split_lines(&doc.text);
                let blocks = mpsge::find_blocks(&lines, &infos);
                if let Some(h) = mpsge::hover(&lines, &blocks, pos.line, pos.character) {
                    return md(h.markdown, Some(Range::new(Position::new(pos.line, h.start), Position::new(pos.line, h.end))));
                }
            }
        }
        let word = word_at(&line, pos.character);
        let word_range = word.as_ref().map(|(a, b, _)| Range::new(Position::new(pos.line, *a), Position::new(pos.line, *b)));
        // 1. symbol from the reference file
        let code = self.is_code_at(&uri, pos, &line);
        if let Some(&(e, id)) = self.symbols_at(path.as_deref(), pos, &line, code).first() {
            let r = &self.refs[e].reference;
            let s = self.sym(e, id);
            let dom = r.domain_names(s);
            let sig = if s.dim > 0 { format!("{}({})", s.name, dom.join(",")) } else { s.name.clone() };
            let mut t = format!("```gams\n{} {}\n```", refs::type_name(s.ty), sig);
            if !s.text.is_empty() {
                t.push_str(&format!("\n\n{}", s.text));
            }
            if s.ty != SymbolType::Model && s.num_elements > 0 {
                t.push_str(&format!("\n\n{} element(s)", s.num_elements));
            }
            if self.refs[e].stale {
                t.push_str("\n\n*(reference data from last run \u{2014} may be outdated)*");
            }
            return md(t, word_range);
        }
        // 2. Studio keyword documentation
        let Some(doc) = self.docs.get_mut(&uri) else { return Ok(Value::Null) };
        if doc.is_lst() {
            return Ok(Value::Null);
        }
        let infos = doc.infos();
        if let Some(info) = infos.get(pos.line as usize) {
            if let Some(d) = keyword_doc_at(info, pos.character) {
                let range = Range::new(Position::new(pos.line, d.start), Position::new(pos.line, d.end));
                return md(format!("**{}**\n\n{}", d.keyword, d.description), Some(range));
            }
        }
        // 3. symbol declared in this document
        if let Some((_, _, w)) = word.filter(|_| code) {
            let decls = doc.decls();
            if let Some(d) = decls.iter().find(|d| d.name.eq_ignore_ascii_case(&w)) {
                let kind = d.type_prefix.as_ref().map(|t| format!("{t} ")).unwrap_or_default();
                let mut t = format!("```gams\n{}{} {}\n```", kind, d.keyword, d.name);
                if let Some(x) = &d.description {
                    t.push_str(&format!("\n\n{x}"));
                }
                return md(t, word_range);
            }
        }
        Ok(Value::Null)
    }

    // ---------------------------------------------------------------- syntax features

    fn semantic_tokens(&mut self, p: Value, range: bool) -> Res {
        let (uri, rng) = if range {
            let p: SemanticTokensRangeParams = params(p)?;
            (p.text_document.uri, Some(p.range))
        } else {
            let p: SemanticTokensParams = params(p)?;
            (p.text_document.uri, None)
        };
        let data = self.semantic_data(&uri, rng)?;
        if range {
            return ok(json!({ "data": data }));
        }
        let id = next_result_id();
        let v = json!({ "resultId": id, "data": data });
        if let Some(d) = self.docs.get_mut(&uri) {
            d.sem = Some((id, data));
        }
        Ok(v)
    }

    /// `semanticTokens/full/delta`: one edit against the last full result (common prefix/suffix).
    fn semantic_tokens_delta(&mut self, p: Value) -> Res {
        let p: SemanticTokensDeltaParams = params(p)?;
        let uri = p.text_document.uri;
        let new = self.semantic_data(&uri, None)?;
        let id = next_result_id();
        let Some(doc) = self.docs.get_mut(&uri) else { return Ok(Value::Null) };
        let v = match doc.sem.take().filter(|(old_id, _)| *old_id == p.previous_result_id) {
            Some((_, old)) => {
                let (start, delete_count, data) = semantic_tokens_edit(&old, &new);
                json!({ "resultId": id, "edits": [{ "start": start, "deleteCount": delete_count, "data": data }] })
            }
            None => json!({ "resultId": id, "data": new }),
        };
        doc.sem = Some((id, new));
        Ok(v)
    }

    /// Encoded semantic token data of a document (of the lines of `rng` if given).
    fn semantic_data(&mut self, uri: &Uri, rng: Option<Range>) -> Result<Vec<u32>, ResponseError> {
        let doc = self.docs.get_mut(uri).ok_or_else(|| err(ErrorCode::InvalidParams as i32, "document not open"))?;
        if doc.is_lst() {
            return Ok(vec![]);
        }
        let infos = doc.infos();
        // Studio tokens, with the MPSGE blocks (extension) re-tokenized
        Ok(semantic_tokens_data(&split_lines(&doc.text), &infos, rng.map(|r| (r.start.line, r.end.line))))
    }

    fn document_symbol(&mut self, p: Value) -> Res {
        let p: DocumentSymbolParams = params(p)?;
        let uri = p.text_document.uri;
        let path = uri_to_path(&uri);
        let doc = self.docs.get_mut(&uri).ok_or_else(|| err(ErrorCode::InvalidParams as i32, "document not open"))?;
        if doc.is_lst() {
            let syms = path.map(|p| lst::document_symbols(&p, &doc.text)).unwrap_or_default();
            return ok(DocumentSymbolResponse::Nested(syms));
        }
        let infos = doc.infos();
        let decls = doc.decls();
        let lines = split_lines(&doc.text);
        let syms: Vec<DocumentSymbol> = build_outline(&lines, &infos, &decls).iter().map(outline_symbol).collect();
        ok(DocumentSymbolResponse::Nested(syms))
    }

    fn folding_range(&mut self, p: Value) -> Res {
        let p: FoldingRangeParams = params(p)?;
        let doc = self.docs.get_mut(&p.text_document.uri).ok_or_else(|| err(ErrorCode::InvalidParams as i32, "document not open"))?;
        if doc.is_lst() {
            return ok(Vec::<FoldingRange>::new());
        }
        let infos = doc.infos();
        let brackets = folding_ranges(&infos);
        // extension: comment sections (`* Data ----`) and MPSGE sections
        let lines = split_lines(&doc.text);
        ok(merge_folds(brackets, section_folds(&lines, &infos)))
    }

    /// `gams/matchingParenthesis`: Studio's parenthesis match at the cursor (see `parens`).
    /// `open`/`close` are in document order; `origin` tells which one is next to the cursor.
    fn matching_parenthesis(&mut self, p: Value) -> Res {
        let p: TextDocumentPositionParams = params(p)?;
        let Some(doc) = self.docs.get_mut(&p.text_document.uri) else { return ok(Value::Null) };
        if doc.lang != "gams" {
            return ok(Value::Null);
        }
        let infos = doc.infos();
        let Some(m) = parens::match_parentheses(&infos, p.position.line, p.position.character) else { return ok(Value::Null) };
        let rng = |(l, c): (u32, u32)| Range::new(Position::new(l, c), Position::new(l, c + 1));
        let (a, b, origin) = if m.start <= m.other { (m.start, m.other, "open") } else { (m.other, m.start, "close") };
        let mut v = json!({ "open": rng(a), "valid": m.valid && m.start != m.other, "origin": origin });
        if a != b {
            v["close"] = json!(rng(b));
        }
        ok(v)
    }

    /// `gams/bracketDepths`: `[{range, depth, valid}]` for the brackets `( [ {` / `) ] }` that start in `range`
    /// (see `parens::bracket_depths`; `depth` is the 0-based nesting level over the whole document).
    fn bracket_depths(&mut self, p: Value) -> Res {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct P {
            text_document: TextDocumentIdentifier,
            range: Range,
        }
        let p: P = params(p)?;
        let Some(doc) = self.docs.get_mut(&p.text_document.uri) else { return ok(Vec::<Value>::new()) };
        if doc.lang != "gams" {
            return ok(Vec::<Value>::new());
        }
        let all = doc.brackets();
        let key = |b: &parens::Bracket| (b.line, b.col);
        let (from, to) = ((p.range.start.line, p.range.start.character), (p.range.end.line, p.range.end.character));
        let lo = all.partition_point(|b| key(b) < from);
        let hi = all.partition_point(|b| key(b) < to);
        let out: Vec<Value> = all[lo..hi.max(lo)]
            .iter()
            .map(|b| json!({ "range": Range::new(Position::new(b.line, b.col), Position::new(b.line, b.col + 1)), "depth": b.depth, "valid": b.valid }))
            .collect();
        ok(out)
    }

    fn document_link(&mut self, p: Value) -> Res {
        let p: DocumentLinkParams = params(p)?;
        let uri = p.text_document.uri;
        let path = uri_to_path(&uri);
        let Some(doc) = self.docs.get(&uri) else { return ok(Vec::<DocumentLink>::new()) };
        if !doc.is_lst() {
            if doc.lang != "gams" {
                return ok(Vec::<DocumentLink>::new());
            }
            // `$include` & co: Ctrl+click opens the file (Studio `CodeEdit::checkLinks`)
            let sp = self.search_paths(&uri);
            let doc = self.docs.get_mut(&uri).expect("checked above");
            let infos = doc.infos();
            let mut links = Vec::new();
            for (ln, line) in split_lines(&doc.text).into_iter().enumerate() {
                for (inc, file) in doc_includes(line, infos.get(ln), &sp) {
                    links.push(DocumentLink {
                        range: Range::new(Position::new(ln as u32, inc.start), Position::new(ln as u32, inc.end)),
                        target: Some(path_to_uri(&file)),
                        tooltip: Some(format!("{} (Ctrl+click to open)", file.display())),
                        data: None,
                    });
                }
            }
            return ok(links);
        }
        ok(path.map(|p| lst::document_links(&p, &doc.text)).unwrap_or_default())
    }

    /// Where `$include`-style names are looked up for the document `uri`.
    fn search_paths(&self, uri: &Uri) -> includes::SearchPaths {
        let mut work_dirs: Vec<PathBuf> = Vec::new();
        if let Some(path) = uri_to_path(uri) {
            // GAMS resolves relative names against the working directory = directory of the main file
            for i in self.entry_for(&path) {
                work_dirs.extend(self.refs[i].gms.parent().map(Path::to_path_buf));
            }
            work_dirs.extend(path.parent().map(Path::to_path_buf));
        }
        let mut seen = HashSet::new();
        work_dirs.retain(|d| seen.insert(d.clone()));
        includes::SearchPaths { work_dirs, sysdir: self.sysdir.clone() }
    }

    /// The include files named on line `ln` that exist.
    fn includes_on_line(&mut self, uri: &Uri, ln: u32) -> Vec<(includes::Include, PathBuf)> {
        let sp = self.search_paths(uri);
        let Some(doc) = self.docs.get_mut(uri) else { return vec![] };
        if doc.lang != "gams" {
            return vec![];
        }
        let infos = doc.infos();
        let Some(line) = split_lines(&doc.text).get(ln as usize).copied() else { return vec![] };
        doc_includes(line, infos.get(ln as usize), &sp)
    }

    // ---------------------------------------------------------------- options (M5)

    fn option_definitions(&mut self, p: Value) -> Res {
        #[derive(serde::Deserialize)]
        struct P {
            def: String,
        }
        let p: P = params(p)?;
        if p.def.contains(['/', '\\']) || !p.def.to_ascii_lowercase().ends_with(".def") {
            return Err(err(ErrorCode::InvalidParams as i32, "def must be a bare .def file name"));
        }
        let d = self.opts.definition(&p.def).map_err(|m| err(gdx::REQUEST_FAILED, m))?;
        Ok(opts::definition_json(&d))
    }

    /// Definition for an open option-file document.
    fn opt_def_for(&mut self, uri: &Uri) -> Option<std::rc::Rc<gams_capi::optfile::OptDefinition>> {
        let path = uri_to_path(uri)?;
        let f = self.opts.def_for_path(&path)?;
        self.opts.definition(&f).ok()
    }

    fn send_diagnostics(&self, uri: Uri, diagnostics: Vec<Diagnostic>) {
        let params = PublishDiagnosticsParams { uri, diagnostics, version: None };
        let n = Notification { method: "textDocument/publishDiagnostics".into(), params: serde_json::to_value(params).unwrap_or(Value::Null) };
        let _ = self.out.send(Message::Notification(n));
    }

    /// Unknown options / bad values from the opt library messages (Studio `logAndClearMessage`).
    fn publish_opt_diagnostics(&mut self, uri: &Uri) {
        let Some(doc) = self.docs.get(uri) else { return };
        if doc.lang != OPT_LANG {
            return;
        }
        let text = doc.text.clone();
        let diags = match uri_to_path(uri).and_then(|p| self.opts.def_for_path(&p)) {
            Some(f) => {
                let lines = split_lines(&text);
                self.opts
                    .diagnose(&f, &text)
                    .into_iter()
                    .map(|(l, m, sev)| {
                        let line = lines.get(l).copied().unwrap_or("");
                        let start = line.len() - line.trim_start().len();
                        let end = line.trim_end().len();
                        Diagnostic {
                            range: Range::new(
                                Position::new(l as u32, char_to_utf16(line, line[..start].chars().count())),
                                Position::new(l as u32, char_to_utf16(line, line[..end].chars().count())),
                            ),
                            severity: Some(if sev == 1 { DiagnosticSeverity::ERROR } else { DiagnosticSeverity::WARNING }),
                            source: Some("gams-opt".into()),
                            message: m,
                            ..Default::default()
                        }
                    })
                    .collect()
            }
            None => vec![Diagnostic {
                range: Range::new(Position::new(0, 0), Position::new(0, 0)),
                severity: Some(DiagnosticSeverity::INFORMATION),
                source: Some("gams-opt".into()),
                message: self
                    .opts
                    .sysdir_problem()
                    .unwrap_or_else(|| "No option definition found for this file name (solver unknown in gmscmpun.txt)".into()),
                ..Default::default()
            }],
        };
        self.send_diagnostics(uri.clone(), diags);
    }

    fn completion(&mut self, p: Value) -> Res {
        let p: CompletionParams = params(p)?;
        if self.docs.get(&p.text_document_position.text_document.uri).is_some_and(|d| d.lang == "gams") {
            return self.gms_completion(p);
        }
        let (uri, pos) = (p.text_document_position.text_document.uri, p.text_document_position.position);
        if !self.docs.get(&uri).is_some_and(|d| d.lang == OPT_LANG) {
            return Ok(Value::Null);
        }
        // the .gms trigger characters do not apply to option files
        if p.context.as_ref().and_then(|c| c.trigger_character.as_deref()).is_some_and(|t| completion::GMS_TRIGGERS.contains(&t)) {
            return Ok(Value::Null);
        }
        let (Some(line), Some(def)) = (self.line_of(&uri, pos.line), self.opt_def_for(&uri)) else { return Ok(Value::Null) };
        let col = utf16_to_char(&line, pos.character);
        let Some(ctx) = opts::line_context(&line, col, &def.eol_chars) else { return Ok(Value::Null) };
        let rng = |a: usize, b: usize| Range::new(Position::new(pos.line, char_to_utf16(&line, a)), Position::new(pos.line, char_to_utf16(&line, b)));
        let mut items: Vec<CompletionItem> = Vec::new();
        match ctx {
            opts::LineCtx::Key { start, end } => {
                let edit = |t: &str| CompletionTextEdit::Edit(TextEdit::new(rng(start, end), t.to_string()));
                for o in def.options.iter().filter(|o| !o.hidden && !o.deprecated) {
                    items.push(CompletionItem {
                        label: o.name.clone(),
                        kind: Some(CompletionItemKind::PROPERTY),
                        detail: Some(o.type_name.clone()),
                        documentation: Some(Documentation::MarkupContent(MarkupContent { kind: MarkupKind::Markdown, value: opts::option_markdown(o, None) })),
                        text_edit: Some(edit(&o.name)),
                        ..Default::default()
                    });
                    for s in &o.synonyms {
                        items.push(CompletionItem {
                            label: s.clone(),
                            kind: Some(CompletionItemKind::PROPERTY),
                            detail: Some(format!("synonym of {}", o.name)),
                            text_edit: Some(edit(s)),
                            ..Default::default()
                        });
                    }
                }
            }
            opts::LineCtx::Value { key, start, end } => {
                let Some(o) = def.find(&key) else { return Ok(Value::Null) };
                let mut vals: Vec<(String, String)> = o.enums.iter().filter(|e| !e.hidden).map(|e| (e.value.clone(), e.description.clone())).collect();
                if vals.is_empty() && o.opt_type == gams_capi::opt::OPT_TYPE_BOOLEAN {
                    vals = vec![("0".into(), "off".into()), ("1".into(), "on".into())];
                }
                for (v, d) in vals {
                    items.push(CompletionItem {
                        label: v.clone(),
                        kind: Some(CompletionItemKind::ENUM_MEMBER),
                        detail: (!d.is_empty()).then_some(d),
                        text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(rng(start, end), v))),
                        ..Default::default()
                    });
                }
            }
        }
        ok(CompletionResponse::Array(items))
    }

    fn opt_hover(&mut self, uri: &Uri, pos: Position, line: &str) -> Res {
        let Some(def) = self.opt_def_for(uri) else { return Ok(Value::Null) };
        let col = utf16_to_char(line, pos.character);
        let Some(ctx) = opts::line_context(line, col, &def.eol_chars) else { return Ok(Value::Null) };
        let rng = |a: usize, b: usize| Range::new(Position::new(pos.line, char_to_utf16(line, a)), Position::new(pos.line, char_to_utf16(line, b)));
        let md = |s: String, r: Range| ok(Hover { contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value: s }), range: Some(r) });
        match ctx {
            opts::LineCtx::Key { start, end } => {
                let key: String = line.chars().skip(start).take(end - start).collect();
                let Some(o) = def.find(&key) else { return Ok(Value::Null) };
                let g = def.groups.iter().find(|g| g.nr == o.group).map(|g| g.description.as_str());
                md(opts::option_markdown(o, g), rng(start, end))
            }
            opts::LineCtx::Value { key, start, end } => {
                let Some(o) = def.find(&key) else { return Ok(Value::Null) };
                let v: String = line.chars().skip(start).take(end - start).collect();
                let v = v.trim_matches('"');
                match o.enums.iter().find(|e| e.value.trim_matches('"').eq_ignore_ascii_case(v)) {
                    Some(e) if !e.description.is_empty() => md(format!("`{}`: {}", e.value, e.description), rng(start, end)),
                    _ => md(opts::option_markdown(o, None), rng(start, end)),
                }
            }
        }
    }

    // ---------------------------------------------------------------- GDX

    fn gdx_job(&self, method: &str, p: Value) -> Result<gdx::Job, ResponseError> {
        if method == "gams/gdxRelease" {
            // `{ path?: string }`; params may be omitted entirely.
            #[derive(serde::Deserialize, Default)]
            struct R {
                path: Option<String>,
            }
            let r: R = if p.is_null() { R::default() } else { params(p)? };
            return Ok(gdx::Job::Release { path: r.path });
        }
        let _ = &self.sysdir;
        gdx::parse_job(method, p).map_err(|m| err(-32602, m))
    }
}

/// The include files named in `line` that exist.
fn doc_includes(line: &str, info: Option<&LineInfo>, sp: &includes::SearchPaths) -> Vec<(includes::Include, PathBuf)> {
    let Some(info) = info else { return vec![] };
    includes::includes_in_line(line, info)
        .into_iter()
        .filter_map(|i| {
            let f = includes::resolve(&i, sp)?;
            Some((i, f))
        })
        .collect()
}

/// Token kinds whose text is no code: words in them are not symbol references.
fn is_prose_kind(k: gams_syntax::SyntaxKind) -> bool {
    use gams_syntax::SyntaxKind as K;
    matches!(
        k,
        K::CommentLine
            | K::CommentBlock
            | K::CommentEndline
            | K::CommentInline
            | K::IgnoredHead
            | K::IgnoredBlock
            | K::String
            | K::Title
            | K::DcoComment
            | K::IdentifierDescription
            | K::EmbeddedBody
    )
}

/// Folding from Studio's nesting markers (`Nesting::parentheses`): block pairs
/// `T/t` $onText, `C/c` echo, `P/p` put, `I/i`, `O/o`, `F/f` $ifThen, `U/u`, `M/m`, `E/e`,
/// data blocks `/ .. /` and brackets. The closing line stays visible.
pub fn folding_ranges(infos: &[LineInfo]) -> Vec<FoldingRange> {
    fn opener_of(c: char) -> char {
        match c {
            ')' => '(',
            ']' => '[',
            '}' => '{',
            '\\' => '/',
            c if c.is_ascii_lowercase() => c.to_ascii_uppercase(),
            c => c,
        }
    }
    let mut stack: Vec<(char, u32)> = Vec::new();
    let mut out = Vec::new();
    for (ln, info) in infos.iter().enumerate() {
        for p in &info.nesting.parentheses {
            if p.opener {
                stack.push((p.ch, ln as u32));
            } else {
                let want = opener_of(p.ch);
                if let Some(i) = stack.iter().rposition(|(c, _)| *c == want) {
                    let (_, start) = stack.remove(i);
                    stack.truncate(i);
                    let end = (ln as u32).saturating_sub(1);
                    if end > start {
                        out.push(FoldingRange {
                            start_line: start,
                            start_character: None,
                            end_line: end,
                            end_character: None,
                            kind: Some(if want == 'T' { FoldingRangeKind::Comment } else { FoldingRangeKind::Region }),
                            collapsed_text: None,
                        });
                    }
                }
            }
        }
    }
    out.sort_by_key(|r| (r.start_line, r.end_line));
    out
}

/// Combine the bracket folds with the section folds into ranges VS Code can use: it keeps one
/// range per start line and drops ranges that cross an enclosing one, so
/// - the outermost range of a start line wins (Studio's `CodeEdit::foldStart` folds from the
///   outermost opener that stays open at the end of the line), and
/// - section folds are clipped to the bracket folds they overlap (`* Data ---` inside a
///   `loop(...)` ends with the loop; a section running into the loop ends before it).
pub fn merge_folds(brackets: Vec<FoldingRange>, sections: Vec<(u32, u32)>) -> Vec<FoldingRange> {
    let span: Vec<(u32, u32)> = brackets.iter().map(|r| (r.start_line, r.end_line)).collect();
    let mut out = brackets;
    for (s, mut e) in sections {
        loop {
            let before = e;
            for &(bs, be) in &span {
                if bs < s && s <= be && e > be {
                    e = be;
                } else if s < bs && bs <= e && be > e {
                    e = bs - 1;
                }
            }
            if e == before {
                break;
            }
        }
        if e > s {
            out.push(FoldingRange { start_line: s, start_character: None, end_line: e, end_character: None, kind: Some(FoldingRangeKind::Region), collapsed_text: None });
        }
    }
    out.sort_by_key(|r| (r.start_line, std::cmp::Reverse(r.end_line)));
    out.dedup_by_key(|r| r.start_line);
    // remaining overlaps (MPSGE vs. comment sections): the later range is cut at the enclosing one
    let mut open: Vec<u32> = Vec::new();
    out.retain_mut(|r| {
        while open.last().is_some_and(|&e| e < r.start_line) {
            open.pop();
        }
        if let Some(&e) = open.last() {
            r.end_line = r.end_line.min(e);
        }
        if r.end_line <= r.start_line {
            return false;
        }
        open.push(r.end_line);
        true
    });
    out
}
