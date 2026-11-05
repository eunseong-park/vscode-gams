// SPDX-License-Identifier: GPL-3.0-or-later
//! Incremental re-highlighting ([`rehighlight`], [`rehighlight_change`]) gives the same result as
//! highlighting the edited text from scratch, over random edit sessions.
use gams_syntax::*;

struct Rng(u64);
impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n.max(1) as u64) as usize
    }
}

const SNIPS: [&str; 24] = [
    "(", ")", "/", "'", "\"", ";", "\n", "\r\n", "\r", "*", "$onText\n", "$offText\n", "\u{1F600}", " ", "set i /a,b/;\n",
    "$eolCom //\n", "// (x)", "Table t(i,j)\n", "$onEmbeddedCode Python:\n", "$offEmbeddedCode\n", "x", "abort$(x and\n",
    "$if set x Set k\n", "parameter p(i) \"d (x)\" / a 1 /;\n",
];

const SAMPLE: &str = "Set i / a, b /\n    j 'markets' / x, y /;\nParameter p(i) / a 1, b 2 /;\n$onText\nnotes (\n$offText\nVariable x(i,j);\nEquation e(i);\ne(i).. sum(j, x(i,j)) =l= p(i);\nModel m / all /;\nsolve m using lp min z;\n";

fn texts() -> Vec<String> {
    let mut v = vec![SAMPLE.repeat(20)];
    let dir = std::env::var("GAMS_SYSDIR").unwrap_or_default();
    for name in ["trnsport.1", "gemmcp.137", "harker.15", "alum.31"] {
        if let Ok(b) = std::fs::read(format!("{dir}/gamslib_ml/{name}")) {
            v.push(String::from_utf8_lossy(&b).into_owned());
        }
    }
    v
}

/// (line, byte column) of a byte offset with the LSP line breaks.
fn line_of(text: &str, off: usize) -> usize {
    let b = text.as_bytes();
    let mut line = 0;
    let mut i = 0;
    while i < off {
        if b[i] == b'\n' || (b[i] == b'\r' && b.get(i + 1) != Some(&b'\n')) {
            line += 1;
        }
        i += 1;
    }
    line
}

fn plain(infos: &[LineInfo]) -> Vec<(Vec<Token>, Vec<SemToken>, Nesting, LineState)> {
    infos.iter().map(|i| (i.tokens.clone(), i.sem.clone(), i.nesting.clone(), i.state.clone())).collect()
}

#[test]
fn incremental_equals_full_rehighlight() {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for base in texts() {
        for by_change in [false, true] {
            let mut text = base.clone();
            let mut infos = highlight_document_info(&text);
            for step in 0..80 {
                let mut a = rng.below(text.len() + 1);
                while !text.is_char_boundary(a) {
                    a -= 1;
                }
                let mut b = (a + [0, 0, 1, 3, 30, 200][rng.below(6)]).min(text.len());
                while !text.is_char_boundary(b) {
                    b += 1;
                }
                let ins = if rng.below(10) < 8 { SNIPS[rng.below(SNIPS.len())] } else { "" };
                let (l0, l1) = (line_of(&text, a), line_of(&text, b));
                let old = text.clone();
                text.replace_range(a..b, ins);
                let new_lines = split_lines(&text);
                if by_change {
                    rehighlight_change(&mut infos, &new_lines, l0, l1, ins);
                } else {
                    rehighlight(&mut infos, &split_lines(&old), &new_lines);
                }
                // errors persist in the cache, so checking every few edits finds them too
                if step % 4 == 3 {
                    assert!(plain(&infos) == plain(&highlight_lines(&new_lines)), "edit {a}..{b} {ins:?}");
                }
            }
        }
    }
}
