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
let res = spawnSync(tscPath, ['-p', '.', ...extraArgs], { stdio: 'inherit' });
if (res.status !== 0) {
  // Fallback to npx that fetches the official typescript package if something went wrong
  res = spawnSync('npx', ['-p', 'typescript', 'tsc', '-p', '.', ...extraArgs], { stdio: 'inherit' });
}
process.exit(res.status || 0);
