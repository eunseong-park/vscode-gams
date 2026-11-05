// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec, file, open, waitFor, WS } from './helpers';

// Fake `gams` (shell script, POSIX only): no GAMS license is used.
const FAKE = String.raw`#!/bin/sh
f="$1"; b=$(basename "$f" .gms)
echo "cwd $(pwd)"
case "$b" in
 taskerr)
  echo "--- Starting compilation"
  echo "--- taskerr.gms(2) 3 Mb[FIL:\"$f\",2,0]"
  echo "*** Error at line 2: division by zero (0)[LST:23]"
  echo "*** Status: Execution error(s)" ;;
 *) echo "ran $b $*" ;;
esac
`;

(process.platform === 'win32' ? suite.skip : suite)('0.1.x legacy support and GAMS tasks (fake GAMS)', function () {
  this.timeout(120000);
  let sysdir: string;
  const cfg = () => vscode.workspace.getConfiguration('gams');
  const old = () => vscode.workspace.getConfiguration('GAMS');
  const logDoc = (): vscode.TextDocument | undefined => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'gams-log');

  suiteSetup(async () => {
    sysdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gams-lt-'));
    fs.writeFileSync(path.join(sysdir, 'gams'), FAKE, { mode: 0o755 });
    for (const n of ['taskerr', 'cwdrun']) fs.writeFileSync(path.join(WS, n + '.gms'), `* ${n}\nScalar x /1/;\n`);
    fs.mkdirSync(path.join(WS, 'legacycwd'), { recursive: true });
    await vscode.extensions.getExtension('eunseong-park.vscode-gams')?.activate();
    await cfg().update('sysdir', sysdir, vscode.ConfigurationTarget.Workspace);
  });

  suiteTeardown(async () => {
    await cfg().update('sysdir', undefined, vscode.ConfigurationTarget.Workspace);
    for (const k of ['runProject', 'runBatchPath', 'terminalCwd']) await old().update(k, undefined, vscode.ConfigurationTarget.Workspace);
    await exec('workbench.action.closeAllEditors');
    fs.rmSync(sysdir, { recursive: true, force: true });
  });

  test('a gams task runs through our runner and produces diagnostics', async () => {
    const uri = file('taskerr.gms');
    await open(uri);
    const tasks = await vscode.tasks.fetchTasks({ type: 'gams' });
    const t = tasks.find((x) => x.name === 'Run taskerr.gms');
    assert.ok(t, `tasks: ${tasks.map((x) => x.name).join(', ')}`);
    const ended = new Promise<void>((resolve) => {
      const s = vscode.tasks.onDidEndTask((e) => { if (e.execution.task.name === t.name) { s.dispose(); resolve(); } });
    });
    await vscode.tasks.executeTask(t);
    await ended;
    const d = await waitFor('diagnostic', () => {
      const x = vscode.languages.getDiagnostics(uri);
      return x.length ? x : undefined;
    });
    assert.match(d[0].message, /division by zero/);
    await waitFor('task log', () => /Process ended/.test(logDoc()?.getText() ?? ''));
  });

  test('GAMS.terminalCwd is the working directory of a normal run', async () => {
    const cwd = path.join(WS, 'legacycwd');
    await old().update('terminalCwd', cwd, vscode.ConfigurationTarget.Workspace);
    try {
      await open(file('cwdrun.gms'));
      await exec('gams.run');
      const log = await waitFor('log with cwd', () => {
        // only this run: the log document may still show the previous test's run
        const t = logDoc()?.getText() ?? '';
        return /cwdrun\.gms/.test(t) && /cwd /.test(t) && /Process ended/.test(t) ? t : undefined;
      });
      assert.ok(log.includes(`cwd ${fs.realpathSync(cwd)}`) || log.includes(`cwd ${cwd}`), log);
    } finally {
      await old().update('terminalCwd', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('GAMS.runProject runs GAMS.runBatchPath in a terminal with cwd = terminalCwd', async () => {
    const cwd = path.join(WS, 'legacycwd');
    const out = path.join(WS, 'batch_out.txt');
    fs.rmSync(out, { force: true });
    const script = path.join(sysdir, 'batch.sh');
    fs.writeFileSync(script, `#!/bin/sh\npwd > "${out}"\n`, { mode: 0o755 });
    await old().update('runProject', true, vscode.ConfigurationTarget.Workspace);
    await old().update('runBatchPath', script, vscode.ConfigurationTarget.Workspace);
    await old().update('terminalCwd', cwd, vscode.ConfigurationTarget.Workspace);
    try {
      await open(file('cwdrun.gms'));
      const before = vscode.window.terminals.length;
      await exec('gams.run');
      await waitFor('batch output', () => fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim());
      assert.strictEqual(fs.realpathSync(fs.readFileSync(out, 'utf8').trim()), fs.realpathSync(cwd));
      const term = await waitFor('terminal', () => vscode.window.terminals.find((x) => /GAMS/.test(x.name)));
      assert.ok(vscode.window.terminals.length >= before);
      const opts = term.creationOptions as { cwd?: string | vscode.Uri; name?: string };
      if (opts.cwd) assert.strictEqual(fs.realpathSync(typeof opts.cwd === 'string' ? opts.cwd : opts.cwd.fsPath), fs.realpathSync(cwd));
    } finally {
      for (const k of ['runProject', 'runBatchPath', 'terminalCwd']) await old().update(k, undefined, vscode.ConfigurationTarget.Workspace);
      vscode.window.terminals.forEach((x) => x.dispose());
    }
  });
});
