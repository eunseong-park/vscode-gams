// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Decision logic for the still supported (deprecated) 0.1.x settings `GAMS.*`. Pure: no vscode imports.
 * Behavior mirrors the previous extension (v0.1.4): run.ts, showListing.ts, openCorrGDX.ts, utils.ts.
 */
import * as path from 'path';

/** Explicitly set (user/workspace) values of the 0.1.x settings; undefined = not set. */
export interface LegacySettings {
  runProject?: boolean;
  runBatchPath?: string;
  projectLst?: string;
  projectGDX?: string;
  terminalCwd?: string;
  preserveFocus?: boolean;
  listingFileLocation?: string;
  executablePath?: string;
  commandLineParameters?: string;
}

const nonEmpty = (s: string | undefined): string | undefined => (s !== undefined && s.trim() !== '' ? s : undefined);

/**
 * 0.1.4 gams.run: with `runProject` and a `runBatchPath` the batch file runs in a terminal; `runProject` without
 * a batch path ran the single-file command (like a normal run), so only the batch case is a different mode.
 */
export function legacyRunMode(s: LegacySettings): 'batch' | 'normal' {
  return s.runProject === true && nonEmpty(s.runBatchPath) ? 'batch' : 'normal';
}

/** Setting values honoured by 0.1.4's showListing / openCorrGDX when `runProject` is on. */
export function legacyProjectFile(s: LegacySettings, kind: 'lst' | 'gdx'): string | undefined {
  if (s.runProject !== true) return undefined;
  return nonEmpty(kind === 'lst' ? s.projectLst : s.projectGDX);
}

/** 0.1.4: `terminalCwd || dirPath`. `${workspaceFolder}` is expanded; a relative path is taken from the workspace folder. */
export function legacyCwd(terminalCwd: string | undefined, fileDir: string, workspaceRoot?: string): string {
  let t = nonEmpty(terminalCwd)?.trim();
  if (!t) return fileDir;
  if (workspaceRoot) t = t.split('${workspaceFolder}').join(workspaceRoot);
  if (!path.isAbsolute(t) && workspaceRoot) t = path.resolve(workspaceRoot, t);
  // normalize separators after substitution (`D:\\w/x` on Windows)
  return path.normalize(t);
}

/** `terminalCwd` for a normal run, unless a project (.gsp) decides the working directory. */
export function runWorkDir(terminalCwd: string | undefined, fromProject: boolean, target: string | undefined, fallback: string, workspaceRoot?: string): string {
  if (fromProject) return target ?? fallback;
  return nonEmpty(terminalCwd) ? legacyCwd(terminalCwd, fallback, workspaceRoot) : (target ?? fallback);
}

/** Result for `viewColumn`: ViewColumn.Active = -1, Beside = -2, One..Nine = 1..9. */
export type Column = number;
export const COLUMN_ACTIVE = -1;
export const COLUMN_BESIDE = -2;
const NAMES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** Maps "beside" | "active" | "1".."9" and the 0.1.x values "Beside", "Active", "One".."Nine" (any case). */
export function columnFor(location: string | undefined): Column {
  const k = (location ?? '').trim().toLowerCase();
  if (k === 'active') return COLUMN_ACTIVE;
  if (/^[1-9]$/.test(k)) return Number(k);
  const i = NAMES.indexOf(k);
  return i >= 0 ? i + 1 : COLUMN_BESIDE;
}

/** New setting if explicitly set, else the legacy value if set, else the default. */
export function effective<T>(explicitNew: T | undefined, legacy: T | undefined, def: T): T {
  return explicitNew ?? legacy ?? def;
}

export interface EditorOpenOptions {
  viewColumn: Column;
  preserveFocus: boolean;
}

export function editorOpenOptions(
  newLocation: string | undefined, newPreserve: boolean | undefined, legacy: LegacySettings,
): EditorOpenOptions {
  return {
    viewColumn: columnFor(effective(newLocation, legacy.listingFileLocation, 'beside')),
    preserveFocus: effective(newPreserve, legacy.preserveFocus, true),
  };
}
