#!/usr/bin/env node
// Verifies that no tracked file in the repo is a byte-identical copy of a file
// in the GAMS system directory ($GAMS_SYSDIR). Skips (exit 0) if no sysdir.
// Intentionally generated files: list their repo-relative paths in
// scripts/fixture-origin-allow.txt (one per line).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const sysdir = process.env.GAMS_SYSDIR || process.argv[2];
if (!sysdir || !fs.existsSync(sysdir)) {
  console.log('check-fixture-origin: GAMS_SYSDIR not set/found; skipped');
  process.exit(0);
}
const SKIP = new Set(['node_modules', 'target', '.git', 'out', 'dist', 'bin', '.vscode-test']);
const MIN = 16; // ignore trivially small files (empty, one-liners)
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) && dir === root) continue;
    if (e.name === 'node_modules' || e.name === 'target' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}
const repoFiles = [];
for (const p of walk(root)) {
  const rel = path.relative(root, p);
  if (/\.vsix$/.test(rel)) continue;
  if (/^(out|dist)\//.test(rel) || /^server\/bin\//.test(rel)) continue;
  if (fs.statSync(p).size >= MIN) repoFiles.push(p);
}
const bySize = new Map();
for (const p of repoFiles) {
  const s = fs.statSync(p).size;
  if (!bySize.has(s)) bySize.set(s, []);
  bySize.get(s).push(p);
}
const allowFile = path.join(__dirname, 'fixture-origin-allow.txt');
const allow = new Set(fs.existsSync(allowFile)
  ? fs.readFileSync(allowFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : []);
const repoHashes = new Map();
let hits = 0;
for (const p of walk(sysdir)) {
  let st;
  try { st = fs.statSync(p); } catch { continue; }
  const cands = bySize.get(st.size);
  if (!cands) continue;
  let h;
  try { h = hash(p); } catch { continue; }
  for (const c of cands) {
    if (!repoHashes.has(c)) repoHashes.set(c, hash(c));
    if (repoHashes.get(c) === h) {
      const rel = path.relative(root, c);
      if (allow.has(rel)) continue;
      console.error(`MATCH ${rel}  ==  ${p}`);
      hits++;
    }
  }
}
if (hits) {
  console.error(`check-fixture-origin: ${hits} file(s) identical to GAMS system files`);
  process.exit(1);
}
console.log(`check-fixture-origin: OK (${repoFiles.length} repo files checked)`);
