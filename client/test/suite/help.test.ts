// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, file, waitFor } from './helpers';

suite('GAMS context help', () => {
  suiteSetup(activate);

  test('gams.contextHelp on $onText opens the GAMS Help webview at the dollar-control anchor', async function () {
    this.timeout(30000);
    const doc = await vscode.workspace.openTextDocument(file('mini.gms'));
    const ed = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split('\n').findIndex((l) => /^\$onText/i.test(l));
    assert.ok(line >= 0);
    ed.selection = new vscode.Selection(line, 3, line, 3);
    const r = (await vscode.commands.executeCommand('gams.contextHelp')) as { shown: string; url: string; target: { page: string; fragment?: string } };
    if (r.shown === 'panel') {
      assert.strictEqual(r.target.page, 'UG_DollarControlOptions.html');
      assert.strictEqual(r.target.fragment, 'DOLLARonofftext');
      assert.match(decodeURIComponent(r.url), /UG_DollarControlOptions\.html#DOLLARonofftext$/);
      const tab = await waitFor('GAMS Help tab', () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputWebview && t.label === 'GAMS Help'), 10000);
      assert.ok(tab);
      // The tab title alone proves nothing (an iframe at an asWebviewUri URL left the panel blank): the docs frame must
      // have rendered the page, and its own script reports the DOM title / first heading back through the shell.
      const st = await waitFor('docs page rendered in the frame', async () => {
        const v = (await vscode.commands.executeCommand('gams.internal.helpState')) as { loaded?: { title: string; heading: string; href: string }; served: string[] };
        return v.loaded && /UG_DollarControlOptions\.html/.test(v.loaded.href) ? v : undefined;
      }, 20000);
      assert.match(st.loaded!.title, /Dollar Control Options/);
      assert.match(st.loaded!.heading, /\S/);
      assert.ok(st.served.includes('UG_DollarControlOptions.html'), `served: ${st.served.join(',')}`);
      console.log('help frame heading:', JSON.stringify(st.loaded!.heading));
      // a target=_blank link to a foreign host cannot open a popup in the sandboxed frame: the click is posted to the shell
      // and forwarded to the extension, which opens it externally (not performed under GAMS_EXT_TEST)
      await vscode.commands.executeCommand('gams._test.helpClick', 'a[target="_blank"][href^="https://www.gams.com/"]');
      const ext = await waitFor('external link request', async () => {
        const v = (await vscode.commands.executeCommand('gams.internal.helpState')) as { external?: string };
        return v.external;
      }, 10000);
      assert.strictEqual(ext, 'https://www.gams.com/');
    } else {
      // no offline docs on this machine: online fallback
      assert.match(r.url, /^https:\/\/www\.gams\.com\/.*UG_DollarControlOptions\.html#DOLLARonofftext$/);
    }
  });
});
