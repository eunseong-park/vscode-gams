// SPDX-License-Identifier: GPL-3.0-or-later
//! Small safe helper on top of the raw `opt` FFI: load an option definition file
//! (e.g. `optgams.def`) and list option names and descriptions.
//! Ported from Studio `src/option/option.cpp` (`Option::readDefinition`): optCreateD,
//! optReadDefinition, then for i in 1..=optCount: optGetHelpNr (name, description),
//! optGetInfoNr, optGetOptHelpNr (group).
use crate::opt::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct OptionInfo {
    pub nr: i32,
    pub name: String,
    pub description: String,
    pub group: i32,
    /// optGetInfoNr data type (opt* dataType codes, e.g. integer/double/string/...)
    pub data_type: i32,
    pub opt_type: i32,
    pub sub_type: i32,
    pub deprecated: bool,
}

fn cstr(buf: &[u8]) -> String {
    CStr::from_bytes_until_nul(buf).map(|c| c.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Load `def_file` (path relative to `sysdir` unless absolute) and list all options.
pub fn list_options(sysdir: &Path, def_file: &str) -> Result<Vec<OptionInfo>, String> {
    let _g = lock();
    let file = sysdir.join(def_file);
    let file = CString::new(file.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    unsafe {
        let mut h = create(sysdir)?;
        let res = (|| {
            let read = optReadDefinition().ok_or("optReadDefinition not loaded")?;
            if read(h, file.as_ptr()) != 0 {
                return Err(format!("optReadDefinition failed for {}", file.to_string_lossy()));
            }
            let count = optCount().ok_or("optCount")?(h);
            let (help, info, ohelp, dep) = (
                optGetHelpNr().ok_or("optGetHelpNr")?,
                optGetInfoNr().ok_or("optGetInfoNr")?,
                optGetOptHelpNr().ok_or("optGetOptHelpNr")?,
                optIsDeprecated().ok_or("optIsDeprecated")?,
            );
            let mut out = Vec::with_capacity(count.max(0) as usize);
            for i in 1..=count {
                let mut name = [0u8; GMS_SSSIZE];
                let mut desc = [0u8; GMS_SSSIZE];
                help(h, i, name.as_mut_ptr() as *mut c_char, desc.as_mut_ptr() as *mut c_char);
                let (mut d, mut dr, mut rn, mut dt, mut ot, mut st) = (0, 0, 0, 0, 0, 0);
                info(h, i, &mut d, &mut dr, &mut rn, &mut dt, &mut ot, &mut st);
                let (mut hc, mut group) = (0, 0);
                let mut n2 = [0u8; GMS_SSSIZE];
                ohelp(h, i, n2.as_mut_ptr() as *mut c_char, &mut hc, &mut group);
                let deprecated = dep(h, name.as_ptr() as *const c_char) != 0;
                out.push(OptionInfo {
                    nr: i,
                    name: cstr(&name),
                    description: cstr(&desc),
                    group,
                    data_type: dt,
                    opt_type: ot,
                    sub_type: st,
                    deprecated,
                });
            }
            Ok(out)
        })();
        free(&mut h);
        res
    }
}
