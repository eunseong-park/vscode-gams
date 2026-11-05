// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
//! GDX reader: port of the read side of `TGXFileObj` (`src/gxfile.cpp`): `gdxOpenReadXX`,
//! `ReadUELTable`, `ReadSetTextList`, `TAcronymList::LoadFromStream`, the symbol info
//! getters, `PrepareSymbolRead` / `DoRead` / `gdxDataReadRaw` / `gdxDataReadStr`,
//! `GetDefaultRecord`, `AcronymRemap`.
use crate::error::*;
use crate::stream::ReadStream;
use crate::strpool::StrPool;
use crate::*;
use std::cell::OnceCell;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::Path;

/// File format version written by the library (`VERSION`); 5 and 6 are still read.
pub const FILE_VERSION: i32 = 7;
const GDX_HEADER_NR: u8 = 123;
const GDX_HEADER_ID: &[u8] = b"GAMSGDX";
pub(crate) const MARK_BOI: i32 = 19510624;
pub(crate) const MARK_UEL: &[u8] = b"_UEL_";
pub(crate) const MARK_SYMB: &[u8] = b"_SYMB_";
pub(crate) const MARK_DATA: &[u8] = b"_DATA_";
pub(crate) const MARK_SETT: &[u8] = b"_SETT_";
pub(crate) const MARK_ACRO: &[u8] = b"_ACRO_";
pub(crate) const MARK_DOMS: &[u8] = b"_DOMS_";
/// Delta base of the record encoding for files of version <= 6 (`MaxDimV148`).
const MAX_DIM_V148: i32 = 10;

/// One entry of the symbol table (`TgdxSymbRecord`), as stored in the file.
#[derive(Debug, Clone, PartialEq)]
pub struct Symbol {
    pub name: Vec<u8>,
    /// File offset of the symbol's data (`SPosition`).
    pub position: i64,
    pub dim: usize,
    /// `DT_SET` .. `DT_ALIAS`.
    pub typ: i32,
    /// Variable / equation type, alias target symbol number, ... (`SUserInfo`).
    pub user_info: i32,
    /// Number of records written (`SDataCount`).
    pub data_count: i32,
    /// Number of records rejected while writing (`SErrors`, not exposed by the C API).
    pub errors: i32,
    /// Some record has a non-zero element text number (`SSetText`, `gdxSetHasText`).
    pub set_text: bool,
    pub expl_text: Vec<u8>,
    /// The data block is zlib compressed (`SIsCompressed`).
    pub compressed: bool,
    /// Regular domain: symbol numbers per dimension, 0 = universe (`SDomSymbols`).
    pub dom_symbols: Option<Vec<i32>>,
    /// Relaxed domain: 1-based indices into the domain string list, 0 = `*` (`SDomStrings`).
    pub dom_strings: Option<Vec<i32>>,
    /// `gdxSymbolGetComment` lines.
    pub comments: Vec<Vec<u8>>,
}

/// `TAcronym`.
#[derive(Debug, Clone, PartialEq)]
pub struct Acronym {
    pub name: Vec<u8>,
    pub text: Vec<u8>,
    /// Acronym index stored in the file (`AcrMap`).
    pub map: i32,
    /// Index to report when reading (`AcrReadMap`, -1 = unchanged).
    pub read_map: i32,
    pub auto_gen: bool,
}

/// Result of `gdxSymbolGetDomainX`.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainInfo {
    /// 1 = no domain information, 2 = relaxed domain strings, 3 = regular domain symbols
    /// (the C function's return value).
    pub kind: i32,
    /// One id per dimension, `*` where unknown.
    pub ids: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    Init,
    Raw,
    Str,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ElemSize {
    Byte,
    Word,
    Integer,
}

/// `GetIntegerSize`.
fn integer_size(n: i64) -> ElemSize {
    if n <= 0 {
        ElemSize::Integer
    } else if n <= 255 {
        ElemSize::Byte
    } else if n <= 65535 {
        ElemSize::Word
    } else {
        ElemSize::Integer
    }
}

/// State of the active sequential read (`fr_raw_data` / `fr_str_data`).
struct ReadState {
    universe: bool,
    universe_nr: i32,
    /// 0-based index of the (alias-resolved) symbol.
    sym: usize,
    typ: i32,
    user_info: i32,
    dim: usize,
    /// Number of value slots stored per record.
    data_size: usize,
    delta: i32,
    scalar_first: bool,
    min: [i32; MAX_INDEX_DIM],
    elem: [ElemSize; MAX_INDEX_DIM],
    last: [i32; MAX_INDEX_DIM],
}

/// An open GDX file (`gdxOpenRead`). Not `Sync`: reads move a file cursor; use it from one
/// thread at a time.
pub struct GdxReader<R: Read + Seek = File> {
    s: ReadStream<R>,
    version: i32,
    compr_level: i32,
    file_system_id: Vec<u8>,
    producer: Vec<u8>,
    symbols: Vec<Symbol>,
    symbol_index: HashMap<Box<[u8]>, u32>,
    uels: StrPool,
    uel_cnt_orig: usize,
    uel_index: OnceCell<HashMap<Box<[u8]>, u32>>,
    set_texts: StrPool,
    map_set_text: Option<Vec<i32>>,
    acronyms: Vec<Acronym>,
    domain_strs: StrPool,
    /// `intlValueMapDbl` / `readIntlValueMapDbl`.
    intl_vals: [f64; 10],
    read_vals: [f64; 10],
    next_auto_acronym: i32,
    map_acr_to_nan: bool,
    mode: Mode,
    rs: ReadState,
}

impl GdxReader<File> {
    /// `gdxOpenRead`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if path.as_os_str().is_empty() {
            return Err(GdxError::new(ERR_NOFILE));
        }
        let f = File::open(path).map_err(|e| {
            let mut g = GdxError::io(&e);
            if g.code == 2 {
                // gdxErrorStr appends the file name for "No such file or directory"
                g.message = format!("{}: \"{}\"", g.message, path.display());
            }
            g
        })?;
        GdxReader::from_reader(f)
    }
}

fn cap(n: i32) -> usize {
    (n.max(0) as usize).min(1 << 16)
}

impl<R: Read + Seek> GdxReader<R> {
    /// `gdxOpenReadXX` on any seekable byte source (positioned at the start of the file).
    pub fn from_reader(inner: R) -> Result<Self> {
        let mut s = ReadStream::new(inner)?;
        let fail = |c| GdxError::new(c);
        if s.read_u8().map_err(|_| fail(ERR_OPEN_FILEHEADER))? != GDX_HEADER_NR {
            return Err(fail(ERR_OPEN_FILEHEADER));
        }
        let id = s.read_string().map_err(|_| fail(ERR_OPEN_FILEMARKER))?;
        if !id.eq_ignore_ascii_case(GDX_HEADER_ID) {
            return Err(fail(ERR_OPEN_FILEMARKER));
        }
        let version = s.read_i32()?;
        if version > FILE_VERSION {
            return Err(fail(ERR_OPEN_FILEVERSION));
        }
        let compr = if version <= 5 { 0 } else { s.read_i32()? };
        let uncompress = compr > 0;
        let file_system_id = until_nul(&s.read_string()?).to_vec();
        let producer = until_nul(&s.read_string()?).to_vec();
        if s.read_i32().map_err(|_| fail(ERR_OPEN_BOI))? != MARK_BOI {
            return Err(fail(ERR_OPEN_BOI));
        }
        let (symb_pos, uel_pos, set_text_pos, mut acro_pos, mut dom_str_pos);
        if version <= 5 {
            symb_pos = s.read_i32()? as i64;
            uel_pos = s.read_i32()? as i64;
            set_text_pos = s.read_i32()? as i64;
            acro_pos = 0;
            dom_str_pos = 0;
        } else {
            symb_pos = s.read_i64()?;
            uel_pos = s.read_i64()?;
            set_text_pos = s.read_i64()?;
            acro_pos = 0;
            dom_str_pos = 0;
            if version >= 7 {
                acro_pos = s.read_i64()?;
                let _next_write = s.read_i64()?;
                dom_str_pos = s.read_i64()?;
            }
        }
        let seek = |s: &mut ReadStream<R>, p: i64| -> Result<()> {
            if p < 0 {
                return Err(GdxError::corrupt(format!("negative section offset {p}")));
            }
            s.set_position(p as u64)
        };
        let expect = |s: &mut ReadStream<R>, mark: &[u8], code: i32| -> Result<()> {
            match s.read_string() {
                Ok(m) if m == mark => Ok(()),
                _ => Err(GdxError::new(code)),
            }
        };

        // symbol table
        s.set_compression(uncompress);
        seek(&mut s, symb_pos)?;
        expect(&mut s, MARK_SYMB, ERR_OPEN_SYMBOLMARKER1)?;
        let nsym = s.read_i32()?;
        let mut symbols = Vec::with_capacity(cap(nsym));
        for _ in 0..nsym.max(0) {
            let name = until_nul(&s.read_string()?).to_vec();
            let position = if version <= 5 { s.read_i32()? as i64 } else { s.read_i64()? };
            let dim = s.read_i32()?;
            let typ = s.read_u8()? as i32;
            let user_info = s.read_i32()?;
            let data_count = s.read_i32()?;
            let errors = s.read_i32()?;
            let set_text = s.read_u8()? != 0;
            let expl_text = until_nul(&s.read_string()?).to_vec();
            let compressed = version > 5 && s.read_u8()? != 0;
            if !(0..=MAX_INDEX_DIM as i32).contains(&dim) {
                return Err(GdxError::corrupt(format!("symbol {} has dimension {dim}", String::from_utf8_lossy(&name))));
            }
            if !(DT_SET..=DT_ALIAS).contains(&typ) {
                return Err(GdxError::corrupt(format!("symbol {} has type {typ}", String::from_utf8_lossy(&name))));
            }
            let dim = dim as usize;
            let mut dom_symbols = None;
            let mut comments = Vec::new();
            if version >= 7 {
                if s.read_u8()? != 0 {
                    let mut d = Vec::with_capacity(dim);
                    for _ in 0..dim {
                        d.push(s.read_i32()?);
                    }
                    dom_symbols = Some(d);
                }
                let nc = s.read_i32()?;
                for _ in 0..nc.max(0) {
                    comments.push(until_nul(&s.read_string()?).to_vec());
                }
            }
            symbols.push(Symbol {
                name,
                position,
                dim,
                typ,
                user_info,
                data_count,
                errors,
                set_text,
                expl_text,
                compressed,
                dom_symbols,
                dom_strings: None,
                comments,
            });
        }
        expect(&mut s, MARK_SYMB, ERR_OPEN_SYMBOLMARKER2)?;

        // UEL table (ReadUELTable)
        s.set_compression(uncompress);
        seek(&mut s, uel_pos)?;
        expect(&mut s, MARK_UEL, ERR_OPEN_UELMARKER1)?;
        let mut nuel = s.read_i32()?;
        // "bug for pre 2002"
        if file_system_id.get(15..file_system_id.len().min(19)) == Some(b"2001".as_slice()) {
            nuel -= 1;
        }
        let mut uels = StrPool::with_capacity(cap(nuel), cap(nuel) * 8);
        let mut tmp = Vec::with_capacity(256);
        while (uels.len() as i64) < nuel as i64 {
            s.read_string_into(&mut tmp)?;
            uels.push(until_nul(&tmp));
        }
        expect(&mut s, MARK_UEL, ERR_OPEN_UELMARKER2)?;

        // set text list (ReadSetTextList): de-duplicated (case-sensitive) like SetTextList->Add
        s.set_compression(uncompress);
        seek(&mut s, set_text_pos)?;
        expect(&mut s, MARK_SETT, ERR_OPEN_TEXTMARKER1)?;
        let ntext = s.read_i32()?;
        let mut set_texts = StrPool::with_capacity(cap(ntext), cap(ntext) * 8);
        let mut map_set_text: Option<Vec<i32>> = None;
        {
            let mut seen: HashMap<Vec<u8>, i32> = HashMap::with_capacity(cap(ntext));
            for n in 0..ntext.max(0) {
                s.read_string_into(&mut tmp)?;
                let t = until_nul(&tmp);
                let nr = match seen.get(t) {
                    Some(&k) => k,
                    None => {
                        let k = set_texts.push(t) as i32;
                        seen.insert(t.to_vec(), k);
                        k
                    }
                };
                if nr != n {
                    let m = map_set_text.get_or_insert_with(|| (0..n).collect());
                    m.resize(n as usize, 0);
                    m.push(nr);
                } else if let Some(m) = map_set_text.as_mut() {
                    m.push(nr);
                }
            }
        }
        expect(&mut s, MARK_SETT, ERR_OPEN_TEXTMARKER2)?;

        // acronyms
        let mut acronyms = Vec::new();
        if version >= 7 {
            s.set_compression(uncompress);
            seek(&mut s, acro_pos)?;
            expect(&mut s, MARK_ACRO, ERR_OPEN_ACROMARKER1)?;
            let n = s.read_i32()?;
            for _ in 0..n.max(0) {
                let name = until_nul(&s.read_string()?).to_vec();
                let text = until_nul(&s.read_string()?).to_vec();
                let map = s.read_i32()?;
                acronyms.push(Acronym { name, text, map, read_map: -1, auto_gen: false });
            }
            expect(&mut s, MARK_ACRO, ERR_OPEN_ACROMARKER2)?;
        }

        // domain strings
        let mut domain_strs = StrPool::default();
        if version >= 7 && dom_str_pos != 0 {
            s.set_compression(uncompress);
            seek(&mut s, dom_str_pos)?;
            expect(&mut s, MARK_DOMS, ERR_OPEN_DOMSMARKER1)?;
            let n = s.read_i32()?;
            domain_strs = StrPool::with_capacity(cap(n), cap(n) * 8);
            for _ in 0..n.max(0) {
                s.read_string_into(&mut tmp)?;
                domain_strs.push(until_nul(&tmp));
            }
            expect(&mut s, MARK_DOMS, ERR_OPEN_DOMSMARKER2)?;
            loop {
                let nr = s.read_i32()?;
                if nr <= 0 {
                    break;
                }
                let sym = symbols
                    .get_mut(nr as usize - 1)
                    .ok_or_else(|| GdxError::corrupt(format!("domain strings for unknown symbol {nr}")))?;
                let mut d = Vec::with_capacity(sym.dim);
                for _ in 0..sym.dim {
                    d.push(s.read_i32()?);
                }
                sym.dom_strings = Some(d);
            }
            expect(&mut s, MARK_DOMS, ERR_OPEN_DOMSMARKER3)?;
        }
        s.set_compression(false);

        // indices the C library dereferences without checks
        let (ns, nd) = (symbols.len() as i32, domain_strs.len() as i32);
        for sy in &symbols {
            let bad_sym = sy.dom_symbols.iter().flatten().any(|&d| d < 0 || d > ns);
            let bad_str = sy.dom_strings.iter().flatten().any(|&d| d < 0 || d > nd);
            if bad_sym || bad_str {
                return Err(GdxError::corrupt(format!("bad domain reference of symbol {}", String::from_utf8_lossy(&sy.name))));
            }
        }

        let mut symbol_index = HashMap::with_capacity(symbols.len());
        for (i, sy) in symbols.iter().enumerate() {
            symbol_index.insert(upper_key(&sy.name), i as u32);
        }
        let uel_cnt_orig = uels.len();
        Ok(GdxReader {
            s,
            version,
            compr_level: compr,
            file_system_id,
            producer,
            symbols,
            symbol_index,
            uels,
            uel_cnt_orig,
            uel_index: OnceCell::new(),
            set_texts,
            map_set_text,
            acronyms,
            domain_strs,
            intl_vals: DEFAULT_INTL_VALUES,
            read_vals: DEFAULT_INTL_VALUES,
            next_auto_acronym: 0,
            map_acr_to_nan: false,
            mode: Mode::Init,
            rs: ReadState {
                universe: false,
                universe_nr: 0,
                sym: 0,
                typ: DT_SET,
                user_info: 0,
                dim: 0,
                data_size: 0,
                delta: 0,
                scalar_first: false,
                min: [0; MAX_INDEX_DIM],
                elem: [ElemSize::Integer; MAX_INDEX_DIM],
                last: [0; MAX_INDEX_DIM],
            },
        })
    }

    // ------------------------------------------------------------------ file / tables

    /// `gdxFileInfo`: (file version, compression level).
    pub fn file_info(&self) -> (i32, i32) {
        (self.version, self.compr_level)
    }
    /// `gdxFileVersion`: (file system id / writer audit line, producer).
    pub fn file_version(&self) -> (&[u8], &[u8]) {
        (&self.file_system_id, &self.producer)
    }
    /// `gdxSystemInfo`: (symbol count, UEL count).
    pub fn system_info(&self) -> (usize, usize) {
        (self.symbols.len(), self.uels.len())
    }
    /// All symbols (index `i` is symbol number `i + 1`).
    pub fn symbols(&self) -> &[Symbol] {
        &self.symbols
    }
    /// Symbol number `nr` (1-based).
    pub fn symbol(&self, nr: usize) -> Option<&Symbol> {
        nr.checked_sub(1).and_then(|i| self.symbols.get(i))
    }

    /// `gdxFindSymbol`: "*" is 0 (the universe); ASCII case-insensitive.
    pub fn find_symbol(&self, name: &[u8]) -> Option<usize> {
        if name == b"*" {
            return Some(0);
        }
        self.symbol_index.get(&upper_key(until_nul(name))).map(|&i| i as usize + 1)
    }

    /// `gdxSymbolInfo`: (name, dimension, type); symbol 0 is the universe `*`.
    pub fn symbol_info(&self, nr: usize) -> Option<(&[u8], usize, i32)> {
        if nr == 0 {
            return Some((b"*", 1, DT_SET));
        }
        self.symbol(nr).map(|s| (s.name.as_slice(), s.dim, s.typ))
    }

    /// `gdxSymbolInfoX`: (record count, user info, explanatory text). Scalars report 1 record
    /// whether or not one is stored (the library's "scalar trick").
    pub fn symbol_info_x(&self, nr: usize) -> Option<(i32, i32, &[u8])> {
        if nr == 0 {
            return Some((self.uel_cnt_orig as i32, 0, b"Universe"));
        }
        self.symbol(nr).map(|s| (if s.dim == 0 { 1 } else { s.data_count }, s.user_info, s.expl_text.as_slice()))
    }

    /// `gdxSymbolDim` (-1 for an unknown symbol).
    pub fn symbol_dim(&self, nr: usize) -> i32 {
        if nr == 0 {
            return 1;
        }
        self.symbol(nr).map(|s| s.dim as i32).unwrap_or(-1)
    }

    /// `gdxSymbolGetDomain`: domain symbol numbers (0 = universe / none).
    pub fn symbol_get_domain(&self, nr: usize) -> Option<Vec<i32>> {
        let s = self.symbol(nr)?;
        Some(match &s.dom_symbols {
            Some(d) => d.clone(),
            None => vec![0; s.dim],
        })
    }

    /// `gdxSymbolGetDomainX`: relaxed domain strings if stored, else the regular domain
    /// symbols' names, `*` where unknown.
    pub fn symbol_get_domain_x(&self, nr: usize) -> Option<DomainInfo> {
        let s = self.symbol(nr)?;
        let mut ids = vec![b"*".to_vec(); s.dim];
        let kind = if let Some(ds) = &s.dom_strings {
            for (id, &d) in ids.iter_mut().zip(ds) {
                if d != 0 {
                    *id = self.domain_strs.get(d as usize - 1).unwrap_or(b"*").to_vec();
                }
            }
            2
        } else if let Some(ds) = &s.dom_symbols {
            for (id, &d) in ids.iter_mut().zip(ds) {
                if d != 0 {
                    *id = self.symbols[d as usize - 1].name.clone();
                }
            }
            3
        } else {
            1
        };
        Some(DomainInfo { kind, ids })
    }

    /// `gdxSymbolGetComment` (`n` is 1-based).
    pub fn symbol_get_comment(&self, nr: usize, n: usize) -> Option<&[u8]> {
        self.symbol(nr)?.comments.get(n.checked_sub(1)?).map(|c| c.as_slice())
    }

    /// `gdxSetHasText`.
    pub fn set_has_text(&self, nr: usize) -> bool {
        self.symbol(nr).is_some_and(|s| s.set_text)
    }

    /// `gdxSymbMaxLength`: longest symbol name.
    pub fn symb_max_length(&self) -> usize {
        self.symbols.iter().map(|s| s.name.len()).max().unwrap_or(0)
    }

    /// `gdxUMUelGet` (`nr` 1-based); `None` where the library reports `?L__<nr>`. Without
    /// user UEL registration (not supported when reading) the user map is always -1.
    pub fn uel(&self, nr: i32) -> Option<&[u8]> {
        if nr < 1 {
            return None;
        }
        self.uels.get(nr as usize - 1)
    }

    /// Number of UELs (`gdxUMUelInfo` UelCnt; HighMap is 0 without user mapping).
    pub fn uel_count(&self) -> usize {
        self.uels.len()
    }

    /// `gdxUMFindUEL`: 1-based UEL number of a label (trailing blanks ignored, ASCII
    /// case-insensitive, the last duplicate wins).
    pub fn find_uel(&self, label: &[u8]) -> Option<i32> {
        let idx = self.uel_index.get_or_init(|| self.uels.build_index(true));
        idx.get(&upper_key(trim_right(label))).map(|&i| i as i32 + 1)
    }

    /// `gdxUELMaxLength`.
    pub fn uel_max_length(&self) -> usize {
        self.uels.iter().map(|u| u.len()).max().unwrap_or(0)
    }

    /// `gdxGetElemText`: text number `nr` (0 is the empty text); `None` where the library
    /// reports `?Str__<nr>`. The node number is always 0 when reading.
    pub fn elem_text(&self, nr: i32) -> Option<&[u8]> {
        if nr < 0 {
            return None;
        }
        self.set_texts.get(nr as usize)
    }

    /// Number of distinct set element texts (incl. the empty text 0).
    pub fn elem_text_count(&self) -> usize {
        self.set_texts.len()
    }

    /// `gdxAcronymCount`.
    pub fn acronym_count(&self) -> usize {
        self.acronyms.len()
    }
    /// All acronyms in file order (`gdxAcronymGetInfo(N)` is `acronyms()[N-1]`).
    pub fn acronyms(&self) -> &[Acronym] {
        &self.acronyms
    }
    /// `gdxAcronymIndex`.
    pub fn acronym_index(&self, v: f64) -> i32 {
        if v < SV_ACR {
            0
        } else {
            delphi_round(v / SV_ACR)
        }
    }
    /// `gdxAcronymValue`.
    pub fn acronym_value(&self, index: i32) -> f64 {
        if index <= 0 {
            0.0
        } else {
            SV_ACR * index as f64
        }
    }
    /// `gdxAcronymName`: `None` for non-acronym values, `UnknownAcronym<n>` if not stored.
    pub fn acronym_name(&self, v: f64) -> Option<Vec<u8>> {
        let idx = self.acronym_index(v);
        if idx <= 0 {
            return None;
        }
        Some(match self.acronyms.iter().find(|a| a.map == idx) {
            Some(a) => a.name.clone(),
            None => format!("UnknownAcronym{idx}").into_bytes(),
        })
    }
    /// `gdxAcronymNextNr`: returns the previous value; `nv >= 0` sets the next automatic
    /// acronym index used to renumber acronyms while reading (0 = keep file indices).
    pub fn acronym_next_nr(&mut self, nv: i32) -> i32 {
        let r = self.next_auto_acronym;
        if nv >= 0 {
            self.next_auto_acronym = nv;
        }
        r
    }
    /// `gdxMapAcronymsToNaNSet`.
    pub fn set_map_acronyms_to_nan(&mut self, v: bool) {
        self.map_acr_to_nan = v;
    }

    /// `gdxGetSpecialValues`: indexed by `SVIDX_*` (slot `SVIDX_NORMAL` is 0).
    pub fn special_values(&self) -> [f64; 7] {
        let v = &self.intl_vals;
        [v[0], v[1], v[2], v[3], v[4], 0.0, SV_ACR]
    }

    /// `gdxSetReadSpecialValues`: values reported for UNDF, NA, +INF, -INF, EPS when reading.
    pub fn set_read_special_values(&mut self, v: [f64; 5]) {
        self.read_vals[..5].copy_from_slice(&v);
    }

    /// `gdxMapValue`: `SVIDX_*` of a value (bitwise comparison), `SVIDX_NORMAL` otherwise.
    pub fn map_value(&self, d: f64) -> usize {
        (0..5).find(|&k| self.intl_vals[k].to_bits() == d.to_bits()).unwrap_or(SVIDX_NORMAL)
    }

    // ------------------------------------------------------------------ data

    /// Resolve aliases: `None` = universe.
    fn resolve(&self, nr: usize) -> Result<Option<usize>> {
        if nr == 0 {
            return Ok(None);
        }
        if nr > self.symbols.len() {
            return Err(GdxError::new(ERR_BADSYMBOLINDEX));
        }
        let mut i = nr - 1;
        let mut steps = 0;
        while self.symbols[i].typ == DT_ALIAS {
            let t = self.symbols[i].user_info;
            if t == 0 {
                return Ok(None);
            }
            steps += 1;
            if t < 0 || t as usize > self.symbols.len() || steps > self.symbols.len() {
                return Err(GdxError::corrupt(format!("bad alias target {t}")));
            }
            i = t as usize - 1;
        }
        Ok(Some(i))
    }

    /// `PrepareSymbolRead` for unmapped reads; returns the record count.
    fn prepare_read(&mut self, nr: usize, mode: Mode) -> Result<i32> {
        self.mode = Mode::Init;
        let target = self.resolve(nr)?;
        let rs = &mut self.rs;
        let nrecs;
        match target {
            None => {
                rs.universe = true;
                rs.universe_nr = 0;
                rs.dim = 1;
                rs.data_size = 1;
                rs.typ = DT_SET;
                rs.scalar_first = false;
                nrecs = self.uel_cnt_orig as i32;
            }
            Some(i) => {
                let sy = &self.symbols[i];
                rs.universe = false;
                rs.sym = i;
                rs.typ = sy.typ;
                rs.user_info = sy.user_info;
                rs.dim = sy.dim;
                rs.data_size = data_type_size(sy.typ);
                nrecs = sy.data_count;
                if sy.position < 0 {
                    return Err(GdxError::corrupt("negative data offset"));
                }
                self.s.set_compression(sy.compressed);
                self.s.set_position(sy.position as u64)?;
            }
        }
        let dim = rs.dim;
        rs.delta = if self.version <= 6 { MAX_DIM_V148 } else { dim as i32 };
        if !rs.universe {
            match self.s.read_string() {
                Ok(m) if m == MARK_DATA => {}
                _ => return Err(GdxError::new(ERR_BADDATAMARKER_DATA)),
            }
            if self.s.read_u8().map_err(|_| GdxError::new(ERR_BADDATAMARKER_DIM))? as usize != dim {
                return Err(GdxError::new(ERR_BADDATAMARKER_DIM));
            }
            self.s.read_i32()?; // record counter (-1 for raw writes)
        }
        if dim == 0 && nrecs == 0 {
            rs.scalar_first = true;
            self.mode = mode;
            return Ok(1);
        }
        if !rs.universe {
            rs.scalar_first = false;
            for d in 0..dim {
                let mn = self.s.read_i32()?;
                let mx = self.s.read_i32()?;
                rs.min[d] = mn;
                rs.elem[d] = integer_size(mx as i64 - mn as i64 + 1);
            }
        }
        rs.last[..dim].fill(-1);
        self.mode = mode;
        Ok(nrecs)
    }

    /// `gdxDataReadRawStart`: start reading symbol `nr` (0 = universe, aliases resolve to
    /// their set); returns the number of records (1 for scalars).
    pub fn data_read_raw_start(&mut self, nr: usize) -> Result<i32> {
        self.prepare_read(nr, Mode::Raw)
    }

    /// `gdxDataReadStrStart`.
    pub fn data_read_str_start(&mut self, nr: usize) -> Result<i32> {
        self.prepare_read(nr, Mode::Str)
    }

    /// `gdxDataReadDone`.
    pub fn data_read_done(&mut self) {
        self.mode = Mode::Init;
    }

    /// Dimension of the active read (`gdxCurrentDim`).
    pub fn current_dim(&self) -> usize {
        self.rs.dim
    }

    /// `GetDefaultRecord` + `mapDefaultRecordValues`.
    fn default_record(&self, vals: &mut [f64]) {
        let rs = &self.rs;
        let rec: &[f64; 5] = match rs.typ {
            DT_VAR => {
                let ui = rs.user_info;
                &DEF_REC_VAR[if (0..VARTYPE_MAX).contains(&ui) { ui as usize } else { 0 }]
            }
            DT_EQU => {
                let t = rs.user_info - EQU_USERINFO_BASE;
                &DEF_REC_EQU[if (0..EQUTYPE_MAX).contains(&t) { t as usize } else { 0 }]
            }
            _ => {
                vals[0] = 0.0;
                return;
            }
        };
        let specials = [SV_UNDEF, SV_NA, SV_PINF, SV_MINF, SV_EPS];
        for (v, &x) in vals.iter_mut().zip(rec) {
            *v = match specials.iter().position(|&s| s == x) {
                Some(j) => self.read_vals[j],
                None => x,
            };
        }
    }

    /// `AcronymRemap`.
    fn acronym_remap(&mut self, v: f64) -> f64 {
        if v < SV_ACR {
            return v;
        }
        if v.is_nan() {
            return self.intl_vals[VM_VALNA as usize];
        }
        if v.is_infinite() {
            return if v < 0.0 { self.intl_vals[VM_VALMIN as usize] } else { self.intl_vals[VM_VALPIN as usize] };
        }
        if !v.is_normal() || v < 0.0 {
            return if v < 0.0 { v } else { self.intl_vals[VM_VALNA as usize] };
        }
        if self.map_acr_to_nan {
            return self.intl_vals[VM_VALNA as usize];
        }
        let org = delphi_round(v / SV_ACR);
        let new = match self.acronyms.iter().position(|a| a.map == org) {
            None => {
                if self.next_auto_acronym <= 0 {
                    org
                } else {
                    let n = self.next_auto_acronym;
                    self.next_auto_acronym += 1;
                    self.acronyms.push(Acronym { name: Vec::new(), text: Vec::new(), map: org, read_map: n, auto_gen: true });
                    n
                }
            }
            Some(k) => {
                let mut n = self.acronyms[k].read_map;
                if n <= 0 {
                    if self.next_auto_acronym <= 0 {
                        n = org;
                    } else {
                        n = self.next_auto_acronym;
                        self.next_auto_acronym += 1;
                        self.acronyms[k].read_map = n;
                        self.acronyms[k].auto_gen = true;
                    }
                }
                n
            }
        };
        SV_ACR * new as f64
    }

    /// `DoRead`: next record into `rs.last` / `vals`; `Ok(None)` at the end of the data.
    #[inline]
    fn do_read(&mut self, vals: &mut [f64]) -> Result<Option<i32>> {
        if self.rs.universe {
            self.rs.universe_nr += 1;
            if self.rs.universe_nr as usize <= self.uel_cnt_orig {
                self.rs.last[0] = self.rs.universe_nr;
                vals[0] = 0.0;
                return Ok(Some(1));
            }
            return Ok(None);
        }
        if self.rs.scalar_first {
            self.rs.scalar_first = false;
            self.default_record(vals);
            return Ok(Some(0));
        }
        let b = self.s.read_u8()? as i32;
        let dim = self.rs.dim;
        let afdim;
        if b > self.rs.delta {
            if b == 255 {
                return Ok(None);
            }
            afdim = dim as i32;
            if dim > 0 {
                self.rs.last[dim - 1] = self.rs.last[dim - 1].wrapping_add(b - self.rs.delta);
            }
        } else {
            if b < 1 {
                return Err(GdxError::corrupt("bad record key marker"));
            }
            afdim = b;
            for d in (b as usize - 1)..dim {
                let v = match self.rs.elem[d] {
                    ElemSize::Integer => self.s.read_i32()?,
                    ElemSize::Word => self.s.read_u16()? as i32,
                    ElemSize::Byte => self.s.read_u8()? as i32,
                };
                self.rs.last[d] = v.wrapping_add(self.rs.min[d]);
            }
        }
        let n = self.rs.data_size;
        for v in vals.iter_mut().take(n) {
            let sv = self.s.read_u8()?;
            *v = if sv >= VM_COUNT {
                0.0
            } else if sv != VM_NORMAL {
                self.read_vals[sv as usize]
            } else {
                let x = self.s.read_f64()?;
                if x >= SV_ACR {
                    self.acronym_remap(x)
                } else {
                    x
                }
            };
        }
        if n > 0 && self.rs.typ == DT_SET && vals[0] != 0.0 {
            if let Some(m) = &self.map_set_text {
                let x = vals[0];
                let d = delphi_round(x);
                if (x - d as f64).abs() < 1e-12 && d >= 0 && (d as usize) < m.len() {
                    vals[0] = m[d as usize] as f64;
                }
            }
        }
        Ok(Some(afdim))
    }

    fn check_buffers(&self, keys: usize, vals: usize) -> Result<()> {
        let need = if self.rs.scalar_first { VAL_MAX } else { self.rs.data_size.max(1) };
        if keys < self.rs.dim || vals < need {
            return Err(GdxError::with(ERR_BADDIMENSION, "key/value buffer too small"));
        }
        Ok(())
    }

    /// `gdxDataReadRaw`: next record: UEL numbers of the keys into `keys[..dim]`, values into
    /// `vals` (only the slots the symbol type stores are written, other slots are left as
    /// they are, as in C). Returns `Some(DimFrst)` (first changed dimension, 1-based; 0 for
    /// a scalar's default record) or `None` at the end (the read is then finished).
    #[inline]
    pub fn data_read_raw(&mut self, keys: &mut [i32], vals: &mut [f64]) -> Result<Option<i32>> {
        if self.mode != Mode::Raw {
            return Err(GdxError::new(ERR_BADMODE));
        }
        self.check_buffers(keys.len(), vals.len())?;
        match self.do_read(vals) {
            Ok(Some(f)) => {
                let d = self.rs.dim;
                keys[..d].copy_from_slice(&self.rs.last[..d]);
                Ok(Some(f))
            }
            Ok(None) => {
                self.mode = Mode::Init;
                Ok(None)
            }
            Err(e) => {
                self.mode = Mode::Init;
                Err(e)
            }
        }
    }

    /// `gdxDataReadStr`: like [`Self::data_read_raw`] with the labels of the keys
    /// (`?L__<nr>` for numbers outside the UEL table).
    pub fn data_read_str(&mut self, keys: &mut [Vec<u8>], vals: &mut [f64]) -> Result<Option<i32>> {
        if self.mode != Mode::Str {
            return Err(GdxError::new(ERR_BADMODE));
        }
        self.check_buffers(keys.len(), vals.len())?;
        let r = self.do_read(vals);
        match r {
            Ok(Some(f)) => {
                for (k, &u) in keys.iter_mut().zip(&self.rs.last[..self.rs.dim]) {
                    k.clear();
                    match self.uel(u) {
                        Some(s) => k.extend_from_slice(s),
                        None => k.extend_from_slice(format!("?L__{u}").as_bytes()),
                    }
                }
                Ok(Some(f))
            }
            Ok(None) => {
                self.mode = Mode::Init;
                Ok(None)
            }
            Err(e) => {
                self.mode = Mode::Init;
                Err(e)
            }
        }
    }

    /// `gdxSymbIndxMaxLength`: (longest key label over all dimensions, per dimension).
    pub fn symb_indx_max_length(&mut self, nr: usize) -> Result<(usize, Vec<usize>)> {
        self.data_read_raw_start(nr)?;
        let dim = self.rs.dim;
        let mut len = vec![0usize; dim];
        if dim > 0 {
            let mut vals = [0.0; VAL_MAX];
            while let Some(f) = self.do_read(&mut vals)? {
                for (d, l) in len.iter_mut().enumerate().skip((f.max(1) - 1) as usize) {
                    if let Some(s) = self.uel(self.rs.last[d]) {
                        *l = (*l).max(s.len());
                    }
                }
            }
        }
        self.data_read_done();
        Ok((len.iter().copied().max().unwrap_or(0), len))
    }

    /// Read all records of symbol `nr` with a callback (like `gdxDataReadRawFastEx`):
    /// `f(keys, values, dim_frst)`, returning `false` stops. Returns the record count reported
    /// by the start call.
    pub fn read_raw_with(&mut self, nr: usize, mut f: impl FnMut(&[i32], &[f64; VAL_MAX], i32) -> bool) -> Result<i32> {
        let n = self.data_read_raw_start(nr)?;
        let mut keys = [0i32; MAX_INDEX_DIM];
        let mut vals = [0.0f64; VAL_MAX];
        let dim = self.rs.dim;
        while let Some(df) = self.data_read_raw(&mut keys, &mut vals)? {
            if !f(&keys[..dim], &vals, df) {
                self.data_read_done();
                break;
            }
        }
        Ok(n)
    }
}
