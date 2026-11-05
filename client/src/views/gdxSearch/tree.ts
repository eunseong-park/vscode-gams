// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { splitDir, symbolDescription } from './query';
import { GdxIndexService, relPath, typeIcon } from './service';

type Node =
  | { kind: 'folder'; dir: string; files: vscode.Uri[] }
  | { kind: 'file'; uri: vscode.Uri; rel: string }
  | { kind: 'symbol'; file: string; name: string; type: string; dim: number; records: number; text: string }
  | { kind: 'message'; text: string };

/** "GDX Files" view: folders -> files -> symbols (symbols are indexed lazily when a file is expanded). */
export class GdxFilesProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private timer: NodeJS.Timeout | undefined;
  /** called before every refresh; used to update context keys */
  onRefresh?: () => void;

  constructor(private readonly svc: GdxIndexService) {}

  refresh(): void {
    this.onRefresh?.();
    this.changed.fire(undefined);
  }

  /** Debounced refresh for file system events. */
  scheduleRefresh(ms = 500): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), ms);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.changed.dispose();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'folder': {
        const t = new vscode.TreeItem(n.dir || '(workspace root)', vscode.TreeItemCollapsibleState.Expanded);
        t.iconPath = vscode.ThemeIcon.Folder;
        t.description = `${n.files.length}`;
        t.contextValue = 'gdxFolder';
        return t;
      }
      case 'file': {
        const t = new vscode.TreeItem(splitDir(n.rel).base, vscode.TreeItemCollapsibleState.Collapsed);
        t.resourceUri = n.uri;
        t.iconPath = new vscode.ThemeIcon('database');
        t.tooltip = n.uri.fsPath;
        t.contextValue = 'gdxFile';
        t.command = { command: 'gams.gdxFiles.open', title: 'Open', arguments: [n] };
        return t;
      }
      case 'symbol': {
        const t = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.None);
        t.iconPath = typeIcon(n.type);
        t.description = symbolDescription(n);
        t.tooltip = n.text ? `${n.name}: ${n.text}` : n.name;
        t.contextValue = 'gdxSymbol';
        t.command = { command: 'gams.openGdxSymbol', title: 'Open Symbol', arguments: [vscode.Uri.file(n.file), n.name] };
        return t;
      }
      default:
        return new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    try {
      if (!n) return await this.roots();
      if (n.kind === 'folder') return n.files.map((uri) => ({ kind: 'file', uri, rel: relPath(uri) }));
      if (n.kind === 'file') {
        const [f] = await this.svc.index([n.uri]);
        if (!f) return [];
        if (f.error) return [{ kind: 'message', text: f.error }];
        return f.symbols.map((s) => ({ kind: 'symbol', file: f.path, name: s.name, type: s.type, dim: s.dim, records: s.records, text: s.text }));
      }
    } catch (e) {
      return [{ kind: 'message', text: (e as Error).message }];
    }
    return [];
  }

  private async roots(): Promise<Node[]> {
    const uris = await this.svc.findFiles();
    if (!uris.length) return [{ kind: 'message', text: 'No .gdx files in the workspace.' }];
    const groups = new Map<string, vscode.Uri[]>();
    for (const u of uris) {
      const dir = splitDir(relPath(u)).dir;
      const g = groups.get(dir);
      if (g) g.push(u);
      else groups.set(dir, [u]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, files]) => ({ kind: 'folder', dir, files }));
  }
}
