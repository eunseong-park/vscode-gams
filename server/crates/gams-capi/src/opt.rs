// SPDX-License-Identifier: GPL-3.0-or-later
//! Raw FFI for optcc.h (OPT API), loaded at runtime with `libloading` from the sysdir given to
//! [`create`] (`loader.rs` mirrors optcc.c: `OPTAPIVERSION` 4, `CXCheck`/`CXAPIVersion`
//! handshake). Like gdx, the `opt*` entries are global function pointers, `None` until
//! [`create`] succeeded, exposed as functions (`opt::optCount()`).
#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, missing_docs)]
use crate::sysdir_cstring;
use std::os::raw::{c_char, c_int};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

#[repr(C)]
pub struct optRec {
    _p: [u8; 0],
}
pub type OptHandle = *mut optRec;

const SPEC: crate::loader::Spec = crate::loader::Spec {
    basename: "optdclib",
    api_version: 4,
    xcreate: "XCreate",
    xcreate_d: None,
    xfree: "XFree",
    xcheck: "CXCheck",
    xapiversion: "CXAPIVersion",
    set_load_path: "CoptSetLoadPath",
};

static LOCK: Mutex<()> = Mutex::new(());

/// Whether the OPT library is currently loaded (`optLibraryLoaded`).
pub fn optLibraryLoaded() -> bool {
    LOADER.loaded()
}

/// Unload the library if no handle is alive (`optLibraryUnload`); false if handles exist.
pub fn optLibraryUnload() -> bool {
    LOADER.unload()
}

/// Take the process-wide opt loader lock. Hold it across [`create`], use and [`free`] of a
/// handle (the lock is not re-entrant).
pub fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// `optCreateD`. Errors with the loader's message, or if `sysdir` is too long.
///
/// # Safety
/// The caller must hold [`lock`].
pub unsafe fn create(sysdir: &Path) -> Result<OptHandle, String> {
    sysdir_cstring(sysdir)?; // length / NUL validation
    let h = LOADER.create(sysdir).map_err(|m| format!("Could not load OPT library: {m}"))?;
    Ok(h as OptHandle)
}

/// `optFree`.
///
/// # Safety
/// The caller must hold [`lock`] (the same guard as for [`create`]); `h` must be live.
pub unsafe fn free(h: &mut OptHandle) {
    LOADER.free(&mut *(h as *mut OptHandle as *mut *mut std::ffi::c_void));
}

crate::loader::api_loader! {
    spec: SPEC;
    optReadDefinition: unsafe extern "C" fn(popt: OptHandle, fn_: *const c_char) -> c_int = [3,11] "C";
    optReadParameterFile: unsafe extern "C" fn(popt: OptHandle, fn_: *const c_char) -> c_int = [3,11] "C";
    optReadFromStr: unsafe extern "C" fn(popt: OptHandle, s: *const c_char) = [0,11] "C";
    optResetAll: unsafe extern "C" fn(popt: OptHandle) = [0] "";
    optSeparator: unsafe extern "C" fn(popt: OptHandle, buf: *mut c_char) -> *mut c_char = [12] "C";
    optStringQuote: unsafe extern "C" fn(popt: OptHandle, buf: *mut c_char) -> *mut c_char = [12] "C";
    optClearMessages: unsafe extern "C" fn(popt: OptHandle) = [0] "";
    optGetMessage: unsafe extern "C" fn(popt: OptHandle, nr_msg: c_int, info: *mut c_char, i_type: *mut c_int) = [0,3,12,4] "C";
    optMessageCount: unsafe extern "C" fn(popt: OptHandle) -> c_int = [3] "";
    optFindStr: unsafe extern "C" fn(popt: OptHandle, aname: *const c_char, anr: *mut c_int, arefnr: *mut c_int) -> c_int = [3,11,4,4] "C";
    optLookUp: unsafe extern "C" fn(popt: OptHandle, aopt: *const c_char) -> c_int = [3,11] "C";
    optGetInfoNr: unsafe extern "C" fn(popt: OptHandle, anr: c_int, adefined: *mut c_int, adefinedr: *mut c_int, arefnr: *mut c_int, adatatype: *mut c_int, aopttype: *mut c_int, asubtype: *mut c_int) -> c_int = [3,3,4,4,4,4,4,4] "";
    optGetValuesNr: unsafe extern "C" fn(popt: OptHandle, anr: c_int, asname: *mut c_char, aival: *mut c_int, adval: *mut f64, asval: *mut c_char) -> c_int = [3,3,12,4,14,12] "C";
    optGetNameNr: unsafe extern "C" fn(popt: OptHandle, anr: c_int, asname: *mut c_char) -> c_int = [3,3,12] "C";
    optGetHelpNr: unsafe extern "C" fn(popt: OptHandle, anr: c_int, asopt: *mut c_char, ashelp: *mut c_char) -> c_int = [3,3,12,12] "C";
    optGetOptHelpNr: unsafe extern "C" fn(popt: OptHandle, anr: c_int, aname: *mut c_char, ahc: *mut c_int, agroup: *mut c_int) -> c_int = [3,3,12,4,4] "C";
    optGetGroupNr: unsafe extern "C" fn(popt: OptHandle, anr: c_int, aname: *mut c_char, agroup: *mut c_int, ahc: *mut c_int, ahelp: *mut c_char) -> c_int = [3,3,12,4,4,12] "C";
    optGetEnumCount: unsafe extern "C" fn(popt: OptHandle, anr: c_int, acount: *mut c_int) -> c_int = [3,3,4] "";
    optGetEnumHelp: unsafe extern "C" fn(popt: OptHandle, anr: c_int, aord: c_int, ahc: *mut c_int, ahelpstr: *mut c_char) -> c_int = [3,3,3,4,12] "C";
    optGetEnumValue: unsafe extern "C" fn(popt: OptHandle, anr: c_int, aord: c_int, avalint: *mut c_int, avalstr: *mut c_char) -> c_int = [3,3,3,4,12] "C";
    optGetEnumStrNr: unsafe extern "C" fn(popt: OptHandle, anr: c_int, asval: *mut c_char, aord: *mut c_int) -> c_int = [3,3,12,4] "C";
    optGetBoundsInt: unsafe extern "C" fn(popt: OptHandle, anr: c_int, ilval: *mut c_int, ihval: *mut c_int, idval: *mut c_int) -> c_int = [3,3,4,4,4] "";
    optGetBoundsDbl: unsafe extern "C" fn(popt: OptHandle, anr: c_int, dlval: *mut f64, dhval: *mut f64, ddval: *mut f64) -> c_int = [3,3,14,14,14] "";
    optGetDefaultStr: unsafe extern "C" fn(popt: OptHandle, anr: c_int, sval: *mut c_char) -> c_int = [3,3,12] "C";
    optGetTypeName: unsafe extern "C" fn(popt: OptHandle, tnr: c_int, stname: *mut c_char) -> c_int = [3,3,12] "C";
    optGetConstName: unsafe extern "C" fn(popt: OptHandle, cgroup: c_int, cindex: c_int, cname: *mut c_char) -> c_int = [3,3,3,12] "C";
    optSynonymCount: unsafe extern "C" fn(popt: OptHandle) -> c_int = [3] "";
    optGetSynonym: unsafe extern "C" fn(popt: OptHandle, nr_syn: c_int, ssyn: *mut c_char, sname: *mut c_char) -> c_int = [3,3,12,12] "C";
    optIsDeprecated: unsafe extern "C" fn(popt: OptHandle, aname: *const c_char) -> c_int = [15,11] "C";
    optCount: unsafe extern "C" fn(popt: OptHandle) -> c_int = [3] "";
    optGroupCount: unsafe extern "C" fn(popt: OptHandle) -> c_int = [3] "";
    optVersion: unsafe extern "C" fn(popt: OptHandle, sversion: *mut c_char) = [0,12] "C";
    optDefinitionFile: unsafe extern "C" fn(popt: OptHandle, sfilename: *mut c_char) = [0,12] "C";
    optEOLChars: unsafe extern "C" fn(popt: OptHandle, eolchars: *mut c_char) -> c_int = [3,12] "C";
    optErrorCount: unsafe extern "C" fn(popt: OptHandle, ierrors: *mut c_int, iwarnings: *mut c_int) = [0,4,4] "";
}

pub const GMS_SSSIZE: usize = 256;

/// `optMsgType` (optcc.h)
pub const OPT_MSG_INPUT_ECHO: c_int = 0;
pub const OPT_MSG_HELP: c_int = 1;
pub const OPT_MSG_DEFINE_ERROR: c_int = 2;
pub const OPT_MSG_VALUE_ERROR: c_int = 3;
pub const OPT_MSG_VALUE_WARNING: c_int = 4;
pub const OPT_MSG_DEPRECATED: c_int = 5;
pub const OPT_MSG_FILE_ENTER: c_int = 6;
pub const OPT_MSG_FILE_LEAVE: c_int = 7;
pub const OPT_MSG_TOO_MANY_MSGS: c_int = 8;
pub const OPT_MSG_USER_ERROR: c_int = 9;

/// `optOptionType` (optcc.h)
pub const OPT_TYPE_INTEGER: i32 = 0;
pub const OPT_TYPE_DOUBLE: i32 = 1;
pub const OPT_TYPE_STRING: i32 = 2;
pub const OPT_TYPE_BOOLEAN: i32 = 3;
pub const OPT_TYPE_ENUM_STR: i32 = 4;
pub const OPT_TYPE_ENUM_INT: i32 = 5;
pub const OPT_TYPE_MULTI_LIST: i32 = 6;
pub const OPT_TYPE_STR_LIST: i32 = 7;
pub const OPT_TYPE_MACRO: i32 = 8;
pub const OPT_TYPE_IMMEDIATE: i32 = 9;
