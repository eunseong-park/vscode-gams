// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, file, open, waitFor } from './helpers';
import { RUN_GAMS } from './helpers';

// These start real GAMS processes (network license); enable with GAMS_RUN_TESTS=1.
(RUN_GAMS ? suite : suite.skip)('GAMS runs (GAMS_RUN_TESTS=1)', function () {
  this.timeout(180000);
  suiteSetup(activate);

  test('F9 on mini.gms: no diagnostics, log document exists', async () => {
    const uri = file('mini.gms');
    await open(uri);
    await vscode.commands.executeCommand('gams.run');
    const log = await waitFor('log doc', () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'gams-log' && /\*\*\* Process ended/.test(d.getText())), 150000);
    // wait for the run to finish ("*** Process ended") so the next test's compile isn't refused
    assert.match(log.getText(), /Normal completion/);
    assert.strictEqual(vscode.languages.getDiagnostics(uri).length, 0);
  });

  // expected positions come from server/tests/fixtures/mini_err.log (real GAMS 54.6 output)
  test('compile mini_err.gms yields 3 diagnostics in the main file and 2 in the include', async () => {
    const uri = file('mini_err.gms');
    const inc = file('mini_err_inc.inc');
    await open(uri);
    await vscode.commands.executeCommand('gams.compile');
    const d = await waitFor('error diagnostics', () => {
      const x = vscode.languages.getDiagnostics(uri);
      return x.length >= 3 && vscode.languages.getDiagnostics(inc).length >= 2 ? x : undefined;
    }, 150000);
    const pos = (x: vscode.Diagnostic[]) => x.map((e) => `${e.range.start.line + 1},${e.range.start.character + 1}`).sort();
    assert.strictEqual(d.length, 3);
    assert.deepStrictEqual(pos(d), ['11,30', '12,27', '9,34']);
    assert.match(d.map((e) => e.message).join('|'), /Unknown symbol/);
    assert.match(d.map((e) => e.message).join('|'), /Unable to open include file/);
    const di = vscode.languages.getDiagnostics(inc);
    assert.deepStrictEqual(pos(di), ['2,35', '3,20']);
    assert.match(di.map((e) => e.message).join('|'), /Domain violation for element/);
    // wait until the compile has finished, so the next test's run is not refused as "already running"
    await waitFor('end of compile', () => vscode.workspace.textDocuments.find((t) => t.uri.scheme === 'gams-log' && /\*\*\* Process ended/.test(t.getText())), 150000);
  });
});
