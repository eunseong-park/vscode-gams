// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { gamsEnvironment } from '../sysdir';
import { currentSysdirCheck, reportSysdirProblem } from '../sysdirUi';
import { findSysdirGlbs, findUserGlbs, gamslibArgs, GlbLibrary, GlbModel, libraryLabel, modelInputFile, parseGlbFile, resolveTargetDir } from './glb';

function defaultUserLibDir(): string {
  // CommonPaths::userModelLibraryDir: <GAMS documents dir>/modellibs
  return path.join(os.homedir(), 'Documents', 'GAMS', 'modellibs');
}

/** Port of Studio's model library dialog (modeldialog/*) as QuickPicks. */
export async function openModelLibrary(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gams');
  const check = currentSysdirCheck();
  const sysdir = check.dir;
  if (!sysdir) {
    reportSysdirProblem(check.problem ?? 'GAMS system directory not found. Set "gams.sysdir".', 'Model library');
    return;
  }
  const userDirCfg = cfg.get<string>('userModelLibraryDir', '');
  const ur = userDirCfg ? resolveTargetDir(userDirCfg, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(), os.homedir()) : undefined;
  const userDir = ur && 'dir' in ur ? ur.dir : defaultUserLibDir();
  const libs: GlbLibrary[] = [];
  for (const f of [...findSysdirGlbs(sysdir), ...findUserGlbs(userDir)]) {
    try { libs.push(parseGlbFile(f)); } catch (e) { void vscode.window.showWarningMessage((e as Error).message); }
  }
  if (!libs.length) {
    void vscode.window.showErrorMessage(`No model libraries found in ${sysdir} (GAMS system directory, ${check.source === 'setting' ? 'setting gams.sysdir' : 'auto-detected, set gams.sysdir to change it'}) or in ${userDir}.`, 'Open Settings').then((pick) => {
      if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'gams.sysdir');
    });
    return;
  }
  const lib = (await vscode.window.showQuickPick(
    libs.map((l) => ({ label: libraryLabel(l), description: `${l.models.length} models`, detail: l.glbFile, lib: l })),
    { title: 'GAMS: Model Library', placeHolder: 'Select a library' },
  ))?.lib;
  if (!lib) return;
  const nameCol = lib.columns.findIndex((c) => c.toLowerCase() === 'name');
  const descCol = lib.columns.findIndex((c) => c.toLowerCase() === 'description');
  const model = (await vscode.window.showQuickPick(
    lib.models.map((m) => ({
      label: m.nameWithSuffix,
      description: [m.values[descCol], ...m.values.filter((_, i) => i !== nameCol && i !== descCol).map((v, _i) => v)].filter(Boolean).join(' | '),
      detail: m.longDescription.split('\n')[0] || undefined,
      m,
    })),
    { title: libraryLabel(lib), placeHolder: 'Search by name or description', matchOnDescription: true, matchOnDetail: true },
  ))?.m;
  if (!model) return;
  await retrieveModel(sysdir, lib, model, cfg);
}

async function retrieveModel(sysdir: string, lib: GlbLibrary, model: GlbModel, cfg: vscode.WorkspaceConfiguration): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const def = cfg.get<string>('modelLibraryTargetDir', '') || ws || os.homedir();
  const base = ws ?? os.homedir();
  const typed = await vscode.window.showInputBox({
    title: `Copy ${model.nameWithSuffix} to folder`,
    value: def,
    prompt: 'Target folder (~ and relative paths are resolved against the workspace folder, or the home folder)',
    validateInput: (v) => ('error' in resolveTargetDir(v, base, os.homedir()) ? (resolveTargetDir(v, base, os.homedir()) as { error: string }).error : undefined),
  });
  if (!typed) return;
  const resolved = resolveTargetDir(typed, base, os.homedir());
  if ('error' in resolved) return void vscode.window.showErrorMessage(resolved.error);
  const dest = resolved.dir;
  const input = modelInputFile(model);
  const target = path.join(dest, input);
  if (fs.existsSync(target)) {
    const pick = await vscode.window.showWarningMessage(`${input} already exists in ${dest}.`, { modal: true }, 'Open', 'Replace');
    if (!pick) return;
    if (pick === 'Open') return void (await vscode.window.showTextDocument(vscode.Uri.file(target)));
    // Studio renames the old file to a backup (renameToBackup)
    let b = 1;
    while (fs.existsSync(`${target}.bak${b}`)) b++;
    fs.renameSync(target, `${target}.bak${b}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  const exe = path.join(sysdir, process.platform === 'win32' ? 'gamslib.exe' : 'gamslib');
  const err = await new Promise<string | undefined>((resolve) => {
    execFile(exe, gamslibArgs(lib.glbFile, model, dest), { cwd: dest, env: gamsEnvironment(sysdir) }, (e, _o, se) => resolve(e ? `${e.message}\n${se}` : undefined));
  });
  if (err) return void vscode.window.showErrorMessage(`gamslib failed: ${err}`);
  if (fs.existsSync(target)) await vscode.window.showTextDocument(vscode.Uri.file(target));
  else void vscode.window.showWarningMessage(`Model copied to ${dest}, but ${input} was not found.`);
}
