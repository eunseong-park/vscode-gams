// SPDX-License-Identifier: GPL-3.0-or-later
/** GAMS system directory detection. Pure node (no vscode imports). */
import * as fs from 'fs';
import * as path from 'path';

const isWin = process.platform === 'win32';

export function gamsExecutableName(): string {
  return isWin ? 'gams.exe' : 'gams';
}

function isSysdir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, gamsExecutableName())).isFile();
  } catch {
    return false;
  }
}

/** Compare names like gams54.6_<platform> / 49.6.1 numerically, descending. */
export function compareVersionDesc(a: string, b: string): number {
  const na = (a.match(/\d+/g) ?? []).map(Number);
  const nb = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] ?? -1) - (na[i] ?? -1);
    if (d !== 0) return d;
  }
  return b.localeCompare(a);
}

/** Version-sorted (newest first) sysdirs among the sub directories of the given parents. */
function newestIn(...parents: string[]): string | undefined {
  const cands: { name: string; dir: string }[] = [];
  for (const parent of parents) {
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch {
      continue;
    }
    for (const e of entries) cands.push({ name: e, dir: path.join(parent, e) });
  }
  for (const c of cands.sort((a, b) => compareVersionDesc(a.name, b.name))) {
    if (isSysdir(c.dir)) return c.dir;
    // macOS framework layout: Versions/<major>/Resources holds gams (Studio MacOSPathFinder::systemDir).
    const res = path.join(c.dir, 'Resources');
    if (isSysdir(res)) return res;
  }
  return undefined;
}

function fromPath(envPath: string | undefined): string | undefined {
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, gamsExecutableName());
    if (fs.existsSync(exe)) {
      try {
        return path.dirname(fs.realpathSync(exe));
      } catch {
        return dir;
      }
    }
  }
  return undefined;
}

/**
 * Install locations searched when nothing is configured: Linux `/opt/gams/gams<ver>_...`,
 * Windows `C:\GAMS\<NN>` and the older `C:\GAMS\win64\<NN>` layout, macOS
 * `/Library/Frameworks/GAMS.framework/Versions/<major>/Resources` (`Current` is a symlink and sorts last).
 */
export const DEFAULT_SYSDIR_ROOTS: readonly string[][] = [
  ['/opt/gams'],
  ['C:/GAMS', 'C:/GAMS/win64'],
  ['/Library/Frameworks/GAMS.framework/Versions'],
];

export interface SysdirCheck {
  /** Usable system directory (contains the gams executable). */
  dir?: string;
  /** Why the configured directory cannot be used / why nothing was found. */
  problem?: string;
  /** Where `dir` came from. */
  source?: 'setting' | 'path' | 'install';
}

/**
 * Validate the `gams.sysdir` setting (or auto-detect when it is empty): the directory must exist and
 * contain `gams[.exe]`; a setting that points at the executable itself yields its directory.
 * Order without a setting: `gams` on PATH, newest installation under the default roots.
 */
export function checkSysdir(
  setting: string | undefined,
  envPath = process.env.PATH,
  roots: readonly string[][] = DEFAULT_SYSDIR_ROOTS,
): SysdirCheck {
  const exeName = gamsExecutableName();
  const given = setting?.trim().replace(/^"(.*)"$/, '$1');
  if (given) {
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(given);
    } catch {
      st = undefined;
    }
    if (!st) return { problem: `The GAMS system directory "${given}" (setting gams.sysdir) does not exist.` };
    if (st.isFile()) {
      if (path.basename(given).toLowerCase().replace(/\.exe$/, '') === 'gams') return { dir: path.dirname(given), source: 'setting' };
      return { problem: `"${given}" (setting gams.sysdir) is a file. Set it to the GAMS system directory, the folder that contains ${exeName}.` };
    }
    if (isSysdir(given)) return { dir: given, source: 'setting' };
    return { problem: `The folder "${given}" (setting gams.sysdir) does not contain ${exeName}. Set it to the GAMS system directory.` };
  }
  const p = fromPath(envPath);
  if (p) return { dir: p, source: 'path' };
  for (const r of roots) {
    const d = newestIn(...r);
    if (d) return { dir: d, source: 'install' };
  }
  return { problem: `No GAMS installation found (${exeName} is not on PATH and not in ${roots.map((r) => r[0]).join(' or ')}). Set the GAMS system directory in the setting gams.sysdir.` };
}

/** setting -> `gams` on PATH -> newest /opt/gams/* -> newest C:/GAMS/[win64/]*; undefined when unusable (see checkSysdir). */
export function detectSysdir(setting: string | undefined, envPath = process.env.PATH): string | undefined {
  return checkSysdir(setting, envPath).dir;
}

/**
 * Environment for GAMS child processes, ported from Studio's
 * `Application::initEnvironment` (application.cpp): prepend `<sysdir>` and
 * `<sysdir>/gbin` to PATH, and on non-Windows also to LD_LIBRARY_PATH (macOS:
 * DYLD_LIBRARY_PATH). Studio changes its own process environment; here it is
 * applied only to the processes we spawn so other extensions are unaffected.
 */
export function gamsEnvironment(
  sysdir: string,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const sep = platform === 'win32' ? ';' : ':';
  const dirSep = platform === 'win32' ? '\\' : '/';
  const dir = platform === 'win32' ? sysdir.replace(/\//g, '\\') : sysdir;
  const gamsArr = dir + sep + dir + dirSep + 'gbin';
  const env: NodeJS.ProcessEnv = { ...base };
  const prepend = (name: string): void => {
    // Windows env names are case-insensitive; keep the existing key spelling.
    const key = Object.keys(env).find((k) => (platform === 'win32' ? k.toUpperCase() === name : k === name)) ?? name;
    const cur = env[key];
    env[key] = gamsArr + (cur ? sep + cur : '');
  };
  prepend('PATH');
  if (platform !== 'win32') prepend('LD_LIBRARY_PATH');
  if (platform === 'darwin') prepend('DYLD_LIBRARY_PATH');
  return env;
}
