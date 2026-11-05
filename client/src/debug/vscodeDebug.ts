// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * VS Code glue for the GAMS debugger: configuration provider, inline debug adapter, and the
 * commands of Studio's debug actions (MainWindow::on_actionRunDebugger_triggered /
 * on_actionStepDebugger_triggered, src/mainwindow.cpp) plus "open snapshot in GDX viewer"
 * (PExProjectNode::openDebugGdx, src/file/pexgroupnode.cpp).
 * GPL-3.0-or-later.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { notifyRefUpdated, releaseGdx } from '../lsp';
import type { GdxRecord, GdxSymbolInfo } from '../views/gdx/model';
import { beginBusy } from '../run/busy';
import { sharedDiagnostics } from '../run/diagnostics';
import { prepareRun } from '../run/prepare';
import { GamsDebugSession, GamsLaunchArguments, GdxAccess } from './debugSession';
import { isGamsFile, isGamsSource } from '../languages';

export const DEBUG_TYPE = 'gams';
const GDX_VIEW_TYPE = 'gams.gdxViewer';

export interface DebugDeps {
  getClient(): LanguageClient | undefined;
  getSysdir(): string | undefined;
}

/** busy token taken when a launch configuration is resolved (before the save); handed over to the adapter */
let pendingBusy: (() => void) | undefined;
let pendingTimer: NodeJS.Timeout | undefined;
function takePendingBusy(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = undefined;
  pendingBusy?.();
  pendingBusy = undefined;
}

class InlineAdapter implements vscode.DebugAdapter {
  private readonly endBusy: () => void;
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private readonly session: GamsDebugSession;

  constructor(gdx: GdxAccess) {
    this.endBusy = beginBusy();
    takePendingBusy();
    this.session = new GamsDebugSession((m) => this.emitter.fire(m as vscode.DebugProtocolMessage), {
      gdx,
      refWritten: (gms, refPath, t) => notifyRefUpdated(vscode.Uri.file(gms), refPath, t),
      onError: (e) => sharedDiagnostics().add(e),
    });
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    this.session.handleMessage(message as { type: string });
  }

  dispose(): void {
    this.endBusy();
    this.session.dispose();
    this.emitter.dispose();
  }
}

function gdxAccess(deps: DebugDeps): GdxAccess {
  const client = (): LanguageClient => {
    const c = deps.getClient();
    if (!c) throw new Error('The GAMS language server is not running.');
    return c;
  };
  return {
    symbols: async (p) => (await client().sendRequest<{ symbols: GdxSymbolInfo[] }>('gams/gdxSymbols', { path: p })).symbols,
    records: (p, symbolIndex, offset, limit) =>
      client().sendRequest<{ total: number; records: GdxRecord[] }>('gams/gdxRecords', { path: p, symbolIndex, offset, limit }),
    release: (p) => releaseGdx(p),
  };
}

class ConfigProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly deps: DebugDeps) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [{ type: DEBUG_TYPE, request: 'launch', name: 'GAMS: Debug current file', program: '${file}' }];
  }

  async resolveDebugConfiguration(_f: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    if (!config.type && !config.request && !config.name) {
      const ed = vscode.window.activeTextEditor;
      if (!isGamsSource(ed?.document)) return config; // VS Code shows launch.json creation
      config = { type: DEBUG_TYPE, request: 'launch', name: 'GAMS: Debug current file', program: '${file}' };
    }
    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    _f: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const a = config as vscode.DebugConfiguration & GamsLaunchArguments;
    takePendingBusy();
    pendingBusy = beginBusy();
    pendingTimer = setTimeout(takePendingBusy, 30000); // safety: the adapter never started
    const config2 = await this.resolveInner(a);
    if (!config2) takePendingBusy();
    return config2;
  }

  private async resolveInner(a: vscode.DebugConfiguration & GamsLaunchArguments): Promise<vscode.DebugConfiguration | undefined> {
    if (!a.program) {
      void vscode.window.showErrorMessage('GAMS debug: "program" (the .gms file) is missing.');
      return undefined;
    }
    // same steps as F9: save all modified files, sysdir check, project / main file, project parameters
    if (!path.isAbsolute(a.program)) a.program = path.resolve(a.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(), a.program);
    const prep = await prepareRun(a.program, 'GAMS debug', a.sysdir);
    if (!prep) return undefined;
    sharedDiagnostics().clear();
    a.program = prep.main;
    a.cwd = a.cwd || prep.workDir;
    a.sysdir = prep.sysdir;
    a.defaultParameters = prep.params;
    return a;
  }
}

async function startDebug(stopOnEntry: boolean): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isGamsFile(ed.document)) {
    void vscode.window.showErrorMessage('Open a saved GAMS file (.gms) to debug.');
    return;
  }
  await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(ed.document.uri), {
    type: DEBUG_TYPE,
    request: 'launch',
    name: `GAMS: ${stopOnEntry ? 'Step' : 'Debug'} ${path.basename(ed.document.uri.fsPath)}`,
    program: ed.document.uri.fsPath,
    stopOnEntry,
  });
}

/** snapshot files opened per debug session id */
const openedSnapshots = new Map<string, string>();

async function openSnapshot(): Promise<void> {
  const s = vscode.debug.activeDebugSession;
  if (!s || s.type !== DEBUG_TYPE) {
    void vscode.window.showInformationMessage('No active GAMS debug session.');
    return;
  }
  const r = (await s.customRequest('gamsSnapshot')) as { gdx?: string };
  if (!r?.gdx) {
    void vscode.window.showInformationMessage('No GDX snapshot yet: the GAMS debugger is not paused.');
    return;
  }
  openedSnapshots.set(s.id, vscode.Uri.file(r.gdx).toString());
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(r.gdx), GDX_VIEW_TYPE, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
  });
}

export function registerDebug(deps: DebugDeps): vscode.Disposable {
  const gdx = gdxAccess(deps);
  return vscode.Disposable.from(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new ConfigProvider(deps)),
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new InlineAdapter(gdx)),
    }),
    vscode.commands.registerCommand('gams.debug', () => startDebug(false)),
    vscode.commands.registerCommand('gams.stepDebug', () => startDebug(true)),
    vscode.commands.registerCommand('gams.debug.openSnapshot', () => openSnapshot()),
    vscode.debug.onDidTerminateDebugSession((s) => {
      const snap = openedSnapshots.get(s.id);
      openedSnapshots.delete(s.id);
      if (s.type !== DEBUG_TYPE || !snap) return;
      // MainWindow::stopDebugServer closes the snapshot editors (the adapter deletes the temp GDX)
      for (const g of vscode.window.tabGroups.all) {
        for (const t of g.tabs) {
          const inp = t.input;
          if (inp instanceof vscode.TabInputCustom && inp.viewType === GDX_VIEW_TYPE && inp.uri.toString() === snap) {
            void vscode.window.tabGroups.close(t);
          }
        }
      }
    }),
  );
}
