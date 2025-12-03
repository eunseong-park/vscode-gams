#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();

function log(...args) { console.log(...args); }
function error(...args) { console.error(...args); }

const nodeModules = path.join(root, 'node_modules');
const outDir = path.join(root, 'out');

if (!fs.existsSync(nodeModules)) {
  error('Required dependencies are not installed (no node_modules).');
  error('Please run `npm ci` (preferred) or `npm install` in this folder, then retry `vsce package`.');
  process.exit(1);
}

// If out/extension.js already exists, nothing to do
const entry = path.join(outDir, 'extension.js');
if (fs.existsSync(entry)) {
  log('Build output found at', entry, '- skipping compilation.');
  process.exit(0);
}

// Try to resolve typescript bin and run it with node (no npm spawn)
let resolvedTscJs = null;
try {
  resolvedTscJs = require.resolve('typescript/bin/tsc', { paths: [root] });
  log('Found TypeScript compiler at', resolvedTscJs);
} catch (e) {
  error('TypeScript is not installed in node_modules.');
  error('Please run `npm ci` (or `npm install`) and retry `vsce package`.');
  process.exit(1);
}

log('Running TypeScript compiler...');
const res = spawnSync(process.execPath, [resolvedTscJs, '-p', '.'], { stdio: 'inherit' });
if (res.status !== 0) {
  error('TypeScript compilation failed (exit code ' + res.status + ').');
  process.exit(res.status || 1);
}

// verify output
if (!fs.existsSync(entry)) {
  error('Compilation finished but expected output file not found:', entry);
  process.exit(1);
}

log('Compilation completed.');
process.exit(0);
