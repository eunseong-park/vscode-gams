// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, file, startRawClient } from './helpers';

suite('Workspace GDX search', () => {
  suiteSetup(activate);

  test('commands are registered', async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['gams.gdxSearch.symbol', 'gams.gdxSearch.element', 'gams.gdxFiles.refresh', 'gams.gdxFiles.open']) assert.ok(cmds.includes(c), c);
    await vscode.commands.executeCommand('gams.gdxFiles.refresh');
  });

  test('gams/gdxIndex and gams/gdxFindElement', async () => {
    const c = await startRawClient();
    try {
      const p = file('mini.gdx').fsPath;
      const idx = await c.sendRequest<{ files: Array<{ symbols: Array<{ name: string; type: string }> }> }>('gams/gdxIndex', { paths: [p] });
      assert.ok(idx.files[0].symbols.some((s) => s.name === 'flow' && s.type === 'Variable'));
      const r = await c.sendRequest<{ matches: Array<{ symbol: string }> }>('gams/gdxFindElement', { paths: [p], label: 'north' });
      assert.ok(r.matches.some((m) => m.symbol === 'flow'));
    } finally {
      await c.stop();
    }
  });
});
