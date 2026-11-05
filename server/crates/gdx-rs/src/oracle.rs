// SPDX-License-Identifier: GPL-3.0-or-later
//! Reference implementation for tests (feature `capi-oracle`): the official GDX C library of
//! a GAMS installation (`$GAMS_SYSDIR/libgdxcclib64.so`, exported `c__gdx*` functions with
//! the signatures of `$GAMS_SYSDIR/apifiles/C/api/gdxcc.h`), loaded at runtime with
//! `libloading`. Only used to compare `gdx-rs` against the C library and to generate test
//! files with the C writer; not part of the extension.
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::sync::OnceLock;

type H = *mut c_void;

macro_rules! api {
    ($($name:ident : fn($($a:ty),*) -> $r:ty;)*) => {
        #[allow(non_snake_case)]
        struct Api {
            _lib: libloading::Library,
            xcreate: unsafe extern "C" fn(*mut H),
            xfree: unsafe extern "C" fn(*mut H),
            $($name: unsafe extern "C" fn(H $(, $a)*) -> $r,)*
        }
        impl Api {
            unsafe fn load(lib: libloading::Library) -> Result<Api, String> {
                macro_rules! sym { ($s:expr) => { *lib.get($s).map_err(|e| format!("{}: {e}", String::from_utf8_lossy($s)))? } }
                Ok(Api {
                    xcreate: sym!(b"xcreate"),
                    xfree: sym!(b"xfree"),
                    $($name: sym!(concat!("c__", stringify!($name)).to_ascii_lowercase().as_bytes()),)*
                    _lib: lib,
                })
            }
        }
    };
}

api! {
    gdxopenread: fn(*const c_char, *mut c_int) -> c_int;
    gdxopenwriteex: fn(*const c_char, *const c_char, c_int, *mut c_int) -> c_int;
    gdxautoconvert: fn(c_int) -> c_int;
    gdxclose: fn() -> c_int;
    gdxsysteminfo: fn(*mut c_int, *mut c_int) -> c_int;
    gdxfileversion: fn(*mut c_char, *mut c_char) -> c_int;
    gdxfileinfo: fn(*mut c_int, *mut c_int) -> c_int;
    gdxsymbolinfo: fn(c_int, *mut c_char, *mut c_int, *mut c_int) -> c_int;
    gdxsymbolinfox: fn(c_int, *mut c_int, *mut c_int, *mut c_char) -> c_int;
    gdxsymboldim: fn(c_int) -> c_int;
    gdxsymbolgetdomain: fn(c_int, *mut c_int) -> c_int;
    gdxsymbolgetdomainx: fn(c_int, *mut *mut c_char) -> c_int;
    gdxsymbolgetcomment: fn(c_int, c_int, *mut c_char) -> c_int;
    gdxsethastext: fn(c_int) -> c_int;
    gdxfindsymbol: fn(*const c_char, *mut c_int) -> c_int;
    gdxumuelget: fn(c_int, *mut c_char, *mut c_int) -> c_int;
    gdxumfinduel: fn(*const c_char, *mut c_int, *mut c_int) -> c_int;
    gdxumuelinfo: fn(*mut c_int, *mut c_int) -> c_int;
    gdxuelmaxlength: fn() -> c_int;
    gdxsymbmaxlength: fn() -> c_int;
    gdxsymbindxmaxlength: fn(c_int, *mut c_int) -> c_int;
    gdxgetelemtext: fn(c_int, *mut c_char, *mut c_int) -> c_int;
    gdxacronymcount: fn() -> c_int;
    gdxacronymgetinfo: fn(c_int, *mut c_char, *mut c_char, *mut c_int) -> c_int;
    gdxacronymname: fn(f64, *mut c_char) -> c_int;
    gdxgetspecialvalues: fn(*mut f64) -> c_int;
    gdxdatareadrawstart: fn(c_int, *mut c_int) -> c_int;
    gdxdatareadraw: fn(*mut c_int, *mut f64, *mut c_int) -> c_int;
    gdxdatareadstrstart: fn(c_int, *mut c_int) -> c_int;
    gdxdatareadstr: fn(*mut *mut c_char, *mut f64, *mut c_int) -> c_int;
    gdxdatareaddone: fn() -> c_int;
    gdxuelregisterrawstart: fn() -> c_int;
    gdxuelregisterraw: fn(*const c_char) -> c_int;
    gdxuelregisterstrstart: fn() -> c_int;
    gdxuelregisterstr: fn(*const c_char, *mut c_int) -> c_int;
    gdxuelregisterdone: fn() -> c_int;
    gdxdatawriterawstart: fn(*const c_char, *const c_char, c_int, c_int, c_int) -> c_int;
    gdxdatawriteraw: fn(*const c_int, *const f64) -> c_int;
    gdxdatawritestrstart: fn(*const c_char, *const c_char, c_int, c_int, c_int) -> c_int;
    gdxdatawritestr: fn(*const *const c_char, *const f64) -> c_int;
    gdxdatawritedone: fn() -> c_int;
    gdxaddsettext: fn(*const c_char, *mut c_int) -> c_int;
    gdxaddalias: fn(*const c_char, *const c_char) -> c_int;
    gdxsymbolsetdomain: fn(*const *const c_char) -> c_int;
    gdxsymbolsetdomainx: fn(c_int, *const *const c_char) -> c_int;
    gdxacronymadd: fn(*const c_char, *const c_char, c_int) -> c_int;
    gdxsymboladdcomment: fn(c_int, *const c_char) -> c_int;
    gdxgetlasterror: fn() -> c_int;
    gdxerrorstr: fn(c_int, *mut c_char) -> c_int;
}

// SAFETY: the function pointers stay valid while `_lib` lives (static).
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

static API: OnceLock<Result<Api, String>> = OnceLock::new();

fn api(sysdir: &Path) -> Result<&'static Api, String> {
    API.get_or_init(|| {
        let p = sysdir.join(if cfg!(windows) { "gdxcclib64.dll" } else if cfg!(target_vendor = "apple") { "libgdxcclib64.dylib" } else { "libgdxcclib64.so" });
        // SAFETY: loading the GAMS GDX library; signatures follow gdxcc.h.
        unsafe { libloading::Library::new(&p).map_err(|e| format!("{}: {e}", p.display())).and_then(|l| Api::load(l)) }
    })
    .as_ref()
    .map_err(|e| e.clone())
}

fn buf<const N: usize>() -> [u8; N] {
    [0u8; N]
}
fn cstr(b: &[u8]) -> Vec<u8> {
    CStr::from_bytes_until_nul(b).map(|c| c.to_bytes().to_vec()).unwrap_or_default()
}
fn cs(s: &[u8]) -> CString {
    CString::new(s.to_vec()).unwrap_or_default()
}

/// One C GDX object (`gdxCreate` .. `gdxFree`).
pub struct CGdx {
    a: &'static Api,
    h: H,
}

impl Drop for CGdx {
    fn drop(&mut self) {
        unsafe {
            (self.a.gdxclose)(self.h);
            (self.a.xfree)(&mut self.h);
        }
    }
}

pub struct CSymbolInfo {
    pub name: Vec<u8>,
    pub dim: i32,
    pub typ: i32,
    pub rec_cnt: i32,
    pub user_info: i32,
    pub text: Vec<u8>,
    pub domain: Vec<i32>,
    pub domain_x_kind: i32,
    pub domain_x: Vec<Vec<u8>>,
    pub comments: Vec<Vec<u8>>,
    pub has_text: bool,
}

impl CGdx {
    pub fn new(sysdir: &Path) -> Result<CGdx, String> {
        let a = api(sysdir)?;
        let mut h: H = std::ptr::null_mut();
        unsafe { (a.xcreate)(&mut h) };
        if h.is_null() {
            return Err("xcreate failed".into());
        }
        Ok(CGdx { a, h })
    }

    pub fn error_str(&self, n: i32) -> String {
        let mut m = buf::<256>();
        unsafe { (self.a.gdxerrorstr)(self.h, n, m.as_mut_ptr() as *mut c_char) };
        String::from_utf8_lossy(&cstr(&m)).into_owned()
    }
    pub fn last_error(&self) -> i32 {
        unsafe { (self.a.gdxgetlasterror)(self.h) }
    }

    pub fn open_read(sysdir: &Path, path: &Path) -> Result<CGdx, (i32, String)> {
        let g = CGdx::new(sysdir).map_err(|e| (-1, e))?;
        let p = cs(path.to_string_lossy().as_bytes());
        let mut err = 0;
        let ok = unsafe { (g.a.gdxopenread)(g.h, p.as_ptr(), &mut err) };
        if ok == 0 || err != 0 {
            let m = g.error_str(err);
            return Err((err, m));
        }
        Ok(g)
    }

    /// `gdxOpenWriteEx`; auto conversion via gdxcopy is switched off.
    pub fn open_write(sysdir: &Path, path: &Path, producer: &str, compress: bool) -> Result<CGdx, String> {
        let g = CGdx::new(sysdir)?;
        let p = cs(path.to_string_lossy().as_bytes());
        let pr = cs(producer.as_bytes());
        let mut err = 0;
        unsafe {
            (g.a.gdxautoconvert)(g.h, 0);
            if (g.a.gdxopenwriteex)(g.h, p.as_ptr(), pr.as_ptr(), compress as c_int, &mut err) == 0 {
                return Err(format!("open write: {}", g.error_str(err)));
            }
        }
        Ok(g)
    }

    pub fn close(&mut self) -> i32 {
        unsafe { (self.a.gdxclose)(self.h) }
    }

    pub fn system_info(&self) -> (i32, i32) {
        let (mut s, mut u) = (0, 0);
        unsafe { (self.a.gdxsysteminfo)(self.h, &mut s, &mut u) };
        (s, u)
    }
    pub fn file_version(&self) -> (Vec<u8>, Vec<u8>) {
        let (mut a, mut b) = (buf::<256>(), buf::<256>());
        unsafe { (self.a.gdxfileversion)(self.h, a.as_mut_ptr() as *mut c_char, b.as_mut_ptr() as *mut c_char) };
        (cstr(&a), cstr(&b))
    }
    pub fn file_info(&self) -> (i32, i32) {
        let (mut v, mut c) = (0, 0);
        unsafe { (self.a.gdxfileinfo)(self.h, &mut v, &mut c) };
        (v, c)
    }

    pub fn symbol(&self, nr: i32) -> Option<CSymbolInfo> {
        unsafe {
            let a = self.a;
            let mut name = buf::<256>();
            let (mut dim, mut typ) = (0, 0);
            if (a.gdxsymbolinfo)(self.h, nr, name.as_mut_ptr() as *mut c_char, &mut dim, &mut typ) == 0 {
                return None;
            }
            let mut text = buf::<256>();
            let (mut rc, mut ui) = (0, 0);
            (a.gdxsymbolinfox)(self.h, nr, &mut rc, &mut ui, text.as_mut_ptr() as *mut c_char);
            let mut domain = vec![0i32; 20];
            let mut domain_x_kind = 0;
            let mut dx = vec![[0u8; 256]; 20];
            let n = dim.clamp(0, 20) as usize;
            if nr > 0 {
                (a.gdxsymbolgetdomain)(self.h, nr, domain.as_mut_ptr());
                let mut ptrs: Vec<*mut c_char> = dx.iter_mut().map(|b| b.as_mut_ptr() as *mut c_char).collect();
                domain_x_kind = (a.gdxsymbolgetdomainx)(self.h, nr, ptrs.as_mut_ptr());
            }
            let mut comments = Vec::new();
            for k in 1.. {
                let mut c = buf::<256>();
                if (a.gdxsymbolgetcomment)(self.h, nr, k, c.as_mut_ptr() as *mut c_char) == 0 {
                    break;
                }
                comments.push(cstr(&c));
            }
            Some(CSymbolInfo {
                name: cstr(&name),
                dim,
                typ,
                rec_cnt: rc,
                user_info: ui,
                text: cstr(&text),
                domain: domain[..n].to_vec(),
                domain_x_kind,
                domain_x: if nr > 0 { dx[..n].iter().map(|b| cstr(b)).collect() } else { Vec::new() },
                comments,
                has_text: (a.gdxsethastext)(self.h, nr) != 0,
            })
        }
    }

    pub fn symbol_dim(&self, nr: i32) -> i32 {
        unsafe { (self.a.gdxsymboldim)(self.h, nr) }
    }
    pub fn find_symbol(&self, name: &[u8]) -> Option<i32> {
        let n = cs(name);
        let mut nr = 0;
        (unsafe { (self.a.gdxfindsymbol)(self.h, n.as_ptr(), &mut nr) } != 0).then_some(nr)
    }
    /// (ok, label, user map)
    pub fn uel(&self, nr: i32) -> (bool, Vec<u8>, i32) {
        let mut b = buf::<256>();
        let mut m = 0;
        let ok = unsafe { (self.a.gdxumuelget)(self.h, nr, b.as_mut_ptr() as *mut c_char, &mut m) } != 0;
        (ok, cstr(&b), m)
    }
    pub fn find_uel(&self, label: &[u8]) -> Option<i32> {
        let l = cs(label);
        let (mut nr, mut m) = (0, 0);
        (unsafe { (self.a.gdxumfinduel)(self.h, l.as_ptr(), &mut nr, &mut m) } != 0).then_some(nr)
    }
    pub fn uel_info(&self) -> (i32, i32) {
        let (mut c, mut h) = (0, 0);
        unsafe { (self.a.gdxumuelinfo)(self.h, &mut c, &mut h) };
        (c, h)
    }
    pub fn uel_max_length(&self) -> i32 {
        unsafe { (self.a.gdxuelmaxlength)(self.h) }
    }
    pub fn symb_max_length(&self) -> i32 {
        unsafe { (self.a.gdxsymbmaxlength)(self.h) }
    }
    pub fn symb_indx_max_length(&self, nr: i32) -> (i32, Vec<i32>) {
        let mut l = vec![0i32; 20];
        let r = unsafe { (self.a.gdxsymbindxmaxlength)(self.h, nr, l.as_mut_ptr()) };
        (r, l)
    }
    /// (ok, text, node)
    pub fn elem_text(&self, nr: i32) -> (bool, Vec<u8>, i32) {
        let mut b = buf::<256>();
        let mut node = 0;
        let ok = unsafe { (self.a.gdxgetelemtext)(self.h, nr, b.as_mut_ptr() as *mut c_char, &mut node) } != 0;
        (ok, cstr(&b), node)
    }
    pub fn acronym_count(&self) -> i32 {
        unsafe { (self.a.gdxacronymcount)(self.h) }
    }
    pub fn acronym_info(&self, n: i32) -> Option<(Vec<u8>, Vec<u8>, i32)> {
        let (mut a, mut t) = (buf::<256>(), buf::<256>());
        let mut i = 0;
        (unsafe { (self.a.gdxacronymgetinfo)(self.h, n, a.as_mut_ptr() as *mut c_char, t.as_mut_ptr() as *mut c_char, &mut i) } != 0)
            .then(|| (cstr(&a), cstr(&t), i))
    }
    pub fn acronym_name(&self, v: f64) -> Option<Vec<u8>> {
        let mut b = buf::<256>();
        (unsafe { (self.a.gdxacronymname)(self.h, v, b.as_mut_ptr() as *mut c_char) } != 0).then(|| cstr(&b))
    }
    pub fn special_values(&self) -> [f64; 7] {
        let mut v = [0.0; 7];
        unsafe { (self.a.gdxgetspecialvalues)(self.h, v.as_mut_ptr()) };
        v
    }

    /// Raw read of all records: (record count from start, records as (keys, values, dimfrst)).
    /// Values are read into a buffer that is reset to 0 before each record.
    pub fn read_raw(&self, nr: i32, mut f: impl FnMut(&[i32], &[f64; 5], i32)) -> Option<i32> {
        unsafe {
            let mut n = 0;
            if (self.a.gdxdatareadrawstart)(self.h, nr, &mut n) == 0 {
                return None;
            }
            let mut keys = [0i32; 20];
            let mut vals: [f64; 5];
            let mut df = 0;
            let dim = if nr == 0 { 1 } else { self.symbol_dim(nr).clamp(0, 20) as usize };
            // aliases report their own dim, which equals the target's
            while {
                vals = [0.0; 5];
                (self.a.gdxdatareadraw)(self.h, keys.as_mut_ptr(), vals.as_mut_ptr(), &mut df) != 0
            } {
                f(&keys[..dim], &vals, df);
            }
            (self.a.gdxdatareaddone)(self.h);
            Some(n)
        }
    }

    pub fn read_str(&self, nr: i32, mut f: impl FnMut(&[Vec<u8>], &[f64; 5], i32)) -> Option<i32> {
        unsafe {
            let mut n = 0;
            if (self.a.gdxdatareadstrstart)(self.h, nr, &mut n) == 0 {
                return None;
            }
            let mut kb = vec![[0u8; 256]; 20];
            let mut vals: [f64; 5];
            let mut df = 0;
            let dim = if nr == 0 { 1 } else { self.symbol_dim(nr).clamp(0, 20) as usize };
            loop {
                vals = [0.0; 5];
                let mut ptrs: Vec<*mut c_char> = kb.iter_mut().map(|b| b.as_mut_ptr() as *mut c_char).collect();
                if (self.a.gdxdatareadstr)(self.h, ptrs.as_mut_ptr(), vals.as_mut_ptr(), &mut df) == 0 {
                    break;
                }
                let keys: Vec<Vec<u8>> = kb[..dim].iter().map(|b| cstr(b)).collect();
                f(&keys, &vals, df);
            }
            (self.a.gdxdatareaddone)(self.h);
            Some(n)
        }
    }

    // ---------------------------------------------------------------- writing

    fn ok(&self, r: c_int, what: &str) -> Result<(), String> {
        if r != 0 {
            Ok(())
        } else {
            Err(format!("{what}: {}", self.error_str(self.last_error())))
        }
    }
    pub fn register_raw(&mut self, uels: &[&str]) -> Result<(), String> {
        unsafe {
            self.ok((self.a.gdxuelregisterrawstart)(self.h), "UELRegisterRawStart")?;
            for u in uels {
                let c = cs(u.as_bytes());
                self.ok((self.a.gdxuelregisterraw)(self.h, c.as_ptr()), "UELRegisterRaw")?;
            }
            self.ok((self.a.gdxuelregisterdone)(self.h), "UELRegisterDone")
        }
    }
    pub fn register_str(&mut self, uels: &[&str]) -> Result<Vec<i32>, String> {
        unsafe {
            self.ok((self.a.gdxuelregisterstrstart)(self.h), "UELRegisterStrStart")?;
            let mut out = Vec::new();
            for u in uels {
                let c = cs(u.as_bytes());
                let mut n = 0;
                self.ok((self.a.gdxuelregisterstr)(self.h, c.as_ptr(), &mut n), "UELRegisterStr")?;
                out.push(n);
            }
            self.ok((self.a.gdxuelregisterdone)(self.h), "UELRegisterDone")?;
            Ok(out)
        }
    }
    pub fn write_raw_start(&mut self, name: &str, text: &str, dim: i32, typ: i32, ui: i32) -> Result<(), String> {
        let (n, t) = (cs(name.as_bytes()), cs(text.as_bytes()));
        unsafe { self.ok((self.a.gdxdatawriterawstart)(self.h, n.as_ptr(), t.as_ptr(), dim, typ, ui), "DataWriteRawStart") }
    }
    pub fn write_raw(&mut self, keys: &[i32], vals: &[f64; 5]) -> bool {
        let mut k = [0i32; 20];
        k[..keys.len()].copy_from_slice(keys);
        unsafe { (self.a.gdxdatawriteraw)(self.h, k.as_ptr(), vals.as_ptr()) != 0 }
    }
    pub fn write_str_start(&mut self, name: &str, text: &str, dim: i32, typ: i32, ui: i32) -> Result<(), String> {
        let (n, t) = (cs(name.as_bytes()), cs(text.as_bytes()));
        unsafe { self.ok((self.a.gdxdatawritestrstart)(self.h, n.as_ptr(), t.as_ptr(), dim, typ, ui), "DataWriteStrStart") }
    }
    pub fn write_str(&mut self, keys: &[&str], vals: &[f64; 5]) -> bool {
        let cks: Vec<CString> = keys.iter().map(|k| cs(k.as_bytes())).collect();
        let mut ptrs: Vec<*const c_char> = cks.iter().map(|c| c.as_ptr()).collect();
        ptrs.resize(20, c"".as_ptr());
        unsafe { (self.a.gdxdatawritestr)(self.h, ptrs.as_ptr(), vals.as_ptr()) != 0 }
    }
    pub fn write_done(&mut self) -> Result<(), String> {
        unsafe { self.ok((self.a.gdxdatawritedone)(self.h), "DataWriteDone") }
    }
    pub fn add_set_text(&mut self, t: &str) -> i32 {
        let c = cs(t.as_bytes());
        let mut n = 0;
        unsafe { (self.a.gdxaddsettext)(self.h, c.as_ptr(), &mut n) };
        n
    }
    pub fn add_alias(&mut self, a: &str, b: &str) -> Result<(), String> {
        let (x, y) = (cs(a.as_bytes()), cs(b.as_bytes()));
        unsafe { self.ok((self.a.gdxaddalias)(self.h, x.as_ptr(), y.as_ptr()), "AddAlias") }
    }
    pub fn set_domain(&mut self, ids: &[&str]) -> Result<(), String> {
        let c: Vec<CString> = ids.iter().map(|k| cs(k.as_bytes())).collect();
        let p: Vec<*const c_char> = c.iter().map(|c| c.as_ptr()).collect();
        unsafe { self.ok((self.a.gdxsymbolsetdomain)(self.h, p.as_ptr()), "SymbolSetDomain") }
    }
    pub fn set_domain_x(&mut self, nr: i32, ids: &[&str]) -> Result<(), String> {
        let c: Vec<CString> = ids.iter().map(|k| cs(k.as_bytes())).collect();
        let p: Vec<*const c_char> = c.iter().map(|c| c.as_ptr()).collect();
        unsafe { self.ok((self.a.gdxsymbolsetdomainx)(self.h, nr, p.as_ptr()), "SymbolSetDomainX") }
    }
    pub fn acronym_add(&mut self, name: &str, text: &str, idx: i32) -> i32 {
        let (n, t) = (cs(name.as_bytes()), cs(text.as_bytes()));
        unsafe { (self.a.gdxacronymadd)(self.h, n.as_ptr(), t.as_ptr(), idx) }
    }
    pub fn add_comment(&mut self, nr: i32, text: &str) -> Result<(), String> {
        let t = cs(text.as_bytes());
        unsafe { self.ok((self.a.gdxsymboladdcomment)(self.h, nr, t.as_ptr()), "SymbolAddComment") }
    }
}
