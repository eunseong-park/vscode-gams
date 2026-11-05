// SPDX-License-Identifier: GPL-3.0-or-later
//! GAMS listing outline (`.lxi`) parser.
//!
//! Port of `LxiParser::parseFile` and the cursor->item lookup of
//! `LxiViewer::jumpToTreeItem` (GAMS Studio, `src/lxiviewer/`).
//! Studio does not parse the `.lst` body itself; [`scan_lst_markers`] is a
//! small extra helper that is NOT part of Studio.

/// One outline entry. Group nodes created by the parser (Studio: "virtual"
/// nodes) have `lst_line == -1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LxiNode {
    /// Section code letter(s) `A`..`J`. For group nodes this is, as in Studio,
    /// the code of the *previous* entry (Studio quirk), not the group's own.
    pub kind: String,
    /// Entry text, or the group caption for group nodes.
    pub label: String,
    /// 1-based line in the .lst; -1 for group nodes.
    pub lst_line: i32,
    pub children: Vec<LxiNode>,
}

impl LxiNode {
    pub fn is_group(&self) -> bool {
        self.lst_line == -1
    }
}

/// Group caption for a section code (`LxiParser::initCaptions`); empty for unknown codes.
pub fn caption(code: &str) -> &'static str {
    match code {
        "A" => "???",
        "B" => "SubTitle",
        "C" => "Solve Summary",
        "D" => "Equation",
        "E" => "Column",
        "F" => "SolEQU",
        "G" => "SolVAR",
        "H" => "Solution",
        "I" => "Display",
        "J" => "Message",
        _ => "",
    }
}

/// Parse `.lxi` text exactly like Studio: split each line on a single space,
/// skip lines with fewer than 2 fields, `B` entries are top level, any other
/// code change opens a new group node under the root.
pub fn parse_lxi(text: &str) -> Vec<LxiNode> {
    let mut root: Vec<LxiNode> = Vec::new();
    // Index of the current group in `root`, or None when parent is the root.
    let mut parent: Option<usize> = None;
    let mut last_idx = String::from("B");
    for line in text.lines() {
        let mut fields = line.split(' ');
        let idx = fields.next().unwrap_or("");
        let Some(nr) = fields.next() else { continue };
        let lst_line = qt_to_int(nr);
        let label = fields.collect::<Vec<_>>().join(" ");
        if idx == "B" {
            parent = None;
        } else if idx != last_idx {
            root.push(LxiNode {
                kind: last_idx.clone(),
                label: caption(idx).to_string(),
                lst_line: -1,
                children: Vec::new(),
            });
            parent = Some(root.len() - 1);
        }
        let node = LxiNode { kind: idx.to_string(), label, lst_line, children: Vec::new() };
        match parent {
            None => root.push(node),
            Some(p) => root[p].children.push(node),
        }
        last_idx = idx.to_string();
    }
    root
}

/// Qt `QString::toInt()` semantics: 0 on failure.
fn qt_to_int(s: &str) -> i32 {
    s.parse().unwrap_or(0)
}

/// Real (non-group) entries in file order (Studio's flat `treeItems` list).
pub fn flat_entries(nodes: &[LxiNode]) -> Vec<&LxiNode> {
    let mut out = Vec::new();
    for n in nodes {
        if n.is_group() {
            out.extend(n.children.iter());
        } else {
            out.push(n);
        }
    }
    out
}

/// Port of `LxiViewer::jumpToTreeItem`: for a 0-based cursor line, return the
/// index into [`flat_entries`] of the entry to select. Like Studio, this is a
/// linear scan over file order (entries are expected to be ascending).
pub fn entry_index_for_line(nodes: &[LxiNode], cursor_line0: i32) -> Option<usize> {
    let flat = flat_entries(nodes);
    if flat.is_empty() {
        return None;
    }
    let mut idx = 0;
    if flat.len() > 1 && cursor_line0 >= flat[1].lst_line - 1 {
        idx = 1;
        while flat.len() > idx && cursor_line0 >= flat[idx].lst_line - 1 {
            idx += 1;
        }
        idx -= 1;
    }
    Some(idx)
}

/// Path of the `.lxi` for a `.lst` path: replace only the last suffix
/// (Studio: `QFileInfo::completeBaseName()` + ".lxi").
pub fn lxi_path_for_lst(lst: &str) -> String {
    let name_start = lst.rfind(['/', '\\']).map_or(0, |i| i + 1);
    match lst[name_start..].rfind('.') {
        Some(i) => format!("{}.lxi", &lst[..name_start + i]),
        None => format!("{lst}.lxi"),
    }
}

/// Kind of marker found by [`scan_lst_markers`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerKind {
    /// `****` line carrying `$nnn` error-marker columns.
    ErrorMarker,
    /// `**** nnn  message` error text line.
    ErrorText,
    /// Any other `**** ` line (summaries, `**** n ERROR(S)` ...).
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LstMarker {
    /// 1-based line in the .lst.
    pub line: usize,
    pub kind: MarkerKind,
    /// Error numbers (`$170` -> 170 / `**** 170` -> 170) when present.
    pub codes: Vec<u32>,
    pub text: String,
}

/// NOT in Studio (Studio shows the .lst as plain text and only uses the .lxi
/// and log tags). Light helper that lists `**** ` lines of a listing.
pub fn scan_lst_markers(text: &str) -> Vec<LstMarker> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if !line.starts_with("**** ") {
            continue;
        }
        let rest = line[5..].trim();
        let mut codes = Vec::new();
        for tok in rest.split_whitespace() {
            if let Some(d) = tok.strip_prefix('$') {
                if let Ok(n) = d.parse() {
                    codes.push(n);
                }
            }
        }
        let kind = if !codes.is_empty() {
            MarkerKind::ErrorMarker
        } else if let Some(n) = rest.split_whitespace().next().and_then(|t| t.parse::<u32>().ok()) {
            // "**** 170  Domain violation ..." but not "**** 2 ERROR(S) ..."
            if rest.contains("ERROR(S)") {
                MarkerKind::Other
            } else {
                codes.push(n);
                MarkerKind::ErrorText
            }
        } else {
            MarkerKind::Other
        };
        out.push(LstMarker { line: i + 1, kind, codes, text: rest.to_string() });
    }
    out
}
