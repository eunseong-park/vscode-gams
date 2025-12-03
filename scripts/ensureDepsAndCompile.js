#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const requiredPackages = ['typescript', '@types/node', '@types/vscode', '@types/jest'];

function hasPackage(name) {
  return fs.existsSync(path.join(root, 'node_modules', name));
}

const missing = requiredPackages.filter(p => !hasPackage(p));
if (missing.length) {
  console.log('Missing dev dependencies:', missing.join(', '));
  const useCi = fs.existsSync(path.join(root, 'package-lock.json'));
  const args = useCi ? ['ci'] : ['install'];
  console.log(`Running npm ${args.join(' ')} to install devDependencies...`);
  const res = spawnSync('npm', args, { stdio: 'inherit' });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

// Forward additional args (e.g., --watch)
const extraArgs = process.argv.slice(2);

console.log('Running TypeScript compiler...');
const tscPath = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
console.log('Using tsc at:', tscPath);

// Try running the local tsc and capture output so we can log it on failures.
let res = spawnSync(tscPath, ['-p', '.', ...extraArgs], { encoding: 'utf8' });
if (res.error) {
  console.error('Error launching tsc:', res.error);
}
console.log('tsc exit code:', res.status);
if (res.stdout) console.log('tsc stdout:\n', res.stdout);
if (res.stderr) console.error('tsc stderr:\n', res.stderr);

if (res.status !== 0) {
  console.log('Local tsc failed; falling back to npx -p typescript tsc');
  res = spawnSync('npx', ['-p', 'typescript', 'tsc', '-p', '.', ...extraArgs], { encoding: 'utf8' });
  if (res.error) console.error('Error launching npx tsc:', res.error);
  console.log('npx tsc exit code:', res.status);
  if (res.stdout) console.log('npx tsc stdout:\n', res.stdout);
  if (res.stderr) console.error('npx tsc stderr:\n', res.stderr);
}

// If compilation succeeded, also list emitted files for debugging
if ((res.status === 0 || res.status === null) && extraArgs.indexOf('--listEmittedFiles') === -1) {
  try {
    const listRes = spawnSync(tscPath, ['-p', '.', '--listEmittedFiles'], { encoding: 'utf8' });
    if (listRes.stdout) console.log('Emitted files:\n', listRes.stdout);
    if (listRes.stderr) console.error('List emitted files stderr:\n', listRes.stderr);
  } catch (e) {
    // ignore
  }
}

process.exit(res.status || 0);
