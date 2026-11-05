// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  fileChildren, fileDescription, GROUPS, GroupDef, KINDS, KindKey, makeMatcher, RefData, RefFile, RefLocation,
  RefSymbol, symbolDescription, symbolsOfGroup, totalLocations,
} from './model';

type Node =
  | { t: 'group'; g: GroupDef }
  | { t: 'symbol'; s: RefSymbol; g: GroupDef }
  | { t: 'kind'; s: RefSymbol; key: KindKey; label: string }
  | { t: 'loc'; s: RefSymbol; l: RefLocation }
  | { t: 'file'; f: RefFile };

function toRange(l: RefLocation): vscode.Range {
  return new vscode.Range(l.range.start.line, l.range.start.character, l.range.end.line, l.range.end.character);
}

function locLabel(l: RefLocation): string {
  const u = vscode.Uri.parse(l.uri);
  return `${path.basename(u.fsPath)}:${l.range.start.line + 1}:${l.range.start.character + 1}`;
}

export class SymbolsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  data: RefData | undefined;
  /** main .gms the data belongs to */
  gms: vscode.Uri | undefined;
  private filter = '';
  private match: ((n: string) => boolean) | undefined;
  private seq = 0;
  /** called after each refresh with the current state (view title/description/message) */
  onState: () => void = () => undefined;

  constructor(private readonly getClient: () => LanguageClient | undefined) {}

  dispose(): void {
    this.changed.dispose();
  }

  get stale(): boolean {
    return !!this.data?.stale;
  }

  get filterText(): string {
    return this.filter;
  }

  setFilter(f: string): void {
    this.filter = f;
    this.match = makeMatcher(f);
    this.changed.fire(undefined);
    this.onState();
  }

  /** Mark the loaded data outdated without asking the server (an edit just happened). */
  markStale(): void {
    if (this.data && !this.data.stale) {
      this.data.stale = true;
      this.changed.fire(undefined);
      this.onState();
    }
  }

  /** Is `uri` the main file or one of the files-used of the loaded reference? */
  involves(uri: vscode.Uri): boolean {
    if (!this.data || !this.gms) return false;
    const p = uri.toString().toLowerCase();
    return p === this.gms.toString().toLowerCase() || this.data.files.some((f) => f.uri.toLowerCase() === p);
  }

  async refresh(gms?: vscode.Uri): Promise<void> {
    const client = this.getClient();
    const target = gms ?? this.gms;
    if (!client || !target) return;
    const my = ++this.seq;
    try {
      const d = (await client.sendRequest('gams/refSymbols', { gmsUri: target.toString() })) as RefData;
      if (my !== this.seq) return;
      this.data = d.refPath ? d : undefined;
      this.gms = target;
    } catch {
      if (my !== this.seq) return;
      this.data = undefined;
    }
    this.changed.fire(undefined);
    this.onState();
  }

  getChildren(n?: Node): Node[] {
    const d = this.data;
    if (!d) return [];
    if (!n) {
      return GROUPS.filter((g) => g.id === 'all' || g.id === 'fileUsed' ? true : symbolsOfGroup(d, g).length > 0).map((g) => ({ t: 'group', g }));
    }
    switch (n.t) {
      case 'group':
        if (n.g.id === 'fileUsed') return fileChildren(d, 0).map((f) => ({ t: 'file', f }));
        return symbolsOfGroup(d, n.g)
          .filter((s) => !this.match || this.match(s.name))
          .map((s) => ({ t: 'symbol', s, g: n.g }));
      case 'symbol':
        return KINDS.filter((k) => n.s.locations[k.key]?.length).map((k) => ({ t: 'kind', s: n.s, key: k.key, label: k.label }));
      case 'kind':
        return n.s.locations[n.key].map((l) => ({ t: 'loc', s: n.s, l }));
      case 'file':
        return fileChildren(d, n.f.id).map((f) => ({ t: 'file', f }));
      default:
        return [];
    }
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const d = this.data;
    switch (n.t) {
      case 'group': {
        const count = d ? (n.g.id === 'fileUsed' ? d.files.length : this.visibleCount(n.g)) : 0;
        const it = new vscode.TreeItem(n.g.label, vscode.TreeItemCollapsibleState.Collapsed);
        it.description = String(count);
        it.contextValue = 'gamsSymbolGroup';
        return it;
      }
      case 'symbol': {
        const it = new vscode.TreeItem(n.s.name, totalLocations(n.s) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        it.description = symbolDescription(n.s, n.g.id === 'all' || n.g.id === 'unused');
        it.tooltip = `${n.s.type} ${n.s.name}${n.s.dim ? `(${n.s.domain.join(',')})` : ''}${n.s.text ? `\n${n.s.text}` : ''}`;
        it.contextValue = 'gamsSymbol';
        // click on a symbol jumps to its declaration (Studio: double click in the table)
        const decl = n.s.locations.declare?.[0] ?? n.s.locations.define?.[0];
        if (decl) it.command = openCommand(decl);
        return it;
      }
      case 'kind': {
        const it = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
        it.description = String(n.s.locations[n.key].length);
        return it;
      }
      case 'loc': {
        const it = new vscode.TreeItem(locLabel(n.l), vscode.TreeItemCollapsibleState.None);
        it.tooltip = `${vscode.Uri.parse(n.l.uri).fsPath}:${n.l.range.start.line + 1}:${n.l.range.start.character + 1}`;
        it.command = openCommand(n.l);
        return it;
      }
      case 'file': {
        const u = vscode.Uri.parse(n.f.uri);
        const kids = d ? fileChildren(d, n.f.id).length : 0;
        const it = new vscode.TreeItem(path.basename(u.fsPath), kids ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        it.description = fileDescription(n.f);
        it.tooltip = u.fsPath;
        it.command = { command: 'vscode.open', title: 'Open', arguments: [u] };
        return it;
      }
    }
  }

  private visibleCount(g: GroupDef): number {
    const list = symbolsOfGroup(this.data as RefData, g);
    return this.match ? list.filter((s) => this.match?.(s.name)).length : list.length;
  }
}

function openCommand(l: RefLocation): vscode.Command {
  return {
    command: 'vscode.open',
    title: 'Open',
    arguments: [vscode.Uri.parse(l.uri), { selection: toRange(l), preview: true } satisfies vscode.TextDocumentShowOptions],
  };
}
