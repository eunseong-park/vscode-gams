// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
//! GDX writer: port of the write side of `TGXFileObj` (`src/gxfile.cpp`): `gdxOpenWriteEx`,
//! `gdxUELRegister{Raw,Str,Map}*`, `PrepareSymbolWrite`, `gdxDataWrite{Raw,Str,Map}*`,
//! `InitDoWrite` / `DoWrite`, `gdxDataWriteDone`, `gdxAddSetText`, `gdxAddAlias`,
//! `gdxSymbolSetDomain(X)`, `gdxAcronymAdd`, `gdxSymbolAddComment` and `gdxClose`.
//!
//! Differences: no `gdxOpenAppend`; `gdxAutoConvert` (running `gdxcopy` after close when the
//! `GDXCOMPRESS`/`GDXCONVERT` environment asks for another format) is not done; records
//! rejected by `DoWrite` (duplicates, unsorted raw data, domain violations) are reported as
//! errors of the write call instead of being collected in an error list; closing also
//! finishes a symbol that was started but never received a record.
use crate::error::*;
use crate::read::{FILE_VERSION, MARK_ACRO, MARK_BOI, MARK_DATA, MARK_DOMS, MARK_SETT, MARK_SYMB, MARK_UEL};
use crate::stream::WriteStream;
use crate::strpool::StrPool;
use crate::*;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Seek, Write};
use std::path::Path;

const INDEX_INITIAL: i32 = -256;
/// File system id written by this writer (the C library writes its audit line here).
const AUDIT_LINE: &str = concat!("GDX Library Rust gdx-rs V7 ", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    Init,
    RegRaw,
    RegStr,
    RegMap,
    DomRaw,
    DomStr,
    DomMap,
    Raw,
    Str,
    Map,
    Closed,
}

struct WSymbol {
    name: Vec<u8>,
    position: i64,
    dim: usize,
    typ: i32,
    user_info: i32,
    data_count: i32,
    errors: i32,
    set_text: bool,
    expl_text: Vec<u8>,
    compressed: bool,
    dom_symbols: Option<Vec<i32>>,
    dom_strings: Option<Vec<i32>>,
    comments: Vec<Vec<u8>>,
    /// Elements of a one-dimensional set (`SSetBitMap`), used for domain checks.
    bitmap: Option<Vec<bool>>,
}

/// GDX file being written (`gdxOpenWrite`). Call [`GdxWriter::close`] to write the tables;
/// dropping an unclosed writer closes it and ignores errors.
pub struct GdxWriter<W: Write + Seek = BufWriter<File>> {
    s: WriteStream<W>,
    compress_out: bool,
    mode: Mode,
    mode_after_reg: Mode,
    symbols: Vec<WSymbol>,
    symbol_index: HashMap<Box<[u8]>, usize>,
    uels: StrPool,
    uel_index: HashMap<Box<[u8]>, i32>,
    /// user UEL number per entry (1-based entry -> user nr, -1 = none) and the reverse.
    uel_user: Vec<i32>,
    usr2ent: HashMap<i32, i32>,
    usr_high: i32,
    set_texts: StrPool,
    set_text_index: HashMap<Box<[u8]>, i32>,
    acronyms: Vec<(Vec<u8>, Vec<u8>, i32)>,
    domain_strs: StrPool,
    domain_str_index: HashMap<Box<[u8]>, i32>,
    major_index_position: u64,
    next_write_position: u64,
    intl_i64: [u64; 10],
    store_domain_sets: bool,
    allow_bogus_domain: bool,
    // current symbol
    cur: Option<usize>,
    dim: usize,
    data_size: usize,
    delta_for_write: i32,
    last: [i32; MAX_INDEX_DIM],
    min: [i32; MAX_INDEX_DIM],
    max: [i32; MAX_INDEX_DIM],
    elem: [u8; MAX_INDEX_DIM],
    wr_bitmaps: [Option<usize>; MAX_INDEX_DIM],
    data_count: i32,
    err_cnt: i32,
    sort: Vec<([i32; MAX_INDEX_DIM], [f64; VAL_MAX])>,
    last_str: Vec<Option<(Vec<u8>, i32)>>,
}

impl GdxWriter<BufWriter<File>> {
    /// `gdxOpenWriteEx(file, producer, compress)`.
    pub fn create(path: impl AsRef<Path>, producer: &str, compress: bool) -> Result<Self> {
        let path = path.as_ref();
        if path.as_os_str().is_empty() {
            return Err(GdxError::new(ERR_NOFILE));
        }
        let f = File::create(path).map_err(|e| GdxError::io(&e))?;
        Ok(GdxWriter::new(BufWriter::with_capacity(64 * 1024, f), producer, compress))
    }

    /// `gdxOpenWrite`: compression from the `GDXCOMPRESS` environment variable (default off;
    /// `GetEnvCompressFlag`).
    pub fn create_env(path: impl AsRef<Path>, producer: &str) -> Result<Self> {
        let c = std::env::var("GDXCOMPRESS").ok().and_then(|s| s.chars().next()).map(|c| !matches!(c.to_ascii_uppercase(), 'N' | '0')).unwrap_or(false);
        Self::create(path, producer, c)
    }
}

impl<W: Write + Seek> GdxWriter<W> {
    /// Start a GDX file on any seekable sink.
    pub fn new(inner: W, producer: &str, compress: bool) -> Self {
        let mut s = WriteStream::new(inner);
        s.write_u8(123);
        s.write_string(b"GAMSGDX");
        s.write_i32(FILE_VERSION);
        s.write_i32(compress as i32);
        s.write_string(AUDIT_LINE.as_bytes());
        s.write_string(producer.as_bytes());
        let major_index_position = s.position();
        for _ in 0..10 {
            s.write_i64(0);
        }
        let mut set_texts = StrPool::default();
        set_texts.push(b"");
        let mut set_text_index = HashMap::new();
        set_text_index.insert(Box::<[u8]>::from(&b""[..]), 0);
        let next_write_position = s.position();
        GdxWriter {
            s,
            compress_out: compress,
            mode: Mode::Init,
            mode_after_reg: Mode::Init,
            symbols: Vec::new(),
            symbol_index: HashMap::new(),
            uels: StrPool::default(),
            uel_index: HashMap::new(),
            uel_user: Vec::new(),
            usr2ent: HashMap::new(),
            usr_high: 0,
            set_texts,
            set_text_index,
            acronyms: Vec::new(),
            domain_strs: StrPool::default(),
            domain_str_index: HashMap::new(),
            major_index_position,
            next_write_position,
            intl_i64: DEFAULT_INTL_VALUES.map(f64::to_bits),
            store_domain_sets: true,
            allow_bogus_domain: true,
            cur: None,
            dim: 0,
            data_size: 0,
            delta_for_write: 0,
            last: [0; MAX_INDEX_DIM],
            min: [0; MAX_INDEX_DIM],
            max: [0; MAX_INDEX_DIM],
            elem: [2; MAX_INDEX_DIM],
            wr_bitmaps: [None; MAX_INDEX_DIM],
            data_count: 0,
            err_cnt: 0,
            sort: Vec::new(),
            last_str: Vec::new(),
        }
    }

    fn check_mode(&self, ok: &[Mode]) -> Result<()> {
        if ok.contains(&self.mode) {
            Ok(())
        } else {
            Err(GdxError::with(ERR_BADMODE, format!("called in mode {:?}", self.mode)))
        }
    }

    /// `gdxStoreDomainSetsSet` (default true): keep the elements of one-dimensional sets to
    /// check records of symbols using them as domain.
    pub fn set_store_domain_sets(&mut self, v: bool) {
        self.store_domain_sets = v;
    }
    /// `gdxAllowBogusDomainsSet` (default true).
    pub fn set_allow_bogus_domains(&mut self, v: bool) {
        self.allow_bogus_domain = v;
    }

    /// `gdxSetSpecialValues`: values that are stored as UNDF, NA, +INF, -INF, EPS.
    pub fn set_special_values(&mut self, v: [f64; 5]) -> Result<()> {
        let mut t = self.intl_i64;
        for k in 0..5 {
            t[k] = v[k].to_bits();
        }
        for a in 0..5 {
            for b in a + 1..5 {
                if t[a] == t[b] {
                    return Err(GdxError::new(ERR_DUPLICATESPECVAL));
                }
            }
        }
        self.intl_i64 = t;
        Ok(())
    }

    // ------------------------------------------------------------------ UELs

    /// `AddObject` on the UEL table: 1-based entry number (existing or new).
    fn uel_add(&mut self, s: &[u8]) -> i32 {
        let k = upper_key(s);
        if let Some(&n) = self.uel_index.get(&k) {
            return n;
        }
        self.uels.push(s);
        self.uel_user.push(-1);
        let n = self.uels.len() as i32;
        self.uel_index.insert(k, n);
        n
    }

    fn checked_uel(s: &str) -> Result<&[u8]> {
        let t = trim_right(s.as_bytes());
        if !good_uel_string(t) {
            return Err(GdxError::with(ERR_BADUELSTR, s));
        }
        Ok(t)
    }

    pub fn uel_register_raw_start(&mut self) -> Result<()> {
        self.check_mode(&[Mode::Init])?;
        self.mode_after_reg = Mode::Init;
        self.mode = Mode::RegRaw;
        Ok(())
    }
    /// `gdxUELRegisterRaw`: raw UEL numbers are the registration order.
    pub fn uel_register_raw(&mut self, uel: &str) -> Result<()> {
        self.check_mode(&[Mode::RegRaw])?;
        let t = Self::checked_uel(uel)?;
        self.uel_add(t);
        Ok(())
    }
    pub fn uel_register_str_start(&mut self) -> Result<()> {
        self.check_mode(&[Mode::Init])?;
        self.mode_after_reg = Mode::Init;
        self.mode = Mode::RegStr;
        Ok(())
    }
    /// `gdxUELRegisterStr` (`AddUsrNew`): returns the user UEL number.
    pub fn uel_register_str(&mut self, uel: &str) -> Result<i32> {
        self.check_mode(&[Mode::RegStr])?;
        let t = Self::checked_uel(uel)?.to_vec();
        let en = self.uel_add(&t);
        let mut r = self.uel_user[en as usize - 1];
        if r < 0 {
            r = self.usr_high + 1;
            self.set_user(en, r);
        }
        Ok(r)
    }
    pub fn uel_register_map_start(&mut self) -> Result<()> {
        self.check_mode(&[Mode::Init])?;
        self.mode_after_reg = Mode::Init;
        self.mode = Mode::RegMap;
        Ok(())
    }
    /// `gdxUELRegisterMap` (`AddUsrIndxNew`): register `uel` under user number `nr`.
    pub fn uel_register_map(&mut self, nr: i32, uel: &str) -> Result<()> {
        self.check_mode(&[Mode::RegMap])?;
        let t = Self::checked_uel(uel)?.to_vec();
        let en = self.uel_add(&t);
        let r = self.uel_user[en as usize - 1];
        if r < 0 {
            self.set_user(en, nr);
        } else if r != nr {
            return Err(GdxError::new(ERR_UELCONFLICT));
        }
        Ok(())
    }
    fn set_user(&mut self, en: i32, nr: i32) {
        self.uel_user[en as usize - 1] = nr;
        self.usr2ent.insert(nr, en);
        self.usr_high = self.usr_high.max(nr);
    }
    pub fn uel_register_done(&mut self) -> Result<()> {
        self.check_mode(&[Mode::RegRaw, Mode::RegStr, Mode::RegMap])?;
        self.mode = self.mode_after_reg;
        Ok(())
    }

    // ------------------------------------------------------------------ symbols

    fn is_good_new_symbol(&self, name: &[u8]) -> Result<()> {
        if self.symbol_index.contains_key(&upper_key(name)) || self.acronyms.iter().any(|a| a.0.eq_ignore_ascii_case(name)) {
            return Err(GdxError::with(ERR_DUPLICATESYMBOL, String::from_utf8_lossy(name)));
        }
        if !is_good_ident(name) {
            return Err(GdxError::with(ERR_BADIDENTFORMAT, String::from_utf8_lossy(name)));
        }
        Ok(())
    }

    fn add_symbol(&mut self, sy: WSymbol) -> usize {
        self.symbol_index.insert(upper_key(&sy.name), self.symbols.len());
        self.symbols.push(sy);
        self.symbols.len()
    }

    /// `PrepareSymbolWrite`.
    fn prepare(&mut self, name: &str, text: &str, dim: usize, typ: i32, user_info: i32) -> Result<()> {
        self.cur = None;
        self.sort.clear();
        self.check_mode(&[Mode::Init])?;
        self.is_good_new_symbol(name.as_bytes())?;
        if dim > MAX_INDEX_DIM {
            return Err(GdxError::new(ERR_BADDIMENSION));
        }
        if !(DT_SET..=DT_EQU).contains(&typ) {
            return Err(GdxError::new(ERR_BADDATATYPE));
        }
        // assignExplanatoryText + MakeGoodExplText
        let mut expl = until_nul(text.as_bytes()).to_vec();
        if expl.len() >= SSSIZE {
            let mut o = b"String overflow: ".to_vec();
            o.extend_from_slice(&expl[..SSSIZE - 21]);
            o.extend_from_slice(b"...");
            expl = o;
        }
        make_good_expl_text(&mut expl);
        let compressed = self.compress_out && dim > 0;
        let bitmap = (typ == DT_SET && dim == 1 && self.store_domain_sets).then(Vec::new);
        let nr = self.add_symbol(WSymbol {
            name: name.as_bytes().to_vec(),
            position: 0,
            dim,
            typ,
            user_info,
            data_count: 0,
            errors: 0,
            set_text: false,
            expl_text: expl,
            compressed,
            dom_symbols: None,
            dom_strings: None,
            comments: Vec::new(),
            bitmap,
        });
        self.cur = Some(nr - 1);
        self.dim = dim;
        self.delta_for_write = 255 - dim as i32 - 1;
        self.data_size = data_type_size(typ);
        for d in 0..dim {
            self.last[d] = INDEX_INITIAL;
            self.min[d] = i32::MAX;
            self.max[d] = 0;
            self.wr_bitmaps[d] = None;
        }
        self.s.set_compression(compressed);
        Ok(())
    }

    /// `InitDoWrite`.
    fn init_do_write(&mut self, nrecs: i32) {
        self.data_count = 0;
        self.s.set_position(self.next_write_position);
        let cur = self.cur.expect("symbol");
        self.symbols[cur].position = self.next_write_position as i64;
        self.s.write_string(MARK_DATA);
        self.s.write_u8(self.dim as u8);
        self.s.write_i32(nrecs);
        for d in 0..self.dim {
            self.last[d] = INDEX_INITIAL;
            let range = self.max[d] as i64 - self.min[d] as i64 + 1;
            self.elem[d] = if range <= 0 {
                2
            } else if range <= 255 {
                0
            } else if range <= 65535 {
                1
            } else {
                2
            };
            self.s.write_i32(self.min[d]);
            self.s.write_i32(self.max[d]);
        }
    }

    /// `gdxDataWriteRawStart`: keys are raw UEL numbers in strictly increasing order.
    pub fn data_write_raw_start(&mut self, name: &str, text: &str, dim: usize, typ: i32, user_info: i32) -> Result<()> {
        self.prepare(name, text, dim, typ, user_info)?;
        self.min[..dim].fill(0);
        self.max[..dim].fill(i32::MAX);
        self.init_do_write(-1);
        self.mode = Mode::DomRaw;
        Ok(())
    }
    /// `gdxDataWriteStrStart`: keys are labels, any order.
    pub fn data_write_str_start(&mut self, name: &str, text: &str, dim: usize, typ: i32, user_info: i32) -> Result<()> {
        self.prepare(name, text, dim, typ, user_info)?;
        self.last_str = vec![None; dim];
        self.mode = Mode::DomStr;
        Ok(())
    }
    /// `gdxDataWriteMapStart`: keys are user UEL numbers (see `uel_register_map`/`_str`).
    pub fn data_write_map_start(&mut self, name: &str, text: &str, dim: usize, typ: i32, user_info: i32) -> Result<()> {
        self.prepare(name, text, dim, typ, user_info)?;
        self.mode = Mode::DomMap;
        Ok(())
    }

    fn pad(vals: &[f64]) -> [f64; VAL_MAX] {
        let mut v = [0.0; VAL_MAX];
        let n = vals.len().min(VAL_MAX);
        v[..n].copy_from_slice(&vals[..n]);
        v
    }

    /// `gdxDataWriteRaw`.
    pub fn data_write_raw(&mut self, keys: &[i32], vals: &[f64]) -> Result<()> {
        if self.mode == Mode::DomRaw {
            self.mode = Mode::Raw;
        }
        self.check_mode(&[Mode::Raw])?;
        if keys.len() < self.dim {
            return Err(GdxError::new(ERR_BADDIMENSION));
        }
        let mut k = [0; MAX_INDEX_DIM];
        k[..self.dim].copy_from_slice(&keys[..self.dim]);
        self.do_write(&k, &Self::pad(vals))
    }

    /// `gdxDataWriteStr`.
    pub fn data_write_str(&mut self, keys: &[&str], vals: &[f64]) -> Result<()> {
        if self.mode == Mode::DomStr {
            self.mode = Mode::Str;
        }
        self.check_mode(&[Mode::Str])?;
        if keys.len() < self.dim {
            return Err(GdxError::new(ERR_BADDIMENSION));
        }
        let mut k = [0; MAX_INDEX_DIM];
        for d in 0..self.dim {
            let sv = trim_right(keys[d].as_bytes());
            let kd = match &self.last_str[d] {
                Some((s, n)) if s.as_slice() == sv => *n,
                _ => {
                    let kd = match self.uel_index.get(&upper_key(sv)) {
                        Some(&n) => n,
                        None => {
                            if !good_uel_string(sv) {
                                return Err(GdxError::with(ERR_BADUELSTR, keys[d]));
                            }
                            self.uel_add(sv)
                        }
                    };
                    self.last_str[d] = Some((sv.to_vec(), kd));
                    self.min[d] = self.min[d].min(kd);
                    self.max[d] = self.max[d].max(kd);
                    kd
                }
            };
            k[d] = kd;
        }
        self.sort.push((k, Self::pad(vals)));
        Ok(())
    }

    /// `gdxDataWriteMap`.
    pub fn data_write_map(&mut self, keys: &[i32], vals: &[f64]) -> Result<()> {
        if self.mode == Mode::DomMap {
            self.mode = Mode::Map;
        }
        self.check_mode(&[Mode::Map])?;
        if keys.len() < self.dim {
            return Err(GdxError::new(ERR_BADDIMENSION));
        }
        let mut k = [0; MAX_INDEX_DIM];
        for d in 0..self.dim {
            let kd = *self.usr2ent.get(&keys[d]).ok_or_else(|| GdxError::new(ERR_BADELEMENTINDEX))?;
            k[d] = kd;
            self.min[d] = self.min[d].min(kd);
            self.max[d] = self.max[d].max(kd);
        }
        self.sort.push((k, Self::pad(vals)));
        Ok(())
    }

    /// `DoWrite`.
    fn do_write(&mut self, e: &[i32; MAX_INDEX_DIM], vals: &[f64; VAL_MAX]) -> Result<()> {
        let dim = self.dim;
        for d in 0..dim {
            if let Some(b) = self.wr_bitmaps[d] {
                let bm = self.symbols[b].bitmap.as_deref().unwrap_or(&[]);
                if !(e[d] >= 0 && bm.get(e[d] as usize).copied().unwrap_or(false)) {
                    self.err_cnt += 1;
                    return Err(GdxError::new(ERR_DOMAINVIOLATION));
                }
            }
        }
        let mut fdim = dim + 1;
        let mut delta = 0i64;
        for d in 0..dim {
            delta = e[d] as i64 - self.last[d] as i64;
            if delta != 0 {
                fdim = d + 1;
                break;
            }
        }
        if fdim > dim {
            if dim > 0 && self.data_count >= 1 {
                self.err_cnt += 1;
                return Err(GdxError::new(ERR_DATADUPLICATE));
            }
            self.s.write_u8(1);
        } else {
            if delta < 0 {
                self.err_cnt += 1;
                return Err(GdxError::new(ERR_RAWNOTSORTED));
            }
            if fdim == dim && delta <= self.delta_for_write as i64 {
                self.s.write_u8((dim as i64 + delta) as u8);
                self.last[dim - 1] = e[dim - 1];
            } else {
                self.s.write_u8(fdim as u8);
                for d in fdim - 1..dim {
                    let v = e[d].wrapping_sub(self.min[d]);
                    match self.elem[d] {
                        0 => self.s.write_u8(v as u8),
                        1 => self.s.write_u16(v as u16),
                        _ => self.s.write_i32(v),
                    }
                    self.last[d] = e[d];
                }
            }
        }
        for &x in vals.iter().take(self.data_size) {
            let bits = x.to_bits();
            let mut xv = (0..VM_NORMAL).find(|&k| self.intl_i64[k as usize] == bits).unwrap_or(VM_NORMAL);
            if xv == VM_NORMAL {
                if x == 0.0 {
                    xv = VM_ZERO; // -0.0
                } else if x.is_nan() {
                    xv = VM_VALNA;
                } else if x == f64::INFINITY {
                    xv = VM_VALPIN;
                } else if x == f64::NEG_INFINITY {
                    xv = VM_VALMIN;
                }
            }
            self.s.write_u8(xv);
            if xv == VM_NORMAL {
                self.s.write_f64(x);
                if x >= SV_ACR {
                    let m = delphi_round(x / SV_ACR);
                    if !self.acronyms.iter().any(|a| a.2 == m) {
                        self.acronyms.push((Vec::new(), Vec::new(), m));
                    }
                }
            }
        }
        self.data_count += 1;
        let cur = self.cur.expect("symbol");
        let sy = &mut self.symbols[cur];
        if sy.typ == DT_SET {
            if vals[0] != 0.0 {
                sy.set_text = true;
            }
            if dim == 1 {
                if let Some(bm) = sy.bitmap.as_mut() {
                    let i = self.last[0].max(0) as usize;
                    if bm.len() <= i {
                        bm.resize(i + 1, false);
                    }
                    bm[i] = true;
                }
            }
        }
        Ok(())
    }

    /// `gdxSymbolSetDomain`: domain of the symbol being written (call right after the
    /// `*_start` call): symbol names (sets or aliases) or `*`.
    pub fn symbol_set_domain(&mut self, ids: &[&str]) -> Result<()> {
        self.check_mode(&[Mode::DomRaw, Mode::DomMap, Mode::DomStr])?;
        let cur = self.cur.ok_or_else(|| GdxError::new(ERR_BADMODE))?;
        let dim = self.symbols[cur].dim;
        if ids.len() < dim {
            return Err(GdxError::new(ERR_BADDIMENSION));
        }
        let mut res = Ok(());
        let mut doms = vec![0i32; dim];
        for d in 0..dim {
            let mut domap = true;
            let mut dom_sy: i32 = if ids[d] == "*" {
                0
            } else {
                match self.symbol_index.get(&upper_key(ids[d].as_bytes())) {
                    Some(&i) => i as i32 + 1,
                    None => {
                        res = Err(GdxError::with(ERR_UNKNOWNDOMAIN, ids[d]));
                        0
                    }
                }
            };
            let mut synr = 0;
            if dom_sy > 0 {
                synr = dom_sy;
                loop {
                    let o = &self.symbols[synr as usize - 1];
                    if !self.allow_bogus_domain && o.dim == 1 && (o.typ == DT_SET || o.typ == DT_ALIAS) {
                        let target = if o.typ == DT_ALIAS && o.user_info > 0 { &self.symbols[o.user_info as usize - 1] } else { o };
                        if target.bitmap.is_none() {
                            self.symbols[cur].dom_symbols = Some(doms);
                            return Err(GdxError::new(ERR_NODOMAINDATA));
                        }
                    }
                    if o.typ == DT_SET {
                        break;
                    }
                    if o.typ == DT_ALIAS {
                        synr = o.user_info;
                        if synr > 0 {
                            continue;
                        }
                        domap = false;
                        break;
                    }
                    res = Err(GdxError::new(ERR_ALIASSETEXPECTED));
                    dom_sy = 0;
                    break;
                }
            }
            doms[d] = dom_sy;
            if domap && dom_sy > 0 && (dim != 1 || cur != dom_sy as usize - 1) {
                let t = synr as usize - 1;
                self.wr_bitmaps[d] = self.symbols[t].bitmap.as_ref().map(|_| t);
            }
        }
        self.symbols[cur].dom_symbols = Some(doms);
        self.mode = match self.mode {
            Mode::DomRaw => Mode::Raw,
            Mode::DomMap => Mode::Map,
            Mode::DomStr => Mode::Str,
            m => m,
        };
        res
    }

    /// `gdxSymbolSetDomainX`: relaxed domain names of symbol `nr` (1-based); empty, `*` or
    /// non-identifiers are stored as `*`.
    pub fn symbol_set_domain_x(&mut self, nr: usize, ids: &[&str]) -> Result<()> {
        if nr < 1 || nr > self.symbols.len() {
            return Err(GdxError::new(ERR_BADSYMBOLINDEX));
        }
        let dim = self.symbols[nr - 1].dim;
        if dim == 0 {
            return Ok(());
        }
        if ids.len() < dim {
            return Err(GdxError::new(ERR_BADDIMENSION));
        }
        let mut ds = self.symbols[nr - 1].dom_strings.take().unwrap_or_else(|| vec![0; dim]);
        for d in 0..dim {
            let s = until_nul(ids[d].as_bytes());
            ds[d] = if s.is_empty() || s == b"*" || !is_good_ident(s) {
                0
            } else {
                let k = upper_key(s);
                match self.domain_str_index.get(&k) {
                    Some(&i) => i,
                    None => {
                        let i = self.domain_strs.push(s) as i32 + 1;
                        self.domain_str_index.insert(k, i);
                        i
                    }
                }
            };
        }
        self.symbols[nr - 1].dom_strings = Some(ds);
        Ok(())
    }

    /// `gdxDataWriteDone`.
    pub fn data_write_done(&mut self) -> Result<()> {
        self.check_mode(&[Mode::Raw, Mode::Map, Mode::Str, Mode::DomRaw, Mode::DomMap, Mode::DomStr])?;
        let mut first_err = None;
        if !matches!(self.mode, Mode::Raw | Mode::DomRaw) {
            let mut recs = std::mem::take(&mut self.sort);
            let dim = self.dim;
            recs.sort_by(|a, b| a.0[..dim].cmp(&b.0[..dim]));
            self.init_do_write(recs.len() as i32);
            for (k, v) in &recs {
                if let Err(e) = self.do_write(k, v) {
                    first_err.get_or_insert(e);
                }
            }
        }
        self.s.write_u8(255);
        self.next_write_position = self.s.position();
        let cur = self.cur.take().expect("symbol");
        self.symbols[cur].data_count = self.data_count;
        self.symbols[cur].errors = self.err_cnt;
        self.err_cnt = 0;
        self.mode = Mode::Init;
        self.s.set_compression(false);
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// `gdxAddSetText`: number of a set element text (identical texts share a number).
    pub fn add_set_text(&mut self, text: &str) -> i32 {
        let mut t = until_nul(text.as_bytes()).to_vec();
        t.truncate(SSSIZE - 1);
        make_good_expl_text(&mut t);
        if let Some(&n) = self.set_text_index.get(t.as_slice()) {
            return n;
        }
        let n = self.set_texts.push(&t) as i32;
        self.set_text_index.insert(t.into_boxed_slice(), n);
        n
    }

    /// `gdxAddAlias`: one of `id1`/`id2` names an existing set (or `*`), the other the alias.
    pub fn add_alias(&mut self, id1: &str, id2: &str) -> Result<()> {
        self.check_mode(&[Mode::Init, Mode::DomRaw, Mode::DomMap, Mode::DomStr, Mode::Raw, Mode::Map, Mode::Str])?;
        let find = |s: &str| -> i64 {
            if s == "*" {
                i32::MAX as i64
            } else {
                self.symbol_index.get(&upper_key(s.as_bytes())).map(|&i| i as i64 + 1).unwrap_or(-1)
            }
        };
        let (n1, n2) = (find(id1), find(id2));
        if (n1 >= 0) == (n2 >= 0) {
            return Err(GdxError::new(ERR_ALIASSETEXPECTED));
        }
        let (mut synr, aname) = if n1 > 0 { (n1, id2) } else { (n2, id1) };
        if synr == i32::MAX as i64 {
            synr = 0;
        } else {
            let t = self.symbols[synr as usize - 1].typ;
            if t != DT_SET && t != DT_ALIAS {
                return Err(GdxError::new(ERR_ALIASSETEXPECTED));
            }
        }
        self.is_good_new_symbol(aname.as_bytes())?;
        let (dim, text) = if synr == 0 {
            (1, b"Aliased with *".to_vec())
        } else {
            let o = &self.symbols[synr as usize - 1];
            let mut t = b"Aliased with ".to_vec();
            t.extend_from_slice(&o.name);
            (o.dim, t)
        };
        self.add_symbol(WSymbol {
            name: aname.as_bytes().to_vec(),
            position: 0,
            dim,
            typ: DT_ALIAS,
            user_info: synr as i32,
            data_count: 0,
            errors: 0,
            set_text: false,
            expl_text: text,
            compressed: false,
            dom_symbols: None,
            dom_strings: None,
            comments: Vec::new(),
            bitmap: None,
        });
        Ok(())
    }

    /// `gdxAcronymAdd`: returns the 1-based acronym number.
    pub fn acronym_add(&mut self, name: &str, text: &str, index: i32) -> Result<usize> {
        for (n, a) in self.acronyms.iter().enumerate() {
            if a.0.eq_ignore_ascii_case(name.as_bytes()) {
                if a.2 != index {
                    return Err(GdxError::new(ERR_ACROBADADDITION));
                }
                return Ok(n);
            }
            if a.2 == index {
                return Err(GdxError::new(ERR_ACROBADADDITION));
            }
        }
        let mut t = until_nul(text.as_bytes()).to_vec();
        make_good_expl_text(&mut t);
        self.acronyms.push((name.as_bytes().to_vec(), t, index));
        Ok(self.acronyms.len())
    }

    /// `gdxSymbolAddComment` (`nr` 0 = the symbol being written); at most 255 bytes kept.
    pub fn symbol_add_comment(&mut self, nr: usize, text: &str) -> Result<()> {
        let i = if nr == 0 { self.cur } else { (nr <= self.symbols.len()).then(|| nr - 1) };
        let i = i.ok_or_else(|| GdxError::new(ERR_NOSYMBOLFORCOMMENT))?;
        let t = until_nul(text.as_bytes());
        self.symbols[i].comments.push(t[..t.len().min(255)].to_vec());
        Ok(())
    }

    /// Number of symbols so far (the next symbol gets `symbol_count() + 1`).
    pub fn symbol_count(&self) -> usize {
        self.symbols.len()
    }

    /// `gdxClose`: finish an open symbol and write the symbol, set text, UEL, acronym and
    /// domain tables and the section index.
    pub fn close(mut self) -> Result<()> {
        self.close_inner()
    }

    fn close_inner(&mut self) -> Result<()> {
        if self.mode == Mode::Closed {
            return Ok(());
        }
        let mut res = Ok(());
        if matches!(self.mode, Mode::Raw | Mode::Map | Mode::Str | Mode::DomRaw | Mode::DomMap | Mode::DomStr) {
            res = self.data_write_done();
        }
        if matches!(self.mode, Mode::RegRaw | Mode::RegStr | Mode::RegMap) {
            self.mode = Mode::Init;
        }
        let co = self.compress_out;
        let s = &mut self.s;
        s.set_compression(co);
        s.set_position(self.next_write_position);
        let symb_pos = self.next_write_position;
        s.write_string(MARK_SYMB);
        s.write_i32(self.symbols.len() as i32);
        for sy in &self.symbols {
            s.write_string(&sy.name);
            s.write_i64(sy.position);
            s.write_i32(sy.dim as i32);
            s.write_u8(sy.typ as u8);
            s.write_i32(sy.user_info);
            s.write_i32(sy.data_count);
            s.write_i32(sy.errors);
            s.write_u8(sy.set_text as u8);
            s.write_string(&sy.expl_text);
            s.write_u8(sy.compressed as u8);
            s.write_u8(sy.dom_symbols.is_some() as u8);
            if let Some(d) = &sy.dom_symbols {
                for &x in d {
                    s.write_i32(x);
                }
            }
            s.write_i32(sy.comments.len() as i32);
            for c in &sy.comments {
                s.write_string(c);
            }
        }
        s.write_string(MARK_SYMB);

        let set_text_pos = s.position();
        s.set_compression(co);
        s.write_string(MARK_SETT);
        s.write_i32(self.set_texts.len() as i32);
        for t in self.set_texts.iter() {
            s.write_string(t);
        }
        s.write_string(MARK_SETT);

        let uel_pos = s.position();
        s.set_compression(co);
        s.write_string(MARK_UEL);
        s.write_i32(self.uels.len() as i32);
        for u in self.uels.iter() {
            s.write_string(u);
        }
        s.write_string(MARK_UEL);

        let acro_pos = s.position();
        s.set_compression(co);
        s.write_string(MARK_ACRO);
        s.write_i32(self.acronyms.len() as i32);
        for (name, text, map) in &self.acronyms {
            if name.is_empty() {
                s.write_string(format!("UnknownACRO{map}").as_bytes());
            } else {
                s.write_string(name);
            }
            s.write_string(text);
            s.write_i32(*map);
        }
        s.write_string(MARK_ACRO);

        let dom_str_pos = s.position();
        s.set_compression(co);
        s.write_string(MARK_DOMS);
        s.write_i32(self.domain_strs.len() as i32);
        for t in self.domain_strs.iter() {
            s.write_string(t);
        }
        s.write_string(MARK_DOMS);
        for (n, sy) in self.symbols.iter().enumerate() {
            if let Some(d) = &sy.dom_strings {
                s.write_i32(n as i32 + 1);
                for &x in d {
                    s.write_i32(x);
                }
            }
        }
        s.write_i32(-1);
        s.write_string(MARK_DOMS);

        s.set_position(self.major_index_position);
        s.set_compression(false);
        s.write_i32(MARK_BOI);
        for off in [symb_pos, uel_pos, set_text_pos, acro_pos, self.next_write_position, dom_str_pos] {
            s.write_i64(off as i64);
        }
        self.mode = Mode::Closed;
        let fin = self.s.finish();
        res.and(fin)
    }
}

impl<W: Write + Seek> Drop for GdxWriter<W> {
    fn drop(&mut self) {
        let _ = self.close_inner();
    }
}
