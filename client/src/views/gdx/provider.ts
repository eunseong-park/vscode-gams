// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { GdxSymbolInfo } from './model';
import type { ExcelExportRequest, RpcMethod, ToExtension, ToWebview } from './protocol';
import { DEFAULT_SUBSTITUTIONS } from './connect';
import { exportCsv } from './export';
import { buildConnectYaml, defaultExportFiles, skippedNote, splitExportSymbols, validateExport, writeConnectFile, xlsxSpecs } from './exportExcel';
import { loadXlsx } from '../xlsx/load';
import { registerGdxDiff } from './diff';
import { detectSysdir } from '../../sysdir';
import { releaseGdx } from '../../lsp';
import { loadDisplayPrefs, loadExportHeaderRow, saveDisplayPrefs, saveExportHeaderRow } from './prefs';
import { CSS } from './webview/style';

export const GDX_VIEW_TYPE = 'gams.gdxViewer';

const RPC_METHODS: Record<RpcMethod, string> = {
  records: 'gams/gdxRecords',
  labels: 'gams/gdxLabels',
  table: 'gams/gdxTable',
  defaults: 'gams/gdxDefaults',
};

/** An open GDX viewer webview, tracked so `gams.openGdxSymbol` can select a symbol in it. */
interface LivePanel {
  panel: vscode.WebviewPanel;
  fsPath: string;
  ready: boolean;
  /** selection requested before the webview reported `ready` */
  queued?: string;
  post(m: ToWebview): void;
}
const livePanels = new Set<LivePanel>();
/** symbol to preselect in the next viewer resolved for a path (command issued before the panel exists) */
const pendingSelect = new Map<string, string>();

function sameFile(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function deliverSelect(lp: LivePanel, name: string): void {
  if (lp.ready) lp.post({ type: 'select', name }); else lp.queued = name;
}

/**
 * Command `gams.openGdxSymbol(uri, symbolName)`: open `uri` in the GDX viewer and select the symbol.
 * The selection is queued until the webview has sent `ready`; an already open viewer is reused.
 */
export async function openGdxSymbol(uri: vscode.Uri | string, symbolName: string): Promise<void> {
  const target = typeof uri === 'string' ? vscode.Uri.file(uri) : uri;
  const fsPath = target.fsPath;
  const existing = [...livePanels].filter((l) => sameFile(l.fsPath, fsPath));
  const visible = existing.filter((l) => l.panel.visible);
  if (existing.length === 0) pendingSelect.set(fsPath, symbolName);
  await vscode.commands.executeCommand('vscode.openWith', target, GDX_VIEW_TYPE);
  const targets = visible.length > 0 ? visible : existing;
  for (const lp of targets) deliverSelect(lp, symbolName);
  // a panel created by the openWith call above picks the name up from pendingSelect when it resolves
}

class GdxDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

/** Read-only custom editor for *.gdx; data comes from the language server (`gams/gdxSymbols`, `gams/gdxRecords`). */
export class GdxEditorProvider implements vscode.CustomReadonlyEditorProvider<GdxDocument> {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => LanguageClient | undefined,
  ) {}

  static register(extensionUri: vscode.Uri, getClient: () => LanguageClient | undefined): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(GDX_VIEW_TYPE, new GdxEditorProvider(extensionUri, getClient), {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand('gams.openGdxSymbol', (uri: vscode.Uri | string, symbolName: string) => openGdxSymbol(uri, symbolName)),
      registerGdxDiff(() => detectSysdir(vscode.workspace.getConfiguration('gams').get<string>('sysdir', ''))),
    );
  }

  openCustomDocument(uri: vscode.Uri): GdxDocument {
    return new GdxDocument(uri);
  }

  resolveCustomEditor(doc: GdxDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    webview.html = renderHtml(webview, vscode.Uri.joinPath(distUri, 'gdxWebview.js'), path.basename(doc.uri.fsPath));

    const post = (m: ToWebview): void => { void webview.postMessage(m); };
    const fsPath = doc.uri.fsPath;
    const live: LivePanel = { panel, fsPath, ready: false, post };
    const pend = pendingSelect.get(fsPath);
    if (pend !== undefined) { pendingSelect.delete(fsPath); live.queued = pend; }
    livePanels.add(live);

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(fsPath)), path.basename(fsPath)),
    );
    let timer: NodeJS.Timeout | undefined;
    const changed = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => post({ type: 'reload' }), 300); // file may still be written
    };
    watcher.onDidChange(changed);
    watcher.onDidCreate(changed);
    watcher.onDidDelete(() => {
      if (timer) clearTimeout(timer);
      post({ type: 'deleted' });
    });

    const sub = webview.onDidReceiveMessage(async (m: ToExtension) => {
      switch (m.type) {
        case 'ready':
          post({ type: 'init', fileName: path.basename(fsPath), language: vscode.env.language, prefs: loadDisplayPrefs(), exportHeaderRow: loadExportHeaderRow() });
          live.ready = true;
          if (live.queued !== undefined) { post({ type: 'select', name: live.queued }); live.queued = undefined; }
          break;
        case 'symbols':
          try {
            const r = await this.request<{ symbols: GdxSymbolInfo[] }>('gams/gdxSymbols', { path: fsPath });
            post({ type: 'symbols', symbols: r.symbols });
          } catch (e) {
            post({ type: 'symbolsError', message: errText(e) });
          }
          break;
        case 'rpc':
          try {
            const result = await this.request<unknown>(RPC_METHODS[m.method], { ...m.params, path: fsPath });
            post({ type: 'rpcResult', reqId: m.reqId, result });
          } catch (e) {
            post({ type: 'rpcError', reqId: m.reqId, message: errText(e) });
          }
          break;
        case 'exportCsv':
          try {
            await exportCsv(m, fsPath, (method, params) => this.request(method, params));
          } catch (e) {
            void vscode.window.showErrorMessage(`GDX export failed: ${errText(e)}`);
          }
          break;
        case 'exportDefaults':
          post({ type: 'exportDefaults', ...defaultExportFiles(fsPath) });
          break;
        case 'browse': {
          const filters: Record<string, string[]> = m.kind === 'excel' ? { 'Excel file': ['xlsx'] } : { 'Connect instructions': ['yaml'] };
          const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(m.current || fsPath), filters, saveLabel: 'Choose', title: m.kind === 'excel' ? 'Choose Excel File...' : 'Choose Connect File...' });
          if (target) post({ type: 'browsed', kind: m.kind, path: target.fsPath });
          break;
        }
        case 'exportExcel':
          try {
            await this.exportExcel(m, fsPath);
          } catch (e) {
            void vscode.window.showErrorMessage(`GDX export failed: ${errText(e)}`);
          }
          break;
        case 'openDiffView':
          await vscode.commands.executeCommand('gams.gdxOpenDiffView', doc.uri);
          break;
        case 'prefs':
          saveDisplayPrefs(m.prefs);
          break;
        case 'clipboard':
          await vscode.env.clipboard.writeText(m.text);
          break;
        case 'saveText': {
          const dir = vscode.Uri.file(path.dirname(fsPath));
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(dir, m.suggestedName),
            filters: { [m.filter]: [path.extname(m.suggestedName).slice(1) || 'txt'] },
          });
          if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(m.text, 'utf8'));
          break;
        }
      }
    });
    panel.onDidDispose(() => {
      livePanels.delete(live);
      if (timer) clearTimeout(timer);
      sub.dispose();
      watcher.dispose();
      void releaseGdx(fsPath);
    });
  }

  /** Port of ExportDialog::save / saveAndExecute: write the Connect file, then (unless "Save") the workbook. */
  private async exportExcel(m: ExcelExportRequest, gdxPath: string): Promise<void> {
    saveExportHeaderRow(m.headerRow === true);
    const v = validateExport(m, gdxPath);
    if (v.error) {
      void vscode.window.showErrorMessage(v.error, { modal: true });
      return;
    }
    for (const f of m.connectOnly ? [v.connectFile] : [v.excelFile, v.connectFile]) {
      if (fs.existsSync(f)) {
        const a = await vscode.window.showWarningMessage(`${path.basename(f)} already exists.\nDo you want to overwrite it?`, { modal: true }, 'Yes');
        if (a !== 'Yes') return;
      }
    }
    await writeConnectFile(v.connectFile, buildConnectYaml(m, gdxPath, v.excelFile));
    if (m.connectOnly) {
      const a = await vscode.window.showInformationMessage(`Saved the Connect file ${v.connectFile}.${skippedNote(splitExportSymbols(m).skipped)}`, 'Open');
      if (a) void vscode.window.showTextDocument(vscode.Uri.file(v.connectFile));
      return;
    }
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Exporting to Excel…' },
      (p) => loadXlsx().exportGdxXlsx(v.excelFile, gdxPath, xlsxSpecs(m), { ...DEFAULT_SUBSTITUTIONS, ...m.substitutions }, (mm, pp) => this.request(mm, pp), (n) => p.report({ message: n })),
    );
    const note = res.truncated.length ? ` ${res.truncated.map((t) => `${t.name}: ${t.reason}`).join('; ')}.` : '';
    const a = await vscode.window.showInformationMessage(`Exported ${res.sheets.length} symbol(s) to ${v.excelFile} (Connect file: ${path.basename(v.connectFile)}).${note}${skippedNote(splitExportSymbols(m).skipped)}`, 'Reveal');
    if (a) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(v.excelFile));
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const c = this.getClient();
    if (!c) return Promise.reject(new Error('The GAMS language server is not running.'));
    return c.sendRequest<T>(method, params);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function renderHtml(webview: vscode.Webview, script: vscode.Uri, title: string): string {
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${n}'`,
    `script-src 'nonce-${n}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title.replace(/[<&>"]/g, '')}</title>
<style nonce="${n}">${CSS}</style></head>
<body><div id="app"></div>
<script nonce="${n}" src="${webview.asWebviewUri(script)}"></script>
</body></html>`;
}
