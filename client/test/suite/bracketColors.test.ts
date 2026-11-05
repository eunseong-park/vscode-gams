// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, file, waitFor, waitForServer } from './helpers';

type Dec = { version: number; types: number[][][] };

const SNIPPETS = [
  '$eolCom !',
  'parameters',
  '  flexiblePFX  Logical flag (1=flexible exchange rate) /1/,',
  '  m0(g)  Imports (cif)',
  '  ;',
  'market(g,"m0") = m0(g);   ! Imports (cif)',
  'x = sum(s, (a[1]) + "(");',
  '* a (comment)',
  'y = (b];',
  '',
].join('\n');

suite('Bracket nesting colors', () => {
  suiteSetup(async () => {
    await activate();
    await waitForServer(file('mini.gms'));
  });

  async function openText(text: string): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({ language: 'gams', content: text });
    return vscode.window.showTextDocument(doc);
  }
  const decs = (ed: vscode.TextEditor): Thenable<Dec | undefined> => vscode.commands.executeCommand<Dec | undefined>('gams._test.bracketDecorations');
  const ready = (ed: vscode.TextEditor): Promise<Dec> =>
    waitFor('bracket decorations', async () => {
      const d = await decs(ed);
      return d && d.version === ed.document.version && d.types.some((t) => t.length) ? d : undefined;
    });
  const colOf = (line: number, needle: string, nth = 0): number => {
    const l = SNIPPETS.split('\n')[line];
    let i = -1;
    for (let k = 0; k <= nth; k++) i = l.indexOf(needle, i + 1);
    return i;
  };
  const at = (d: Dec, line: number, col: number): number => d.types.findIndex((t) => t.some((r) => r[0] === line && r[1] === col));

  test('descriptions and custom end-of-line comments are not decorated; code brackets are', async () => {
    const ed = await openText(SNIPPETS);
    const d = await ready(ed);
    const all = d.types.flat();
    // (1) unquoted symbol descriptions
    assert.strictEqual(all.filter((r) => r[0] === 2 && r[1] < colOf(2, '/1/')).length, 0, 'flexiblePFX description');
    assert.strictEqual(all.filter((r) => r[0] === 3 && r[1] > colOf(3, ')')).length, 0, 'm0(g) description');
    // domain of m0(g) in the declaration is decorated
    assert.strictEqual(at(d, 3, colOf(3, '(')), 0);
    assert.strictEqual(at(d, 3, colOf(3, ')')), 0);
    // (2) `! Imports (cif)` after `$eolCom !`
    const bang = colOf(5, '!');
    assert.strictEqual(all.filter((r) => r[0] === 5 && r[1] > bang).length, 0, 'eol comment');
    assert.strictEqual(all.filter((r) => r[0] === 5).length, 4); // market(...) and m0(g) pairs
    assert.strictEqual(at(d, 5, colOf(5, 'm0(g)') + 2), 0);
    // quoted "(" and `*` comment line: nothing
    assert.strictEqual(all.filter((r) => r[0] === 6 && r[1] === colOf(6, '"') + 1).length, 0, 'quoted (');
    assert.strictEqual(all.filter((r) => r[0] === 7).length, 0);
  });

  test('colors cycle by nesting depth over all bracket types; mismatches are unexpected', async () => {
    const ed = await openText(SNIPPETS);
    const d = await ready(ed);
    // x = sum(s, (a[1]) + "(");  depths: sum( 0, ( 1, [ 2, ] 2, ) 1, ) 0
    assert.deepStrictEqual(
      [colOf(6, 'sum(') + 3, colOf(6, '(a'), colOf(6, '['), colOf(6, ']'), colOf(6, ')'), colOf(6, ')', 1)].map((c) => at(d, 6, c)),
      [0, 1, 2, 2, 1, 0],
    );
    // y = (b];  -> unexpected-bracket type (index 6)
    assert.strictEqual(at(d, 8, colOf(8, '(')), 6);
    assert.strictEqual(at(d, 8, colOf(8, ']')), 6);
  });

  test('editing re-decorates; turning the setting off removes the decorations', async () => {
    const ed = await openText('x = (a);\n');
    await ready(ed);
    await ed.edit((b) => b.insert(new vscode.Position(0, 4), '['));
    const d = await waitFor('updated decorations', async () => {
      const v = await decs(ed);
      return v && v.version === ed.document.version && v.types[6].length === 1 ? v : undefined; // `[` is unclosed
    });
    assert.strictEqual(d.types[6][0][1], 4);
    const cfg = vscode.workspace.getConfiguration('gams');
    await cfg.update('editor.bracketNestingColors', false, vscode.ConfigurationTarget.Global);
    try {
      await waitFor('decorations removed', async () => (await decs(ed)) === undefined);
    } finally {
      await cfg.update('editor.bracketNestingColors', undefined, vscode.ConfigurationTarget.Global);
    }
    await ready(ed);
  });

  test('VS Code bracket pair colorization is off for GAMS by default', () => {
    const cfg = vscode.workspace.getConfiguration('editor', { languageId: 'gams' });
    assert.strictEqual(cfg.get('bracketPairColorization.enabled'), false);
  });
});
