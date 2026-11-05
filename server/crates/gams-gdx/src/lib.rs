// SPDX-License-Identifier: GPL-3.0-or-later
//! Safe, read-only GDX reader for the language server. Logic ported from GAMS Studio's GDX
//! viewer (`src/gdxviewer/gdxsymbol.cpp`, `gdxsymboltablemodel.cpp`, `gdxviewer.cpp`):
//! gdxOpenRead -> gdxSystemInfo -> per symbol gdxSymbolInfo/InfoX/GetDomainX ->
//! gdxDataReadRawStart/Raw/Done with UELs mapped through gdxUMUelGet.
//!
//! Backend: the pure Rust GDX library `gdx-rs` (port of GAMS-dev/gdx); no GAMS installation
//! is needed. The previous C API backend is kept as [`capi`] behind the cargo feature
//! `capi-oracle` and is only used by tests as reference implementation.
//!
//! Thread-safety: [`GdxFile`] is `Send` but NOT `Sync` (it keeps a read cursor; use it from
//! one thread at a time, wrap in a Mutex to share).
#[cfg(feature = "capi-oracle")]
pub mod capi;
pub mod query;
pub mod write;
use gdx_rs::GdxReader;
pub use query::RawTable;
use std::path::Path;

/// GAMS special values and limits (gclgms.h), re-exported from `gdx-rs`.
pub use gdx_rs::{MAX_INDEX_DIM, SV_ACR, SV_EPS, SV_MINF, SV_NA, SV_PINF, SV_UNDEF};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GdxError(pub String);
impl std::fmt::Display for GdxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for GdxError {}
pub type Result<T> = std::result::Result<T, GdxError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Set,
    Parameter,
    Variable,
    Equation,
    Alias,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SymbolInfo {
    /// 1-based GDX symbol number (use with `records`).
    pub index: usize,
    pub name: String,
    pub dim: usize,
    pub kind: SymbolKind,
    pub records: usize,
    pub explanatory_text: String,
    /// Domain names; "*" for relaxed/universe dimensions.
    pub domain: Vec<String>,
    /// Raw userinfo (for aliases: the aliased symbol number).
    pub user_info: i32,
    /// Var type (GMS_VARTYPE_*) / equation type (GMS_EQUTYPE_*) via gmsFixVarType/gmsFixEquType, -1 if unknown.
    pub sub_type: i32,
}

/// A value slot with GAMS special values decoded (Studio `GdxSymbol::formatValue`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Value {
    Num(f64),
    Undf,
    Na,
    PInf,
    MInf,
    Eps,
    /// Value >= SV_ACR: acronym (raw value kept; resolve with `GdxFile::acronym_name`).
    Acronym(f64),
}

impl Value {
    pub fn from_f64(v: f64) -> Value {
        if v < SV_UNDEF {
            Value::Num(v)
        } else if v == SV_UNDEF {
            Value::Undf
        } else if v == SV_NA {
            Value::Na
        } else if v == SV_PINF {
            Value::PInf
        } else if v == SV_MINF {
            Value::MInf
        } else if v == SV_EPS {
            Value::Eps
        } else {
            Value::Acronym(v)
        }
    }
    /// Studio text form: UNDF, NA, +INF, -INF, EPS.
    pub fn special_name(&self) -> Option<&'static str> {
        match self {
            Value::Undf => Some("UNDF"),
            Value::Na => Some("NA"),
            Value::PInf => Some("+INF"),
            Value::MInf => Some("-INF"),
            Value::Eps => Some("EPS"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub keys: Vec<String>,
    /// Slots: level, marginal, lower, upper, scale. Parameters/sets only use `values[0]`
    /// (for sets it is the element-text number, see `GdxFile::element_text`).
    pub values: [Value; 5],
}

pub struct GdxFile {
    r: GdxReader,
    /// Open `gdxDataReadRaw` cursor (GDX allows only one active read per object).
    cursor: Option<Cursor>,
}

/// State of the open sequential read of one symbol: `next` records have been consumed so far.
#[derive(Debug, Clone, Copy)]
struct Cursor {
    sym: usize,
    next: usize,
    total: usize,
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn gerr(e: gdx_rs::GdxError) -> GdxError {
    GdxError(e.message)
}

impl GdxFile {
    /// Open `path` for reading. `sysdir` is ignored (kept for signature compatibility; GDX
    /// files are read by `gdx-rs` without a GAMS installation). Prefer [`GdxFile::open_file`].
    pub fn open(_sysdir: &Path, path: &Path) -> Result<Self> {
        Self::open_file(path)
    }

    /// Open `path` for reading (`gdxOpenRead` + `gdxSystemInfo`).
    pub fn open_file(path: &Path) -> Result<Self> {
        let r = GdxReader::open(path).map_err(|e| GdxError(format!("Unable to open GDX file {}: {}", path.display(), e.message)))?;
        Ok(GdxFile { r, cursor: None })
    }

    /// The underlying `gdx-rs` reader (full GDX API: comments, acronym table, file version...).
    pub fn reader(&self) -> &GdxReader {
        &self.r
    }

    pub fn symbol_count(&self) -> usize {
        self.r.system_info().0
    }
    pub fn uel_count(&self) -> usize {
        self.r.system_info().1
    }

    /// All symbols (1..=count). The universe (index 0) is not included.
    pub fn symbols(&self) -> Vec<SymbolInfo> {
        (1..=self.symbol_count()).filter_map(|i| self.symbol(i).ok()).collect()
    }

    pub fn find_symbol(&self, name: &str) -> Option<usize> {
        self.r.find_symbol(name.as_bytes())
    }

    /// Port of `GdxSymbol::loadMetaData` + `loadDomains`.
    pub fn symbol(&self, index: usize) -> Result<SymbolInfo> {
        if index == 0 {
            return Err(GdxError(format!("invalid symbol index {index}")));
        }
        let (name, dim, typ) = self.r.symbol_info(index).ok_or_else(|| GdxError(format!("invalid symbol index {index}")))?;
        let (recs, ui, text) = self.r.symbol_info_x(index).unwrap_or((0, 0, b""));
        let kind = match typ {
            gdx_rs::DT_SET => SymbolKind::Set,
            gdx_rs::DT_PAR => SymbolKind::Parameter,
            gdx_rs::DT_VAR => SymbolKind::Variable,
            gdx_rs::DT_EQU => SymbolKind::Equation,
            _ => SymbolKind::Alias,
        };
        // gmsFixEquType / gmsFixVarType from gclgms.h (GMS_EQUTYPE_MAX=7, GMS_VARTYPE_MAX=10)
        let sub_type = match kind {
            SymbolKind::Equation => {
                if ui - gdx_rs::EQU_USERINFO_BASE >= gdx_rs::EQUTYPE_MAX { -1 } else { ui - gdx_rs::EQU_USERINFO_BASE }
            }
            SymbolKind::Variable => {
                if ui >= gdx_rs::VARTYPE_MAX { -1 } else { ui }
            }
            _ => ui,
        };
        let domain = self.r.symbol_get_domain_x(index).map(|d| d.ids.iter().map(|s| lossy(s)).collect()).unwrap_or_default();
        Ok(SymbolInfo {
            index,
            name: lossy(name),
            dim,
            kind,
            records: recs.max(0) as usize,
            explanatory_text: lossy(text),
            domain,
            user_info: ui,
            sub_type,
        })
    }

    /// UEL label for a 1-based UEL number (`gdxUMUelGet` like Studio `uel2Label`; `?L__<nr>`
    /// for unknown numbers, "" for negative ones).
    pub fn uel(&self, nr: i32) -> String {
        if nr < 0 {
            return String::new();
        }
        match self.r.uel(nr) {
            Some(s) => lossy(s),
            None => format!("?L__{nr}"),
        }
    }

    /// UEL number for a label (gdxUMFindUEL), as Studio `label2Uel`.
    pub fn find_uel(&self, label: &str) -> Option<i32> {
        self.r.find_uel(label.as_bytes())
    }

    /// Set element text (gdxGetElemText); `text_nr <= 0` is "Y" as in Studio.
    pub fn element_text(&self, text_nr: i32) -> String {
        if text_nr <= 0 {
            return "Y".into();
        }
        match self.r.elem_text(text_nr) {
            Some(s) => lossy(s),
            None => format!("?Str__{text_nr}"),
        }
    }

    /// `gdxAcronymName`: "" for values that are no acronym.
    pub fn acronym_name(&self, v: f64) -> String {
        self.r.acronym_name(v).map(|s| lossy(&s)).unwrap_or_default()
    }

    /// End the active sequential read (`gdxDataReadDone`), if any.
    fn close_cursor(&mut self) {
        if self.cursor.take().is_some() {
            self.r.data_read_done();
        }
    }

    fn start(&mut self, symbol_index: usize) -> Result<usize> {
        let n = self.r.data_read_raw_start(symbol_index).map_err(|e| GdxError(format!("Problems reading GDX file: {}", e.message)))?;
        Ok(n.max(0) as usize)
    }

    /// Read every record of symbol `symbol_index` (not an alias) into a [`RawTable`] with a
    /// fresh raw read (Studio `GdxSymbol::loadData`); used for whole-symbol sort / filter / pivot.
    pub fn read_all(&mut self, symbol_index: usize) -> Result<RawTable> {
        let sym = self.symbol(symbol_index)?;
        let dim = sym.dim;
        let stride = match sym.kind {
            SymbolKind::Variable | SymbolKind::Equation => 5,
            _ => 1,
        };
        self.close_cursor();
        let mut t = RawTable { dim, stride, is_set: sym.kind == SymbolKind::Set, keys: Vec::new(), vals: Vec::new() };
        let n = self.start(symbol_index)?;
        // `n` comes from the file: do not trust it for a huge up-front allocation
        let hint = n.min(1 << 22);
        t.keys.reserve(hint * dim);
        t.vals.reserve(hint * stride);
        let mut keys = [0i32; MAX_INDEX_DIM];
        let mut vals = [0f64; 5];
        for _ in 0..n {
            match self.r.data_read_raw(&mut keys, &mut vals).map_err(gerr)? {
                None => break,
                Some(_) => {
                    t.keys.extend_from_slice(&keys[..dim]);
                    t.vals.extend_from_slice(&vals[..stride]);
                }
            }
        }
        self.r.data_read_done();
        Ok(t)
    }

    /// The universe as a one-dimensional set: one record per UEL (`1..=uel_count`), no texts. This is
    /// what an alias of the universe (`Alias (u, *)`) stands for. Extension helper, not from Studio.
    pub fn read_universe(&self) -> RawTable {
        let n = self.uel_count();
        RawTable { dim: 1, stride: 1, is_set: true, keys: (1..=n as i32).collect(), vals: vec![0.0; n] }
    }

    /// Sequential raw scan of the keys (UEL numbers) of `symbol_index`; `f` gets each record's
    /// key tuple and returns `false` to stop early. Returns whether the scan ran to the end.
    /// Values are not decoded. Extension helper (workspace GDX search), not from Studio.
    pub fn scan_keys(&mut self, symbol_index: usize, mut f: impl FnMut(&[i32]) -> bool) -> Result<bool> {
        let sym = self.symbol(symbol_index)?;
        let dim = sym.dim;
        self.close_cursor();
        let n = self.start(symbol_index)?;
        let mut keys = [0i32; MAX_INDEX_DIM];
        let mut vals = [0f64; 5];
        let mut complete = true;
        for _ in 0..n {
            match self.r.data_read_raw(&mut keys, &mut vals) {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(e) => {
                    self.r.data_read_done();
                    return Err(gerr(e));
                }
            }
            if !f(&keys[..dim]) {
                complete = false;
                break;
            }
        }
        self.r.data_read_done();
        Ok(complete)
    }

    /// Read `limit` records starting at `offset` (0-based) of symbol `symbol_index` (1-based;
    /// 0 = universe is not supported). Uses the raw sequential read like Studio. GDX has no
    /// seek, so the read cursor is kept open between calls: a page that starts at or after
    /// the cursor position continues from there (skipping any gap), making consecutive paging
    /// O(total) instead of O(pages * offset). The cursor is restarted when the offset lies
    /// before it or another symbol is requested (only one read can be active), and closed
    /// when the last record has been read.
    pub fn records(&mut self, symbol_index: usize, offset: usize, limit: usize) -> Result<Vec<Record>> {
        let sym = self.symbol(symbol_index)?;
        let dim = sym.dim;
        let reuse = self.cursor.is_some_and(|cu| cu.sym == symbol_index && cu.next <= offset);
        if !reuse {
            self.close_cursor();
        }
        let mut cu = match self.cursor {
            Some(cu) if reuse => cu,
            _ => {
                let total = self.start(symbol_index)?;
                Cursor { sym: symbol_index, next: 0, total }
            }
        };
        // from here a read is active; `self.cursor` must reflect it on every exit path
        self.cursor = Some(cu);
        let mut out = Vec::new();
        let mut keys = [0i32; MAX_INDEX_DIM];
        let mut vals = [0f64; 5];
        let end = cu.total.min(offset.saturating_add(limit));
        while cu.next < end {
            match self.r.data_read_raw(&mut keys, &mut vals) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    cu.next = cu.total;
                    break;
                }
                Err(e) => {
                    self.cursor = None;
                    self.r.data_read_done();
                    return Err(gerr(e));
                }
            }
            let i = cu.next;
            cu.next += 1;
            if i < offset {
                continue;
            }
            let mut v = [Value::Num(0.0); 5];
            for (s, x) in v.iter_mut().zip(vals.iter()) {
                *s = Value::from_f64(*x);
            }
            out.push(Record { keys: keys[..dim].iter().map(|&u| self.uel(u)).collect(), values: v });
        }
        self.cursor = Some(cu);
        if cu.next >= cu.total {
            self.close_cursor();
        }
        Ok(out)
    }
}
