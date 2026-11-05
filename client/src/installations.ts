// SPDX-License-Identifier: GPL-3.0-or-later
/** Finding the installed GAMS versions (for the picker and the status bar). Pure node (no vscode imports). */
import * as fs from 'fs';
import * as path from 'path';
import { compareVersionDesc, DEFAULT_SYSDIR_ROOTS, gamsExecutableName } from './sysdir';

export interface GamsInstallation {
  dir: string;
  /** `x.y.z` from `gamsstmp.txt`, else the version part of the folder name, else "unknown". */
  version: string;
  source: 'path' | 'install';
}

export const UNKNOWN_VERSION = 'unknown';

function hasGams(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, gamsExecutableName())).isFile();
  } catch {
    return false;
  }
}

/** Version of a GAMS system directory: first `x.y.z` of the first line of `gamsstmp.txt`, else from the folder name. */
export function readGamsVersion(dir: string): string {
  try {
    const first = fs.readFileSync(path.join(dir, 'gamsstmp.txt'), 'utf8').split(/\r?\n/, 1)[0] ?? '';
    const m = /\b(\d+\.\d+\.\d+)\b/.exec(first);
    if (m) return m[1];
  } catch {
    // fall through to the folder name
  }
  return versionFromFolderName(dir);
}

/** `gams54.6_linux_x64` -> `54.6`, `49` -> `49`; macOS `.../Versions/54/Resources` uses the parent folder. */
export function versionFromFolderName(dir: string): string {
  let name = path.basename(dir);
  if (name.toLowerCase() === 'resources') name = path.basename(path.dirname(dir));
  const m = /(\d+(?:\.\d+)*)/.exec(name);
  return m ? m[1] : UNKNOWN_VERSION;
}

/** `54.6.1` -> `54.6`; anything without a minor part is returned as is. */
export function shortVersion(version: string): string {
  const m = /^(\d+\.\d+)/.exec(version);
  return m ? m[1] : version;
}

function real(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Every usable GAMS system directory: each `gams` on PATH plus every version folder under the roots
 * (same layouts as `checkSysdir`), de-duplicated by real path (a PATH hit wins), newest version first.
 */
export function listInstallations(
  envPath: string | undefined = process.env.PATH,
  roots: readonly string[][] = DEFAULT_SYSDIR_ROOTS,
): GamsInstallation[] {
  const seen = new Set<string>();
  const out: GamsInstallation[] = [];
  const add = (dir: string, source: GamsInstallation['source']): void => {
    const key = real(dir);
    if (seen.has(key)) return;
    seen.add(key);
    const shown = source === 'path' ? key : dir;
    out.push({ dir: shown, version: readGamsVersion(shown), source });
  };
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (dir && hasGams(dir)) add(real(dir), 'path');
  }
  for (const r of roots) {
    for (const parent of r) {
      let entries: string[];
      try {
        entries = fs.readdirSync(parent);
      } catch {
        continue;
      }
      for (const e of entries) {
        const d = path.join(parent, e);
        if (hasGams(d)) add(d, 'install');
        else if (hasGams(path.join(d, 'Resources'))) add(path.join(d, 'Resources'), 'install');
      }
    }
  }
  return out.sort((a, b) => compareVersionDesc(a.version, b.version) || a.dir.localeCompare(b.dir));
}

export type SettingScope = 'workspaceFolder' | 'workspace' | 'global';

export interface SettingInspect {
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
}

/** Scopes that hold a non-empty value and would override a choice written to `target`. */
export function overridingScopes(target: 'workspace' | 'global', inspect: SettingInspect): SettingScope[] {
  const set = (v: string | undefined): boolean => v !== undefined && v !== '';
  const res: SettingScope[] = [];
  if (set(inspect.workspaceFolderValue)) res.push('workspaceFolder');
  if (target === 'global' && set(inspect.workspaceValue)) res.push('workspace');
  return res;
}

/** The two target choices: "This workspace" only when a folder is open. */
export function availableTargets(hasFolder: boolean): ('workspace' | 'global')[] {
  return hasFolder ? ['workspace', 'global'] : ['global'];
}

/** The installation `gams.sysdir` is currently resolving to (real path compare), if listed. */
export function sameDir(a: string, b: string): boolean {
  return real(a) === real(b) || a === b;
}
