/*
 * VS Code side of the GAMS system directory check (see sysdir.ts): a non-modal error with an
 * "Open Settings" button for everything that needs the sysdir (run, compile, debug, profile,
 * model library, NEOS, Connect).
 */
import * as vscode from 'vscode';
import { checkSysdir, SysdirCheck } from './sysdir';

export function sysdirSetting(): string {
  return vscode.workspace.getConfiguration('gams').get<string>('sysdir', '');
}

export function currentSysdirCheck(): SysdirCheck {
  return checkSysdir(sysdirSetting());
}

/** Show the problem (never modal, never awaited by the caller) with an "Open Settings" action. */
export function reportSysdirProblem(problem: string, what?: string): void {
  const text = what ? `${what}: ${problem}` : problem;
  void vscode.window.showErrorMessage(text, 'Open Settings').then((pick) => {
    if (pick === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'gams.sysdir');
  });
}

/** The valid sysdir, or undefined after showing the error. */
export function requireSysdir(what?: string): string | undefined {
  const r = currentSysdirCheck();
  if (r.dir) return r.dir;
  reportSysdirProblem(r.problem ?? 'GAMS system directory not found. Set "gams.sysdir".', what);
  return undefined;
}
