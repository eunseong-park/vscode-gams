// SPDX-License-Identifier: GPL-3.0-or-later
/** "GAMS: Select GAMS Installation" and the status text shown by the runner's status bar item. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { availableTargets, GamsInstallation, listInstallations, overridingScopes, readGamsVersion, sameDir, SettingInspect, shortVersion } from './installations';
import { checkSysdir, gamsExecutableName } from './sysdir';
import { sysdirSetting } from './sysdirUi';

export interface InstallationStatus {
  text: string;
  tooltip: string;
  notFound: boolean;
  version?: string;
  dir?: string;
}

/** What the status bar item shows when idle: version of the installation in use, or "not found". */
export function installationStatus(): InstallationStatus {
  const r = checkSysdir(sysdirSetting());
  if (!r.dir) return { text: 'GAMS: not found', tooltip: `${r.problem ?? 'GAMS not found.'} Click to select a GAMS installation.`, notFound: true };
  const version = readGamsVersion(r.dir);
  const where = r.source === 'setting' ? 'setting gams.sysdir' : r.source === 'path' ? 'PATH' : 'newest found';
  return {
    text: `GAMS ${shortVersion(version)}`,
    tooltip: `GAMS ${version}\n${r.dir}\nChosen by: ${where}\nClick to select a GAMS installation.`,
    notFound: false,
    version,
    dir: r.dir,
  };
}

interface Pick extends vscode.QuickPickItem {
  kind?: vscode.QuickPickItemKind;
  action?: 'auto' | 'browse' | 'dir';
  dir?: string;
}

/** Folder containing gams[.exe], or the executable itself -> its folder; undefined if not a GAMS folder. */
export function sysdirFromBrowse(p: string): string | undefined {
  let dir = p;
  try {
    if (fs.statSync(p).isFile()) dir = path.dirname(p);
  } catch {
    return undefined;
  }
  const r = checkSysdir(dir);
  return r.dir;
}

async function browse(): Promise<string | undefined> {
  const exe = gamsExecutableName();
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select GAMS',
    title: `Select the GAMS folder (the one containing ${exe}) or ${exe} itself`,
  });
  if (!picked?.length) return undefined;
  const dir = sysdirFromBrowse(picked[0].fsPath);
  if (!dir) {
    void vscode.window.showErrorMessage(`"${picked[0].fsPath}" is not a GAMS folder: ${exe} was not found there.`);
    return undefined;
  }
  return dir;
}

function scopeName(s: string): string {
  return s === 'workspaceFolder' ? 'folder' : s === 'workspace' ? 'workspace' : 'user';
}

export async function selectInstallation(): Promise<void> {
  const current = checkSysdir(sysdirSetting());
  const list = listInstallations();
  const newest = list[0];
  const items: Pick[] = list.map((i: GamsInstallation) => {
    const marks: string[] = [];
    if (current.dir && sameDir(i.dir, current.dir)) marks.push('(in use)');
    if (i === newest) marks.push('(newest, auto)');
    return {
      label: `GAMS ${i.version}${marks.length ? ' ' + marks.join(' ') : ''}`,
      description: i.dir,
      detail: i.source === 'path' ? 'Found on PATH' : 'Installed',
      action: 'dir' as const,
      dir: i.dir,
    };
  });
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(sparkle) Automatic (newest found)', detail: 'Clears gams.sysdir; the extension picks PATH or the newest installation.', action: 'auto' });
  items.push({ label: '$(folder-opened) Browse...', detail: 'Choose the GAMS folder or the gams program.', action: 'browse' });
  const pick = await vscode.window.showQuickPick(items, { title: 'Select GAMS Installation', placeHolder: current.dir ? `In use: ${current.dir}` : 'No GAMS installation in use' });
  if (!pick?.action) return;

  const cfg = vscode.workspace.getConfiguration('gams');
  const info = cfg.inspect<string>('sysdir');
  const inspect: SettingInspect = { globalValue: info?.globalValue, workspaceValue: info?.workspaceValue, workspaceFolderValue: info?.workspaceFolderValue };

  if (pick.action === 'auto') {
    const set = (v: string | undefined): boolean => v !== undefined && v !== '';
    if (set(inspect.workspaceFolderValue)) await cfg.update('sysdir', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    if (set(inspect.workspaceValue)) await cfg.update('sysdir', undefined, vscode.ConfigurationTarget.Workspace);
    if (set(inspect.globalValue)) await cfg.update('sysdir', undefined, vscode.ConfigurationTarget.Global);
    return;
  }

  const dir = pick.action === 'browse' ? await browse() : pick.dir;
  if (!dir) return;

  const targets = availableTargets((vscode.workspace.workspaceFolders?.length ?? 0) > 0);
  let target = targets[0];
  if (targets.length > 1) {
    const remote = vscode.env.remoteName;
    const t = await vscode.window.showQuickPick(
      [
        { label: 'This workspace', detail: 'Only for the folder that is open now (saved in .vscode/settings.json).', t: 'workspace' as const },
        { label: 'All workspaces', detail: remote ? `For every folder opened on ${remote} (saved in the settings of ${remote}).` : 'For every folder you open (your user settings).', t: 'global' as const },
      ],
      { title: `Use GAMS ${readGamsVersion(dir)} for...`, placeHolder: dir },
    );
    if (!t) return;
    target = t.t;
  } else if (vscode.env.remoteName) {
    void vscode.window.setStatusBarMessage(`Saved in the settings of ${vscode.env.remoteName}`, 4000);
  }
  await cfg.update('sysdir', dir, target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);

  const over = overridingScopes(target, inspect);
  if (over.length) {
    const names = over.map(scopeName).join(' and ');
    const act = await vscode.window.showWarningMessage(
      `gams.sysdir is also set in the ${names} settings, which takes priority over your choice.`,
      'Clear it',
      'Keep',
    );
    if (act === 'Clear it') {
      const fresh = vscode.workspace.getConfiguration('gams');
      if (over.includes('workspaceFolder')) await fresh.update('sysdir', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      if (over.includes('workspace')) await fresh.update('sysdir', undefined, vscode.ConfigurationTarget.Workspace);
    }
  }
}

export function registerInstallationCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gams.selectInstallation', () => selectInstallation()),
    // not in package.json: used by the integration tests
    vscode.commands.registerCommand('gams._installationStatus', () => installationStatus()),
  ];
}
