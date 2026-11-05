// SPDX-License-Identifier: GPL-3.0-or-later
/* Task definition `gams` (tasks.json) resolution and tasks.json merge. Pure: no vscode imports. */
import * as path from 'path';

export interface GamsTaskDef {
  type: 'gams';
  file?: string;
  parameters?: string[];
  compile?: boolean;
}

export interface TaskContext {
  /** active GAMS file (the `${file}` default); undefined when no GAMS editor is active */
  activeFile?: string;
  workspaceRoot?: string;
}

export interface ResolvedGamsTask {
  file: string;
  parameters: string[];
  compile: boolean;
}

/** Replaces `${file}`, `${workspaceFolder}`, `${fileDirname}`, `${fileBasename}`; relative files resolve against the workspace. */
export function resolveTaskDef(def: Partial<GamsTaskDef>, ctx: TaskContext): ResolvedGamsTask | { error: string } {
  const raw = def.file && def.file.trim() ? def.file.trim() : '${file}';
  const active = ctx.activeFile;
  if (raw.includes('${file') && !active) return { error: 'No GAMS file is open; set "file" in the task.' };
  let file = raw
    .split('${workspaceFolder}').join(ctx.workspaceRoot ?? '')
    .split('${fileDirname}').join(active ? path.dirname(active) : '')
    .split('${fileBasename}').join(active ? path.basename(active) : '')
    .split('${file}').join(active ?? '');
  if (!path.isAbsolute(file)) {
    if (!ctx.workspaceRoot) return { error: `Cannot resolve "${file}" without a workspace folder.` };
    file = path.resolve(ctx.workspaceRoot, file);
  }
  file = path.normalize(file); // separators after substitution (`D:\\w/c.gms` on Windows)
  const parameters = Array.isArray(def.parameters) ? def.parameters.filter((p): p is string => typeof p === 'string') : [];
  return { file, parameters, compile: def.compile === true };
}

export interface ShellTaskJson {
  label: string;
  type: 'shell';
  command: string;
  options?: { cwd: string };
  problemMatcher: string[];
  [k: string]: unknown;
}

export function shellTaskFromRunScript(command: string, cwd?: string, label = 'GAMS project run'): ShellTaskJson {
  const t: ShellTaskJson = { label, type: 'shell', command, problemMatcher: [] };
  if (cwd && cwd.trim()) t.options = { cwd };
  return t;
}

/** Appends `task` to the existing tasks without touching them; a task with the same label is kept as is. */
export function mergeTask(existing: unknown, task: { label: string }): { tasks: unknown[]; added: boolean } {
  const list = Array.isArray(existing) ? [...existing] : [];
  if (list.some((t) => t && typeof t === 'object' && (t as { label?: unknown }).label === task.label)) return { tasks: list, added: false };
  list.push(task);
  return { tasks: list, added: true };
}
