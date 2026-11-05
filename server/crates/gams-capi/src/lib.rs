// SPDX-License-Identifier: GPL-3.0-or-later
//! FFI to the GAMS GDX and OPT C APIs. The shared libraries (`libgdxcclib64.so`,
//! `liboptdclib64.so`, `.dll`, `.dylib`) are loaded at runtime from the user's GAMS system
//! directory with `libloading`; nothing from GAMS is needed at build time. The Rust loader in
//! `loader.rs` reproduces the MIT-licensed C loaders `gdxcc.c`/`optcc.c` from the GAMS
//! installation (`apifiles/C/api`): library names, API version handshake (`XAPIVersion`,
//! `XCheck`) and error messages.
//!
//! The function tables are process-global. [`gdx::create`]/[`gdx::free`] serialise access
//! internally; for `opt` the caller takes [`opt::lock`] around create/use/free. Wrappers that
//! pass a sysdir go through [`sysdir_cstring`], which keeps the historical path length limit
//! (the C loader overflowed a 512-byte buffer) so callers see the same errors as before.
use std::ffi::CString;
use std::path::Path;

mod loader;

pub mod gdx;
pub mod opt;
pub mod optdef;
pub mod optfile;

/// The C loaders (`libloader` in gdxcc.c/optcc.c) copy the sysdir into a `char[512]` with
/// `strncpy` (511 bytes), then unconditionally `strcat` a separator (`strlen(buf)` is the NUL
/// position, so the "already ends with /" test never fires) and `strncat` the library name
/// with a size computed from `strlen`, which underflows when the buffer is full. Sysdirs of
/// 511 bytes or more overflow it; keep a margin (library names are < 32 bytes).
pub const MAX_SYSDIR_LEN: usize = 480;

/// Convert a sysdir to the C string handed to `*CreateD`, rejecting values that are too long
/// for the C loader (see [`MAX_SYSDIR_LEN`]) or contain a NUL byte.
pub fn sysdir_cstring(sysdir: &Path) -> Result<CString, String> {
    let s = sysdir.to_string_lossy();
    if s.len() >= MAX_SYSDIR_LEN {
        return Err(format!(
            "GAMS system directory path is too long ({} bytes, the GAMS API loader supports at most {}): {}",
            s.len(),
            MAX_SYSDIR_LEN - 1,
            s
        ));
    }
    CString::new(s.as_bytes()).map_err(|_| "GAMS system directory path contains a NUL byte".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sysdir_length_limit() {
        assert!(sysdir_cstring(Path::new(&"a".repeat(MAX_SYSDIR_LEN - 1))).is_ok());
        let e = sysdir_cstring(Path::new(&"a".repeat(MAX_SYSDIR_LEN))).unwrap_err();
        assert!(e.contains("too long"), "{e}");
        assert!(sysdir_cstring(Path::new("a\0b")).is_err());
    }

    #[test]
    fn long_sysdir_rejected_by_all_creators() {
        let long = std::path::PathBuf::from("x".repeat(600));
        assert!(gdx::create(&long).unwrap_err().contains("too long"));
        {
            let _g = opt::lock();
            assert!(unsafe { opt::create(&long) }.unwrap_err().contains("too long"));
        }
        assert!(optdef::list_options(&long, "optgams.def").unwrap_err().contains("too long"));
        assert!(optfile::load_definition(&long, "optgams.def").unwrap_err().contains("too long"));
    }
}

#[cfg(test)]
mod loader_tests {
    use super::*;

    #[test]
    fn library_names() {
        let n = loader::library_file_name("gdxcclib");
        if cfg!(windows) {
            assert_eq!(n, "gdxcclib64.dll");
        } else if cfg!(target_vendor = "apple") {
            assert_eq!(n, "libgdxcclib64.dylib");
        } else {
            assert_eq!(n, "libgdxcclib64.so");
        }
    }

    #[test]
    fn empty_sysdir_reports_error_not_panic() {
        let dir = std::env::temp_dir().join(format!("gams-capi-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let e = gdx::create(&dir).unwrap_err();
        assert!(e.starts_with("Could not load GDX library: Could not load shared library "), "{e}");
        assert!(e.contains(&loader::library_file_name("gdxcclib")), "{e}");
        let e = {
            let _g = opt::lock();
            unsafe { opt::create(&dir) }.unwrap_err()
        };
        assert!(e.starts_with("Could not load OPT library: Could not load shared library "), "{e}");
        assert!(e.contains(&loader::library_file_name("optdclib")), "{e}");
        let e = optdef::list_options(&dir, "optgams.def").unwrap_err();
        assert!(e.contains("Could not load OPT library"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Helpers for tests that need a real GAMS installation at runtime.
#[doc(hidden)]
pub mod testing {
    use std::path::PathBuf;

    /// `$GAMS_SYSDIR` if it is set and contains the GDX and OPT libraries.
    /// Otherwise prints a skip note (naming `test`) and returns `None`.
    pub fn sysdir_or_skip(test: &str) -> Option<PathBuf> {
        let Some(dir) = std::env::var_os("GAMS_SYSDIR").map(PathBuf::from) else {
            eprintln!("SKIP {test}: GAMS system directory not found (set GAMS_SYSDIR)");
            return None;
        };
        let ok = ["gdxcclib", "optdclib"].iter().all(|b| dir.join(crate::loader::library_file_name(b)).is_file());
        if !ok {
            eprintln!("SKIP {test}: GAMS libraries not found in {} (set GAMS_SYSDIR)", dir.display());
            return None;
        }
        Some(dir)
    }
}
