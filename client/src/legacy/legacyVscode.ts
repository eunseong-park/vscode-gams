// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * vscode side of the 0.1.x compatibility (deprecated `GAMS.*` settings, see legacy.ts) and of the
 * gams.openListingAfterRun / gams.editor.openLocation / gams.editor.preserveFocus settings.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { legacyCwd, legacyProjectFile, legacyRunMode, LegacySettings, editorOpenOptions } from './legacy';
import { isGamsSource } from '../languages';

type Inspected<T> = { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
/** Value set by the user (folder > workspace > user); defaults are ignored. */
function explicit<T>(i: Inspected<T>): T | undefined {
  return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
}

export function readLegacy(scope?: vscode.Uri): LegacySettings {
  const c = vscode.workspace.getConfiguration('GAMS', scope);
  const g = <T>(k: string): T | undefined => explicit(c.inspect<T>(k));
  return {
    runProject: g<boolean>('runProject'),
    runBatchPath: g<string>('runBatchPath'),
    projectLst: g<string>('projectLst'),
    projectGDX: g<string>('projectGDX'),
    terminalCwd: g<string>('terminalCwd'),
    preserveFocus: g<boolean>('preserveFocus'),
    listingFileLocation: g<string>('listingFileLocation'),
    executablePath: g<string>('executablePath'),
    commandLineParameters: g<string>('commandLineParameters'),
  };
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** `GAMS.terminalCwd` (if set) as a resolved directory. */
export function terminalCwdSetting(): string | undefined {
  const t = readLegacy().terminalCwd;
  return t && t.trim() ? legacyCwd(t, '', workspaceRoot()) : undefined;
}

/** Where and how editors for the listing / log open: gams.editor.* with GAMS.listingFileLocation / GAMS.preserveFocus as fallbacks. */
export function editorOptions(): vscode.TextDocumentShowOptions {
  const c = vscode.workspace.getConfiguration('gams');
  const o = editorOpenOptions(
    explicit(c.inspect<string>('editor.openLocation')),
    explicit(c.inspect<boolean>('editor.preserveFocus')),
    readLegacy(),
  );
  return { viewColumn: o.viewColumn as vscode.ViewColumn, preserveFocus: o.preserveFocus, preview: true };
}

export function openListingAfterRun(): boolean {
  return vscode.workspace.getConfiguration('gams').get<boolean>('openListingAfterRun', false);
}

/** Opens a listing file (silently ignores a missing one). */
export async function openListing(file: string | undefined, quiet = true): Promise<void> {
  if (!file || !fs.existsSync(file)) {
    if (!quiet) void vscode.window.showInformationMessage('The corresponding listing file does not exist.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc, editorOptions());
}

function activeGms(): string | undefined {
  const d = vscode.window.activeTextEditor?.document;
  return d && d.uri.scheme === 'file' ? d.fileName : undefined;
}

const stemPath = (f: string, ext: string): string => f.replace(/\.[^/.]+$/, '') + ext;

/** 0.1.4 `gams.run` with runProject + runBatchPath: the batch file runs as a shell task (VS Code terminal). */
export function runBatchInTerminal(batch: string, cwd: string, onEnd?: () => void): Thenable<vscode.TaskExecution> {
  const task = new vscode.Task({ type: 'gams', legacy: true }, vscode.TaskScope.Workspace, 'GAMS', 'GAMS', new vscode.ShellExecution(batch, { cwd }));
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: false, panel: vscode.TaskPanelKind.Dedicated, showReuseMessage: false, clear: false };
  if (onEnd) {
    const sub = vscode.tasks.onDidEndTask((e) => {
      if (e.execution.task === task || (e.execution.task.definition.legacy === true && e.execution.task.name === 'GAMS')) {
        sub.dispose();
        onEnd();
      }
    });
  }
  return vscode.tasks.executeTask(task);
}

/**
 * `gams.run`: when GAMS.runProject is on and GAMS.runBatchPath is set, F9 runs the batch file in a terminal
 * (cwd = GAMS.terminalCwd or the file's directory) like 0.1.4; otherwise a normal run.
 */
export async function runWithLegacy(normalRun: () => Promise<void>): Promise<void> {
  const s = readLegacy();
  const file = activeGms();
  if (legacyRunMode(s) !== 'batch' || !file) return normalRun();
  const cwd = legacyCwd(s.terminalCwd, path.dirname(file), workspaceRoot());
  const lst = legacyProjectFile(s, 'lst');
  await runBatchInTerminal(s.runBatchPath as string, cwd, openListingAfterRun() ? () => void openListing(lst ?? stemPath(file, '.lst')) : undefined);
}

export function registerLegacy(): vscode.Disposable[] {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'gams.toggleRunProject';
  status.tooltip = 'Toggle GAMS Project Run Mode (GAMS.runProject, deprecated)';
  const update = (): void => {
    const rp = readLegacy().runProject;
    status.text = `$(checklist) Run Project: ${rp === true ? 'On' : 'Off'}`;
    const ed = vscode.window.activeTextEditor;
    if (rp !== undefined && ed && isGamsSource(ed.document)) status.show();
    else status.hide();
  };
  update();
  return [
    status,
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('GAMS.runProject')) update(); }),
    vscode.commands.registerCommand('gams.toggleRunProject', async () => {
      const c = vscode.workspace.getConfiguration('GAMS');
      const next = readLegacy().runProject !== true;
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      try {
        await c.update('runProject', next, target);
      } catch {
        await c.update('runProject', next, vscode.ConfigurationTarget.Global);
      }
      update();
      void vscode.window.showInformationMessage(`GAMS.runProject toggled to ${next}.`);
    }),
    vscode.commands.registerCommand('gams.showListing', async () => {
      const f = activeGms();
      if (!f) { void vscode.window.showErrorMessage('No file opened in the editor.'); return; }
      await openListing(legacyProjectFile(readLegacy(), 'lst') ?? stemPath(f, '.lst'), false);
    }),
    vscode.commands.registerCommand('gams.openCorrGDX', async () => {
      const f = activeGms();
      if (!f) { void vscode.window.showErrorMessage('No file opened in the editor.'); return; }
      const gdx = legacyProjectFile(readLegacy(), 'gdx') ?? stemPath(f, '.gdx');
      if (!fs.existsSync(gdx)) { void vscode.window.showInformationMessage('The corresponding GDX file does not exist.'); return; }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(gdx));
    }),
  ];
}
