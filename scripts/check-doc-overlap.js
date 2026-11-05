#!/usr/bin/env node
/*
 * Licensing check: reports bundled strings that share a run of >= N consecutive words (default 8) with the
 * GAMS documentation ($GAMS_SYSDIR/docs/*.html and *.pdf via pdftotext), which has no open license.
 * Scans string literals / JSON string values in syntaxes/, schemas/, snippets/, server/crates/gams-syntax/src
 * (excluding generated/syntaxdata.rs: GPL-3.0 Studio data), server/crates/gams-lsp/src and client/src.
 * Usage: node scripts/check-doc-overlap.js [--n 8] [--verbose]    (exit 1 if any overlap is found)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const sysdir = process.env.GAMS_SYSDIR;
if (!sysdir) {
  console.error('set GAMS_SYSDIR to the GAMS system directory');
  process.exit(2);
}
const N = Number(process.argv[process.argv.indexOf('--n') + 1]) || 8;
const SCAN = ['syntaxes', 'schemas', 'snippets', 'server/crates/gams-syntax/src', 'server/crates/gams-lsp/src', 'client/src'];
const EXT = new Set(['.ts', '.rs', '.json']);

const words = (t) => t.toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
const decode = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const grams = new Set();
function addText(t) {
  const w = words(t);
  for (let i = 0; i + N <= w.length; i++) grams.add(w.slice(i, i + N).join(' '));
}
const docsDir = path.join(sysdir, 'docs');
for (const f of fs.readdirSync(docsDir)) {
  const p = path.join(docsDir, f);
  if (f.endsWith('.html')) addText(decode(fs.readFileSync(p, 'utf8')));
  else if (f.endsWith('.pdf')) {
    try { addText(execFileSync('pdftotext', [p, '-'], { maxBuffer: 1 << 28 }).toString()); } catch { /* skip */ }
  }
}

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'target'].includes(e.name)) yield* files(p); }
    else if (EXT.has(path.extname(e.name))) yield p;
  }
}

// Strings taken from GAMS Studio's GPL-3.0 sources (codecompleter.cpp), not from the documentation.
const ALLOW = [['gams-syntax/src/completion.rs', 'compile time variable based on a gams set']];
let hits = 0;
for (const d of SCAN) {
  const abs = path.join(root, d);
  if (!fs.existsSync(abs)) continue;
  for (const f of files(abs)) {
    const rel = path.relative(root, f);
    if (rel.endsWith('generated/syntaxdata.rs') || rel.includes('/test/') || rel.endsWith('style.ts')) continue; // style.ts: CSS
    const text = fs.readFileSync(f, 'utf8');
    // string literals (single line, escapes allowed) and Rust doc/line comments
    const re = /"((?:[^"\\\n]|\\[\s\S])*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`|\/\/[\/!]?(.*)/g;
    let m;
    while ((m = re.exec(text))) {
      const s = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      const w = words(s);
      for (let i = 0; i + N <= w.length; i++) {
        const g = w.slice(i, i + N);
        // ignore code-like runs (regexes, CSS): need at least 4 distinct words of >= 4 letters
        if (new Set(g.filter((x) => x.length >= 4)).size >= 4 && grams.has(g.join(' ')) && !ALLOW.some(([f2, n]) => rel.endsWith(f2) && g.join(' ').includes(n))) {
          hits++;
          console.log(`${rel}:${text.slice(0, m.index).split('\n').length}: ${g.join(' ')}`);
          break;
        }
      }
    }
  }
}
console.log(hits ? `${hits} overlapping string(s) with >= ${N} consecutive words` : `no overlaps of >= ${N} consecutive words`);
process.exit(hits ? 1 : 0);
