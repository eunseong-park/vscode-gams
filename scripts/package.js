// Build the language server for a VS Code target platform and package the VSIX.
// Usage: node scripts/package.js <vsce-target> [--no-server]
//   targets: linux-x64, linux-arm64, win32-x64, darwin-arm64, darwin-x64
// win32-x64 uses the msvc target on Windows and the mingw (gnu) cross-build elsewhere.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = process.argv[2];
const noServer = process.argv.includes('--no-server');
const rustTargets = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-pc-windows-gnu',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
};
if (!rustTargets[target]) {
  console.error('Usage: node scripts/package.js <' + Object.keys(rustTargets).join('|') + '>');
  process.exit(2);
}
const sh = process.platform === 'win32';
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: sh });
  if (r.status !== 0) process.exit(r.status || 1);
}
if (!noServer) run('node', ['scripts/build-server.js', rustTargets[target]]);
run('node', ['esbuild.js', '--production']);
// VS Code convention: odd minor version = pre-release (marked inside the VSIX), even = stable
const version = require(path.join(root, 'package.json')).version;
const preRelease = Number(version.split('.')[1]) % 2 === 1;
if (preRelease) console.log(`version ${version}: packaging as pre-release`);
run('npx', ['vsce', 'package', '--target', target, ...(preRelease ? ['--pre-release'] : [])]);
