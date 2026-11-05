// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, file, sleep, startRawClient, waitFor } from './helpers';

const tabInput = (): { viewType?: string } | undefined => {
  const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { viewType?: string } | undefined;
  return t;
};

suite('GDX compare and viewer hooks', () => {
  suiteSetup(activate);

  test('commands are registered and the compare context is set', async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['gams.gdxCompare', 'gams.gdxOpenDiffView', 'gams.openGdxSymbol', 'gams.gdxDiff']) assert.ok(cmds.includes(c), c);
  });

  test('gams.openGdxSymbol opens the GDX viewer on the file', async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand('gams.openGdxSymbol', file('mini.gdx'), 'flow');
    const t = await waitFor('gdx viewer tab', () => {
      const i = tabInput();
      return i?.viewType === 'gams.gdxViewer' ? i : undefined;
    });
    assert.strictEqual(t.viewType, 'gams.gdxViewer');
    // a second call reuses the open editor (no error, the select message is posted)
    await vscode.commands.executeCommand('gams.openGdxSymbol', file('mini.gdx'), 'fee');
    await sleep(200);
    assert.strictEqual(tabInput()?.viewType, 'gams.gdxViewer');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('gams.gdxCompare opens the compare panel for two files', async function () {
    this.timeout(20000);
    const f = file('mini.gdx');
    await vscode.commands.executeCommand('gams.gdxCompare', f, f);
    const t = await waitFor('compare webview tab', () => {
      const i = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { viewType?: string } | undefined;
      return i?.viewType?.endsWith('gams.gdxCompareView') ? i : undefined;
    });
    assert.ok(t);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('compare requests answer through the bundled server', async () => {
    const c = await startRawClient();
    try {
      const p = file('mini.gdx').fsPath;
      const r = await c.sendRequest<{ symbols: Array<{ name: string; status: string }> }>('gams/gdxCompareSymbols', { pathA: p, pathB: p });
      // the default summary merges nothing: statuses are exact only where the symbol tables tell, the rest is pending
      assert.ok(r.symbols.length > 0 && r.symbols.every((s) => s.status === 'pending' || s.status === 'equal'));
      const full = await c.sendRequest<{ symbols: Array<{ name: string; status: string }>; truncated?: boolean }>('gams/gdxCompareSymbols', { pathA: p, pathB: p, full: true });
      assert.ok(full.symbols.length > 0 && full.symbols.every((s) => s.status === 'equal'));
      const some = await c.sendRequest<{ symbols: Array<{ name: string; status: string }> }>('gams/gdxCompareSymbols', { pathA: p, pathB: p, names: [full.symbols[0].name] });
      assert.strictEqual(some.symbols[0].status, 'equal');
      const rec = await c.sendRequest<{ total: number }>('gams/gdxCompareRecords', { pathA: p, pathB: p, name: 'flow', limit: 5 });
      assert.ok(rec.total > 0);
    } finally {
      await c.stop();
    }
  });
});
