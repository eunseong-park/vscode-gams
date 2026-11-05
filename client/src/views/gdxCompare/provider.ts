// SPDX-License-Identifier: GPL-3.0-or-later
// Host side of the GDX compare view (extension feature): commands `gams.gdxCompare` (two GDX files) and
// `gams.gdxOpenDiffView` (output of gdxdiff), one webview panel per comparison, requests forwarded to the
// language server (`gams/gdxCompare*`, `gams/gdxDiffFile*`) and the CSV / Excel exports.
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { CSS } from '../gdx/webview/style';
import { loadDisplayPrefs, saveDisplayPrefs, setPrefsStore } from '../gdx/prefs';
import { releaseGdx } from '../../lsp';
import { COMPARE_CSS } from './webview/style';
import { DEFAULT_EXPORT_OPTIONS } from './exportModel';
import { exportCompareCsv, optionParams, SymbolRequest } from './exportCsv';
import { loadXlsx } from '../xlsx/load';
import type { CompareSymbol, CompareSymbolsResult } from './model';
import { SYMBOL_STATUS_LABEL, symbolSummary } from './model';
import type { CompareSource, ExportRequest, ToExtension, ToWebview } from './protocol';

export const COMPARE_COMMAND = 'gams.gdxCompare';
export const DIFF_VIEW_COMMAND = 'gams.gdxOpenDiffView';
const VIEW_TYPE = 'gams.gdxCompareView';

const METHODS = {
  files: { symbols: 'gams/gdxCompareSymbols', records: 'gams/gdxCompareRecords', next: 'gams/gdxCompareNext' },
  diffFile: { symbols: 'gams/gdxDiffFileSymbols', records: 'gams/gdxDiffFileRecords', next: 'gams/gdxDiffFileNext' },
} as const;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const GDX_FILTER = { 'GDX files': ['gdx'], 'All files': ['*'] };

/** Parameters that identify the files of a request (the server adds the comparison options). */
export function sourceParams(s: CompareSource): Record<string, unknown> {
  return s.kind === 'files' ? { pathA: s.a, pathB: s.b } : { path: s.path };
}

export function sourceKey(s: CompareSource): string {
  return s.kind === 'files' ? `${s.a}\u0000${s.b}` : `diff:${s.path}`;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function html(webview: vscode.Webview, script: vscode.Uri, title: string): string {
  const n = nonce();
  const csp = ["default-src 'none'", `style-src 'nonce-${n}'`, `script-src 'nonce-${n}'`].join('; ');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title.replace(/[<&>"]/g, '')}</title>
<style nonce="${n}">${CSS}${COMPARE_CSS}</style></head>
<body><div id="app"></div>
<script nonce="${n}" src="${webview.asWebviewUri(script)}"></script>
</body></html>`;
}

export class CompareService {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => LanguageClient | undefined,
  ) {}

  private request<T>(method: string, params: unknown, token?: vscode.CancellationToken): Promise<T> {
    const c = this.getClient();
    if (!c) return Promise.reject(new Error('The GAMS language server is not running.'));
    return token ? c.sendRequest<T>(method, params, token) : c.sendRequest<T>(method, params);
  }

  async compareCommand(first?: vscode.Uri | vscode.Uri[], second?: vscode.Uri | vscode.Uri[]): Promise<void> {
    // explorer: (clicked, selected[]) - the clicked file is part of the selection; programmatic: (uriA, uriB)
    const isGdx = (u: unknown): u is vscode.Uri => u instanceof vscode.Uri && u.fsPath.toLowerCase().endsWith('.gdx');
    let picked: vscode.Uri[];
    if (Array.isArray(second)) picked = second.filter(isGdx);
    else picked = [first, second].flat().filter(isGdx);
    if (picked.length === 0 && isGdx(first)) picked = [first];
    let a: string | undefined = picked[0]?.fsPath;
    let b: string | undefined = picked[1]?.fsPath;
    if (!a) a = await this.pick('Compare GDX files: choose file A');
    if (!a) return;
    if (!b) b = await this.pick('Compare GDX files: choose file B', path.dirname(a));
    if (!b) return;
    await this.open({ kind: 'files', a, b });
  }

  private async pick(title: string, dir?: string): Promise<string | undefined> {
    const r = await vscode.window.showOpenDialog({
      title, canSelectMany: false, filters: GDX_FILTER, defaultUri: dir ? vscode.Uri.file(dir) : undefined,
    });
    return r?.[0]?.fsPath;
  }

  async openDiffFile(file?: vscode.Uri | string): Promise<void> {
    const p = typeof file === 'string' ? file : file?.fsPath ?? (await this.pick('Open a gdxdiff output file'));
    if (p) await this.open({ kind: 'diffFile', path: p });
  }

  async open(source: CompareSource, initialSymbol?: string): Promise<void> {
    const key = sourceKey(source);
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      if (initialSymbol) void existing.webview.postMessage({ type: 'select', name: initialSymbol } satisfies ToWebview);
      return;
    }
    const files = source.kind === 'files' ? [source.a, source.b] : [source.path];
    const title = source.kind === 'files' ? `${path.basename(source.a)} ↔ ${path.basename(source.b)}` : `Diff: ${path.basename(source.path)}`;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist],
    });
    this.panels.set(key, panel);
    panel.webview.html = html(panel.webview, vscode.Uri.joinPath(dist, 'gdxCompareWebview.js'), title);
    const post = (m: ToWebview): void => { void panel.webview.postMessage(m); };

    const watchers = files.map((f) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(f)), path.basename(f)));
      let t: NodeJS.Timeout | undefined;
      const changed = (): void => {
        if (t) clearTimeout(t);
        t = setTimeout(() => post({ type: 'reload' }), 400);
      };
      w.onDidChange(changed);
      w.onDidCreate(changed);
      return w;
    });

    const running = new Map<number, vscode.CancellationTokenSource>();
    const sub = panel.webview.onDidReceiveMessage(async (m: ToExtension) => {
      switch (m.type) {
        case 'ready':
          post({
            type: 'init',
            mode: source.kind,
            fileA: source.kind === 'files' ? source.a : source.path,
            fileB: source.kind === 'files' ? source.b : source.path,
            nameA: source.kind === 'files' ? path.basename(source.a) : 'A',
            nameB: source.kind === 'files' ? path.basename(source.b) : 'B',
            language: vscode.env.language,
            prefs: loadDisplayPrefs(),
            initialSymbol,
          });
          break;
        case 'rpc': {
          const cts = new vscode.CancellationTokenSource();
          running.set(m.reqId, cts);
          try {
            const result = await this.request<unknown>(METHODS[source.kind][m.op], {
              ...sourceParams(source),
              ...(m.params.options ? optionParams(m.params.options) : {}),
              ...m.params, options: undefined,
            }, cts.token);
            post({ type: 'rpcResult', reqId: m.reqId, result });
          } catch (e) {
            post({ type: 'rpcError', reqId: m.reqId, message: cts.token.isCancellationRequested && !/^\[cancelled\]/.test(errText(e)) ? '[cancelled] cancelled' : errText(e) });
          } finally {
            running.delete(m.reqId);
            cts.dispose();
          }
          break;
        }
        case 'cancel':
          running.get(m.reqId)?.cancel();
          break;
        case 'export':
          try {
            await this.runExport(source, m);
          } catch (e) {
            void vscode.window.showErrorMessage(`GDX compare export failed: ${errText(e)}`);
          }
          break;
        case 'openRaw':
          await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(files[0]), 'gams.gdxViewer');
          break;
        case 'swap':
          if (source.kind === 'files') {
            panel.dispose();
            await this.open({ kind: 'files', a: source.b, b: source.a });
          }
          break;
        case 'prefs':
          saveDisplayPrefs(m.prefs);
          break;
        case 'clipboard':
          await vscode.env.clipboard.writeText(m.text);
          break;
      }
    });
    panel.onDidDispose(() => {
      this.panels.delete(key);
      sub.dispose();
      running.forEach((c) => c.cancel());
      watchers.forEach((w) => w.dispose());
      for (const f of files) void releaseGdx(f);
    });
  }

  // ---- export ----

  private async runExport(source: CompareSource, m: ExportRequest): Promise<void> {
    const request = <T>(method: string, p: unknown): Promise<T> => this.request<T>(method, p);
    // the summary needs exact statuses: merge every symbol (cancellable; the server may stop at its deadline)
    let sr: CompareSymbolsResult;
    try {
      sr = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Comparing all symbols…', cancellable: true },
        (_p, token) => this.request<CompareSymbolsResult>(METHODS[source.kind].symbols, { ...sourceParams(source), ...optionParams(m.options), full: true }, token),
      );
    } catch (e) {
      if (/^\[cancelled\]/.test(errText(e)) || /cancel/i.test(errText(e))) return;
      throw e;
    }
    const symbols = sr.symbols;
    const stillPending = symbols.filter((s) => s.status === 'pending').length;
    const truncatedNote = sr.truncated || stillPending ? `${stillPending} symbol(s) could not be compared within the time limit and are listed as Pending.` : undefined;
    if (truncatedNote) void vscode.window.showWarningMessage(`GDX compare: ${truncatedNote}`);
    const items = symbols.map((s) => ({
      label: s.name,
      description: `${SYMBOL_STATUS_LABEL[s.status]} · ${symbolSummary(s)}`,
      picked: m.format === 'csv' ? s.name === m.current : s.status !== 'equal',
      symbol: s,
    }));
    if (m.format === 'csv' && !items.some((i) => i.picked) && items.length) items[0].picked = true;
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: m.format === 'csv' ? 'Export to CSV: choose the symbols (one symbol = one file, several = a folder)' : 'Export to Excel: choose the symbols (one sheet each, plus a Summary sheet)',
      placeHolder: 'Select the symbols to export',
      matchOnDescription: true,
    });
    if (!chosen || chosen.length === 0) return;
    const selected: CompareSymbol[] = chosen.map((c) => c.symbol);
    const nameA = source.kind === 'files' ? path.basename(source.a, '.gdx') : 'diff';
    const nameB = source.kind === 'files' ? path.basename(source.b, '.gdx') : '';
    const baseDir = path.dirname(source.kind === 'files' ? source.a : source.path);
    const stem = nameB ? `${nameA}_vs_${nameB}` : nameA;
    const sreq: SymbolRequest = {
      base: sourceParams(source), method: METHODS[source.kind].records, options: m.options,
      export: { ...DEFAULT_EXPORT_OPTIONS, attrs: m.attrs, diffColumns: m.diffColumns, onlyDiff: m.onlyDiff },
    };
    if (m.format === 'csv') {
      const single = selected.length === 1;
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(baseDir, single ? `${selected[0].name}_${stem}.csv` : `${stem}_csv`)),
        filters: single ? { CSV: ['csv'] } : undefined,
        title: single ? 'Export to CSV' : 'Folder for the CSV files and summary.csv (created)',
      });
      if (!target) return;
      const files = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Exporting the comparison to CSV…' },
        (p) => exportCompareCsv(target.fsPath, selected, symbols, sreq, request, (n) => p.report({ message: n })),
      );
      void vscode.window.showInformationMessage(single ? `Exported ${selected[0].name} to ${target.fsPath}` : `Exported ${selected.length} CSV files and summary.csv to ${target.fsPath}`, 'Reveal')
        .then((a) => { if (a) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(files[0])); });
    } else {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(baseDir, `${stem}.xlsx`)), filters: { 'Excel workbook': ['xlsx'] }, title: 'Export to Excel',
      });
      if (!target) return;
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Exporting the comparison to Excel…' },
        (p) => loadXlsx().exportCompareXlsx(target.fsPath, selected, symbols, sreq, {
          fileA: source.kind === 'files' ? source.a : (sr.fileA ?? ''), fileB: source.kind === 'files' ? source.b : (sr.fileB ?? ''),
          eps: m.options.eps, relEps: m.options.relEps, cmpDefaults: m.options.cmpDefaults, cmpDomains: m.options.cmpDomains, extra: truncatedNote ? [truncatedNote] : undefined,
        }, request, (n) => p.report({ message: n })),
      );
      const note = res.truncated.length ? ` ${res.truncated.map((t) => t.name).join(', ')}: cut at the Excel limit of 1,048,576 rows (see the Summary sheet).` : '';
      void vscode.window.showInformationMessage(`Exported ${selected.length} sheet(s) to ${target.fsPath}.${note}`, 'Reveal')
        .then((a) => { if (a) void vscode.commands.executeCommand('revealFileInOS', target); });
    }
  }
}

/** Register the compare commands. */
export function registerGdxCompare(context: vscode.ExtensionContext, getClient: () => LanguageClient | undefined): vscode.Disposable {
  setPrefsStore(context.globalState);
  const svc = new CompareService(context.extensionUri, getClient);
  void vscode.commands.executeCommand('setContext', 'gams.gdxCompareAvailable', true);
  return vscode.Disposable.from(
    vscode.commands.registerCommand(COMPARE_COMMAND, (a?: vscode.Uri | vscode.Uri[], b?: vscode.Uri | vscode.Uri[]) => svc.compareCommand(a, b)),
    vscode.commands.registerCommand(DIFF_VIEW_COMMAND, (u?: vscode.Uri | string) => svc.openDiffFile(u)),
  );
}

