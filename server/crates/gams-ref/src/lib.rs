// SPDX-License-Identifier: GPL-3.0-or-later
//! GAMS reference file (`.ref`) parser.
//!
//! Port of `Reference::parseFile` and friends (GAMS Studio `src/reference/`).
//! Lines/columns are kept 1-based exactly as written in the file. For `declared`
//! records the column is the 1-based position just *after* the symbol name; for
//! other kinds (observed on GAMS 54.6 output) it is only an upper bound a few
//! characters after the name, which is why Studio re-searches the name in the
//! source line (`FileMeta::referenceTo`) -- see [`locate_in_line`].

mod path;
pub use path::{file_name_key, is_windows_style, normalize_path, path_key, paths_equal};

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The input contained nothing but whitespace.
    Empty,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Empty => write!(f, "empty reference file"),
        }
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

/// `SymbolDataType::SymbolType` (without the synthetic FileUsed/Unused).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SymbolType {
    Unknown,
    Funct,
    Set,
    Acronym,
    Parameter,
    Variable,
    Equation,
    Model,
    File,
    Macro,
}

impl SymbolType {
    /// `SymbolDataType::typeFrom`: matches any alias "CODE,PLURAL,Label" case-insensitively.
    pub fn parse_name(s: &str) -> SymbolType {
        const T: &[(SymbolType, [&str; 3])] = &[
            (SymbolType::Funct, ["FUNCT", "FUNCTIONS", "Function"]),
            (SymbolType::Set, ["SET", "SETS", "Set"]),
            (SymbolType::Acronym, ["ACRNM", "ACRONYMS", "Acronym"]),
            (SymbolType::Parameter, ["PARAM", "PARAMETERS", "Parameter"]),
            (SymbolType::Variable, ["VAR", "VARIABLES", "Variable"]),
            (SymbolType::Equation, ["EQU", "EQUATIONS", "Equation"]),
            (SymbolType::Model, ["MODEL", "MODELS", "Model"]),
            (SymbolType::File, ["FILE", "FILES", "File"]),
            (SymbolType::Macro, ["MACRO", "MACROS", "Macro"]),
        ];
        for (t, names) in T {
            if names.iter().any(|n| n.eq_ignore_ascii_case(s)) {
                return *t;
            }
        }
        SymbolType::Unknown
    }
}

/// `ReferenceDataType::ReferenceType` (Unknown records are dropped).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RefKind {
    Declare,
    Define,
    Assign,
    ImplicitAssign,
    Reference,
    Control,
    Index,
}

impl RefKind {
    pub const ALL: [RefKind; 7] = [
        RefKind::Declare,
        RefKind::Define,
        RefKind::Assign,
        RefKind::ImplicitAssign,
        RefKind::Reference,
        RefKind::Control,
        RefKind::Index,
    ];

    /// `ReferenceDataType::typeFrom`: aliases "code,Label", case-insensitive.
    /// The real file uses `declared defined assigned impl-asn ref control index`.
    pub fn parse_name(s: &str) -> Option<RefKind> {
        const T: &[(RefKind, [&str; 2])] = &[
            (RefKind::Declare, ["declared", "Declared"]),
            (RefKind::Define, ["defined", "Defined"]),
            (RefKind::Assign, ["assign", "Assigned"]),
            (RefKind::ImplicitAssign, ["impl-asn", "Implicitly Assigned"]),
            (RefKind::Control, ["control", "Controlled"]),
            (RefKind::Reference, ["ref", "Referenced"]),
            (RefKind::Index, ["index", "Indexed"]),
        ];
        for (k, names) in T {
            if names.iter().any(|n| n.eq_ignore_ascii_case(s)) {
                return Some(*k);
            }
        }
        None
    }
}

/// One location of a symbol (`ReferenceItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    pub file: String,
    pub line: i32,
    pub col: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Symbol {
    pub id: i32,
    pub name: String,
    pub ty: SymbolType,
    pub dim: i32,
    /// Domain symbol ids (0 / ids not in the table = universe `*`).
    pub domain: Vec<i32>,
    pub num_elements: i32,
    pub text: String,
    pub declare: Vec<Location>,
    pub define: Vec<Location>,
    pub assign: Vec<Location>,
    pub implicit_assign: Vec<Location>,
    pub reference: Vec<Location>,
    pub control: Vec<Location>,
    pub index: Vec<Location>,
}

impl Symbol {
    fn new(id: i32, name: &str, ty: SymbolType) -> Self {
        Symbol {
            id,
            name: name.to_string(),
            ty,
            dim: 0,
            domain: vec![],
            num_elements: 0,
            text: String::new(),
            declare: vec![],
            define: vec![],
            assign: vec![],
            implicit_assign: vec![],
            reference: vec![],
            control: vec![],
            index: vec![],
        }
    }

    pub fn locations(&self, kind: RefKind) -> &[Location] {
        match kind {
            RefKind::Declare => &self.declare,
            RefKind::Define => &self.define,
            RefKind::Assign => &self.assign,
            RefKind::ImplicitAssign => &self.implicit_assign,
            RefKind::Reference => &self.reference,
            RefKind::Control => &self.control,
            RefKind::Index => &self.index,
        }
    }

    fn locations_mut(&mut self, kind: RefKind) -> &mut Vec<Location> {
        match kind {
            RefKind::Declare => &mut self.declare,
            RefKind::Define => &mut self.define,
            RefKind::Assign => &mut self.assign,
            RefKind::ImplicitAssign => &mut self.implicit_assign,
            RefKind::Reference => &mut self.reference,
            RefKind::Control => &mut self.control,
            RefKind::Index => &mut self.index,
        }
    }

    /// `SymbolReferenceItem::isUnused`: nothing but declare/define records.
    pub fn is_unused(&self) -> bool {
        self.assign.is_empty()
            && self.implicit_assign.is_empty()
            && self.reference.is_empty()
            && self.control.is_empty()
            && self.index.is_empty()
    }
}

/// Section 3 record (files-used tree). Id 0 is the synthetic root and is not stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileUsed {
    pub id: i32,
    pub global_line: String,
    /// INPUT, INCLUDE, BATINCLUDE, SYSINCLUDE, LIBINCLUDE, GDXIN, GDXOUT, ... (empty in the fallback list)
    pub ref_type: String,
    pub parent_id: i32,
    pub local_line: String,
    pub location: String,
    /// First occurrence of this location among linked rows ("compact view").
    pub first_entry: bool,
}

/// A hit returned by [`Reference::references_at`].
#[derive(Debug, Clone)]
pub struct Hit<'a> {
    pub symbol: &'a Symbol,
    pub kind: RefKind,
    pub location: &'a Location,
}

#[derive(Debug, Clone, Default)]
pub struct Reference {
    /// All referenced symbols ordered by id (Studio keeps a QMap by id).
    pub symbols: Vec<Symbol>,
    /// Distinct file locations in order of first appearance in section 1 (`mFileUsed`).
    pub files_used: Vec<String>,
    /// Section 3 records in file order (or the flat fallback list with parent 0).
    pub file_tree: Vec<FileUsed>,
    /// `None` if the whole file parsed (Studio `mLastErrorLine == -1`); otherwise the
    /// 1-based line where parsing stopped. Data read before that point is kept.
    pub error_line: Option<usize>,
    by_id: HashMap<i32, usize>,
    by_name: HashMap<String, i32>,
}

fn qt_int(s: &str) -> i32 {
    s.parse().unwrap_or(0)
}

/// Text starting at the `n`-th (0-based) whitespace-separated token to end of line.
fn tail_from_token(line: &str, n: usize) -> &str {
    let mut rest = line.trim_start();
    for _ in 0..n {
        match rest.find(char::is_whitespace) {
            Some(i) => rest = rest[i..].trim_start(),
            None => return "",
        }
    }
    rest.trim_end()
}

impl Reference {
    /// Parse a `.ref` file. Truncated/garbled files still yield `Ok` with the data
    /// read so far and `error_line` set; only whitespace-only input is an error.
    pub fn parse(text: &str) -> Result<Reference> {
        if text.trim().is_empty() {
            return Err(Error::Empty);
        }
        let mut r = Reference::default();
        r.error_line = r.parse_inner(text);
        r.finish();
        Ok(r)
    }

    pub fn is_complete(&self) -> bool {
        self.error_line.is_none()
    }

    /// Returns the error line (None = success). Mirrors the line accounting of Studio.
    fn parse_inner(&mut self, text: &str) -> Option<usize> {
        let mut lines = text.lines();
        let mut lineread = 0usize;
        let mut syms: BTreeMap<i32, Symbol> = BTreeMap::new();
        let mut seen_files: HashSet<String> = HashSet::new();
        let mut files: Vec<String> = vec![];
        let mut ret: Option<usize> = None;
        let mut rec: Vec<&str> = vec![];
        let mut at_symtab = false;

        // Section 1: references
        for line in lines.by_ref() {
            lineread += 1;
            rec = line.split_whitespace().collect();
            if rec.is_empty() {
                ret = Some(lineread);
                break;
            }
            if qt_int(rec[0]) == 0 {
                at_symtab = true;
                break;
            }
            if rec.len() < 11 {
                ret = Some(lineread);
                break;
            }
            let id = qt_int(rec[1]);
            let location = tail_from_token(line, 10);
            let ty = SymbolType::parse_name(rec[3]);
            let sym = syms.entry(id).or_insert_with(|| Symbol::new(id, rec[2], ty));
            if seen_files.insert(location.to_string()) {
                files.push(location.to_string());
            }
            if let Some(kind) = RefKind::parse_name(rec[4]) {
                sym.locations_mut(kind).push(Location {
                    file: location.to_string(),
                    line: qt_int(rec[6]),
                    col: qt_int(rec[7]),
                });
            }
        }
        self.files_used = files;
        let finish = |me: &mut Reference, syms: BTreeMap<i32, Symbol>| {
            me.symbols = syms.into_values().collect();
        };
        if ret.is_some() || !at_symtab {
            // EOF inside section 1 (or error): Studio reports the last line read
            let e = ret.unwrap_or(lineread);
            finish(self, syms);
            return Some(e);
        }
        // Section 2: symbol table header `0 N ...`
        if rec.len() < 2 {
            finish(self, syms);
            return Some(lineread);
        }
        let size = qt_int(rec[1]).max(0) as usize;
        let expected = size + lineread;
        let mut names: Vec<(String, i32)> = vec![];
        while lineread < expected {
            let Some(line) = lines.next() else { break };
            lineread += 1;
            let rec: Vec<&str> = line.split_whitespace().collect();
            if rec.len() < 6 {
                finish(self, syms);
                self.register_names(&names);
                return Some(lineread);
            }
            let id = qt_int(rec[0]);
            let Some(sym) = syms.get_mut(&id) else { continue };
            let dim = qt_int(rec[4]);
            sym.dim = dim;
            sym.num_elements = qt_int(rec[5]);
            let dimu = dim.max(0) as usize;
            if rec.len() < 6 + dimu {
                // Studio would read out of range; treat as a damaged line.
                finish(self, syms);
                self.register_names(&names);
                return Some(lineread);
            }
            sym.domain = rec[6..6 + dimu].iter().map(|d| qt_int(d)).collect();
            sym.text = rec[6 + dimu..].join(" ");
            names.push((rec[1].to_string(), id));
        }
        finish(self, syms);
        self.register_names(&names);
        if lineread < expected {
            return Some(lineread); // truncated table
        }
        // Section 3: `0 M` header then M records
        let Some(hdr) = lines.next() else {
            // Absent section 3: Studio keeps a flat fallback list and reports unsuccessful.
            self.flat_fallback();
            return Some(lineread);
        };
        let h: Vec<&str> = hdr.split_whitespace().collect();
        lineread += 1;
        if h.is_empty() || qt_int(h[0]) != 0 || h.len() < 2 {
            self.flat_fallback();
            return Some(lineread);
        }
        let m = qt_int(h[1]).max(0) as usize;
        let mut got = 0;
        let mut tree = vec![];
        for line in lines.by_ref() {
            if got >= m {
                break;
            }
            let t: Vec<&str> = line.split_whitespace().collect();
            if t.len() < 6 {
                break;
            }
            lineread += 1;
            got += 1;
            tree.push(FileUsed {
                id: qt_int(t[0]),
                global_line: t[1].to_string(),
                ref_type: t[2].to_string(),
                parent_id: qt_int(t[3]),
                local_line: t[4].to_string(),
                location: t[5..].join(" "),
                first_entry: false,
            });
        }
        // filterFileUsedReference: first-entry flags for linkable types
        let mut seen: HashSet<String> = HashSet::new();
        for f in &mut tree {
            const LINK: [&str; 7] =
                ["INCLUDE", "INPUT", "GDXIN", "GDXOUT", "BATINCLUDE", "SYSINCLUDE", "LIBINCLUDE"];
            if f.id != 0 && LINK.contains(&f.ref_type.as_str()) {
                f.first_entry = seen.insert(f.location.clone());
            }
        }
        self.file_tree = tree;
        if got < m {
            if self.file_tree.is_empty() {
                self.flat_fallback();
            }
            return Some(lineread + 1);
        }
        None
    }

    fn flat_fallback(&mut self) {
        self.file_tree = self
            .files_used
            .iter()
            .enumerate()
            .map(|(i, f)| FileUsed {
                id: i as i32 + 1,
                global_line: String::new(),
                ref_type: String::new(),
                parent_id: 0,
                local_line: String::new(),
                location: f.clone(),
                first_entry: true,
            })
            .collect();
    }

    fn register_names(&mut self, names: &[(String, i32)]) {
        for (n, id) in names {
            self.by_name.insert(n.to_lowercase(), *id);
        }
    }

    fn finish(&mut self) {
        self.by_id = self.symbols.iter().enumerate().map(|(i, s)| (s.id, i)).collect();
        // Lenient: symbols whose section-2 line was never reached stay findable by name.
        for s in &self.symbols {
            self.by_name.entry(s.name.to_lowercase()).or_insert(s.id);
        }
    }

    pub fn symbol_by_id(&self, id: i32) -> Option<&Symbol> {
        self.by_id.get(&id).map(|&i| &self.symbols[i])
    }

    /// Case-insensitive lookup (GAMS identifiers are case-insensitive; Studio's own map is case-sensitive).
    pub fn symbol(&self, name: &str) -> Option<&Symbol> {
        self.by_name.get(&name.to_lowercase()).and_then(|&id| self.symbol_by_id(id))
    }

    pub fn symbols_of_type(&self, ty: SymbolType) -> impl Iterator<Item = &Symbol> {
        self.symbols.iter().filter(move |s| s.ty == ty)
    }

    /// The "Unused" tab: symbols that only have declare/define records.
    pub fn unused(&self) -> impl Iterator<Item = &Symbol> {
        self.symbols.iter().filter(|s| s.is_unused())
    }

    /// Domain column: names of the domain symbols; unknown ids render as `*`.
    pub fn domain_names(&self, s: &Symbol) -> Vec<String> {
        s.domain
            .iter()
            .map(|&d| self.symbol_by_id(d).map_or("*".to_string(), |x| x.name.clone()))
            .collect()
    }

    /// Children of a file-tree node (`0` = root) in file order.
    pub fn file_children(&self, parent_id: i32) -> impl Iterator<Item = &FileUsed> {
        self.file_tree.iter().filter(move |f| f.id != 0 && f.parent_id == parent_id)
    }

    /// All records whose location covers the 1-based `(line, col)` in `file`, using
    /// the record column as the position just after the name, i.e. covering
    /// `[col - name_len, col)`. Exact for declared records only; use
    /// [`Reference::references_at_in_text`] when the source line is available.
    /// `file` is compared with [`paths_equal`] (separators, drive-letter and Windows case).
    pub fn references_at(&self, file: &str, line: i32, col: i32) -> Vec<Hit<'_>> {
        self.hits(file, line, |s, loc| {
            let len = s.name.chars().count() as i32;
            col >= loc.col - len && col < loc.col
        })
    }

    /// Like [`Reference::references_at`] but re-locates the name in `line_text` the
    /// way Studio's `FileMeta::referenceTo` does (last case-insensitive occurrence
    /// in the first `col-1` characters). `col` is the 1-based cursor column.
    pub fn references_at_in_text(&self, file: &str, line: i32, col: i32, line_text: &str) -> Vec<Hit<'_>> {
        self.hits(file, line, |s, loc| match locate_in_line(&s.name, loc.col, line_text) {
            Some((a, b)) => {
                let c0 = (col - 1).max(0) as usize;
                c0 >= a && c0 < b
            }
            None => false,
        })
    }

    fn hits<F: Fn(&Symbol, &Location) -> bool>(&self, file: &str, line: i32, f: F) -> Vec<Hit<'_>> {
        let mut out = vec![];
        for s in &self.symbols {
            for kind in RefKind::ALL {
                for loc in s.locations(kind) {
                    if loc.line == line && paths_equal(&loc.file, file) && f(s, loc) {
                        out.push(Hit { symbol: s, kind, location: loc });
                    }
                }
            }
        }
        out
    }
}

const INCLUDE_TYPES: [&str; 4] = ["INCLUDE", "BATINCLUDE", "SYSINCLUDE", "LIBINCLUDE"];

/// Precomputed include spans of a [`Reference`]; see [`Reference::line_mapper`].
pub struct LineMapper<'a> {
    reference: &'a Reference,
    root: &'a FileUsed,
    totals: HashMap<i32, u32>,
    total: u32,
}

impl LineMapper<'_> {
    pub fn map(&self, global: u32) -> Option<(String, u32)> {
        if global == 0 || global > self.total {
            return None;
        }
        self.reference.resolve_global(self.root, 0, global, &self.totals)
    }
}

impl Reference {
    /// Map a *global* (expanded) line number of the compiler listing to `(file, local line)`.
    ///
    /// Not part of Studio (Studio never maps listing lines into include files); derived from the
    /// "Include File Summary" of `$GAMS_SYSDIR/docs/UG_GAMSOutput.html`: the GLOBAL column is the
    /// global line of the `$include` statement itself, LOCAL its line in the parent, and the
    /// contents of the included file follow the statement in the global numbering.
    /// `line_count` returns the number of lines of a file (without nested include expansion);
    /// `None` makes the mapping fail (`None`). Returns `None` for lines outside the input file.
    pub fn map_global_line(&self, global: u32, line_count: &dyn Fn(&str) -> Option<u32>) -> Option<(String, u32)> {
        self.line_mapper(line_count)?.map(global)
    }

    /// Build a [`LineMapper`] once (reading every file of the tree at most once); then map many lines.
    pub fn line_mapper(&self, line_count: &dyn Fn(&str) -> Option<u32>) -> Option<LineMapper<'_>> {
        let root = self.file_tree.iter().find(|f| f.id != 0 && f.parent_id == 0 && f.ref_type == "INPUT")?;
        let mut totals: HashMap<i32, u32> = HashMap::new();
        let mut counts: HashMap<String, Option<u32>> = HashMap::new();
        let mut counter = |loc: &str| -> Option<u32> { *counts.entry(loc.to_string()).or_insert_with(|| line_count(loc)) };
        let total = self.span_total(root.id, &mut counter, &mut totals)?;
        Some(LineMapper { reference: self, root, totals, total })
    }

    fn include_children(&self, id: i32) -> Vec<&FileUsed> {
        let mut v: Vec<&FileUsed> =
            self.file_children(id).filter(|c| INCLUDE_TYPES.contains(&c.ref_type.as_str())).collect();
        v.sort_by_key(|c| c.global_line.trim().parse::<u32>().unwrap_or(0));
        v
    }

    /// Lines contributed to the global numbering by file `id`: own lines plus nested includes.
    fn span_total(&self, id: i32, line_count: &mut dyn FnMut(&str) -> Option<u32>, memo: &mut HashMap<i32, u32>) -> Option<u32> {
        let f = self.file_tree.iter().find(|f| f.id == id)?;
        let mut n = line_count(&f.location)?;
        for c in self.include_children(id) {
            n += self.span_total(c.id, line_count, memo)?;
        }
        memo.insert(id, n);
        Some(n)
    }

    fn resolve_global(&self, f: &FileUsed, base: u32, x: u32, totals: &HashMap<i32, u32>) -> Option<(String, u32)> {
        let mut acc = 0;
        for c in self.include_children(f.id) {
            let stmt = c.global_line.trim().parse::<u32>().ok()?;
            let t = *totals.get(&c.id)?;
            if x > stmt && x <= stmt + t {
                return self.resolve_global(c, stmt, x, totals);
            }
            if x > stmt + t {
                acc += t;
            }
        }
        Some((f.location.clone(), x.checked_sub(base + acc)?.max(1)))
    }
}

/// Port of the name search in `FileMeta::referenceTo`: for a record column `col`
/// (1-based, as in the file) return the 0-based half-open char range of the last
/// case-insensitive occurrence of `name` in `line_text[..col-1]`. `None` if absent.
pub fn locate_in_line(name: &str, col: i32, line_text: &str) -> Option<(usize, usize)> {
    if col <= 0 || name.is_empty() {
        return None;
    }
    let hay: Vec<char> = line_text.chars().take((col - 1) as usize).flat_map(|c| c.to_lowercase()).collect();
    let needle: Vec<char> = name.chars().flat_map(|c| c.to_lowercase()).collect();
    if needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len())
        .rev()
        .find(|&i| hay[i..i + needle.len()] == needle[..])
        .map(|i| (i, i + needle.len()))
}

#[cfg(test)]
mod map_tests {
    use super::*;

    /// Doc-derived (UG_GAMSOutput.html, "The Include File Summary"), not a real GAMS run.
    fn doc_example() -> Reference {
        let ref_txt = "0 3 t\n1 1 INPUT 0 0 C:\\models\\test.gms\n2 1 INCLUDE 1 1 C:\\models\\file1.inc\n3 6 INCLUDE 1 4 C:\\models\\file2.inc\n";
        let full = format!("0 0\n{}", ref_txt.replacen("0 3 t", "0 3", 1));
        Reference::parse(&full).unwrap()
    }

    #[test]
    fn maps_documented_include_example() {
        let r = doc_example();
        assert_eq!(r.file_tree.len(), 3, "{:?}", r.file_tree);
        let count = |f: &str| match f {
            "C:\\models\\test.gms" => Some(4),
            "C:\\models\\file1.inc" => Some(2),
            "C:\\models\\file2.inc" => Some(1),
            _ => None,
        };
        let m = |g| r.map_global_line(g, &count);
        assert_eq!(m(1), Some(("C:\\models\\test.gms".into(), 1))); // the $include statement
        assert_eq!(m(2), Some(("C:\\models\\file1.inc".into(), 1)));
        assert_eq!(m(3), Some(("C:\\models\\file1.inc".into(), 2)));
        assert_eq!(m(4), Some(("C:\\models\\test.gms".into(), 2)));
        assert_eq!(m(5), Some(("C:\\models\\test.gms".into(), 3)));
        assert_eq!(m(6), Some(("C:\\models\\test.gms".into(), 4)));
        assert_eq!(m(7), Some(("C:\\models\\file2.inc".into(), 1)));
        assert_eq!(m(8), None);
        assert_eq!(r.map_global_line(2, &|_| None), None);
    }

    #[test]
    fn mapper_reads_each_file_once_and_matches_documented_mapping() {
        use std::cell::RefCell;
        let r = doc_example();
        let reads: RefCell<Vec<String>> = RefCell::new(vec![]);
        let count = |f: &str| {
            reads.borrow_mut().push(f.to_string());
            match f {
                "C:\\models\\test.gms" => Some(4),
                "C:\\models\\file1.inc" => Some(2),
                "C:\\models\\file2.inc" => Some(1),
                _ => None,
            }
        };
        let mapper = r.line_mapper(&count).unwrap();
        let got: Vec<_> = (0..=8).map(|g| mapper.map(g)).collect();
        assert_eq!(reads.borrow().len(), 3, "{:?}", reads.borrow());
        let plain = |f: &str| match f {
            "C:\\models\\test.gms" => Some(4),
            "C:\\models\\file1.inc" => Some(2),
            "C:\\models\\file2.inc" => Some(1),
            _ => None,
        };
        let want: Vec<_> = (0..=8).map(|g| r.map_global_line(g, &plain)).collect();
        assert_eq!(got, want);
        assert_eq!(got[3], Some(("C:\\models\\file1.inc".into(), 2)));
        assert_eq!(got[7], Some(("C:\\models\\file2.inc".into(), 1)));
    }
}
