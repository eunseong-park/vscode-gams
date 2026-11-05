// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "GAMS Help" webview showing the offline docs (docs/ of the GAMS system directory) in an iframe. The frame points at a
 * loopback-only static server (docsServer.ts): a frame pointing at an asWebviewUri URL rendered nothing (verified by
 * screenshot in the xvfb integration environment).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CHAPTER, HelpTarget, relativeUrl } from './helpData';
import { DocsServer, startDocsServer } from './docsServer';
import { docFileOfUrl, isOpenableUrl } from './links';

export interface DocLoaded { title: string; heading: string; href: string }

export class HelpPanel {
  private static current: HelpPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  /** Last page the docs frame reported (title and first heading of the rendered DOM), for tests. */
  static lastLoaded: DocLoaded | undefined;
  /** Last external link / download the docs frame asked to open (validated), for tests. */
  static lastExternal: string | undefined;
  static get servedPages(): string[] { return HelpPanel.current?.server.served ?? []; }

  /**
   * Base URL the webview (which may run on another machine, e.g. Windows over Remote-SSH) uses to reach the docs server:
   * vscode.env.asExternalUri forwards the loopback port and returns the client-side address (unchanged when local).
   * portMapping alone does not cover navigations of a nested iframe, which left the panel blank over SSH.
   */
  private readonly base: string;

  private static zoomState: vscode.Memento | undefined;
  /** Remembers the docs zoom factor (globalState) across panels and sessions. */
  static setZoomStore(m: vscode.Memento): void { HelpPanel.zoomState = m; }
  private static get zoom(): number { return HelpPanel.zoomState?.get<number>('gams.help.zoom', 1) ?? 1; }

  private constructor(private readonly docsDir: string, private readonly server: DocsServer, external: vscode.Uri, private onlineOf: () => string | undefined, first: HelpTarget) {
    const token = new URL(server.base).pathname; // "/<token>/"
    this.base = `${external.scheme}://${external.authority}${token}`;
    server.allowHost(external.authority);
    this.panel = vscode.window.createWebviewPanel(
      'gams.help',
      'GAMS Help',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
        portMapping: [{ webviewPort: server.port, extensionHostPort: server.port }],
      },
    );
    this.panel.onDidDispose(() => {
      if (HelpPanel.current === this) HelpPanel.current = undefined;
      void this.server.close();
    });
    this.panel.webview.onDidReceiveMessage((m: { type?: string; title?: unknown; heading?: unknown; href?: unknown }) => {
      if (m.type === 'loaded') {
        const str = (v: unknown): string => (typeof v === 'string' ? v.substring(0, 500) : '');
        HelpPanel.lastLoaded = { title: str(m.title), heading: str(m.heading), href: str(m.href) };
      } else if (m.type === 'zoom' && typeof (m as { value?: unknown }).value === 'number') {
        const v = Math.min(3, Math.max(0.5, (m as { value: number }).value));
        void HelpPanel.zoomState?.update('gams.help.zoom', v);
      } else if (m.type === 'external') {
        void this.openLink((m as { url?: unknown }).url);
      } else if (m.type === 'online') {
        const u = this.onlineOf();
        if (u) void vscode.env.openExternal(vscode.Uri.parse(u));
      }
    });
    this.panel.webview.html = this.html(first);
  }

  /** A link the docs frame could not open itself: external pages go to the browser, served files are saved. */
  private async openLink(url: unknown): Promise<void> {
    if (!isOpenableUrl(url)) return;
    HelpPanel.lastExternal = url;
    if (process.env.GAMS_EXT_TEST === '1') return;
    const file = docFileOfUrl([this.base, this.server.base.replace(/docs\/$/, '')], url, this.docsDir);
    if (!file) {
      if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url)) return; // never hand the docs server itself to the browser
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    // a file of the docs (spreadsheet, pdf, example model ...): let the user save a copy
    const home = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
    const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(home, path.basename(file)), title: 'Save ' + path.basename(file) });
    if (!dest) return;
    try {
      await vscode.workspace.fs.writeFile(dest, fs.readFileSync(file));
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not save ${path.basename(file)}: ${(e as Error).message}`);
      return;
    }
    if (/\.(gms|inc|csv|opt|dat)$/i.test(file)) await vscode.window.showTextDocument(dest);
  }

  /** Show `target` in the (re-used) help panel. */
  static async show(docsDir: string, target: HelpTarget, onlineOf: () => string | undefined): Promise<HelpPanel> {
    const cur = HelpPanel.current;
    if (cur && cur.docsDir === docsDir) {
      cur.onlineOf = onlineOf;
      cur.navigate(target);
      cur.panel.reveal(undefined, false);
      return cur;
    }
    cur?.panel.dispose();
    const server = await startDocsServer(docsDir, { testHooks: process.env.GAMS_EXT_TEST === '1' });
    const again = HelpPanel.current; // another call may have opened a panel meanwhile
    if (again && again.docsDir === docsDir) { void server.close(); again.onlineOf = onlineOf; again.navigate(target); return again; }
    again?.panel.dispose();
    let external: vscode.Uri;
    try {
      external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${server.port}/`));
    } catch {
      external = vscode.Uri.parse(`http://127.0.0.1:${server.port}/`);
    }
    const p = new HelpPanel(docsDir, server, external, onlineOf, target);
    HelpPanel.current = p;
    return p;
  }

  /** Test only: click the first element of the docs frame matching `selector`. */
  static testClick(selector: string): void {
    void HelpPanel.current?.panel.webview.postMessage({ type: 'testClick', selector });
  }

  static get isOpen(): boolean {
    return HelpPanel.current !== undefined;
  }

  /** The URL (webview URI) the panel was last asked to display, for tests. */
  lastUrl = '';

  private uriOf(t: HelpTarget): string {
    return this.base + relativeUrl(t);
  }

  private navigate(t: HelpTarget): void {
    this.lastUrl = this.uriOf(t);
    void this.panel.webview.postMessage({ type: 'navigate', url: this.lastUrl });
  }

  private html(first: HelpTarget): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    this.lastUrl = this.uriOf(first);
    const home = this.uriOf({ page: CHAPTER['Main'] });
    const search = this.uriOf({ page: CHAPTER['Search'] });
    const csp = [
      "default-src 'none'",
      `frame-src http://127.0.0.1:${this.server.port} ${new URL(this.base).origin} https://www.gams.com`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    // Docs pages run in their own frame (they read location/query themselves); this shell only needs scripts of its own.
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
html,body{height:100%;margin:0;padding:0;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}
body{display:flex;flex-direction:column}
#bar{display:flex;gap:4px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--vscode-panel-border)}
button,input{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-contrastBorder,transparent);padding:2px 8px;font:inherit}
button:hover{background:var(--vscode-button-secondaryHoverBackground);cursor:pointer}
button:disabled{opacity:.5;cursor:default}
input{flex:1;max-width:320px;background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
#spacer{flex:1}
iframe{flex:1;border:0;width:100%;background:#fff}
</style></head><body>
<div id="bar">
<button id="home" title="Documentation start page">Home</button>
<button id="back" title="Back" disabled>&#9664;</button>
<button id="fwd" title="Forward" disabled>&#9654;</button>
<input id="q" type="search" placeholder="Search documentation" aria-label="Search documentation">
<span id="spacer"></span>
<button id="zout" title="Zoom out (Ctrl+-)">A&#8722;</button>
<button id="zreset" title="Reset zoom (Ctrl+0)">100%</button>
<button id="zin" title="Zoom in (Ctrl++)">A+</button>
<button id="online" title="Open this topic on www.gams.com in the browser">View online</button>
</div>
<iframe id="doc" title="GAMS documentation" sandbox="allow-scripts allow-same-origin" src="${this.lastUrl}"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const BASE = ${JSON.stringify(this.base)};
const ORIGIN = new URL(BASE).origin;
const TEST = ${process.env.GAMS_EXT_TEST === '1'};
const doc = document.getElementById('doc');
const back = document.getElementById('back'), fwd = document.getElementById('fwd');
let pos = 0, max = 0, skip = 0;
function upd() { back.disabled = pos <= 0; fwd.disabled = pos >= max; }
// Fragment-only navigations fire no load event, so back/forward only track page loads.
doc.addEventListener('load', () => {
  if (skip > 0) { skip--; upd(); return; }
  pos++; max = pos; upd();
});
pos = -1; // the first load makes it 0
function step(d) { pos += d; skip++; setTimeout(() => { skip = 0; }, 1000); if (d < 0) history.back(); else history.forward(); upd(); }
back.onclick = () => { if (pos > 0) step(-1); };
fwd.onclick = () => { if (pos < max) step(1); };
document.getElementById('home').onclick = () => { doc.src = ${JSON.stringify(home)}; };
document.getElementById('online').onclick = () => vscode.postMessage({ type: 'online' });
let zoom = ${JSON.stringify(HelpPanel.zoom)};
const zreset = document.getElementById('zreset');
function applyZoom(save) {
  zoom = Math.min(3, Math.max(0.5, Math.round(zoom * 10) / 10));
  zreset.textContent = Math.round(zoom * 100) + '%';
  try { doc.contentWindow.postMessage({ gamsZoom: zoom }, ORIGIN); } catch (e) {}
  if (save) vscode.postMessage({ type: 'zoom', value: zoom });
}
document.getElementById('zin').onclick = () => { zoom += 0.1; applyZoom(true); };
document.getElementById('zout').onclick = () => { zoom -= 0.1; applyZoom(true); };
zreset.onclick = () => { zoom = 1; applyZoom(true); };
doc.addEventListener('load', () => applyZoom(false));
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '+' || e.key === '=') { zoom += 0.1; applyZoom(true); e.preventDefault(); }
  else if (e.key === '-') { zoom -= 0.1; applyZoom(true); e.preventDefault(); }
  else if (e.key === '0') { zoom = 1; applyZoom(true); e.preventDefault(); }
});
document.getElementById('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    doc.src = ${JSON.stringify(search)} + '?q=' + encodeURIComponent(e.target.value.trim());
  }
});
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (e.source === doc.contentWindow || e.origin === ORIGIN) {
    // the docs frame: only its load ping and open-link requests (re-validated by the extension) are accepted (it is page content, not the extension)
    if (e.source === doc.contentWindow && e.origin === ORIGIN) {
      if (d.gamsDocLoaded === true) vscode.postMessage({ type: 'loaded', title: String(d.title || ''), heading: String(d.heading || ''), href: String(d.href || '') });
      else if (typeof d.gamsOpenExternal === 'string' && /^(https?:|mailto:)/i.test(d.gamsOpenExternal)) vscode.postMessage({ type: 'external', url: d.gamsOpenExternal });
    }
    return;
  }
  if (TEST && d.type === 'testClick' && typeof d.selector === 'string') { doc.contentWindow.postMessage({ gamsTestClick: d.selector }, ORIGIN); return; }
  if (d.type === 'navigate' && typeof d.url === 'string' && d.url.startsWith(BASE)) doc.src = d.url;
});
</script></body></html>`;
  }
}
