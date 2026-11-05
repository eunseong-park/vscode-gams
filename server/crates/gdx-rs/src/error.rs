// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
//! Errors. Codes and texts are those of the GDX library (`ERR_*`, `gdxErrorStr` in
//! `src/gxfile.cpp`); positive codes are operating system error numbers (`SysErrorMessage`).
#[path = "codes.rs"]
pub mod codes;
pub use codes::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GdxError {
    /// Library error code (`ERR_*`, negative) or OS error number (positive).
    pub code: i32,
    /// Human readable text: `gdxErrorStr(code)` plus details where the library has none.
    pub message: String,
}

pub type Result<T> = std::result::Result<T, GdxError>;

impl GdxError {
    pub fn new(code: i32) -> Self {
        GdxError { code, message: error_str(code) }
    }
    pub fn with(code: i32, detail: impl std::fmt::Display) -> Self {
        GdxError { code, message: format!("{}: {detail}", error_str(code)) }
    }
    /// A file that ends early or has an impossible structure.
    pub(crate) fn corrupt(detail: impl std::fmt::Display) -> Self {
        GdxError { code: ERR_BADDATAFORMAT, message: format!("Corrupt GDX file: {detail}") }
    }
    pub(crate) fn io(e: &std::io::Error) -> Self {
        match e.raw_os_error() {
            Some(n) => GdxError { code: n, message: os_message(n) },
            None => GdxError { code: ERR_FILEERROR, message: format!("File I/O error: {e}") },
        }
    }
}

impl std::fmt::Display for GdxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for GdxError {}

fn os_message(n: i32) -> String {
    let s = std::io::Error::from_raw_os_error(n).to_string();
    // "No such file or directory (os error 2)" -> strerror text
    match s.rfind(" (os error ") {
        Some(i) => s[..i].to_string(),
        None => s,
    }
}

/// `gdxErrorStr`: message of a library error code, or the OS message for other numbers.
pub fn error_str(code: i32) -> String {
    match MESSAGES.iter().find(|(c, _)| *c == code) {
        Some((_, m)) => (*m).to_string(),
        None => os_message(code),
    }
}
