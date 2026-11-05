// SPDX-License-Identifier: GPL-3.0-or-later
//! Pure-Rust replacement for the MIT-licensed C loaders `gdxcc.c`/`optcc.c` shipped in
//! `$GAMS_SYSDIR/apifiles/C/api`. Behaviour mirrors those files (version 54.6):
//!
//! * library file name = `GMS_DLL_PREFIX + BASENAME + GMS_DLL_SUFFIX + GMS_DLL_EXTENSION`
//!   (`lib`/`""` prefix, `64` suffix on 64-bit targets, `.so`/`.dylib`/`.dll`), joined to the
//!   directory passed at call time; no other search order is used;
//! * the first successful load wins: later creates reuse the loaded library whatever
//!   directory they pass (`isLoaded` in C); a failed load leaves nothing loaded;
//! * load = open library, resolve `XCreate`/`XFree`/`XCheck`/`XAPIVersion` (all mandatory),
//!   call `XAPIVersion(<API version>, buf, &cl)` (0 = incompatible, buf holds the message),
//!   optionally resolve `*SetLoadPath` and call it with the directory, then for each API
//!   function ask `XCheck(name, nargs, signature, buf)` and resolve it; a missing symbol aborts
//!   the load with `Could not load symbol '<sym>': <os error>`;
//! * symbols are tried in lower-case, original and upper-case spelling (in this order);
//! * handles are reference counted: `unload` refuses while objects exist.
//!
//! Differences from the C loaders: the loader only resolves the functions Rust uses (not all
//! ~190), and where `XCheck` says a function is unavailable the entry stays `None` instead of
//! pointing at a C stub that reports an error.
use libloading::Library;
use std::ffi::{c_void, CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::Path;
use std::sync::{Mutex, RwLock};

pub(crate) type XCreateFn = unsafe extern "C" fn(*mut *mut c_void);
pub(crate) type XFreeFn = unsafe extern "C" fn(*mut *mut c_void);
type XApiVersionFn = unsafe extern "C" fn(c_int, *mut c_char, *mut c_int) -> c_int;
type XCheckFn = unsafe extern "C" fn(*const c_char, c_int, *const c_int, *mut c_char) -> c_int;
type SetLoadPathFn = unsafe extern "C" fn(*const c_char);

/// Per-library constants (names are the exported symbols of the GAMS library).
pub(crate) struct Spec {
    pub basename: &'static str,
    pub api_version: c_int,
    pub xcreate: &'static str,
    /// gdxcc.c additionally requires `XCreateD` to exist.
    pub xcreate_d: Option<&'static str>,
    pub xfree: &'static str,
    pub xcheck: &'static str,
    pub xapiversion: &'static str,
    pub set_load_path: &'static str,
}

/// `GMS_DLL_PREFIX GMS_DLL_BASENAME GMS_DLL_SUFFIX GMS_DLL_EXTENSION` of the C loaders.
pub(crate) fn library_file_name(basename: &str) -> String {
    let prefix = if cfg!(windows) { "" } else { "lib" };
    let suffix = if cfg!(target_pointer_width = "64") { "64" } else { "" };
    let ext = if cfg!(windows) {
        ".dll"
    } else if cfg!(target_vendor = "apple") {
        ".dylib"
    } else {
        ".so"
    };
    format!("{prefix}{basename}{suffix}{ext}")
}

/// `loadSym`: try lower-case, original, upper-case; the error is the last attempt's.
fn load_sym<T: Copy>(lib: &Library, sym: &str) -> Result<T, String> {
    let mut err = String::new();
    for name in [sym.to_ascii_lowercase(), sym.to_string(), sym.to_ascii_uppercase()] {
        // SAFETY: the caller picks `T` to match the exported C signature.
        match unsafe { lib.get::<T>(name.as_bytes()) } {
            Ok(s) => return Ok(*s),
            Err(e) => err = e.to_string(),
        }
    }
    Err(format!("Could not load symbol '{sym}': {err}"))
}

/// Wrapper around the library's `XCheck`, handed to the generated table loader.
pub(crate) struct Checker {
    f: XCheckFn,
}

impl Checker {
    /// `XCheck(name, nargs, signature, msg)`: true if the library offers `name` with this
    /// signature (`signature[0]` is the return type code, then one code per argument).
    pub fn available(&self, name: &str, signature: &[c_int]) -> bool {
        let Ok(n) = CString::new(name) else { return false };
        let mut msg = [0 as c_char; 4096];
        // SAFETY: valid C string / int array / writable buffer; signature is const-read by C.
        unsafe { (self.f)(n.as_ptr(), signature.len() as c_int - 1, signature.as_ptr(), msg.as_mut_ptr()) != 0 }
    }

    pub fn sym<T: Copy>(&self, lib: &Library, sym: &str) -> Result<T, String> {
        load_sym(lib, sym)
    }
}

struct Core {
    lib: Option<Library>,
    xcreate: Option<XCreateFn>,
    xfree: Option<XFreeFn>,
    objects: usize,
}

/// One loadable GAMS API library plus its global function table `T`.
pub(crate) struct Loader<T: Copy + 'static> {
    spec: Spec,
    core: Mutex<Core>,
    table: RwLock<T>,
    empty: T,
    fill: fn(&Library, &Checker) -> Result<T, String>,
}

fn cbuf_to_string(buf: &[c_char]) -> String {
    // SAFETY: buffers are zero-initialised and the library writes NUL-terminated strings.
    unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned()
}

impl<T: Copy + 'static> Loader<T> {
    pub const fn new(spec: Spec, empty: T, fill: fn(&Library, &Checker) -> Result<T, String>) -> Self {
        Loader {
            spec,
            core: Mutex::new(Core { lib: None, xcreate: None, xfree: None, objects: 0 }),
            table: RwLock::new(empty),
            empty,
            fill,
        }
    }

    /// Current function table (all `None` while nothing is loaded).
    pub fn table(&self) -> T {
        *self.table.read().unwrap_or_else(|e| e.into_inner())
    }

    /// `XLibraryLoad` + `*SetLoadPath` for a fresh load. Error text as in the C loader.
    fn load(&self, dir: &Path) -> Result<(Library, XCreateFn, XFreeFn, T), String> {
        let spec = &self.spec;
        let path = dir.join(library_file_name(spec.basename));
        let path_str = path.to_string_lossy().into_owned();
        // SAFETY: loading a shared library runs its initialisers; that is the point.
        let lib = unsafe { Library::new(&path) }
            .map_err(|e| format!("Could not load shared library {path_str}: {e}"))?;
        let xcreate: XCreateFn = load_sym(&lib, spec.xcreate)?;
        if let Some(n) = spec.xcreate_d {
            let _: unsafe extern "C" fn(*mut *mut c_void, *const c_char) = load_sym(&lib, n)?;
        }
        let xfree: XFreeFn = load_sym(&lib, spec.xfree)?;
        let xcheck: XCheckFn = load_sym(&lib, spec.xcheck)?;
        let xapi: XApiVersionFn = load_sym(&lib, spec.xapiversion)?;
        let mut buf = [0 as c_char; 4096];
        let mut cl: c_int = 0;
        // SAFETY: matches the exported signature; buf is writable.
        if unsafe { xapi(spec.api_version, buf.as_mut_ptr(), &mut cl) } == 0 {
            let m = cbuf_to_string(&buf);
            return Err(if m.is_empty() {
                format!("{path_str}: incompatible API version (expected {})", spec.api_version)
            } else {
                m
            });
        }
        // Optional; the C loader ignores a missing one.
        let set_path: Option<SetLoadPathFn> = load_sym(&lib, spec.set_load_path).ok();
        let table = (self.fill)(&lib, &Checker { f: xcheck })?;
        if let (Some(f), Ok(d)) = (set_path, CString::new(dir.to_string_lossy().as_bytes())) {
            if !d.as_bytes().is_empty() {
                // SAFETY: valid C string.
                unsafe { f(d.as_ptr()) };
            }
        }
        Ok((lib, xcreate, xfree, table))
    }

    /// `*CreateD`: load the library from `dir` if it is not loaded yet, then `XCreate`.
    pub fn create(&self, dir: &Path) -> Result<*mut c_void, String> {
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        if core.lib.is_none() {
            let (lib, xcreate, xfree, table) = self.load(dir)?;
            core.lib = Some(lib);
            core.xcreate = Some(xcreate);
            core.xfree = Some(xfree);
            *self.table.write().unwrap_or_else(|e| e.into_inner()) = table;
        }
        let mut h: *mut c_void = std::ptr::null_mut();
        // SAFETY: library is loaded and kept alive by `core.lib`.
        unsafe { (core.xcreate.expect("loaded"))(&mut h) };
        if h.is_null() {
            return Err("Error while creating object".to_string());
        }
        core.objects += 1;
        Ok(h)
    }

    /// `*Free`: `XFree` and drop the object count.
    ///
    /// # Safety
    /// `h` must come from [`Loader::create`] and not have been freed.
    pub unsafe fn free(&self, h: &mut *mut c_void) {
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(f) = core.xfree {
            f(h);
            core.objects = core.objects.saturating_sub(1);
        }
    }

    pub fn loaded(&self) -> bool {
        self.core.lock().unwrap_or_else(|e| e.into_inner()).lib.is_some()
    }

    /// `*LibraryUnload`: false while objects exist; otherwise unloads and clears the table.
    pub fn unload(&self) -> bool {
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        if core.objects > 0 {
            return false;
        }
        if core.lib.is_some() {
            *self.table.write().unwrap_or_else(|e| e.into_inner()) = self.empty;
            core.xcreate = None;
            core.xfree = None;
            core.lib = None;
        }
        true
    }
}

/// Define the function table, the `name()` accessors and the static [`Loader`] for one API.
/// Each entry: `name: fn type = [XCheck signature codes] "symbol prefix";` (the codes and
/// prefixes are copied from the `CheckAndLoad(...)` lines of gdxcc.c/optcc.c).
macro_rules! api_loader {
    (spec: $spec:expr; $( $name:ident : $ty:ty = [$($s:expr),+] $prefix:literal; )*) => {
        #[derive(Clone, Copy)]
        struct Table { $( $name: Option<$ty>, )* }
        const EMPTY: Table = Table { $( $name: None, )* };
        static LOADER: $crate::loader::Loader<Table> = $crate::loader::Loader::new($spec, EMPTY, fill_table);

        fn fill_table(lib: &libloading::Library, c: &$crate::loader::Checker) -> Result<Table, String> {
            let mut t = EMPTY;
            $(
                if c.available(stringify!($name), &[$($s),+]) {
                    t.$name = Some(c.sym::<$ty>(lib, concat!($prefix, stringify!($name)))?);
                }
            )*
            Ok(t)
        }

        $(
            #[inline]
            pub fn $name() -> Option<$ty> { LOADER.table().$name }
        )*
    };
}
pub(crate) use api_loader;
