// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import * as path from 'path';
import type { LanguageClient } from 'vscode-languageclient/node';
import { combineExcludes, ElementMatch, ElementQuery, GdxSymbolInfo, IndexedSymbol } from './query';

/** Files per `gams/gdxIndex` / `gams/gdxFindElement` request (cancellation granularity). */
const CHUNK = 100;

export interface IndexedFile {
  path: string;
  rel: string;
  mtime: number;
  size: number;
  symbols: GdxSymbolInfo[];
  error?: string;
}

interface IndexReply {
  files: Array<{ path: string; mtime?: number; size?: number; symbols?: GdxSymbolInfo[]; error?: string }>;
  truncated: boolean;
}

interface FindReply {
  matches: ElementMatch[];
  filesWithLabel: number;
  truncated: boolean;
  error?: string;
  errors?: Array<{ path: string; error: string }>;
}

export function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, true).replace(/\\/g, '/');
}

export function toSymbols(f: IndexedFile): IndexedSymbol[] {
  return f.symbols.map((s) => ({ ...s, file: f.path, rel: f.rel, mtime: f.mtime }));
}

/** Client side of the server's workspace GDX index (`gams/gdxIndex`, `gams/gdxFindElement`). */
export class GdxIndexService {
  constructor(private readonly getClient: () => LanguageClient | undefined) {}

  private client(): LanguageClient {
    const c = this.getClient();
    if (!c) throw new Error('The GAMS language server is not running.');
    return c;
  }

  /** All workspace .gdx files (files.exclude, search.exclude and gams.gdxSearch.exclude are honoured). */
  async findFiles(token?: vscode.CancellationToken): Promise<vscode.Uri[]> {
    const cfg = vscode.workspace.getConfiguration();
    const exclude = combineExcludes(
      [cfg.get<Record<string, boolean>>('files.exclude'), cfg.get<Record<string, boolean>>('search.exclude')],
      cfg.get<string[]>('gams.gdxSearch.exclude', []),
    );
    const max = Math.max(1, cfg.get<number>('gams.gdxSearch.maxFiles', 5000));
    const uris = await vscode.workspace.findFiles('**/*.gdx', exclude, max, token);
    return uris.filter((u) => u.scheme === 'file').sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  async index(uris: vscode.Uri[], token?: vscode.CancellationToken): Promise<IndexedFile[]> {
    const c = this.client();
    const out: IndexedFile[] = [];
    for (let i = 0; i < uris.length; i += CHUNK) {
      if (token?.isCancellationRequested) break;
      const part = uris.slice(i, i + CHUNK);
      const r = await c.sendRequest<IndexReply>('gams/gdxIndex', { paths: part.map((u) => u.fsPath) }, token);
      const rel = new Map(part.map((u) => [u.fsPath, relPath(u)]));
      for (const f of r.files) {
        out.push({
          path: f.path,
          rel: rel.get(f.path) ?? path.basename(f.path),
          mtime: f.mtime ?? 0,
          size: f.size ?? 0,
          symbols: f.symbols ?? [],
          error: f.error,
        });
      }
      if (r.truncated) break;
    }
    return out;
  }

  async indexSymbols(token?: vscode.CancellationToken): Promise<{ symbols: IndexedSymbol[]; errors: number }> {
    const files = await this.index(await this.findFiles(token), token);
    return { symbols: files.flatMap(toSymbols), errors: files.filter((f) => f.error).length };
  }

  async findElement(
    uris: vscode.Uri[],
    q: ElementQuery,
    token?: vscode.CancellationToken,
  ): Promise<{ matches: ElementMatch[]; filesWithLabel: number; truncated: boolean }> {
    const c = this.client();
    const matches: ElementMatch[] = [];
    let filesWithLabel = 0;
    let truncated = false;
    for (let i = 0; i < uris.length; i += CHUNK) {
      if (token?.isCancellationRequested) {
        truncated = true;
        break;
      }
      const r = await c.sendRequest<FindReply>(
        'gams/gdxFindElement',
        { paths: uris.slice(i, i + CHUNK).map((u) => u.fsPath), label: q.label, regex: q.regex, caseSensitive: q.caseSensitive },
        token,
      );
      if (r.error) throw new Error(r.error);
      matches.push(...r.matches);
      filesWithLabel += r.filesWithLabel;
      if (r.truncated) {
        truncated = true;
        break;
      }
    }
    return { matches, filesWithLabel, truncated };
  }
}

/** Open the GDX viewer on `symbol` (command `gams.openGdxSymbol`); falls back to just opening the file. */
export async function openSymbol(file: string, symbol: string): Promise<void> {
  const uri = vscode.Uri.file(file);
  if ((await vscode.commands.getCommands(true)).includes('gams.openGdxSymbol')) {
    await vscode.commands.executeCommand('gams.openGdxSymbol', uri, symbol);
  } else {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'gams.gdxViewer');
  }
}

export const TYPE_ICONS: Record<string, string> = {
  Set: 'symbol-array',
  Parameter: 'symbol-constant',
  Variable: 'symbol-variable',
  Equation: 'symbol-operator',
  Alias: 'symbol-reference',
};
export const typeIcon = (type: string): vscode.ThemeIcon => new vscode.ThemeIcon(TYPE_ICONS[type] ?? 'symbol-misc');
