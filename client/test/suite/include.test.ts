// SPDX-License-Identifier: GPL-3.0-or-later
// `.inc` files have their own language id (`gams-inc`, own Explorer icon) and must get every `gams` feature.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, exec, file, open, waitFor, waitForServer } from './helpers';

const INC = file('mini_data.inc');

suite('Include files (gams-inc)', () => {
  let doc: vscode.TextDocument;
  suiteSetup(async () => {
    await activate();
    await waitForServer(file('mini.gms'));
    doc = await open(INC);
  });

  test('language id and TextMate/semantic tokens like gams', async () => {
    assert.strictEqual(doc.languageId, 'gams-inc');
    const legend = (await exec<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', INC))!;
    assert.ok(legend && legend.tokenTypes.includes('gamsDeclaration'));
    const toks = await waitFor('inc semantic tokens', async () => {
      const r = await exec<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', INC);
      return r && r.data.length > 0 ? r : undefined;
    }, 60000);
    const types = new Set<string>();
    for (let i = 3; i < toks.data.length; i += 5) types.add(legend.tokenTypes[toks.data[i]]);
    for (const t of ['gamsComment', 'gamsDeclaration']) assert.ok(types.has(t), [...types].join(' '));
  });

  test('outline, hover and completion from the language server', async () => {
    const syms = await waitFor('inc outline', async () => {
      const s = await exec<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', INC);
      return s && s.length > 0 ? s : undefined;
    }, 60000);
    const names: string[] = [];
    const walk = (s: vscode.DocumentSymbol[]) => s.forEach((x) => { names.push(x.name); walk(x.children); });
    walk(syms);
    for (const n of ['stock', 'need', 'fee']) assert.ok(names.includes(n), names.join(','));
    const d = await vscode.workspace.openTextDocument({ language: 'gams-inc', content: 'Set i;\n$' });
    const items = await waitFor('inc completion', async () => {
      const r = await exec<vscode.CompletionList>('vscode.executeCompletionItemProvider', d.uri, new vscode.Position(1, 1), '$');
      return r && r.items.length > 0 ? r.items : undefined;
    }, 60000);
    const labels = items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes('$include'), labels.join('|'));
  });

  test('GAMS edit command (column-1 comment) works in an include file', async () => {
    const d = await vscode.workspace.openTextDocument({ language: 'gams-inc', content: 'x = 1;\n' });
    const ed = await vscode.window.showTextDocument(d);
    ed.selection = new vscode.Selection(0, 3, 0, 3);
    await vscode.commands.executeCommand('gams.toggleLineComment');
    assert.match(d.lineAt(0).text, /^\* ?x = 1;$/);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });
});
