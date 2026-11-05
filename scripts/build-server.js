// Build the language server and copy it to server/bin.
// Usage: node scripts/build-server.js [rust-target-triple]
// Without a target, builds for the host. Output name: gams-lsp(.exe).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || process.env.GAMS_LSP_TARGET || '';
const root = path.resolve(__dirname, '..');
const args = ['build', '--release', '--manifest-path', path.join(root, 'server', 'Cargo.toml'), '-p', 'gams-lsp'];
if (target) args.push('--target', target);
const r = spawnSync('cargo', args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
if (r.status !== 0) process.exit(r.status || 1);

const exe = target ? (target.includes('windows') ? '.exe' : '') : process.platform === 'win32' ? '.exe' : '';
const relDir = path.join(root, 'server', 'target', target, 'release');
const outDir = path.join(root, 'server', 'bin');
fs.rmSync(outDir, { recursive: true, force: true }); // never ship another platform's binary
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(relDir, 'gams-lsp' + exe), path.join(outDir, 'gams-lsp' + exe));
console.log('server/bin/gams-lsp' + exe + ' <- ' + (target || 'host'));
