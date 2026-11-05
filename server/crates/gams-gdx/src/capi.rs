// SPDX-License-Identifier: GPL-3.0-or-later
//! The previous backend on top of the GAMS C API (`gams-capi`, `libgdxcclib64` loaded from a
//! GAMS system directory), kept behind the cargo feature `capi-oracle` as reference
//! implementation for the tests that compare it with the pure Rust backend (`gdx-rs`).
//! Logic ported from GAMS Studio's GDX viewer (`src/gdxviewer/gdxsymbol.cpp`,
//! `gdxsymboltablemodel.cpp`, `gdxviewer.cpp`): gdxCreateD -> gdxOpenRead -> gdxSystemInfo ->
//! per symbol gdxSymbolInfo/InfoX/GetDomainX -> gdxDataReadRawStart/Raw/Done.
#![allow(clippy::missing_safety_doc)]
use crate::{GdxError, RawTable, Record, Result, SymbolInfo, SymbolKind, Value};
use gams_capi::gdx as c;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::collections::BTreeSet;
use std::path::Path;

/// C API backed GDX file (reference implementation).
pub struct GdxFile {
    h: c::GdxHandle,
    symbols: usize,
    uels: usize,
    uel_cache: Vec<Option<String>>,
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

// Safe to move between threads, but not to share.
unsafe impl Send for GdxFile {}

fn cstr(buf: &[u8]) -> String {
    CStr::from_bytes_until_nul(buf).map(|c| c.to_string_lossy().into_owned()).unwrap_or_default()
}

macro_rules! f {
    ($n:ident) => {
        c::$n().ok_or_else(|| GdxError(format!("{} not loaded", stringify!($n))))?
    };
}

impl GdxFile {
    /// Load the GDX library from `sysdir` and open `path` for reading.
    pub fn open(sysdir: &Path, path: &Path) -> Result<Self> {
        let file = CString::new(path.to_string_lossy().as_bytes()).map_err(|e| GdxError(e.to_string()))?;
        let h = c::create(sysdir).map_err(GdxError)?;
        // From here on `Drop` closes and frees the handle.
        let mut me = GdxFile { h, symbols: 0, uels: 0, uel_cache: Vec::new(), cursor: None };
        unsafe {
            let mut err: c_int = 0;
            let ok = f!(gdxOpenRead)(h, file.as_ptr(), &mut err);
            if ok == 0 || err != 0 {
                let m = me.error_str(err);
                return Err(GdxError(format!("Unable to open GDX file {}: {}", path.display(), m)));
            }
            let (mut s, mut u) = (0, 0);
            f!(gdxSystemInfo)(h, &mut s, &mut u);
            me.symbols = s as usize;
            me.uels = u as usize;
        }
        Ok(me)
    }

    fn error_str(&self, err: c_int) -> String {
        let mut m = [0u8; c::GMS_SSSIZE];
        unsafe {
            if let Some(g) = c::gdxErrorStr() {
                g(self.h, err, m.as_mut_ptr() as *mut c_char);
            }
        }
        cstr(&m)
    }

    fn last_error(&self) -> String {
        unsafe {
            let n = c::gdxGetLastError().map(|g| g(self.h)).unwrap_or(0);
            self.error_str(n)
        }
    }

    pub fn symbol_count(&self) -> usize {
        self.symbols
    }
    pub fn uel_count(&self) -> usize {
        self.uels
    }

    /// All symbols (1..=count). The universe (index 0) is not included.
    pub fn symbols(&self) -> Vec<SymbolInfo> {
        (1..=self.symbols).filter_map(|i| self.symbol(i).ok()).collect()
    }

    pub fn find_symbol(&self, name: &str) -> Option<usize> {
        let n = CString::new(name).ok()?;
        let mut nr = 0;
        unsafe {
            if c::gdxFindSymbol()?(self.h, n.as_ptr(), &mut nr) != 0 {
                Some(nr as usize)
            } else {
                None
            }
        }
    }

    /// Port of `GdxSymbol::loadMetaData` + `loadDomains`.
    pub fn symbol(&self, index: usize) -> Result<SymbolInfo> {
        unsafe {
            let mut name = [0u8; c::GMS_UEL_IDENT_SIZE];
            let (mut dim, mut typ) = (0, 0);
            if f!(gdxSymbolInfo)(self.h, index as c_int, name.as_mut_ptr() as *mut c_char, &mut dim, &mut typ) == 0 {
                return Err(GdxError(format!("invalid symbol index {index}")));
            }
            let mut text = [0u8; c::GMS_SSSIZE];
            let (mut recs, mut ui) = (0, 0);
            f!(gdxSymbolInfoX)(self.h, index as c_int, &mut recs, &mut ui, text.as_mut_ptr() as *mut c_char);
            let kind = match typ {
                c::GMS_DT_SET => SymbolKind::Set,
                c::GMS_DT_PAR => SymbolKind::Parameter,
                c::GMS_DT_VAR => SymbolKind::Variable,
                c::GMS_DT_EQU => SymbolKind::Equation,
                _ => SymbolKind::Alias,
            };
            // gmsFixEquType / gmsFixVarType from gclgms.h (GMS_EQUTYPE_MAX=7, GMS_VARTYPE_MAX=10)
            let sub_type = match kind {
                SymbolKind::Equation => {
                    if ui - c::GMS_EQU_USERINFO_BASE >= 7 { -1 } else { ui - c::GMS_EQU_USERINFO_BASE }
                }
                SymbolKind::Variable => {
                    if ui >= 10 { -1 } else { ui }
                }
                _ => ui,
            };
            let dim = check_dim(dim, index)?;
            let mut bufs = vec![[0u8; c::GMS_SSSIZE]; c::GMS_MAX_INDEX_DIM];
            let mut ptrs: Vec<*mut c_char> = bufs.iter_mut().map(|b| b.as_mut_ptr() as *mut c_char).collect();
            f!(gdxSymbolGetDomainX)(self.h, index as c_int, ptrs.as_mut_ptr());
            let domain = (0..dim.min(c::GMS_MAX_INDEX_DIM)).map(|i| cstr(&bufs[i])).collect();
            Ok(SymbolInfo {
                index,
                name: cstr(&name),
                dim,
                kind,
                records: recs.max(0) as usize,
                explanatory_text: cstr(&text),
                domain,
                user_info: ui,
                sub_type,
            })
        }
    }

    /// UEL label for a 1-based UEL number (uses gdxUMUelGet like Studio `uel2Label`; cached).
    pub fn uel(&mut self, nr: i32) -> String {
        if nr < 0 {
            return String::new();
        }
        let n = nr as usize;
        if self.uel_cache.is_empty() {
            self.uel_cache = vec![None; self.uels + 1];
        }
        if let Some(Some(s)) = self.uel_cache.get(n) {
            return s.clone();
        }
        let mut b = [0u8; c::GMS_UEL_IDENT_SIZE];
        let mut map = 0;
        let s = unsafe {
            match c::gdxUMUelGet() {
                Some(g) if g(self.h, nr, b.as_mut_ptr() as *mut c_char, &mut map) != 0 => cstr(&b),
                _ => format!("?L__{nr}"),
            }
        };
        if n < self.uel_cache.len() {
            self.uel_cache[n] = Some(s.clone());
        }
        s
    }

    /// UEL number for a label (gdxUMFindUEL), as Studio `label2Uel`.
    pub fn find_uel(&self, label: &str) -> Option<i32> {
        let l = CString::new(label).ok()?;
        let (mut nr, mut map) = (-1, -1);
        unsafe {
            if c::gdxUMFindUEL()?(self.h, l.as_ptr(), &mut nr, &mut map) != 0 {
                Some(nr)
            } else {
                None
            }
        }
    }

    /// Set element text (gdxGetElemText); `text_nr <= 0` is "Y" as in Studio.
    pub fn element_text(&self, text_nr: i32) -> String {
        if text_nr <= 0 {
            return "Y".into();
        }
        let mut b = [0u8; c::GMS_SSSIZE];
        let mut node = 0;
        unsafe {
            if let Some(g) = c::gdxGetElemText() {
                g(self.h, text_nr, b.as_mut_ptr() as *mut c_char, &mut node);
            }
        }
        cstr(&b)
    }

    pub fn acronym_name(&self, v: f64) -> String {
        let mut b = [0u8; c::GMS_SSSIZE];
        unsafe {
            if let Some(g) = c::gdxAcronymName() {
                g(self.h, v, b.as_mut_ptr() as *mut c_char);
            }
        }
        cstr(&b)
    }

    /// End the active sequential read (`gdxDataReadDone`), if any.
    fn close_cursor(&mut self) {
        if self.cursor.take().is_some() {
            unsafe {
                if let Some(d) = c::gdxDataReadDone() {
                    d(self.h);
                }
            }
        }
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
        unsafe {
            let mut n = 0;
            if f!(gdxDataReadRawStart)(self.h, symbol_index as c_int, &mut n) == 0 {
                return Err(GdxError(format!("Problems reading GDX file: {}", self.last_error())));
            }
            let n = n.max(0) as usize;
            // `n` comes from the file: do not trust it for a huge up-front allocation
            let hint = n.min(1 << 22);
            t.keys.reserve(hint * dim);
            t.vals.reserve(hint * stride);
            let read = f!(gdxDataReadRaw);
            let mut keys = [0 as c_int; c::GMS_MAX_INDEX_DIM];
            let mut vals = [0f64; c::GMS_VAL_MAX];
            let mut frst = 0;
            for _ in 0..n {
                if read(self.h, keys.as_mut_ptr(), vals.as_mut_ptr(), &mut frst) == 0 {
                    break;
                }
                t.keys.extend_from_slice(&keys[..dim]);
                t.vals.extend_from_slice(&vals[..stride]);
            }
            if let Some(d) = c::gdxDataReadDone() {
                d(self.h);
            }
        }
        Ok(t)
    }

    /// Sequential raw scan of the keys (UEL numbers) of `symbol_index`; `f` gets each record's
    /// key tuple and returns `false` to stop early. Returns whether the scan ran to the end.
    /// Values are not decoded. Extension helper (workspace GDX search), not from Studio.
    pub fn scan_keys(&mut self, symbol_index: usize, mut f: impl FnMut(&[i32]) -> bool) -> Result<bool> {
        let sym = self.symbol(symbol_index)?;
        let dim = sym.dim;
        self.close_cursor();
        let mut complete = true;
        unsafe {
            let mut n = 0;
            if f!(gdxDataReadRawStart)(self.h, symbol_index as c_int, &mut n) == 0 {
                return Err(GdxError(format!("Problems reading GDX file: {}", self.last_error())));
            }
            let read = f!(gdxDataReadRaw);
            let mut keys = [0 as c_int; c::GMS_MAX_INDEX_DIM];
            let mut vals = [0f64; c::GMS_VAL_MAX];
            let mut frst = 0;
            for _ in 0..n.max(0) {
                if read(self.h, keys.as_mut_ptr(), vals.as_mut_ptr(), &mut frst) == 0 {
                    break;
                }
                if !f(&keys[..dim]) {
                    complete = false;
                    break;
                }
            }
            if let Some(d) = c::gdxDataReadDone() {
                d(self.h);
            }
        }
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
        let mut out = Vec::new();
        unsafe {
            let mut cu = match self.cursor {
                Some(cu) if reuse => cu,
                _ => {
                    let mut n = 0;
                    if f!(gdxDataReadRawStart)(self.h, symbol_index as c_int, &mut n) == 0 {
                        return Err(GdxError(format!("Problems reading GDX file: {}", self.last_error())));
                    }
                    Cursor { sym: symbol_index, next: 0, total: n.max(0) as usize }
                }
            };
            // from here a read is active; `self.cursor` must reflect it on every exit path
            self.cursor = Some(cu);
            let read = f!(gdxDataReadRaw);
            let mut keys = [0 as c_int; c::GMS_MAX_INDEX_DIM];
            let mut vals = [0f64; c::GMS_VAL_MAX];
            let mut frst = 0;
            let end = cu.total.min(offset.saturating_add(limit));
            while cu.next < end {
                if read(self.h, keys.as_mut_ptr(), vals.as_mut_ptr(), &mut frst) == 0 {
                    cu.next = cu.total; // truncated data: stop and close below
                    break;
                }
                let i = cu.next;
                cu.next += 1;
                if i < offset {
                    continue;
                }
                let k: Vec<i32> = keys[..dim].to_vec();
                let mut v = [Value::Num(0.0); 5];
                for (s, x) in v.iter_mut().zip(vals.iter()) {
                    *s = Value::from_f64(*x);
                }
                out.push((k, v));
            }
            self.cursor = Some(cu);
            if cu.next >= cu.total {
                self.close_cursor();
            }
        }
        Ok(out
            .into_iter()
            .map(|(k, values)| Record { keys: k.into_iter().map(|u| self.uel(u)).collect(), values })
            .collect())
    }
}

impl Drop for GdxFile {
    fn drop(&mut self) {
        self.close_cursor();
        unsafe {
            if let Some(cl) = c::gdxClose() {
                cl(self.h);
            }
            c::free(&mut self.h);
        }
    }
}

/// A symbol dimension read from a file must fit the fixed `GMS_MAX_INDEX_DIM` key buffers.
fn check_dim(dim: c_int, index: usize) -> Result<usize> {
    if dim < 0 || dim as usize > c::GMS_MAX_INDEX_DIM {
        return Err(GdxError(format!("symbol {index} has an invalid dimension {dim} (maximum {})", c::GMS_MAX_INDEX_DIM)));
    }
    Ok(dim as usize)
}


/// Write with the C library (`gdxOpenWrite`, raw UEL registration and raw data writes).
/// Write `symbols` to `path` with the C library. Records are sorted by key labels; duplicate keys are an error.
pub fn write_gdx(sysdir: &Path, path: &Path, symbols: &[crate::write::WriteSymbol]) -> Result<()> {
    let labels: BTreeSet<&str> = symbols.iter().flat_map(|s| s.records.iter().flat_map(|(k, _)| k.iter().map(|x| x.as_str()))).collect();
    let nr: std::collections::HashMap<&str, c_int> = labels.iter().enumerate().map(|(i, l)| (*l, i as c_int + 1)).collect();
    let mut h = c::create(sysdir).map_err(GdxError)?;
    let out = CString::new(path.to_string_lossy().as_bytes()).map_err(|e| GdxError(e.to_string()))?;
    let prod = CString::new("vscode-gams").unwrap();
    let mut result = Ok(());
    macro_rules! f {
        ($n:ident) => {
            c::$n().ok_or_else(|| GdxError(format!("{} not loaded", stringify!($n))))?
        };
    }
    let run = || -> Result<()> {
        unsafe {
            let mut err: c_int = 0;
            if f!(gdxOpenWrite)(h, out.as_ptr(), prod.as_ptr(), &mut err) == 0 {
                return Err(GdxError(format!("cannot open {} for writing (error {err})", path.display())));
            }
            f!(gdxUELRegisterRawStart)(h);
            for l in &labels {
                let cl = CString::new(*l).map_err(|e| GdxError(e.to_string()))?;
                f!(gdxUELRegisterRaw)(h, cl.as_ptr());
            }
            f!(gdxUELRegisterDone)(h);
            for s in symbols {
                let typ = match s.kind {
                    SymbolKind::Set => c::GMS_DT_SET,
                    SymbolKind::Parameter => c::GMS_DT_PAR,
                    SymbolKind::Variable => c::GMS_DT_VAR,
                    SymbolKind::Equation => c::GMS_DT_EQU,
                    SymbolKind::Alias => return Err(GdxError("alias symbols cannot be written".into())),
                };
                let user = match s.kind {
                    SymbolKind::Variable => s.sub_type,
                    SymbolKind::Equation => c::GMS_EQU_USERINFO_BASE + s.sub_type,
                    _ => 0,
                };
                let name = CString::new(s.name.as_str()).map_err(|e| GdxError(e.to_string()))?;
                let text = CString::new(s.text.as_str()).map_err(|e| GdxError(e.to_string()))?;
                if f!(gdxDataWriteRawStart)(h, name.as_ptr(), text.as_ptr(), s.dim as c_int, typ, user) == 0 {
                    return Err(GdxError(format!("cannot start writing {}", s.name)));
                }
                let mut recs: Vec<(Vec<c_int>, &[f64; 5])> = s.records.iter().map(|(k, v)| (k.iter().map(|l| nr[l.as_str()]).collect(), v)).collect();
                recs.sort_by(|a, b| a.0.cmp(&b.0));
                for (k, v) in &recs {
                    let mut keys = [0 as c_int; c::GMS_MAX_INDEX_DIM];
                    keys[..k.len()].copy_from_slice(k);
                    f!(gdxDataWriteRaw)(h, keys.as_ptr(), v.as_ptr());
                }
                f!(gdxDataWriteDone)(h);
            }
            f!(gdxClose)(h);
        }
        Ok(())
    };
    if let Err(e) = run() {
        result = Err(e);
    }
    unsafe { c::free(&mut h) };
    result
}

