import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec, file, open, sleep, waitFor, WS } from './helpers';

// Runs the real extension commands against a fake `gams` (shell script, POSIX only): no GAMS license is used.
const FAKE = String.raw`#!/bin/sh
f="$1"; b=$(basename "$f" .gms)
case "$b" in
 long*) n=$(echo "$b" | sed 's/long//'); awk -v n=$n -v f="$f" 'BEGIN{for(i=1;i<=n*1000;i++){ if(i%500==0) print "--- m.gms(" i ") 3 Mb[FIL:\"" f "\"," i ",0]"; else print "--- line " i " of a long log with a little more text to be realistic"}}' ;;
 fast) echo "--- fast run"; for i in 1 2 3 4 5 6 7 8; do sleep 0.04; echo "--- step $i"; done ;;
 execerr)
  echo "--- Starting compilation"
  echo "--- execerr.gms(2) 3 Mb[FIL:\"$f\",2,0]"
  echo "*** Error at line 2: division by zero (0)[LST:23]"
  echo "*** Status: Execution error(s)" ;;
 *) echo "ran $b $*" ;;
esac
`;

(process.platform === 'win32' ? suite.skip : suite)('Run with a fake GAMS (log, save all, problems)', function () {
  this.timeout(180000);
  let sysdir: string;
  const cfg = () => vscode.workspace.getConfiguration('gams');
  const logDoc = (): vscode.TextDocument | undefined => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'gams-log');

  suiteSetup(async () => {
    sysdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gams-it-'));
    fs.writeFileSync(path.join(sysdir, 'gams'), FAKE, { mode: 0o755 });
    for (const n of ['long100', 'fast', 'execerr', 'dirty1', 'dirty2']) fs.writeFileSync(path.join(WS, n + '.gms'), `* ${n}\nScalar x /1/;\n`);
    await vscode.extensions.getExtension('eunseong-park.vscode-gams')?.activate();
    await cfg().update('sysdir', sysdir, vscode.ConfigurationTarget.Workspace);
  });

  suiteTeardown(async () => {
    await cfg().update('sysdir', undefined, vscode.ConfigurationTarget.Workspace);
    await cfg().update('log.maxLines', undefined, vscode.ConfigurationTarget.Workspace);
    await exec('workbench.action.closeAllEditors');
    fs.rmSync(sysdir, { recursive: true, force: true });
  });

  async function runAndWait(name: string, timeout = 60000): Promise<vscode.TextDocument> {
    await open(file(name + '.gms'));
    await exec('gams.run');
    return waitFor(`end of ${name}`, () => {
      const d = logDoc();
      const t = d?.getText() ?? '';
      // a truncated log no longer holds the "Running:" line
      return d && (t.includes(`${name}.gms `) || (name.startsWith('long') && t.startsWith('*** Log truncated'))) && /\*\*\* Process ended/.test(t) ? d : undefined;
    }, timeout);
  }

  test('long log: extension host stays responsive, the log is capped and the full log is on disk', async () => {
    await cfg().update('log.maxLines', 20000, vscode.ConfigurationTarget.Workspace);
    let max = 0;
    let last = Date.now();
    const lag = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last - 10); last = now; }, 10);
    let doc: vscode.TextDocument;
    try {
      doc = await runAndWait('long100');
      const links = await exec<vscode.DocumentLink[]>('vscode.executeLinkProvider', doc.uri);
      assert.ok(Array.isArray(links) && links.length > 0);
    } finally {
      clearInterval(lag);
    }
    assert.ok(max < 100, `extension host blocked for ${max} ms`);
    const text = doc.getText();
    assert.match(text.split('\n')[0], /^\*\*\* Log truncated: the first \d+ of \d+ lines are not shown\. Full log: .*long100\.log$/);
    assert.ok(doc.lineCount < 20000 + 3000, `document has ${doc.lineCount} lines`);
    const full = fs.readFileSync(path.join(WS, 'long100.log'), 'utf8').split('\n');
    assert.ok(full.length > 100000, `full log has ${full.length} lines`);
    assert.match(full[0], /^Running: |^--- line 1 /);
    assert.ok(full.some((l) => l.includes('*** Process ended')));
  });

  test('the end of a fast run always reaches the log document (cold start, repeated)', async () => {
    await cfg().update('log.maxLines', undefined, vscode.ConfigurationTarget.Workspace);
    for (let i = 0; i < 25; i++) {
      await exec('workbench.action.closeAllEditors');
      await sleep(100);
      const doc = await runAndWait('fast', 15000);
      assert.match(doc.getText(), /--- fast run/);
    }
  });

  test('F9 saves all modified GAMS files, not only the active one', async () => {
    const a = await open(file('dirty1.gms'));
    const b = await open(file('dirty2.gms'));
    for (const d of [a, b]) {
      const ed = await vscode.window.showTextDocument(d);
      await ed.edit((eb) => eb.insert(new vscode.Position(0, 0), '* edited\n'));
      assert.ok(d.isDirty);
    }
    await exec('gams.run'); // active editor: dirty2
    await waitFor('both saved', async () => {
      if (!a.isDirty && !b.isDirty) return true;
      await exec('gams.run'); // refused while an earlier run is still winding down
      return false;
    }, 60000);
    assert.ok(fs.readFileSync(file('dirty1.gms').fsPath, 'utf8').startsWith('* edited'));
    await waitFor('run end', () => /ran dirty2/.test(logDoc()?.getText() ?? ''));
  });

  test('an execution error gets a Problems entry at the line of the preceding file line', async () => {
    const doc = await runAndWait('execerr');
    assert.match(doc.getText(), /division by zero/);
    const d = await waitFor('diagnostic', () => {
      const x = vscode.languages.getDiagnostics(file('execerr.gms'));
      return x.length ? x : undefined;
    });
    assert.strictEqual(d[0].range.start.line, 1);
    assert.match(d[0].message, /division by zero/);
  });

  test('a wrong gams.sysdir starts no run', async () => {
    await cfg().update('sysdir', path.join(sysdir, 'does-not-exist'), vscode.ConfigurationTarget.Workspace);
    try {
      await open(file('fast.gms'));
      const before = logDoc()?.getText();
      await exec('gams.run');
      await sleep(1500);
      assert.strictEqual(logDoc()?.getText(), before);
    } finally {
      await cfg().update('sysdir', sysdir, vscode.ConfigurationTarget.Workspace);
    }
  });
});
