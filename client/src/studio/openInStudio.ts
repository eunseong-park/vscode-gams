// SPDX-License-Identifier: GPL-3.0-or-later
import * as cp from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { detectSysdir, gamsEnvironment } from '../sysdir';
import { launchSpec, resolveStudioPath, splitArgs } from './studioPath';

function activeUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

/** Opens a .gms/.gdx/.lst file in GAMS Studio (a detached process). */
export async function openInStudio(arg?: vscode.Uri): Promise<void> {
  const target = arg instanceof vscode.Uri ? arg : activeUri();
  if (!target || target.scheme !== 'file') {
    void vscode.window.showWarningMessage('GAMS: open a local .gms, .gdx or .lst file first.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('gams');
  if (vscode.env.remoteName && !cfg.get<boolean>('studio.allowRemote', false)) {
    void vscode.window.showWarningMessage('GAMS Studio would start on the remote machine (it needs a display). Enable gams.studio.allowRemote to do so anyway.');
    return;
  }
  const sysdir = detectSysdir(cfg.get<string>('sysdir'));
  const studio = resolveStudioPath(cfg.get<string>('studio.path'), sysdir, (p) => fs.existsSync(p));
  if (!studio) {
    const pick = 'Open Settings';
    const c = await vscode.window.showErrorMessage('GAMS Studio was not found. Set gams.studio.path.', pick);
    if (c === pick) await vscode.commands.executeCommand('workbench.action.openSettings', 'gams.studio.path');
    return;
  }
  const spec = launchSpec(studio, splitArgs(cfg.get<string>('studio.arguments', '')), target.fsPath);
  try {
    const p = cp.spawn(spec.command, spec.args, {
      detached: true,
      stdio: 'ignore',
      env: sysdir ? gamsEnvironment(sysdir) : process.env,
    });
    p.on('error', (e) => void vscode.window.showErrorMessage(`GAMS: could not start Studio (${spec.command}): ${e.message}`));
    p.unref();
  } catch (e) {
    void vscode.window.showErrorMessage(`GAMS: could not start Studio: ${(e as Error).message}`);
  }
}
