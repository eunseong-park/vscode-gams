// SPDX-License-Identifier: GPL-3.0-or-later
//! Minimal GDX writer (extension helper, not from Studio) used to generate small GDX files for
//! tests and fixtures: `gdxOpenWrite` -> `gdxUELRegisterRaw*` -> `gdxDataWriteRaw*`, written
//! by `gdx-rs` (no GAMS installation needed). All labels are registered up front in
//! ascending order, so the records can be written raw.
use crate::{GdxError, Result, SymbolKind};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

/// One symbol to write. `values` holds up to five slots (level, marginal, lower, upper, scale);
/// parameters / sets use slot 0 only (for sets slot 0 is the element-text number, 0 = none).
#[derive(Debug, Clone)]
pub struct WriteSymbol {
    pub name: String,
    pub text: String,
    pub dim: usize,
    pub kind: SymbolKind,
    /// Var type (`GMS_VARTYPE_*`) / equation type (`GMS_EQUTYPE_*`), ignored otherwise.
    pub sub_type: i32,
    pub records: Vec<(Vec<String>, [f64; 5])>,
    /// Relaxed domain names (`gdxSymbolSetDomainX`); empty = universe (`*`) for every dimension.
    pub domain: Vec<String>,
    /// With `domain`: write a real domain (`gdxSymbolSetDomain`: sets that exist in the file, so
    /// the symbol is checked against them) instead of a relaxed one (`gdxSymbolSetDomainX`).
    pub real_domain: bool,
    /// For `SymbolKind::Alias`: the aliased set (or `*` for the universe).
    pub alias_of: String,
    /// Set element texts, one per record (`""` = none); empty = no texts at all.
    pub texts: Vec<String>,
}

impl WriteSymbol {
    pub fn set(name: &str, dim: usize, recs: &[&[&str]]) -> Self {
        WriteSymbol {
            name: name.into(),
            text: String::new(),
            dim,
            kind: SymbolKind::Set,
            sub_type: 0,
            records: recs.iter().map(|k| (k.iter().map(|s| s.to_string()).collect(), [0.0; 5])).collect(),
            domain: Vec::new(), real_domain: false,
            alias_of: String::new(),
            texts: Vec::new(),
        }
    }
    /// `gdxAddAlias`: alias `name` of set `of` (`*`: universe alias).
    /// Set with element texts (`""` = no text).
    pub fn set_with_text(name: &str, dim: usize, recs: &[(&[&str], &str)]) -> Self {
        let mut s = WriteSymbol::set(name, dim, &recs.iter().map(|(k, _)| *k).collect::<Vec<_>>());
        s.texts = recs.iter().map(|(_, t)| t.to_string()).collect();
        s
    }
    pub fn alias(name: &str, of: &str) -> Self {
        WriteSymbol { name: name.into(), text: String::new(), dim: 1, kind: SymbolKind::Alias, sub_type: 0, records: Vec::new(), domain: Vec::new(), real_domain: false, alias_of: of.into(), texts: Vec::new() }
    }
    pub fn parameter(name: &str, dim: usize, recs: &[(&[&str], f64)]) -> Self {
        WriteSymbol {
            name: name.into(),
            text: String::new(),
            dim,
            kind: SymbolKind::Parameter,
            sub_type: 0,
            records: recs.iter().map(|(k, v)| (k.iter().map(|s| s.to_string()).collect(), [*v, 0.0, 0.0, 0.0, 0.0])).collect(),
            domain: Vec::new(), real_domain: false,
            alias_of: String::new(),
            texts: Vec::new(),
        }
    }
    /// Variable (`equation = false`, `sub_type` 5 = free) or equation (`sub_type` 0 = `=e=`).
    pub fn var_or_equ(name: &str, dim: usize, equation: bool, sub_type: i32, recs: &[(&[&str], [f64; 5])]) -> Self {
        WriteSymbol {
            name: name.into(),
            text: String::new(),
            dim,
            kind: if equation { SymbolKind::Equation } else { SymbolKind::Variable },
            sub_type,
            records: recs.iter().map(|(k, v)| (k.iter().map(|s| s.to_string()).collect(), *v)).collect(),
            domain: Vec::new(), real_domain: false,
            alias_of: String::new(),
            texts: Vec::new(),
        }
    }
}

/// Write `symbols` to `path`. `sysdir` is ignored (kept for signature compatibility).
pub fn write_gdx(_sysdir: &Path, path: &Path, symbols: &[WriteSymbol]) -> Result<()> {
    write_file(path, symbols)
}

/// Write `symbols` to `path` (compressed if the `GDXCOMPRESS` environment variable asks for
/// it, like `gdxOpenWrite`). Records are sorted by key labels; duplicate keys are an error.
pub fn write_file(path: &Path, symbols: &[WriteSymbol]) -> Result<()> {
    write_file_with(path, symbols, None, &[])
}

/// Like [`write_file`] with an explicit compression choice (`None`: `GDXCOMPRESS` environment)
/// and acronym table entries `(name, explanatory text, index)`; an acronym value in a record is
/// `index * SV_ACR`.
pub fn write_file_with(path: &Path, symbols: &[WriteSymbol], compress: Option<bool>, acronyms: &[(&str, &str, i32)]) -> Result<()> {
    let e = |e: gdx_rs::GdxError| GdxError(format!("{}: {}", path.display(), e.message));
    let labels: BTreeSet<&str> = symbols.iter().flat_map(|s| s.records.iter().flat_map(|(k, _)| k.iter().map(|x| x.as_str()))).collect();
    let nr: HashMap<&str, i32> = labels.iter().enumerate().map(|(i, l)| (*l, i as i32 + 1)).collect();
    let mut w = match compress {
        Some(c) => gdx_rs::GdxWriter::create(path, "vscode-gams", c),
        None => gdx_rs::GdxWriter::create_env(path, "vscode-gams"),
    }
    .map_err(e)?;
    for (n, t, i) in acronyms {
        w.acronym_add(n, t, *i).map_err(e)?;
    }
    w.uel_register_raw_start().map_err(e)?;
    for l in &labels {
        w.uel_register_raw(l).map_err(e)?;
    }
    w.uel_register_done().map_err(e)?;
    for (si, s) in symbols.iter().enumerate() {
        let typ = match s.kind {
            SymbolKind::Set => gdx_rs::DT_SET,
            SymbolKind::Parameter => gdx_rs::DT_PAR,
            SymbolKind::Variable => gdx_rs::DT_VAR,
            SymbolKind::Equation => gdx_rs::DT_EQU,
            SymbolKind::Alias => {
                w.add_alias(&s.alias_of, &s.name).map_err(e)?;
                continue;
            }
        };
        let user = match s.kind {
            SymbolKind::Variable => s.sub_type,
            SymbolKind::Equation => gdx_rs::EQU_USERINFO_BASE + s.sub_type,
            _ => 0,
        };
        w.data_write_raw_start(&s.name, &s.text, s.dim, typ, user).map_err(e)?;
        if s.real_domain && !s.domain.is_empty() {
            let ids: Vec<&str> = s.domain.iter().map(String::as_str).collect();
            w.symbol_set_domain(&ids).map_err(e)?;
        }
        let mut recs: Vec<(Vec<i32>, [f64; 5])> = Vec::with_capacity(s.records.len());
        for (i, (k, v)) in s.records.iter().enumerate() {
            let mut v = *v;
            if let Some(t) = s.texts.get(i).filter(|t| !t.is_empty()) {
                v[0] = f64::from(w.add_set_text(t));
            }
            recs.push((k.iter().map(|l| nr[l.as_str()]).collect(), v));
        }
        recs.sort_by(|a, b| a.0.cmp(&b.0));
        for (k, v) in &recs {
            w.data_write_raw(k, &v[..]).map_err(|x| GdxError(format!("{}: symbol {} record {:?}: {}", path.display(), s.name, k, x.message)))?;
        }
        w.data_write_done().map_err(e)?;
        if !s.real_domain && !s.domain.is_empty() {
            let ids: Vec<&str> = s.domain.iter().map(String::as_str).collect();
            w.symbol_set_domain_x(si + 1, &ids).map_err(e)?;
        }
    }
    w.close().map_err(e)
}
