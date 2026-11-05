// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { findElementInGdx, findSymbolInGdx } from './search';
import { GdxIndexService } from './service';
import { GdxFilesProvider } from './tree';

const COMPARE_COMMANDS = ['gams.gdxCompare', 'gams.gdxDiff'];

/** Register workspace-wide GDX search commands and the "GDX Files" view (extension addition, not in Studio). */
export function registerGdxSearch(getClient: () => LanguageClient | undefined): vscode.Disposable {
  const svc = new GdxIndexService(getClient);
  const provider = new GdxFilesProvider(svc);
  const view = vscode.window.createTreeView('gams.gdxFiles', { treeDataProvider: provider, showCollapseAll: true });
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.gdx');

  const compareCommand = async (): Promise<string | undefined> => {
    const all = await vscode.commands.getCommands(true);
    return COMPARE_COMMANDS.find((c) => all.includes(c));
  };
  const updateContext = (): void => {
    void compareCommand().then((c) => vscode.commands.executeCommand('setContext', 'gams.gdxCompareAvailable', !!c));
  };
  provider.onRefresh = updateContext;
  updateContext();
  setTimeout(updateContext, 3000).unref?.();

  const uriOf = (arg: unknown): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) return arg;
    const a = arg as { uri?: vscode.Uri } | undefined;
    return a?.uri instanceof vscode.Uri ? a.uri : undefined;
  };

  return vscode.Disposable.from(
    view,
    provider,
    watcher,
    watcher.onDidCreate(() => provider.scheduleRefresh()),
    watcher.onDidDelete(() => provider.scheduleRefresh()),
    watcher.onDidChange(() => provider.scheduleRefresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gams.gdxSearch') || e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude')) {
        provider.scheduleRefresh();
      }
    }),
    vscode.commands.registerCommand('gams.gdxSearch.symbol', () => findSymbolInGdx(svc)),
    vscode.commands.registerCommand('gams.gdxSearch.element', () => findElementInGdx(svc)),
    vscode.commands.registerCommand('gams.gdxFiles.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('gams.gdxFiles.open', async (arg: unknown) => {
      const u = uriOf(arg);
      if (u) await vscode.commands.executeCommand('vscode.openWith', u, 'gams.gdxViewer');
    }),
    vscode.commands.registerCommand('gams.gdxFiles.compare', async (arg: unknown) => {
      const c = await compareCommand();
      const u = uriOf(arg);
      if (c && u) await vscode.commands.executeCommand(c, u);
    }),
  );
}
