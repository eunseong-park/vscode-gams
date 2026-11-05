// SPDX-License-Identifier: GPL-3.0-or-later
import { registerInstallationCommands } from './installationUi';
import * as vscode from 'vscode';
import { restartLanguageClient, startLanguageClient, stopLanguageClient } from './lsp';
import { Runner } from './run/runner';
import * as lsp from './lsp';
import type { LanguageClient } from 'vscode-languageclient/node';
import { GdxEditorProvider } from './views/gdx/provider';
import { registerGdxCompare } from './views/gdxCompare/provider';
import { promptParameters } from './options/runWithOptions';
import { openModelLibrary } from './modellib/modelLibrary';
import { clearOptionCache } from './options/optionDefs';
import { registerSymbolsView } from './views/symbols';
import { registerGdxSearch } from './views/gdxSearch';
import { registerStudioColors } from './theme/applyStudioColors';
import { registerDebugFeatures } from './debug';
import { ProjectManager } from './project/projects';
import { GamsProcess } from './run/gamsProcess';
import { registerContextHelp } from './help/contextHelp';
import { registerNeos } from './neos/neosCommand';
import { registerConnect } from './connect/connect';
import { registerEditCommands } from './edit/commands';
import { registerBracketColors } from './edit/bracketColors';
import { registerParentheses } from './edit/parentheses';
import { openInStudio } from './studio/openInStudio';
import { registerLegacy, runWithLegacy } from './legacy/legacyVscode';
import { registerGamsTasks } from './tasks/gamsTasks';
import { migrateLegacySettings } from './migrate/settingsMigration';

function applyStopGrace(): void {
  const s = vscode.workspace.getConfiguration('gams').get<number>('stopGracePeriod', 10);
  GamsProcess.defaultGraceMs = Math.max(0, s) * 1000;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  applyStopGrace();
  const runner = new Runner();
  const out = vscode.window.createOutputChannel('GAMS Extension');
  const projects = new ProjectManager(context.workspaceState);
  runner.resolveTarget = (f) => projects.resolveRunTarget(f);
  runner.isProjectFile = (f) => projects.isProjectFile(f);
  context.subscriptions.push(
    runner,
    out,
    projects,
    vscode.window.registerTreeDataProvider('gams.projects', projects),
    registerStudioColors(),
    // getLanguageClient() is expected from lsp.ts (not yet exported => viewer reports 'server not running')
    GdxEditorProvider.register(context.extensionUri, () => (lsp as Record<string, unknown> as { getLanguageClient?: () => LanguageClient | undefined })['getLanguageClient']?.()),
    registerGdxCompare(context, () => lsp.getLanguageClient()),
    vscode.commands.registerCommand('gams.run', () => runWithLegacy(() => runner.run(false))),
    ...registerLegacy(),
    registerGamsTasks(runner),
    vscode.commands.registerCommand('gams.compile', () => runner.run(true)),
    vscode.commands.registerCommand('gams.runWithOptions', async () => {
      const params = await promptParameters(context.workspaceState, 'GAMS: Run with parameters');
      if (params) await runner.run(false, params);
    }),
    vscode.commands.registerCommand('gams.compileWithOptions', async () => {
      const params = await promptParameters(context.workspaceState, 'GAMS: Compile with parameters');
      if (params) await runner.run(true, params);
    }),
    vscode.commands.registerCommand('gams.openModelLibrary', () => openModelLibrary()),
    registerNeos(context, runner),
    registerContextHelp(context.globalState),
    registerConnect(context),
    registerEditCommands(),
    registerParentheses(() => lsp.getLanguageClient()),
    registerBracketColors(() => lsp.getLanguageClient()),
    vscode.commands.registerCommand('gams.openInStudio', (uri?: vscode.Uri) => openInStudio(uri)),
    vscode.commands.registerCommand('gams.interrupt', () => runner.interrupt()),
    vscode.commands.registerCommand('gams.stop', () => runner.stop()),
    vscode.commands.registerCommand('gams.showLog', () => runner.showLog()),
    ...registerInstallationCommands(),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gams.stopGracePeriod')) applyStopGrace();
      if (e.affectsConfiguration('gams.sysdir') || e.affectsConfiguration('gams.serverPath')) {
        clearOptionCache();
        void restartLanguageClient(context, out, runner.sysdir);
      }
    }),
  );
  registerSymbolsView(context, () => lsp.getLanguageClient(), out, (f) => projects.resolveRunTarget(f));
  context.subscriptions.push(registerGdxSearch(() => lsp.getLanguageClient()));
  context.subscriptions.push(registerDebugFeatures(() => lsp.getLanguageClient(), () => runner.sysdir));
  void migrateLegacySettings(context);
  await startLanguageClient(context, out, runner.sysdir);
}

export async function deactivate(): Promise<void> {
  await stopLanguageClient();
}
