// SPDX-License-Identifier: GPL-3.0-or-later
// Launches VS Code (downloaded by @vscode/test-electron) with the extension and a throw-away copy
// of client/test/fixtures/workspace. Needs a display: `xvfb-run -a npm run test:integration`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const SYSDIR = process.env.GAMS_SYSDIR;

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main(): Promise<void> {
  if (!SYSDIR || !fs.existsSync(SYSDIR)) {
    console.log('SKIP integration tests: GAMS system directory not found (set GAMS_SYSDIR)');
    return;
  }
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const fixtures = path.resolve(extensionDevelopmentPath, 'client/test/fixtures/workspace');

  const serverPath = ['server/bin/gams-lsp', 'server/target/debug/gams-lsp']
    .map((p) => path.join(extensionDevelopmentPath, p))
    .find((p) => fs.existsSync(p));
  if (!serverPath) throw new Error('gams-lsp not built: run `cargo build -p gams-lsp` in server/');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-gams-it-'));
  const workspace = path.join(root, 'workspace');
  copyDir(fixtures, workspace);
  // Rewrite the /work paths of the recorded .ref fixtures to the real workspace; a .ref must be newer than its .gms.
  const future = new Date(Date.now() + 5000);
  for (const f of fs.readdirSync(workspace).filter((n) => n.endsWith('.ref'))) {
    const refFile = path.join(workspace, f);
    fs.writeFileSync(refFile, fs.readFileSync(refFile, 'utf8').split('/work/').join(workspace + '/'));
    fs.utimesSync(refFile, future, future);
  }
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({ 'gams.sysdir': SYSDIR, 'gams.serverPath': serverPath, 'gams.showLogOnRun': true }, null, 2),
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--user-data-dir', path.join(root, 'user-data'),
        '--extensions-dir', path.join(root, 'extensions'),
      ],
      extensionTestsEnv: { GAMS_EXT_TEST: '1', GAMS_TEST_WORKSPACE: workspace, GAMS_TEST_SERVER: serverPath, GAMS_TEST_SYSDIR: SYSDIR },
    });
  } finally {
    if (!process.env.GAMS_KEEP_TMP) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('Failed to run tests', e);
  process.exit(1);
});
