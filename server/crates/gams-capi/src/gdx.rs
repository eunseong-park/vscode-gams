// SPDX-License-Identifier: GPL-3.0-or-later
//! Raw FFI for gdxcc.h (GDX API), loaded at runtime with `libloading` from the sysdir given to
//! [`create`] (`loader.rs` mirrors gdxcc.c: `GDXAPIVERSION` 11, `C__XCheck`/`C__XAPIVersion`
//! handshake). Signatures are hand-written against gclgms.h/gdxcc.h.
//!
//! Every API function is a global function pointer, `None` until a [`create`] succeeded. They
//! are exposed as functions (`gdx::gdxOpenRead()`) returning the current pointer.
#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, missing_docs)]
use crate::sysdir_cstring;
use std::os::raw::{c_char, c_int};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

#[repr(C)]
pub struct gdxRec {
    _p: [u8; 0],
}
pub type GdxHandle = *mut gdxRec;

const SPEC: crate::loader::Spec = crate::loader::Spec {
    basename: "gdxcclib",
    api_version: 11,
    xcreate: "XCreate",
    xcreate_d: Some("XCreateD"),
    xfree: "XFree",
    xcheck: "C__XCheck",
    xapiversion: "C__XAPIVersion",
    set_load_path: "C__gdxSetLoadPath",
};

/// Take the process-wide gdx loader lock (loading and freeing are serialised by it as well
/// as by the loader's own mutex).
fn guard() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the GDX library is currently loaded (`gdxLibraryLoaded`).
pub fn gdxLibraryLoaded() -> bool {
    LOADER.loaded()
}

/// Unload the library if no handle is alive (`gdxLibraryUnload`); false if handles exist.
pub fn gdxLibraryUnload() -> bool {
    LOADER.unload()
}

static LOCK: Mutex<()> = Mutex::new(());

/// `gdxCreateD` under the loader lock. Errors with the loader's message, or if `sysdir` is
/// too long (see [`crate::MAX_SYSDIR_LEN`]).
pub fn create(sysdir: &Path) -> Result<GdxHandle, String> {
    sysdir_cstring(sysdir)?; // length / NUL validation
    let _g = guard();
    let h = LOADER.create(sysdir).map_err(|m| format!("Could not load GDX library: {m}"))?;
    Ok(h as GdxHandle)
}

/// `gdxFree` under the same lock as [`create`].
///
/// # Safety
/// `h` must be a handle obtained from [`create`] that has not been freed.
pub unsafe fn free(h: &mut GdxHandle) {
    let _g = guard();
    LOADER.free(&mut *(h as *mut GdxHandle as *mut *mut std::ffi::c_void));
}

crate::loader::api_loader! {
    spec: SPEC;
    gdxSystemInfo: unsafe extern "C" fn(pgdx: GdxHandle, sy_cnt: *mut c_int, uel_cnt: *mut c_int) -> c_int = [3,4,4] "C__";
    gdxSymbolInfo: unsafe extern "C" fn(pgdx: GdxHandle, sy_nr: c_int, sy_id: *mut c_char, dimen: *mut c_int, typ: *mut c_int) -> c_int = [3,3,12,4,4] "C__";
    gdxSymbolInfoX: unsafe extern "C" fn(pgdx: GdxHandle, sy_nr: c_int, rec_cnt: *mut c_int, user_info: *mut c_int, expl_txt: *mut c_char) -> c_int = [3,3,4,4,12] "C__";
    gdxSymbolDim: unsafe extern "C" fn(pgdx: GdxHandle, sy_nr: c_int) -> c_int = [3,3] "C__";
    gdxSymbolGetDomain: unsafe extern "C" fn(pgdx: GdxHandle, sy_nr: c_int, domain_sy_nrs: *mut c_int) -> c_int = [3,3,52] "C__";
    gdxSymbolGetDomainX: unsafe extern "C" fn(pgdx: GdxHandle, sy_nr: c_int, domain_ids: *mut *mut c_char) -> c_int = [3,3,56] "C__";
    gdxSymbolGetComment: unsafe extern "C" fn(pgdx: GdxHandle, sy_nr: c_int, n: c_int, txt: *mut c_char) -> c_int = [3,3,3,12] "C__";
    gdxSetHasText: unsafe extern "C" fn(pgdx: GdxHandle, sy_nr: c_int) -> c_int = [3,3] "C__";
    gdxFindSymbol: unsafe extern "C" fn(pgdx: GdxHandle, sy_id: *const c_char, sy_nr: *mut c_int) -> c_int = [3,11,4] "C__";
    gdxOpenRead: unsafe extern "C" fn(pgdx: GdxHandle, file_name: *const c_char, err_nr: *mut c_int) -> c_int = [3,11,4] "C__";
    gdxClose: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
    gdxErrorStr: unsafe extern "C" fn(pgdx: GdxHandle, err_nr: c_int, err_msg: *mut c_char) -> c_int = [3,3,12] "C__";
    gdxGetLastError: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
    gdxErrorCount: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
    gdxDataErrorCount: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
    gdxDataErrorRecord: unsafe extern "C" fn(pgdx: GdxHandle, rec_nr: c_int, key_int: *mut c_int, values: *mut f64) -> c_int = [3,3,52,54] "C__";
    gdxDataReadRawStart: unsafe extern "C" fn(pgdx: GdxHandle, sy_nr: c_int, nr_recs: *mut c_int) -> c_int = [3,3,4] "C__";
    gdxDataReadRaw: unsafe extern "C" fn(pgdx: GdxHandle, key_int: *mut c_int, values: *mut f64, dim_frst: *mut c_int) -> c_int = [3,52,54,4] "C__";
    gdxDataReadStrStart: unsafe extern "C" fn(pgdx: GdxHandle, sy_nr: c_int, nr_recs: *mut c_int) -> c_int = [3,3,4] "C__";
    gdxDataReadStr: unsafe extern "C" fn(pgdx: GdxHandle, key_str: *mut *mut c_char, values: *mut f64, dim_frst: *mut c_int) -> c_int = [3,56,54,4] "C__";
    gdxDataReadDone: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
    gdxGetElemText: unsafe extern "C" fn(pgdx: GdxHandle, txt_nr: c_int, txt: *mut c_char, node: *mut c_int) -> c_int = [3,3,12,4] "C__";
    gdxGetUEL: unsafe extern "C" fn(pgdx: GdxHandle, uel_nr: c_int, uel: *mut c_char) -> c_int = [3,3,12] "C__";
    gdxUMUelGet: unsafe extern "C" fn(pgdx: GdxHandle, uel_nr: c_int, uel: *mut c_char, uel_map: *mut c_int) -> c_int = [3,3,12,4] "C__";
    gdxUMFindUEL: unsafe extern "C" fn(pgdx: GdxHandle, uel: *const c_char, uel_nr: *mut c_int, uel_map: *mut c_int) -> c_int = [3,11,4,4] "C__";
    gdxUMUelInfo: unsafe extern "C" fn(pgdx: GdxHandle, uel_cnt: *mut c_int, high_map: *mut c_int) -> c_int = [3,4,4] "C__";
    gdxUELMaxLength: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
    gdxGetSpecialValues: unsafe extern "C" fn(pgdx: GdxHandle, avals: *mut f64) -> c_int = [3,58] "C__";
    gdxMapValue: unsafe extern "C" fn(pgdx: GdxHandle, d: f64, sv: *mut c_int) -> c_int = [3,13,4] "C__";
    gdxAcronymCount: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
    gdxAcronymName: unsafe extern "C" fn(pgdx: GdxHandle, v: f64, aname: *mut c_char) -> c_int = [3,13,12] "C__";
    gdxGetDLLVersion: unsafe extern "C" fn(pgdx: GdxHandle, v: *mut c_char) -> c_int = [3,12] "C__";
    gdxFileVersion: unsafe extern "C" fn(pgdx: GdxHandle, file_str: *mut c_char, produce_str: *mut c_char) -> c_int = [3,12,12] "C__";
    gdxFileInfo: unsafe extern "C" fn(pgdx: GdxHandle, file_ver: *mut c_int, compr_lev: *mut c_int) -> c_int = [3,4,4] "C__";
    gdxOpenWrite: unsafe extern "C" fn(pgdx: GdxHandle, file_name: *const c_char, producer: *const c_char, err_nr: *mut c_int) -> c_int = [3,11,11,4] "C__";
    gdxUELRegisterRawStart: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
    gdxUELRegisterRaw: unsafe extern "C" fn(pgdx: GdxHandle, uel: *const c_char) -> c_int = [3,11] "C__";
    gdxUELRegisterDone: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
    gdxDataWriteRawStart: unsafe extern "C" fn(pgdx: GdxHandle, sy_id: *const c_char, expl_txt: *const c_char, dimen: c_int, typ: c_int, user_info: c_int) -> c_int = [3,11,11,3,3,3] "C__";
    gdxDataWriteRaw: unsafe extern "C" fn(pgdx: GdxHandle, key_int: *const c_int, values: *const f64) -> c_int = [3,51,53] "C__";
    gdxDataWriteDone: unsafe extern "C" fn(pgdx: GdxHandle) -> c_int = [3] "C__";
}

// Constants from gclgms.h
pub const GMS_MAX_INDEX_DIM: usize = 20;
pub const GMS_SSSIZE: usize = 256;
pub const GMS_UEL_IDENT_SIZE: usize = 64;
pub const GMS_VAL_MAX: usize = 5;
pub const GMS_DT_SET: c_int = 0;
pub const GMS_DT_PAR: c_int = 1;
pub const GMS_DT_VAR: c_int = 2;
pub const GMS_DT_EQU: c_int = 3;
pub const GMS_DT_ALIAS: c_int = 4;
pub const GMS_SV_UNDEF: f64 = 1.0e300;
pub const GMS_SV_NA: f64 = 2.0e300;
pub const GMS_SV_PINF: f64 = 3.0e300;
pub const GMS_SV_MINF: f64 = 4.0e300;
pub const GMS_SV_EPS: f64 = 5.0e300;
pub const GMS_SV_ACR: f64 = 10.0e300;
pub const GMS_EQU_USERINFO_BASE: c_int = 53;
