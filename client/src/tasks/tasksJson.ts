// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { mergeTask, shellTaskFromRunScript } from './taskDef';

/** Adds a shell task "GAMS project run" (the 0.1.x run script) to the workspace's tasks.json, keeping existing tasks. */
export async function createTaskFromRunScript(command: string, cwd?: string): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage('GAMS: open a folder to create a task in .vscode/tasks.json.');
    return false;
  }
  const cfg = vscode.workspace.getConfiguration('tasks', folder.uri);
  const task = shellTaskFromRunScript(command, cwd);
  const { tasks, added } = mergeTask(cfg.inspect('tasks')?.workspaceFolderValue, task);
  if (!added) {
    void vscode.window.showInformationMessage(`GAMS: tasks.json already has a task "${task.label}".`);
    return false;
  }
  try {
    if (!cfg.inspect('version')?.workspaceFolderValue) await cfg.update('version', '2.0.0', vscode.ConfigurationTarget.WorkspaceFolder);
    await cfg.update('tasks', tasks, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch (e) {
    void vscode.window.showWarningMessage(`GAMS: could not write tasks.json: ${(e as Error).message}`);
    return false;
  }
  void vscode.window.showInformationMessage(`GAMS: added task "${task.label}" to .vscode/tasks.json. Chain it with GAMS tasks via dependsOn.`);
  return true;
}
