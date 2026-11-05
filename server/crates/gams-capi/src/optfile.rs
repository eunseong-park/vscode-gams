// SPDX-License-Identifier: GPL-3.0-or-later
//! Full option-definition loading and option-line checking on top of the `opt` FFI.
//!
//! Port of Studio `src/option/option.cpp` (`Option::readDefinitionFile`: synonyms, groups,
//! EOL chars, separator, per-option bounds/defaults/enum values) and of the message mapping in
//! `src/option/optiontokenizer.cpp` (`logAndClearMessage`): each line of a solver option file is
//! fed to `optReadFromStr` and the library messages (`optGetMessage`) are returned.
use crate::opt::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct EnumValue {
    pub value: String,
    pub description: String,
    /// `helpContext == 0` in the definition
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OptEntry {
    pub nr: i32,
    pub name: String,
    pub description: String,
    pub group: i32,
    pub data_type: i32,
    pub opt_type: i32,
    pub sub_type: i32,
    pub type_name: String,
    pub deprecated: bool,
    /// `helpContext == 0`: hidden in Studio's UI but still parseable
    pub hidden: bool,
    /// non-deprecated synonyms
    pub synonyms: Vec<String>,
    pub default: String,
    pub lower: Option<String>,
    pub upper: Option<String>,
    pub enums: Vec<EnumValue>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Synonym {
    pub synonym: String,
    pub option: String,
    pub deprecated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub nr: i32,
    pub name: String,
    pub description: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct OptDefinition {
    pub file: String,
    pub options: Vec<OptEntry>,
    pub synonyms: Vec<Synonym>,
    pub groups: Vec<Group>,
    pub eol_chars: String,
    pub separator: String,
    pub string_quote: String,
}

impl OptDefinition {
    /// Case-insensitive option lookup by name or (non-deprecated or deprecated) synonym.
    pub fn find(&self, key: &str) -> Option<&OptEntry> {
        if let Some(o) = self.options.iter().find(|o| o.name.eq_ignore_ascii_case(key)) {
            return Some(o);
        }
        let s = self.synonyms.iter().find(|s| s.synonym.eq_ignore_ascii_case(key))?;
        self.options.iter().find(|o| o.name.eq_ignore_ascii_case(&s.option))
    }
}

/// A message produced by the opt library for one input line.
#[derive(Debug, Clone, PartialEq)]
pub struct OptMessage {
    /// `optMsgType`
    pub kind: i32,
    pub text: String,
}

fn cstr(buf: &[u8]) -> String {
    CStr::from_bytes_until_nul(buf).map(|c| c.to_string_lossy().into_owned()).unwrap_or_default()
}

fn fmt_int(v: i32) -> String {
    match v {
        i32::MAX => "maxint".into(),
        i32::MIN => "minint".into(),
        v => v.to_string(),
    }
}

fn fmt_dbl(v: f64) -> String {
    if v >= 1e299 {
        "maxdouble".into()
    } else if v <= -1e299 {
        "mindouble".into()
    } else {
        format!("{v}")
    }
}

struct Handle(OptHandle);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            // Handles are always dropped while the caller still holds `lock()`.
            free(&mut self.0);
        }
    }
}

/// `optCreateD` + `optReadDefinition(sysdir/def_file)`. Caller must hold `lock()`.
unsafe fn open(sysdir: &Path, def_file: &str) -> Result<Handle, String> {
    let file = CString::new(sysdir.join(def_file).to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    let h = Handle(create(sysdir)?);
    let read = optReadDefinition().ok_or("optReadDefinition not loaded")?;
    // returns 0 on success (Studio: `if (!optReadDefinition(...))`)
    if read(h.0, file.as_ptr()) != 0 {
        return Err(format!("optReadDefinition failed for {}", file.to_string_lossy()));
    }
    Ok(h)
}

/// Load a definition file completely (names, synonyms, groups, bounds, defaults, enum values).
pub fn load_definition(sysdir: &Path, def_file: &str) -> Result<OptDefinition, String> {
    let _g = lock();
    unsafe {
        let h = open(sysdir, def_file)?;
        let p = h.0;
        macro_rules! f {
            ($n:ident) => {
                $n().ok_or(concat!(stringify!($n), " not loaded"))?
            };
        }
        let mut def = OptDefinition { file: def_file.to_string(), ..Default::default() };
        let (is_dep, syn_count, get_syn) = (f!(optIsDeprecated), f!(optSynonymCount), f!(optGetSynonym));
        for i in 1..=syn_count(p) {
            let (mut syn, mut name) = ([0u8; GMS_SSSIZE], [0u8; GMS_SSSIZE]);
            get_syn(p, i, syn.as_mut_ptr() as *mut c_char, name.as_mut_ptr() as *mut c_char);
            def.synonyms.push(Synonym {
                deprecated: is_dep(p, syn.as_ptr() as *const c_char) != 0,
                synonym: cstr(&syn),
                option: cstr(&name),
            });
        }
        let get_group = f!(optGetGroupNr);
        for i in 1..=f!(optGroupCount)(p) {
            let (mut name, mut help) = ([0u8; GMS_SSSIZE], [0u8; GMS_SSSIZE]);
            let (mut group, mut hc) = (0, 0);
            get_group(p, i, name.as_mut_ptr() as *mut c_char, &mut group, &mut hc, help.as_mut_ptr() as *mut c_char);
            def.groups.push(Group { nr: i, name: cstr(&name), description: cstr(&help), hidden: hc == 0 });
        }
        let mut buf = [0u8; GMS_SSSIZE];
        if f!(optEOLChars)(p, buf.as_mut_ptr() as *mut c_char) > 0 {
            def.eol_chars = cstr(&buf);
        }
        let mut buf = [0u8; GMS_SSSIZE];
        let r = f!(optSeparator)(p, buf.as_mut_ptr() as *mut c_char);
        def.separator = if !r.is_null() && buf[0] != 0 { cstr(&buf) } else { " ".into() };
        let mut buf = [0u8; GMS_SSSIZE];
        let r = f!(optStringQuote)(p, buf.as_mut_ptr() as *mut c_char);
        def.string_quote = if !r.is_null() && buf[0] != 0 { cstr(&buf) } else { String::new() };

        let (help, info, ohelp, values) = (f!(optGetHelpNr), f!(optGetInfoNr), f!(optGetOptHelpNr), f!(optGetValuesNr));
        for i in 1..=f!(optCount)(p) {
            let (mut name, mut desc, mut n2) = ([0u8; GMS_SSSIZE], [0u8; GMS_SSSIZE], [0u8; GMS_SSSIZE]);
            help(p, i, name.as_mut_ptr() as *mut c_char, desc.as_mut_ptr() as *mut c_char);
            let (mut d, mut dr, mut rn, mut dt, mut ot, mut st) = (0, 0, 0, 0, 0, 0);
            info(p, i, &mut d, &mut dr, &mut rn, &mut dt, &mut ot, &mut st);
            let (mut hc, mut group) = (0, 0);
            ohelp(p, i, n2.as_mut_ptr() as *mut c_char, &mut hc, &mut group);
            let (mut ival, mut dval) = (0, 0.0);
            let (mut vname, mut sval) = ([0u8; GMS_SSSIZE], [0u8; GMS_SSSIZE]);
            values(p, i, vname.as_mut_ptr() as *mut c_char, &mut ival, &mut dval, sval.as_mut_ptr() as *mut c_char);
            let name_s = cstr(&name);
            let mut e = OptEntry {
                nr: i,
                description: cstr(&desc),
                group,
                data_type: dt,
                opt_type: ot,
                sub_type: st,
                type_name: String::new(),
                deprecated: is_dep(p, name.as_ptr() as *const c_char) != 0,
                hidden: hc == 0,
                synonyms: def
                    .synonyms
                    .iter()
                    .filter(|s| !s.deprecated && s.option.eq_ignore_ascii_case(&name_s))
                    .map(|s| s.synonym.clone())
                    .collect(),
                default: String::new(),
                lower: None,
                upper: None,
                enums: vec![],
                name: name_s,
            };
            // optGetTypeName(popt, tnr, name): `tnr` is the option type number
            let mut tn2 = [0u8; GMS_SSSIZE];
            f!(optGetTypeName)(p, ot, tn2.as_mut_ptr() as *mut c_char);
            e.type_name = cstr(&tn2);
            match ot {
                OPT_TYPE_INTEGER => {
                    let (mut lo, mut hi, mut df) = (0, 0, 0);
                    f!(optGetBoundsInt)(p, i, &mut lo, &mut hi, &mut df);
                    e.lower = Some(fmt_int(lo));
                    e.upper = Some(fmt_int(hi));
                    e.default = fmt_int(df);
                }
                OPT_TYPE_DOUBLE => {
                    let (mut lo, mut hi, mut df) = (0.0, 0.0, 0.0);
                    f!(optGetBoundsDbl)(p, i, &mut lo, &mut hi, &mut df);
                    e.lower = Some(fmt_dbl(lo));
                    e.upper = Some(fmt_dbl(hi));
                    e.default = fmt_dbl(df);
                }
                OPT_TYPE_ENUM_INT | OPT_TYPE_BOOLEAN => e.default = ival.to_string(),
                OPT_TYPE_STRING | OPT_TYPE_STR_LIST | OPT_TYPE_ENUM_STR => {
                    let mut s = [0u8; GMS_SSSIZE];
                    f!(optGetDefaultStr)(p, i, s.as_mut_ptr() as *mut c_char);
                    e.default = cstr(&s);
                }
                _ => {}
            }
            let mut count = 0;
            f!(optGetEnumCount)(p, i, &mut count);
            for j in 1..=count {
                let (mut hc, mut text) = (0, [0u8; GMS_SSSIZE]);
                f!(optGetEnumHelp)(p, i, j, &mut hc, text.as_mut_ptr() as *mut c_char);
                let (mut iv, mut sv) = (0, [0u8; GMS_SSSIZE]);
                f!(optGetEnumValue)(p, i, j, &mut iv, sv.as_mut_ptr() as *mut c_char);
                let value = match dt {
                    3 => cstr(&sv),
                    1 => iv.to_string(),
                    _ => continue,
                };
                e.enums.push(EnumValue { value, description: cstr(&text), hidden: hc == 0 });
            }
            def.options.push(e);
        }
        Ok(def)
    }
}

/// Feed every line of a solver option file to `optReadFromStr` (after `optResetAll`, as Studio's
/// `getOptionItemFromStr` does) and collect the library messages per line. Blank lines and lines
/// starting with `*` or an EOL comment character are comments and yield no messages.
pub fn check_lines(sysdir: &Path, def_file: &str, lines: &[&str]) -> Result<Vec<Vec<OptMessage>>, String> {
    let _g = lock();
    unsafe {
        let h = open(sysdir, def_file)?;
        let p = h.0;
        let (reset, read, clear, count, get) = (
            optResetAll().ok_or("optResetAll")?,
            optReadFromStr().ok_or("optReadFromStr")?,
            optClearMessages().ok_or("optClearMessages")?,
            optMessageCount().ok_or("optMessageCount")?,
            optGetMessage().ok_or("optGetMessage")?,
        );
        let mut eol = [0u8; GMS_SSSIZE];
        let n = optEOLChars().ok_or("optEOLChars")?(p, eol.as_mut_ptr() as *mut c_char);
        let eol: Vec<char> = if n > 0 { cstr(&eol).chars().collect() } else { vec![] };
        let mut out = Vec::with_capacity(lines.len());
        for line in lines {
            let t = line.trim();
            let first = t.chars().next();
            if t.is_empty() || first == Some('*') || first.is_some_and(|c| eol.contains(&c)) {
                out.push(vec![]);
                continue;
            }
            let Ok(c) = CString::new(t) else {
                out.push(vec![]);
                continue;
            };
            reset(p);
            clear(p);
            read(p, c.as_ptr());
            let mut msgs = Vec::new();
            for i in 1..=count(p) {
                let (mut buf, mut ty) = ([0u8; GMS_SSSIZE], 0);
                get(p, i, buf.as_mut_ptr() as *mut c_char, &mut ty);
                if matches!(ty, OPT_MSG_FILE_ENTER | OPT_MSG_FILE_LEAVE | OPT_MSG_TOO_MANY_MSGS) {
                    continue;
                }
                msgs.push(OptMessage { kind: ty, text: cstr(&buf) });
            }
            clear(p);
            out.push(msgs);
        }
        Ok(out)
    }
}
