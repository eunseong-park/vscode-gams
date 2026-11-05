// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, exec, file, open, posOf, startRawClient, waitFor, waitForServer, EXT_ID } from './helpers';

const TRN = file('mini.gms');

suite('Activation and language ids', () => {
  suiteSetup(activate);

  test('extension activates and commands exist', async () => {
    assert.ok(vscode.extensions.getExtension(EXT_ID)?.isActive);
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['gams.run', 'gams.compile', 'gams.interrupt', 'gams.stop', 'gams.showLog']) assert.ok(cmds.includes(c), c);
  });

  test('language ids by extension', async () => {
    const ids: Array<[string, string]> = [
      ['mini.gms', 'gams'], ['mini_data.inc', 'gams-inc'], ['mini.lst', 'gams-lst'], ['cplex.opt', 'gams-opt'],
      ['mini.ref', 'gams-ref'], ['mini.lxi', 'gams-lxi'],
    ];
    for (const [f, id] of ids) assert.strictEqual((await vscode.workspace.openTextDocument(file(f))).languageId, id, f);
    const all = await vscode.languages.getLanguages();
    for (const id of ['gams', 'gams-inc', 'gams-opt', 'gams-lst', 'gams-gdx', 'gams-ref', 'gams-lxi', 'gams-gsp']) assert.ok(all.includes(id), id);
  });

  test('.gdx opens in the GDX viewer by default', async () => {
    await vscode.commands.executeCommand('vscode.open', file('mini.gdx'));
    const tab = await waitFor('gdx tab', () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.fsPath.endsWith('mini.gdx')));
    assert.strictEqual((tab.input as vscode.TabInputCustom).viewType, 'gams.gdxViewer');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('.gdx opens in the custom editor', async () => {
    await vscode.commands.executeCommand('vscode.openWith', file('mini.gdx'), 'gams.gdxViewer');
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.fsPath.endsWith('mini.gdx'));
    assert.ok(tab, 'custom editor tab');
    assert.strictEqual((tab!.input as vscode.TabInputCustom).viewType, 'gams.gdxViewer');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('GDX symbols via gams/gdxSymbols', async () => {
    const c = await startRawClient();
    try {
      const r = await c.sendRequest<{ symbols: Array<{ name: string }> }>('gams/gdxSymbols', { path: file('mini.gdx').fsPath });
      assert.strictEqual(r.symbols.length, 10);
      assert.ok(r.symbols.some((s) => s.name === 'flow'));
    } finally {
      await c.stop();
    }
  });
});

suite('Language server features (mini.gms)', () => {
  let doc: vscode.TextDocument;
  suiteSetup(async () => {
    await activate();
    await waitForServer(TRN);
    doc = await open(TRN);
  });

  test('semantic tokens legend has gams* types', async () => {
    const legend = await exec<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', TRN);
    assert.ok(legend, 'legend');
    for (const t of ['gamsDco', 'gamsDeclaration', 'gamsDescription', 'gamsComment']) assert.ok(legend.tokenTypes.includes(t), t);
    assert.ok(legend.tokenTypes.filter((t) => t.startsWith('gams')).length >= 10);
  });

  test('"Positive Variable" is gamsDeclaration, description is gamsDescription', async () => {
    const legend = (await exec<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', TRN))!;
    const toks = (await exec<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', TRN))!;
    assert.ok(toks && toks.data.length > 0);
    const decoded: Array<{ line: number; ch: number; len: number; type: string }> = [];
    let line = 0, ch = 0;
    for (let i = 0; i < toks.data.length; i += 5) {
      const [dl, dc, len, ty] = toks.data.slice(i, i + 4);
      line += dl;
      ch = dl ? dc : ch + dc;
      decoded.push({ line, ch, len, type: legend.tokenTypes[ty] });
    }
    const textOf = (t: { line: number; ch: number; len: number }) => doc.lineAt(t.line).text.substr(t.ch, t.len);
    const pv = doc.positionAt(doc.getText().indexOf('Positive Variable flow;'));
    const onLine = decoded.filter((t) => t.line === pv.line);
    const kw = onLine.filter((t) => t.ch < 'Positive Variable'.length);
    assert.ok(kw.length >= 1 && kw.every((t) => t.type === 'gamsDeclaration'), JSON.stringify(onLine.map((t) => [textOf(t), t.type])));
    assert.ok(kw.map(textOf).join(' ').includes('Positive'), 'Positive covered');
    const desc = decoded.find((t) => textOf(t).includes("'depots'"));
    assert.ok(desc, 'description token');
    assert.strictEqual(desc!.type, 'gamsDescription');
  });

  test('"$" completion at the line start offers DCOs', async () => {
    const d = await vscode.workspace.openTextDocument({ language: 'gams', content: 'Set i;\n$' });
    const items = await waitFor('gms completion', async () => {
      const r = await exec<vscode.CompletionList>('vscode.executeCompletionItemProvider', d.uri, new vscode.Position(1, 1), '$');
      return r && r.items.length > 0 ? r.items : undefined;
    }, 60000);
    const labels = items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    for (const n of ['$onText', '$include', '$call.async']) assert.ok(labels.includes(n), n);
  });

  test('typed blank completes declaration and solve keywords (extension)', async () => {
    const d = await vscode.workspace.openTextDocument({ language: 'gams', content: 'Model m /all/;\nPositive ;\nsolve m ;\ndisplay ;\n' });
    const at = async (line: number, col: number) => {
      const r = await exec<vscode.CompletionList>('vscode.executeCompletionItemProvider', d.uri, new vscode.Position(line, col), ' ');
      return (r?.items ?? []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    };
    const decl = await waitFor('blank after Positive', async () => {
      const l = await at(1, 9);
      return l.length > 0 ? l : undefined;
    }, 60000);
    assert.ok(decl.includes('Variable'), decl.join('|'));
    assert.ok((await at(2, 8)).includes('using'));
  });

  test('MPSGE block: section keyword and field label get the gamsMpsge* token types (extension)', async () => {
    const content = '$onText\n$MODEL:tiny\n$PROD:Y s:1\n  O:P  Q:1\n$offText\n';
    const d = await vscode.workspace.openTextDocument({ language: 'gams', content });
    const legend = (await exec<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', d.uri))!;
    const toks = await waitFor('mpsge tokens', async () => {
      const r = await exec<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', d.uri);
      return r && r.data.length > 0 ? r : undefined;
    }, 60000);
    const found: string[] = [];
    let line = 0, ch = 0;
    for (let i = 0; i < toks.data.length; i += 5) {
      const [dl, dc, len, ty] = toks.data.slice(i, i + 4);
      line += dl;
      ch = dl ? dc : ch + dc;
      found.push(`${legend.tokenTypes[ty]}:${d.lineAt(line).text.substr(ch, len)}`);
    }
    assert.ok(found.includes('gamsMpsgeSection:$PROD:'), found.join(' '));
    assert.ok(found.includes('gamsMpsgeField:Q:'), found.join(' '));
    assert.ok(found.includes('gamsDco:$onText'), found.join(' '));
  });

  test('outline lists declared symbols', async () => {
    const syms = (await exec<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', TRN)) ?? [];
    const names: string[] = [];
    const walk = (s: vscode.DocumentSymbol[]) => s.forEach((x) => { names.push(x.name); walk(x.children); });
    walk(syms);
    for (const n of ['d', 's', 'stock', 'need', 'fee', 'flow', 'total', 'obj', 'cap', 'dem']) assert.ok(names.includes(n), `${n} in ${names.join(',')}`);
  });

  test('folding ranges include the $onText block', async () => {
    const fr = (await exec<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', TRN)) ?? [];
    const start = doc.positionAt(doc.getText().indexOf('$onText')).line;
    const end = doc.positionAt(doc.getText().indexOf('$offText')).line;
    assert.ok(fr.some((r) => r.start === start && r.end >= end - 1 && r.end <= end), JSON.stringify(fr));
  });

  test('document links resolve for $include and $batinclude (real fixtures)', async () => {
    for (const [f, inc] of [['mini_inc.gms', 'mini_data.inc'], ['mini_bat.gms', 'mini_rep.inc']] as const) {
      await open(file(f));
      const links = await waitFor(`include links of ${f}`, async () => {
        const l = (await exec<vscode.DocumentLink[]>('vscode.executeLinkProvider', file(f))) ?? [];
        return l.some((x) => x.target?.fsPath.endsWith(inc)) ? l : undefined;
      }, 30000);
      assert.ok(links.length >= 1);
    }
    // the include file itself has no includes; must not throw
    assert.ok(Array.isArray(await exec<vscode.DocumentLink[]>('vscode.executeLinkProvider', file('mini_data.inc'))));
  });

  test('diagnostics: none for a clean file', async () => {
    assert.strictEqual(vscode.languages.getDiagnostics(TRN).length, 0);
  });
});

suite('Reference-based features (mini.ref)', () => {
  let doc: vscode.TextDocument;
  suiteSetup(async () => {
    await activate();
    await waitForServer(TRN);
    doc = await open(TRN);
    // the .ref is loaded when the document opens; wait until references use it
    await waitFor('reference data', async () => {
      const r = await exec<vscode.Location[]>('vscode.executeReferenceProvider', TRN, posOf(doc, 'Positive Variable flow;').translate(0, 18));
      return r && r.length > 3;
    });
  });

  test('definition of flow (in obj equation) -> declaration', async () => {
    const use = posOf(doc, 'flow(d,s));'); // inside sum in obj..
    const defs = (await exec<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', TRN, use)) ?? [];
    assert.ok(defs.length >= 1);
    const d = defs[0] as vscode.Location;
    const range = (d as vscode.Location).range ?? (d as unknown as vscode.LocationLink).targetRange;
    assert.strictEqual(range.start.line, posOf(doc, 'flow(d,s) \'units shipped\'').line);
  });

  test('references of fee include declaration and use', async () => {
    const pos = posOf(doc, 'fee(d,s) \'cost per unit\'');
    const refs = (await exec<vscode.Location[]>('vscode.executeReferenceProvider', TRN, pos)) ?? [];
    const lines = new Set(refs.map((r) => r.range.start.line));
    assert.ok(lines.has(pos.line), 'declaration');
    assert.ok(lines.has(posOf(doc, 'fee(d,s)*flow').line), 'use in obj');
    assert.ok(refs.length >= 2, `${refs.length}`);
  });

  test('hover on flow and fee shows type, domain and text', async () => {
    for (const [needle, expect, text] of [['flow(d,s) \'units shipped', 'Variable flow(d,s)', 'units shipped'], ['fee(d,s) \'cost per unit', 'Parameter fee(d,s)', 'cost per unit']] as const) {
      const h = (await exec<vscode.Hover[]>('vscode.executeHoverProvider', TRN, posOf(doc, needle))) ?? [];
      const v = h.flatMap((x) => x.contents).map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
      assert.ok(v.includes(expect) && v.includes(text), v);
    }
  });

  test('gams/refSymbols tree data', async () => {
    const c = await startRawClient();
    try {
      // a fresh server loads <stem>.ref when it sees the document open
      await c.sendNotification('textDocument/didOpen', { textDocument: { uri: TRN.toString(), languageId: 'gams', version: 1, text: doc.getText() } });
      const r = await c.sendRequest<{ refPath?: string; symbols: Array<{ name: string; type: string; dim: number; domain: string[]; locations: Record<string, unknown[]> }> }>('gams/refSymbols', { gmsUri: TRN.toString() });
      assert.ok(r.refPath);
      const x = r.symbols.find((s) => s.name === 'flow')!;
      assert.strictEqual(x.type, 'Variable');
      assert.strictEqual(x.dim, 2);
      assert.deepStrictEqual(x.domain, ['d', 's']);
      assert.ok(x.locations.declare.length > 0);
      const d = r.symbols.find((s) => s.name === 'fee')!;
      assert.strictEqual(d.type, 'Parameter');
    } finally {
      await c.stop();
    }
  });
});

suite('Listing and option files', () => {
  suiteSetup(activate);

  test('.lst outline from .lxi', async () => {
    const lst = file('mini.lst');
    await open(lst);
    const syms = await waitFor('lst outline', async () => {
      const s = await exec<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', lst);
      return s && s.length > 0 ? s : undefined;
    }, 60000);
    const names: string[] = [];
    const walk = (s: vscode.DocumentSymbol[]) => s.forEach((x) => { names.push(x.name); walk(x.children); });
    walk(syms);
    assert.ok(names.some((n) => n.includes('Equation Listing')), names.join('|'));
    assert.ok(names.some((n) => n === 'obj'), names.join('|'));
  });

  test('cplex.opt completion offers option names', async () => {
    const uri = file('cplex.opt');
    const doc = await open(uri);
    const items = await waitFor('opt completion', async () => {
      const r = await exec<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, new vscode.Position(doc.lineCount - 1, 0));
      return r && r.items.length > 0 ? r.items : undefined;
    }, 60000);
    const labels = items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label).toLowerCase());
    for (const n of ['lpmethod', 'epgap']) assert.ok(labels.includes(n), n);
    assert.strictEqual(vscode.languages.getDiagnostics(uri).length, 0);
  });

  test('invalid option yields a diagnostic', async () => {
    const uri = file('bad', 'cplex.opt');
    await open(uri);
    const diags = await waitFor('opt diagnostics', () => {
      const d = vscode.languages.getDiagnostics(uri);
      return d.length > 0 ? d : undefined;
    }, 60000);
    assert.ok(diags.some((d) => /unknown option/i.test(d.message)), diags.map((d) => d.message).join('|'));
    assert.ok(diags.some((d) => d.range.start.line === 1));
  });
});
