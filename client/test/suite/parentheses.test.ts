// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, file, sleep, waitFor, waitForServer } from './helpers';

type Dec = { valid: number[][]; invalid: number[][] };

suite('Studio parentheses', () => {
  suiteSetup(async () => {
    await activate();
    await waitForServer(file('mini.gms'));
  });

  async function openText(text: string): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({ language: 'gams', content: text });
    return vscode.window.showTextDocument(doc);
  }
  const decs = (): Thenable<Dec> => vscode.commands.executeCommand<Dec>('gams._test.parenthesisDecorations');

  test('cursor after ) highlights the pair; Ctrl+B jumps and back', async () => {
    const ed = await openText('x = (a +\n  b);\n');
    ed.selection = new vscode.Selection(1, 4, 1, 4); // just after ')'
    const d = await waitFor('valid decoration', async () => {
      const v = await decs();
      return v.valid.length === 2 ? v : undefined;
    });
    assert.deepStrictEqual(d.valid, [[0, 4, 0, 5], [1, 3, 1, 4]]);
    await vscode.commands.executeCommand('gams.jumpToMatchingParenthesis');
    assert.deepStrictEqual([ed.selection.active.line, ed.selection.active.character], [0, 5]);
    await vscode.commands.executeCommand('gams.jumpToMatchingParenthesis');
    assert.deepStrictEqual([ed.selection.active.line, ed.selection.active.character], [1, 4]);
  });

  test('mismatch uses the invalid decoration', async () => {
    const ed = await openText('x = (a];\n');
    ed.selection = new vscode.Selection(0, 4, 0, 4);
    const d = await waitFor('invalid decoration', async () => {
      const v = await decs();
      return v.invalid.length === 2 ? v : undefined;
    });
    assert.strictEqual(d.valid.length, 0);
    await sleep(10);
  });
});
