// SPDX-License-Identifier: GPL-3.0-or-later
//! Parenthesis matching, a port of `CodeEdit::matchParentheses` (Studio `codeedit.cpp`) over the
//! per-line `Nesting::parentheses` lists of the highlighter. Used by `gams/matchingParenthesis`.

use gams_syntax::LineInfo;

/// Studio's `parentheses` string: openers, then closers in the same order.
const PARENTHESES: &str = "{[(/EMTCPIOFU}])\\emtcpiofu";
const SPLIT: usize = PARENTHESES.len() / 2;
/// Index of `/` (block markers after it only get marked on mismatch).
const P_ALL: usize = 3;

/// Single-character range `(line, utf16 column)`.
pub type Pos = (u32, u32);

#[derive(Debug, PartialEq, Eq)]
pub struct Match {
    /// The parenthesis at the cursor (start of the search).
    pub start: Pos,
    /// The partner (or the offending parenthesis on mismatch); `start` itself when unmatched.
    pub other: Pos,
    pub valid: bool,
}

fn index_of(c: char) -> Option<usize> {
    PARENTHESES.chars().position(|p| p == c)
}

fn ch_at(i: usize) -> char {
    PARENTHESES.chars().nth(i).expect("index within table")
}

/// `matchParentheses(cursor, all=false)` for a cursor at `(line, col)`.
pub fn match_parentheses(infos: &[LineInfo], line: u32, col: u32) -> Option<Match> {
    let list = &infos.get(line as usize)?.nesting.parentheses;
    // lowest index at the cursor or directly before it
    let start = list.iter().position(|p| p.pos == col || p.pos + 1 == col)?;
    let ci_full = index_of(list[start].ch)?;
    let back = ci_full >= SPLIT;
    let ci = ci_full % SPLIT;
    let start_pos = (line, list[start].pos);
    let enter_off = if back { SPLIT } else { 0 };
    let leave_off = if back { 0 } else { SPLIT };
    let mut stack = vec![ch_at(leave_off + ci)];
    let mut ln = line as usize;
    let mut pi = start as isize;
    let mut cur = list;
    loop {
        pi += if back { -1 } else { 1 };
        if pi < 0 || pi as usize >= cur.len() {
            // next non-empty line in the search direction
            loop {
                if back {
                    if ln == 0 {
                        return Some(Match { start: start_pos, other: start_pos, valid: false });
                    }
                    ln -= 1;
                } else {
                    ln += 1;
                    if ln >= infos.len() {
                        return Some(Match { start: start_pos, other: start_pos, valid: false });
                    }
                }
                cur = &infos[ln].nesting.parentheses;
                if !cur.is_empty() {
                    break;
                }
            }
            pi = if back { cur.len() as isize - 1 } else { 0 };
        }
        let p = cur[pi as usize];
        let at = (ln as u32, p.pos);
        let idx = index_of(p.ch)?;
        let entering = idx >= enter_off && idx < enter_off + SPLIT;
        if entering {
            stack.push(ch_at(leave_off + idx - enter_off));
        } else if stack.last() == Some(&p.ch) {
            stack.pop();
            if stack.is_empty() {
                if ci > P_ALL {
                    return None; // only mark embedded blocks on mismatch
                }
                return Some(Match { start: start_pos, other: at, valid: true });
            }
        } else {
            return Some(Match { start: start_pos, other: at, valid: false });
        }
    }
}

/// A bracket `( [ {` / `) ] }` of the Studio list with its nesting level (see [`bracket_depths`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bracket {
    pub line: u32,
    /// UTF-16 column.
    pub col: u32,
    /// 0-based nesting level over all bracket types (`sum(i, x(i))`: the outer `(` 0, the inner 1).
    pub depth: u32,
    /// false for unmatched or mismatched brackets.
    pub valid: bool,
}

fn is_bracket(c: char) -> bool {
    matches!(c, '(' | '[' | '{' | ')' | ']' | '}')
}

/// Nesting levels for the brackets of the whole document, in document order, computed from the
/// per-line `Nesting::parentheses` lists (so brackets Studio ignores - comments, strings,
/// descriptions, `$onText`, ... - are not part of it). The depth is carried across lines.
///
/// Studio's block markers (`/` data blocks, `$onText`, ...) are not brackets and get no entry, but they
/// stay on the stack like in [`match_parentheses`]: a closing bracket cannot match across a marker,
/// and a marker closer discards the brackets still open inside its block (those are invalid).
pub fn bracket_depths(infos: &[LineInfo]) -> Vec<Bracket> {
    /// An entry of the stack: a bracket `(char, index into out)` or a marker (`out` = usize::MAX).
    struct Item {
        ch: char,
        out: usize,
        /// Inside embedded code (`$onEmbeddedCode`, `embeddedCode`): never reported invalid.
        foreign: bool,
    }
    let is_marker = |it: &Item| it.out == usize::MAX;
    // Linear in the number of brackets: besides the stack, the stack positions of the open brackets
    // per kind and of the markers (all and per marker char) are kept, so each lookup is a `last()`
    // and every stack entry is removed only once.
    let mut out: Vec<Bracket> = Vec::new();
    let mut stack: Vec<Item> = Vec::new();
    let mut open_at: [Vec<usize>; 3] = Default::default();
    let mut markers: Vec<usize> = Vec::new();
    let mut marker_at: std::collections::HashMap<char, Vec<usize>> = std::collections::HashMap::new();
    let kind = |c: char| match c {
        '(' | ')' => 0,
        '[' | ']' => 1,
        _ => 2,
    };
    // removes stack[k..]; returns the removed brackets (out indices, foreign)
    let drain = |stack: &mut Vec<Item>,
                     open_at: &mut [Vec<usize>; 3],
                     markers: &mut Vec<usize>,
                     marker_at: &mut std::collections::HashMap<char, Vec<usize>>,
                     k: usize,
                     sink: &mut dyn FnMut(usize, usize, bool)| {
        for (n, it) in stack.drain(k..).enumerate() {
            if it.out == usize::MAX {
                markers.pop();
                if let Some(v) = marker_at.get_mut(&it.ch) {
                    v.pop();
                }
            } else {
                open_at[kind(it.ch)].pop();
                sink(n, it.out, it.foreign);
            }
        }
    };
    let mut open_brackets = 0u32;
    for (line, info) in infos.iter().enumerate() {
        for p in &info.nesting.parentheses {
            let at = Bracket { line: line as u32, col: p.pos, depth: 0, valid: true };
            let foreign = markers.last().is_some_and(|&m| matches!(stack[m].ch, 'M' | 'E'));
            if !is_bracket(p.ch) {
                if p.opener {
                    markers.push(stack.len());
                    marker_at.entry(p.ch).or_default().push(stack.len());
                    stack.push(Item { ch: p.ch, out: usize::MAX, foreign });
                } else if let Some(k) = marker_at.get(&opener_of(p.ch)).and_then(|v| v.last().copied()) {
                    drain(&mut stack, &mut open_at, &mut markers, &mut marker_at, k, &mut |_, idx, f| {
                        out[idx].valid &= f;
                        open_brackets -= 1;
                    });
                }
            } else if p.opener {
                open_at[kind(p.ch)].push(stack.len());
                out.push(Bracket { depth: open_brackets, ..at });
                stack.push(Item { ch: p.ch, out: out.len() - 1, foreign });
                open_brackets += 1;
            } else {
                // nearest opener of this kind above the last marker; brackets opened after it stay unclosed
                let floor = markers.last().map_or(0, |m| m + 1);
                match open_at[kind(p.ch)].last().copied().filter(|&k| k >= floor) {
                    Some(k) => {
                        drain(&mut stack, &mut open_at, &mut markers, &mut marker_at, k, &mut |n, idx, f| {
                            open_brackets -= 1;
                            if n > 0 {
                                out[idx].valid &= f;
                            }
                        });
                        out.push(Bracket { depth: open_brackets, ..at });
                    }
                    None => out.push(Bracket { depth: open_brackets, valid: foreign, ..at }),
                }
            }
        }
    }
    for it in stack {
        if !is_marker(&it) {
            out[it.out].valid &= it.foreign;
        }
    }
    out
}

/// The opening marker char of a closing one (`\\` closes `/`, lowercase letters close uppercase ones).
fn opener_of(close: char) -> char {
    if close == '\\' {
        '/'
    } else {
        close.to_ascii_uppercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gams_syntax::highlight_document_info;

    fn m(text: &str, line: u32, col: u32) -> Option<Match> {
        match_parentheses(&highlight_document_info(text), line, col)
    }

    #[test]
    fn before_opening_and_after_closing() {
        let t = "x = (a + b);\n";
        let r = m(t, 0, 4).unwrap();
        assert_eq!((r.start, r.other, r.valid), ((0, 4), (0, 10), true));
        let r = m(t, 0, 11).unwrap(); // just after ')'
        assert_eq!((r.start, r.other, r.valid), ((0, 10), (0, 4), true));
        let r = m(t, 0, 5).unwrap(); // just after '(' also works
        assert_eq!(r.other, (0, 10));
        assert!(m(t, 0, 7).is_none());
        assert!(m(t, 5, 0).is_none());
    }

    #[test]
    fn nested_and_multi_line() {
        let t = "x = f(a,\n  g(b),\n  [c]\n);\n";
        let r = m(t, 0, 5).unwrap();
        assert_eq!((r.other, r.valid), ((3, 0), true));
        let r = m(t, 3, 1).unwrap();
        assert_eq!((r.other, r.valid), ((0, 5), true));
        let r = m(t, 1, 3).unwrap();
        assert_eq!((r.other, r.valid), ((1, 5), true));
    }

    #[test]
    fn mismatch_and_unmatched() {
        let r = m("x = (a];\n", 0, 4).unwrap();
        assert_eq!((r.other, r.valid), ((0, 6), false));
        let r = m("x = (a;\n", 0, 4).unwrap();
        assert_eq!((r.other, r.valid), ((0, 4), false));
        let r = m("x = a);\n", 0, 6).unwrap();
        assert_eq!((r.other, r.valid), ((0, 5), false));
    }

    #[test]
    fn ignores_comments_and_strings() {
        let t = "x = (a +\n* )\n$onText\n)\n$offText\n b 'c)' );\n";
        let r = m(t, 0, 4).unwrap();
        assert_eq!((r.other, r.valid), ((5, 8), true));
    }

    /// Characters of the Studio list per line (`Nesting::parentheses`).
    fn per_line(text: &str) -> Vec<String> {
        let mut v: Vec<String> = highlight_document_info(text).iter().map(|i| i.nesting.parentheses.iter().map(|p| p.ch).collect()).collect();
        while v.last().is_some_and(String::is_empty) {
            v.pop(); // the empty line after the final newline
        }
        v
    }

    /// Column of the first listed bracket on `line` at or after the UTF-16 column of `needle`.
    fn listed_after(text: &str, line: usize, needle: &str) -> Option<u32> {
        let infos = highlight_document_info(text);
        let from = text.lines().nth(line)?.find(needle)? as u32;
        infos[line].nesting.parentheses.iter().map(|p| p.pos).find(|p| *p >= from)
    }

    #[test]
    fn studio_list_excludes_descriptions() {
        // user snippet 1: unquoted description `(1=flexible exchange rate)`; only the `/1/` data block is listed
        let t = "parameters\n  flexiblePFX  Logical flag (1=flexible exchange rate) /1/,\n  k(g) text;\n";
        assert_eq!(per_line(t), ["", "/\\", "()"]);
        assert_eq!(listed_after(t, 1, "Logical"), Some(t.lines().nth(1).unwrap().find("/1/").unwrap() as u32));
        // user snippet 2: `m0(g)  Imports (cif)` inside a parameters declaration: the domain, not the description
        let t = "parameters\n  m0(g)  Imports (cif)\n  m1(g)  More (x) /a 1/\n;\n";
        assert_eq!(per_line(t), ["", "()", "()/\\"]);
    }

    #[test]
    fn studio_list_excludes_custom_eol_comment() {
        // user snippet 3 (`$eolCom !`): the code brackets are listed, the `(cif)` of the comment is not
        let t = "$eolCom !\nmarket(g,\"m0\") = m0(g);   ! Imports (cif)\n";
        assert_eq!(per_line(t), ["", "()()"]);
        assert_eq!(listed_after(t, 1, "!"), None);
        // without `$eolCom` the `!` is plain code and `(cif)` is listed (Studio: no comment, no exclusion)
        let t = "market(g,\"m0\") = m0(g);   ! Imports (cif)\n";
        assert_eq!(per_line(t), ["()()()"]);
        // a later `$eolCom` replaces the character
        let t = "$eolCom //\nx = a(i); // (c)\n$eolCom !\ny = b(j); ! (d)\nz = c(k); // (e)\n";
        assert_eq!(per_line(t), ["", "()", "", "()", "()()"]);
    }

    #[test]
    fn studio_list_excludes_comments_strings_text_and_mpsge() {
        let t = "* (comment\nx = a(\"(\") + b('(') + c(i);\n$onText\n( [ {\n$offText\ny = d(j);\n";
        // `T`/`t` are the $onText/$offText block markers of Studio's list; brackets inside are not listed
        assert_eq!(per_line(t), ["", "()()()", "T", "", "t", "()"]);
        // MPSGE block (inside $onText): neither brackets nor the `!` comments are listed
        let t = "$onText\n$MODEL:M\n$SECTORS:\n  Y(R)  ! sector (x)\n$PROD:Y(R) s:0\n  O:P(R)  Q:1 ! (y)\n$offText\nz = e(k);\n";
        assert_eq!(per_line(t), ["T", "", "", "", "", "", "t", "()"]);
    }

    #[test]
    fn studio_list_includes_code_brackets() {
        let t = "parameter s0(g) 'x (y)';\nm0(g) = sum(s, s0(s,g));\nset q(s,g) / a.b, [c] /;\n";
        // domain `(g)` of the declaration is listed, the quoted text is not; nested calls; data block `/ \`
        assert_eq!(per_line(t), ["()", "()(())", "()/[]\\"]);
    }

    fn depths(text: &str) -> Vec<(u32, u32, u32, bool)> {
        bracket_depths(&highlight_document_info(text)).iter().map(|b| (b.line, b.col, b.depth, b.valid)).collect()
    }

    #[test]
    fn bracket_depths_nesting_across_lines() {
        // `sum(s, s0(s,g))` and a bracket of another kind inside; depth carried over the line break
        let t = "x = sum(s,\n  s0[s,g](h));\n";
        assert_eq!(
            depths(t),
            [(0, 7, 0, true), (1, 4, 1, true), (1, 8, 1, true), (1, 9, 1, true), (1, 11, 1, true), (1, 12, 0, true)]
        );
    }

    #[test]
    fn bracket_depths_user_snippets() {
        let t = "$eolCom !\nparameters\n  flexiblePFX  Logical flag (1=flexible exchange rate) /1/,\n  m0(g)  Imports (cif)\n  ;\nmarket(g,\"m0\") = m0(g);   ! Imports (cif)\nx = sum(s,s0(s,g));\n";
        let d = depths(t);
        // the data block markers `/ \` get no entry; descriptions and the eol comment none either
        assert_eq!(d.iter().map(|b| b.0).collect::<Vec<_>>(), [3, 3, 5, 5, 5, 5, 6, 6, 6, 6]);
        assert!(d.iter().all(|b| b.3));
        assert_eq!(d[6..].iter().map(|b| b.2).collect::<Vec<_>>(), [0, 1, 1, 0]);
    }

    #[test]
    fn bracket_depths_invalid() {
        // `]` meets `(`: the closer is unmatched and the opener stays unclosed
        assert_eq!(depths("x = (a];\n"), [(0, 4, 0, false), (0, 6, 1, false)]);
        // an unclosed inner bracket does not spoil the outer pair
        assert_eq!(depths("x = (a[b);\n"), [(0, 4, 0, true), (0, 6, 1, false), (0, 8, 0, true)]);
        // stray closer
        assert_eq!(depths("x = a);\n"), [(0, 5, 0, false)]);
        // a data block marker is a barrier: the `(` opened inside `/ ... /` is unclosed, the `)` after it unmatched
        let d = depths("set q / a (b /;\ny = 1);\n");
        assert_eq!(d, [(0, 10, 0, false), (1, 5, 0, false)]);
    }

    #[test]
    fn bracket_depths_after_abort_and_execute() {
        // Studio drops the rest of the line after `abort$(` / `execute$(`; its brackets are code
        let d = depths("abort$(a>1 and\n b<2) \"x\";\n");
        assert_eq!(d, [(0, 6, 0, true), (1, 4, 0, true)]);
        let d = depths("if(x>0, execute$(x) 'echo (';);\ny(i) = 1;\n");
        assert!(d.iter().all(|b| b.3), "{d:?}");
        assert_eq!(d.iter().map(|b| (b.1, b.2)).collect::<Vec<_>>(), [(2, 0), (16, 1), (18, 1), (29, 0), (1, 0), (3, 0)]);
        let d = depths("abort.noError$(x) 'm (';\nexecuteTool$(y(i)) 'a';\n");
        assert!(d.iter().all(|b| b.3) && d.len() == 6, "{d:?}");
        // an active end-of-line comment ends the scan
        let d = depths("$onEolCom\nabort$(x) 'm'; !! (\n");
        assert_eq!(d, [(1, 6, 0, true), (1, 8, 0, true)]);
    }

    #[test]
    fn bracket_depths_macro_continuation() {
        let t = "$macro f(x) (sqr(x) + \\\n    (x+1))\ny = f(2);\n";
        let d = depths(t);
        assert!(d.iter().all(|b| b.3), "{d:?}");
        assert_eq!(d.len(), 10);
    }

    #[test]
    fn bracket_depths_embedded_code_is_never_invalid() {
        // foreign syntax (Python strings with brackets, unbalanced YAML) is listed but not judged
        let t = "$onEmbeddedCode Python:\ns = '''(\n'''\nx = [1, 2\n$offEmbeddedCode\ny(i) = 1);\n";
        let d = depths(t);
        assert_eq!(d.iter().filter(|b| !b.3).map(|b| b.0).collect::<Vec<_>>(), [5], "{d:?}");
    }

    #[test]
    fn bracket_depths_linear_in_unclosed_brackets() {
        let t = format!("x = {} 1;\ny = {};\n", "(".repeat(20_000), ")".repeat(5));
        let infos = highlight_document_info(&t);
        let t0 = std::time::Instant::now();
        let d = bracket_depths(&infos);
        assert_eq!(d.len(), 20_005);
        assert!(t0.elapsed().as_millis() < 200, "{:?}", t0.elapsed());
    }

    #[test]
    fn bracket_depths_skip_ignored_text() {
        let t = "x = (a +\n* )\n$onText\n)\n$offText\n b 'c)' );\n";
        assert_eq!(depths(t), [(0, 4, 0, true), (5, 8, 0, true)]);
    }
}

/// Corpus check over the model libraries shipped with GAMS (`$GAMS_SYSDIR/*_ml`, read-only): the models
/// compile, so no bracket may be reported invalid, and no listed bracket may lie in a comment, string,
/// description, title or DCO body. Skipped when the libraries are missing.
#[cfg(test)]
mod corpus {
    use super::*;
    use gams_syntax::{highlight_document_info, SyntaxKind as K};
    use std::path::PathBuf;

    pub(crate) fn corpus_files() -> Vec<PathBuf> {
        let sysdir = std::env::var("GAMS_SYSDIR").unwrap_or_default();
        let Ok(rd) = std::fs::read_dir(&sysdir) else { return vec![] };
        let mut out = Vec::new();
        for d in rd.flatten().map(|e| e.path()) {
            if !d.is_dir() || !d.file_name().is_some_and(|n| n.to_string_lossy().ends_with("_ml")) {
                continue;
            }
            for f in std::fs::read_dir(&d).into_iter().flatten().flatten().map(|e| e.path()) {
                let ext = f.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                let model = ext == "gms" || ext == "inc" || (!ext.is_empty() && ext.bytes().all(|b| b.is_ascii_digit()));
                if model && std::fs::metadata(&f).is_ok_and(|m| m.len() < 3_000_000) {
                    out.push(f);
                }
            }
        }
        out.sort();
        out
    }

    fn text_kind(k: K) -> bool {
        k.is_comment() || matches!(k, K::String | K::IdentifierDescription | K::Title | K::DcoBody | K::DcoComment)
    }

    /// Models whose brackets are unbalanced on purpose or only per compile path: `embed1` checks a
    /// compilation error, `decis03` closes blocks after `$goTo`/`$exit` branches.
    const UNBALANCED: [&str; 2] = ["embed1.146", "decis03.375"];

    /// A `$macro` line: its body is code, so its brackets are listed although it is a DCO body.
    fn is_macro_line(l: &str) -> bool {
        l.trim_start().get(..6).is_some_and(|p| p.eq_ignore_ascii_case("$macro"))
    }

    fn check(f: &PathBuf, invalid: &mut Vec<String>, in_text: &mut Vec<String>) {
        let text = String::from_utf8_lossy(&std::fs::read(f).expect("readable")).into_owned();
        let lines = gams_syntax::split_lines(&text);
        let infos = highlight_document_info(&text);
        let skip_invalid = f.file_name().is_some_and(|n| UNBALANCED.contains(&&*n.to_string_lossy()));
        for b in bracket_depths(&infos) {
            if !b.valid && !skip_invalid {
                invalid.push(format!("{}:{}:{}", f.display(), b.line + 1, b.col));
            }
            let toks = &infos[b.line as usize].tokens;
            let in_tok = toks.iter().any(|t| t.start <= b.col && b.col < t.start + t.len && text_kind(t.kind));
            if in_tok && !is_macro_line(lines[b.line as usize]) {
                in_text.push(format!("{}:{}:{}", f.display(), b.line + 1, b.col));
            }
        }
    }

    #[test]
    fn shipped_models_have_valid_brackets() {
        let files = corpus_files();
        if files.is_empty() {
            eprintln!("GAMS model libraries not found, skipping");
            return;
        }
        let n = std::thread::available_parallelism().map_or(4, |n| n.get());
        let (invalid, in_text) = std::thread::scope(|sc| {
            let hs: Vec<_> = files
                .chunks(files.len().div_ceil(n))
                .map(|chunk| {
                    sc.spawn(move || {
                        let (mut a, mut b) = (Vec::new(), Vec::new());
                        for f in chunk {
                            check(f, &mut a, &mut b);
                        }
                        (a, b)
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().expect("no panic")).fold((vec![], vec![]), |mut acc, (a, b)| {
                acc.0.extend(a);
                acc.1.extend(b);
                acc
            })
        });
        eprintln!("{} files, {} invalid, {} in text", files.len(), invalid.len(), in_text.len());
        assert!(invalid.is_empty(), "{} invalid brackets, e.g. {:#?}", invalid.len(), &invalid[..invalid.len().min(40)]);
        assert!(in_text.is_empty(), "{} brackets in text, e.g. {:#?}", in_text.len(), &in_text[..in_text.len().min(40)]);
    }
}
