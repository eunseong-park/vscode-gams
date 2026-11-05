// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
//! Pure Rust reader and writer for GAMS Data eXchange (GDX) files.
//!
//! Port of the official GDX library <https://github.com/GAMS-dev/gdx> (MIT, copyright GAMS
//! Software GmbH / GAMS Development Corp., see `LICENSE-GDX-MIT`): `src/gxfile.cpp` (file
//! layout, symbol / UEL / set text / acronym / domain tables, record encoding), `src/gdlib/
//! gmsstrm.cpp` (buffered stream, byte-order detection, zlib block compression),
//! `src/gdlib/strhash.hpp` (lookup semantics) and `generated/gclgms.h` (constants).
//!
//! The API mirrors the C API function by function (`gdxSymbolInfo` -> [`GdxReader::symbol_info`],
//! ...) and reports exactly the values the C library reports with its default settings
//! (special values, default records of scalars, acronym mapping, alias resolution, set text
//! de-duplication, record order of `gdxDataReadRaw`). Strings are returned as raw bytes as
//! the file stores them (truncated at the first NUL byte like the C getters).
//!
//! No C code and no `unsafe` (outside the optional `capi-oracle` test binding).
#![deny(unsafe_code)]
// index loops mirror the C++ code they port
#![allow(clippy::needless_range_loop)]

mod error;
mod read;
mod stream;
mod strpool;
mod write;

#[cfg(feature = "capi-oracle")]
#[allow(unsafe_code)]
pub mod oracle;

pub use error::{error_str, GdxError, Result};
pub use read::{Acronym, DomainInfo, GdxReader, Symbol};
pub use write::GdxWriter;

/// `GLOBAL_MAX_INDEX_DIM` / `GMS_MAX_INDEX_DIM` (gclgms.h).
pub const MAX_INDEX_DIM: usize = 20;
/// `GLOBAL_UEL_IDENT_SIZE` (63 characters + NUL).
pub const UEL_IDENT_SIZE: usize = 64;
/// `GMS_SSSIZE` (short string buffer size).
pub const SSSIZE: usize = 256;
/// `GMS_VAL_MAX`: level, marginal, lower, upper, scale.
pub const VAL_MAX: usize = 5;

pub const VAL_LEVEL: usize = 0;
pub const VAL_MARGINAL: usize = 1;
pub const VAL_LOWER: usize = 2;
pub const VAL_UPPER: usize = 3;
pub const VAL_SCALE: usize = 4;

/// Symbol types (`gdxSyType`, `GMS_DT_*`).
pub const DT_SET: i32 = 0;
pub const DT_PAR: i32 = 1;
pub const DT_VAR: i32 = 2;
pub const DT_EQU: i32 = 3;
pub const DT_ALIAS: i32 = 4;

/// GAMS special values (`GMS_SV_*`).
pub const SV_UNDEF: f64 = 1.0e300;
pub const SV_NA: f64 = 2.0e300;
pub const SV_PINF: f64 = 3.0e300;
pub const SV_MINF: f64 = 4.0e300;
pub const SV_EPS: f64 = 5.0e300;
/// Values `>= SV_ACR` are acronyms (`index * SV_ACR`).
pub const SV_ACR: f64 = 10.0e300;

/// Indices into the special value array of [`GdxReader::special_values`] (`gdxSpecValue`).
pub const SVIDX_UNDEF: usize = 0;
pub const SVIDX_NA: usize = 1;
pub const SVIDX_PINF: usize = 2;
pub const SVIDX_MINF: usize = 3;
pub const SVIDX_EPS: usize = 4;
pub const SVIDX_NORMAL: usize = 5;
pub const SVIDX_ACR: usize = 6;

/// Variable types stored in the user info of variables (`GMS_VARTYPE_*`).
pub const VARTYPE_UNKNOWN: i32 = 0;
pub const VARTYPE_BINARY: i32 = 1;
pub const VARTYPE_INTEGER: i32 = 2;
pub const VARTYPE_POSITIVE: i32 = 3;
pub const VARTYPE_NEGATIVE: i32 = 4;
pub const VARTYPE_FREE: i32 = 5;
pub const VARTYPE_SOS1: i32 = 6;
pub const VARTYPE_SOS2: i32 = 7;
pub const VARTYPE_SEMICONT: i32 = 8;
pub const VARTYPE_SEMIINT: i32 = 9;
pub const VARTYPE_MAX: i32 = 10;

/// Equation user info = `EQU_USERINFO_BASE + GMS_EQUTYPE_*` (=e=, =g=, =l=, =n=, =x=, =c=, =b=).
pub const EQU_USERINFO_BASE: i32 = 53;
pub const EQUTYPE_E: i32 = 0;
pub const EQUTYPE_G: i32 = 1;
pub const EQUTYPE_L: i32 = 2;
pub const EQUTYPE_N: i32 = 3;
pub const EQUTYPE_X: i32 = 4;
pub const EQUTYPE_C: i32 = 5;
pub const EQUTYPE_B: i32 = 6;
pub const EQUTYPE_MAX: i32 = 7;

/// `gmsDefRecVar` (gclgms.h): default record per variable type.
pub const DEF_REC_VAR: [[f64; VAL_MAX]; VARTYPE_MAX as usize] = [
    [0.0, 0.0, 0.0, 0.0, 1.0],          // unknown
    [0.0, 0.0, 0.0, 1.0, 1.0],          // binary
    [0.0, 0.0, 0.0, SV_PINF, 1.0],      // integer
    [0.0, 0.0, 0.0, SV_PINF, 1.0],      // positive
    [0.0, 0.0, SV_MINF, 0.0, 1.0],      // negative
    [0.0, 0.0, SV_MINF, SV_PINF, 1.0],  // free
    [0.0, 0.0, 0.0, SV_PINF, 1.0],      // sos1
    [0.0, 0.0, 0.0, SV_PINF, 1.0],      // sos2
    [0.0, 0.0, 1.0, SV_PINF, 1.0],      // semicont
    [0.0, 0.0, 1.0, SV_PINF, 1.0],      // semiint
];

/// `gmsDefRecEqu` (gclgms.h): default record per equation type.
pub const DEF_REC_EQU: [[f64; VAL_MAX]; EQUTYPE_MAX as usize] = [
    [0.0, 0.0, 0.0, 0.0, 1.0],         // =e=
    [0.0, 0.0, 0.0, SV_PINF, 1.0],     // =g=
    [0.0, 0.0, SV_MINF, 0.0, 1.0],     // =l=
    [0.0, 0.0, SV_MINF, SV_PINF, 1.0], // =n=
    [0.0, 0.0, 0.0, 0.0, 1.0],         // =x=
    [0.0, 0.0, 0.0, SV_PINF, 1.0],     // =c=
    [0.0, 0.0, 0.0, 0.0, 1.0],         // =b=
];

/// Number of value slots stored per record for a symbol type (`DataTypSize`).
pub fn data_type_size(typ: i32) -> usize {
    match typ {
        DT_SET | DT_PAR => 1,
        DT_VAR | DT_EQU => 5,
        _ => 0,
    }
}

/// Internal value map of the record encoding (`TgdxIntlValTyp`): the indicator byte
/// written before each value.
pub(crate) const VM_VALNA: u8 = 1;
pub(crate) const VM_VALPIN: u8 = 2;
pub(crate) const VM_VALMIN: u8 = 3;
pub(crate) const VM_ZERO: u8 = 5;
pub(crate) const VM_NORMAL: u8 = 10;
pub(crate) const VM_COUNT: u8 = 11;

/// `gdxResetSpecialValues`: values for the indicator bytes 0..=9.
pub(crate) const DEFAULT_INTL_VALUES: [f64; 10] = [SV_UNDEF, SV_NA, SV_PINF, SV_MINF, SV_EPS, 0.0, 1.0, -1.0, 0.5, 2.0];

/// Delphi `System.Round` as used by the library (`utils::round<int>`): half away from zero,
/// truncated through int64 like the C++ code.
pub(crate) fn delphi_round(n: f64) -> i32 {
    (if n >= 0.0 { n + 0.5 } else { n - 0.5 }) as i64 as i32
}

/// `MakeGoodExplText`: replace control characters by '?'; if both quote kinds occur, replace
/// every quote by the first one seen.
pub(crate) fn make_good_expl_text(s: &mut [u8]) {
    let mut q = 0u8;
    for c in s.iter_mut() {
        if *c != b'"' && *c != b'\'' {
            if *c < b' ' {
                *c = b'?';
            }
        } else {
            if q == 0 {
                q = *c;
            }
            *c = q;
        }
    }
}

/// `IsGoodIdent`: letter followed by letters, digits or '_', shorter than 64.
pub fn is_good_ident(s: &[u8]) -> bool {
    !s.is_empty()
        && s[0].is_ascii_alphabetic()
        && s[1..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
        && s.len() < UEL_IDENT_SIZE
}

/// `GoodUELString`: shorter than 64 and quotable (not both quote kinds, no control chars).
pub fn good_uel_string(s: &[u8]) -> bool {
    if s.len() >= UEL_IDENT_SIZE {
        return false;
    }
    let (mut single, mut double) = (false, false);
    for &c in s {
        if c == b'\'' {
            if double {
                return false;
            }
            single = true;
        } else if c == b'"' {
            if single {
                return false;
            }
            double = true;
        } else if c < b' ' {
            return false;
        }
    }
    true
}

/// `utils::trimRight(const char*)`: drop trailing bytes `<= ' '` (and everything after a NUL).
pub(crate) fn trim_right(s: &[u8]) -> &[u8] {
    let s = until_nul(s);
    let end = s.iter().rposition(|&c| c > b' ').map(|i| i + 1).unwrap_or(0);
    &s[..end]
}

/// The part of `s` before the first NUL (what a C getter returns).
pub(crate) fn until_nul(s: &[u8]) -> &[u8] {
    match s.iter().position(|&c| c == 0) {
        Some(i) => &s[..i],
        None => s,
    }
}

/// ASCII upper-case copy used as case-insensitive key (`strcasecmp` semantics).
pub(crate) fn upper_key(s: &[u8]) -> Box<[u8]> {
    s.iter().map(|c| c.to_ascii_uppercase()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(delphi_round(2.5), 3);
        assert_eq!(delphi_round(-2.5), -3);
        assert_eq!(delphi_round(1.4999), 1);
        let mut t = b"a'b\"c\x01".to_vec();
        make_good_expl_text(&mut t);
        assert_eq!(&t, b"a'b'c?");
        assert!(is_good_ident(b"x_1"));
        assert!(!is_good_ident(b"1x"));
        assert!(!is_good_ident(b""));
        assert!(!is_good_ident(&[b'a'; 64]));
        assert!(good_uel_string(b"new-york"));
        assert!(!good_uel_string(b"a'\""));
        assert_eq!(trim_right(b"ab  \t"), b"ab");
        assert_eq!(trim_right(b"   "), b"");
        assert_eq!(until_nul(b"ab\0cd"), b"ab");
    }
}
