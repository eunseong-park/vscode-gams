// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Main-file resolution (Studio: a file belongs to a project, whose main file is run; "set as main file" in
 * mainwindow.cpp / PExProjectNode::setRunnableGms). Pure: no vscode imports.
 */
import * as path from 'path';
import { GspProject, projectOwnsFile, samePath } from './gsp';

export type Resolution =
  | { kind: 'project'; project: GspProject; main: string }
  | { kind: 'main'; main: string }
  | { kind: 'self' }
  | { kind: 'ask'; candidates: string[] };

export interface ResolveInput {
  active: string;
  projects: GspProject[];
  /** Main file remembered for the workspace (gams.setMainFile). */
  remembered?: string;
  /** Known .gms files whose `$include` chain contains the active file. */
  includers: string[];
}

/** Studio FileKind::Gms suffixes (filetype.cpp): files that become the main file of a dynamic project. */
export function isGmsKind(file: string): boolean {
  return /\.(gms|inc|dmp)$/i.test(file);
}

/**
 * Main file of a project for a run started from `active` (MainWindow::processMainFileDynamics, mainwindow.cpp):
 * a project with `dynamicMainFile` makes the active GAMS source file its main file on every run.
 */
export function projectMainFor(p: GspProject, active: string): string | undefined {
  if (p.dynamicMainFile && projectOwnsFile(p, active) && isGmsKind(active)) return active;
  return p.mainFile;
}

export function resolveMainFile(i: ResolveInput): Resolution {
  for (const p of i.projects) {
    const main = projectMainFor(p, i.active);
    if (main && projectOwnsFile(p, i.active)) return { kind: 'project', project: p, main };
  }
  if (i.remembered && samePath(i.remembered, i.active)) return { kind: 'self' };
  const isGms = /\.gms$/i.test(i.active);
  if (isGms && i.includers.length === 0) return { kind: 'self' };
  if (i.remembered && (i.includers.length === 0 || i.includers.some((f) => samePath(f, i.remembered as string)))) {
    return { kind: 'main', main: i.remembered };
  }
  return { kind: 'ask', candidates: i.includers };
}

/** Files among `files` (path + text) that include `target` via $include/$batInclude/$libInclude/$sysInclude. */
export function findIncluders(target: string, files: { path: string; text: string }[]): string[] {
  const base = path.basename(target).toLowerCase();
  const re = /^\s*\$(?:bat|lib|sys)?include\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gim;
  const res: string[] = [];
  for (const f of files) {
    if (samePath(f.path, target)) continue;
    re.lastIndex = 0;
    for (let m = re.exec(f.text); m; m = re.exec(f.text)) {
      const name = (m[1] ?? m[2] ?? m[3]).replace(/\\/g, '/');
      if (name.split('/').pop()?.toLowerCase() === base) {
        res.push(f.path);
        break;
      }
    }
  }
  return res;
}
