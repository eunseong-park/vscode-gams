// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { notifyRefUpdated, onRefUpdated } from '../../lsp';
import { detectSysdir } from '../../sysdir';
import { compileForReference } from '../../run/refUpdate';
import { CoalescedRunner } from '../../run/busy';
import { SymbolsProvider } from './provider';

const STALE_TEXT = 'stale (edited since last run)';

/** Register the "Symbols" tree view (Studio reference viewer), stale tracking and the opt-in update-on-save. */
export function registerSymbolsView(
  context: vscode.ExtensionContext,
  getClient: () => LanguageClient | undefined,
  out: vscode.OutputChannel,
  resolveTarget?: (active: string) => Promise<{ main: string; workDir: string; params: string[] } | undefined | null>,
): void {
  const provider = new SymbolsProvider(getClient);
  const view = vscode.window.createTreeView('gams.symbols', { treeDataProvider: provider, showCollapseAll: true });
  provider.onState = () => {
    view.description = provider.stale ? STALE_TEXT : undefined;
    view.message = !provider.data
      ? 'No reference data. Run or compile a .gms file to create a reference file.'
      : provider.filterText
        ? `Filter: ${provider.filterText}`
        : undefined;
  };
  provider.onState();

  const isGams = (d: vscode.TextDocument): boolean => d.languageId === 'gams' && d.uri.scheme === 'file';
  const refreshFor = (ed: vscode.TextEditor | undefined): void => {
    if (ed && isGams(ed.document)) void provider.refresh(ed.document.uri);
  };
  // Update-on-save compile: skipped while a run/debug/profile is active (they share <stem>.lst/.ref); saves arriving
  // during a compile collapse into exactly one follow-up compile.
  const updater = new CoalescedRunner(async () => {
    const gms = provider.gms;
    if (!gms) return;
    const cfg = vscode.workspace.getConfiguration('gams');
    const sysdir = detectSysdir(cfg.get<string>('sysdir', ''));
    if (!sysdir) return;
    try {
      const target = await resolveTarget?.(gms.fsPath);
      if (target === null) return;
      const main = target?.main ?? gms.fsPath;
      const params = [...cfg.get<string[]>('defaultParameters', []), ...(target?.params ?? [])];
      const res = await compileForReference(sysdir, main, params, target?.workDir);
      if (res) {
        notifyRefUpdated(vscode.Uri.file(main), res.refPath, res.startedAt);
        setTimeout(res.cleanup, 60000).unref(); // the server reads the file asynchronously
      }
    } catch (e) {
      out.appendLine(`[gams] reference update failed: ${String(e)}`);
    }
  });

  context.subscriptions.push(
    view,
    provider,
    view.onDidChangeVisibility((e) => { if (e.visible) refreshFor(vscode.window.activeTextEditor); }),
    onRefUpdated((gms) => void provider.refresh(gms)),
    vscode.window.onDidChangeActiveTextEditor(refreshFor),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0 && provider.involves(e.document.uri)) provider.markStale();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!vscode.workspace.getConfiguration('gams').get<boolean>('updateReferencesOnSave', false)) return;
      if (!isGams(doc) || !provider.gms || !provider.involves(doc.uri)) return;
      updater.request();
    }),
    vscode.commands.registerCommand('gams.symbols.refresh', () => refreshFor(vscode.window.activeTextEditor)),
    vscode.commands.registerCommand('gams.symbols.filter', async () => {
      const v = await vscode.window.showInputBox({
        title: 'Filter symbols',
        prompt: 'Substring of the symbol name, or /regex/. Empty clears the filter.',
        value: provider.filterText,
      });
      if (v !== undefined) provider.setFilter(v);
    }),
    vscode.commands.registerCommand('gams.symbols.clearFilter', () => provider.setFilter('')),
  );
  refreshFor(vscode.window.activeTextEditor);
}
