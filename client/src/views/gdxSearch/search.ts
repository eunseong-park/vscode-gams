// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { dimsText, ElementMatch, filterSymbols, IndexedSymbol, nextSort, parseElementQuery, parseSymbolQuery, SortBy, sortSymbols, symbolDescription } from './query';
import { GdxIndexService, openSymbol, relPath, typeIcon } from './service';

const MAX_ITEMS = 1500;
const HELP = 'name words, type:par,var  dim:2  file:glob  /regex/ (case-insensitive; /re/s = case-sensitive)';

interface SymItem extends vscode.QuickPickItem {
  sym: IndexedSymbol;
}

const sortButton = (by: SortBy): vscode.QuickInputButton => ({
  iconPath: new vscode.ThemeIcon('sort-precedence'),
  tooltip: `Sorted by ${by} (click to change)`,
});
const refreshButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Re-scan workspace' };

function withProgress<T>(title: string, f: (token: vscode.CancellationToken) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (_p, token) => f(token));
}

/** GAMS: Find Symbol in GDX Files */
export async function findSymbolInGdx(svc: GdxIndexService): Promise<void> {
  const qp = vscode.window.createQuickPick<SymItem>();
  qp.placeholder = HELP;
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  let sort: SortBy = vscode.workspace.getConfiguration('gams.gdxSearch').get<SortBy>('sort', 'name');
  let all: IndexedSymbol[] = [];
  let skipped = 0;
  const cts = new vscode.CancellationTokenSource();
  const update = (): void => {
    const q = parseSymbolQuery(qp.value);
    qp.buttons = [sortButton(sort), refreshButton];
    if (q.error) {
      qp.title = q.error;
      return;
    }
    const hits = sortSymbols(filterSymbols(all, q), sort);
    const shown = hits.slice(0, MAX_ITEMS);
    qp.title = `GDX symbols: ${hits.length} of ${all.length}${hits.length > shown.length ? ` (first ${shown.length} shown)` : ''}, sorted by ${sort}${skipped ? `, ${skipped} unreadable file(s)` : ''}`;
    qp.items = shown.map((s) => ({
      label: s.name,
      iconPath: typeIcon(s.type),
      description: symbolDescription(s),
      detail: (s.text ? s.text + '  —  ' : '') + s.rel,
      alwaysShow: true,
      sym: s,
    }));
  };
  const load = async (): Promise<void> => {
    qp.busy = true;
    qp.title = 'Indexing GDX files...';
    try {
      const r = await svc.indexSymbols(cts.token);
      all = r.symbols;
      skipped = r.errors;
    } catch (e) {
      if (!cts.token.isCancellationRequested) void vscode.window.showErrorMessage(`GDX search failed: ${(e as Error).message}`);
    }
    qp.busy = false;
    update();
  };
  qp.onDidChangeValue(update);
  qp.onDidTriggerButton((b) => {
    if (b === refreshButton) void load();
    else {
      sort = nextSort(sort);
      update();
    }
  });
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0];
    if (!it) return;
    qp.hide();
    void openSymbol(it.sym.file, it.sym.name);
  });
  qp.onDidHide(() => {
    cts.cancel();
    qp.dispose();
  });
  update();
  qp.show();
  await load();
}

interface ElItem extends vscode.QuickPickItem {
  m: ElementMatch;
}

/** GAMS: Find Element in GDX Files */
export async function findElementInGdx(svc: GdxIndexService, initial?: string): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Find Element in GDX Files',
    prompt: 'Label to look for. /regex/ for a regular expression; prefix case: for case-sensitive matching.',
    value: initial,
    validateInput: (v) => (v ? parseElementQuery(v).error : undefined),
  });
  if (!input) return;
  const q = parseElementQuery(input);
  if (q.error) return;
  try {
    const r = await withProgress(`Searching GDX files for "${q.label}"...`, async (token) =>
      svc.findElement(await svc.findFiles(token), q, token),
    );
    if (!r.matches.length) {
      void vscode.window.showInformationMessage(`No GDX symbol uses "${q.label}"${r.truncated ? ' (search was incomplete)' : ''}.`);
      return;
    }
    const items: ElItem[] = r.matches.map((m) => ({
      label: m.symbol,
      iconPath: typeIcon(m.type),
      description: `${m.type} · ${m.dim}D · ${dimsText(m.dims)}`,
      detail: `${relPath(vscode.Uri.file(m.path))}  —  ${m.labels.join(', ')}`,
      m,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: `"${q.label}" in ${r.filesWithLabel} GDX file(s): ${items.length} symbol(s)${r.truncated ? ' (incomplete)' : ''}`,
      matchOnDetail: true,
      matchOnDescription: true,
    });
    if (pick) await openSymbol(pick.m.path, pick.m.symbol);
  } catch (e) {
    if (e instanceof vscode.CancellationError) return;
    void vscode.window.showErrorMessage(`GDX search failed: ${(e as Error).message}`);
  }
}
