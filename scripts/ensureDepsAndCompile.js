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
  let npmRes = spawnSync('npm', args, { encoding: 'utf8' });
  if (npmRes.error) console.error('Error running npm:', npmRes.error);
  if (npmRes.stdout) console.log(npmRes.stdout);
  if (npmRes.stderr) console.error(npmRes.stderr);
  if (npmRes.status !== 0) {
    // try fallback from `npm ci` to `npm install`
    if (args[0] === 'ci') {
      console.log('`npm ci` failed; attempting `npm install` as a fallback...');
      npmRes = spawnSync('npm', ['install'], { encoding: 'utf8' });
      if (npmRes.error) console.error('Error running npm install:', npmRes.error);
      if (npmRes.stdout) console.log(npmRes.stdout);
      if (npmRes.stderr) console.error(npmRes.stderr);
    }
  }
  if (npmRes.status !== 0) {
    console.error('\nFailed to install devDependencies automatically.');
    console.error('Please run `npm ci` (or `npm install`) in this folder and retry `vsce package`.');
    process.exit(npmRes.status || 1);
  }
}

// Forward additional args (e.g., --watch)
const extraArgs = process.argv.slice(2);

console.log('Running TypeScript compiler...');
const tscPath = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
console.log('Candidate tsc wrapper at:', tscPath);

let res;
// Prefer running the tsc JS with the current Node executable to avoid spawning .cmd on Windows
let resolvedTscJs = null;
try {
  resolvedTscJs = require.resolve('typescript/bin/tsc', { paths: [root] });
  console.log('Resolved typescript bin to:', resolvedTscJs);
} catch (e) {
  // not resolved
}

if (resolvedTscJs) {
  res = spawnSync(process.execPath, [resolvedTscJs, '-p', '.', ...extraArgs], { encoding: 'utf8' });
  if (res.error) console.error('Error launching node tsc:', res.error);
  console.log('node tsc exit code:', res.status);
  if (res.stdout) console.log('node tsc stdout:\n', res.stdout);
  if (res.stderr) console.error('node tsc stderr:\n', res.stderr);
} else {
  // fallback to running the wrapper; on Windows run through cmd, otherwise use shell
  try {
    if (process.platform === 'win32') {
      res = spawnSync('cmd', ['/c', tscPath, '-p', '.', ...extraArgs], { encoding: 'utf8' });
    } else {
      res = spawnSync(tscPath, ['-p', '.', ...extraArgs], { encoding: 'utf8', shell: true });
    }
    if (res.error) console.error('Error launching tsc wrapper:', res.error);
    console.log('tsc wrapper exit code:', res.status);
    if (res.stdout) console.log('tsc wrapper stdout:\n', res.stdout);
    if (res.stderr) console.error('tsc wrapper stderr:\n', res.stderr);
  } catch (e) {
    console.error('Unexpected error invoking tsc wrapper:', e);
  }
}

if (!res || res.status !== 0) {
  console.log('Compilation via local tsc failed; attempting npx fallback (if available)');
  try {
    res = spawnSync('npx', ['-p', 'typescript', 'tsc', '-p', '.', ...extraArgs], { encoding: 'utf8' });
    if (res.error) console.error('Error launching npx tsc:', res.error);
    console.log('npx tsc exit code:', res.status);
    if (res.stdout) console.log('npx tsc stdout:\n', res.stdout);
    if (res.stderr) console.error('npx tsc stderr:\n', res.stderr);
  } catch (e) {
    console.error('npx fallback failed:', e);
  }
}

// If compilation succeeded, also list emitted files for debugging
if (res && (res.status === 0 || res.status === null) && extraArgs.indexOf('--listEmittedFiles') === -1) {
  try {
    let listRes;
    if (resolvedTscJs) {
      listRes = spawnSync(process.execPath, [resolvedTscJs, '-p', '.', '--listEmittedFiles'], { encoding: 'utf8' });
    } else if (process.platform === 'win32') {
      listRes = spawnSync('cmd', ['/c', tscPath, '-p', '.', '--listEmittedFiles'], { encoding: 'utf8' });
    } else {
      listRes = spawnSync(tscPath, ['-p', '.', '--listEmittedFiles'], { encoding: 'utf8', shell: true });
    }
    if (listRes && listRes.stdout) console.log('Emitted files:\n', listRes.stdout);
    if (listRes && listRes.stderr) console.error('List emitted files stderr:\n', listRes.stderr);
  } catch (e) {
    // ignore
  }
}

process.exit((res && res.status) || 0);
