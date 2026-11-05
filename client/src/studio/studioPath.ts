// SPDX-License-Identifier: GPL-3.0-or-later
/** Locating and launching GAMS Studio. Pure (no vscode imports). */
import * as path from 'path';

/** Default Studio location below the sysdir (or the macOS application folder). */
export function studioCandidates(sysdir: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  if (sysdir) {
    if (platform === 'win32') out.push(path.win32.join(sysdir, 'studio', 'studio.exe'));
    else if (platform === 'darwin') out.push(path.posix.join(sysdir, 'studio', 'GAMS Studio.app'));
    else out.push(path.posix.join(sysdir, 'studio', 'studio.AppImage'), path.posix.join(sysdir, 'studio', 'studio'));
  }
  if (platform === 'darwin') out.push('/Applications/GAMS Studio.app');
  return out;
}

export function resolveStudioPath(
  setting: string | undefined,
  sysdir: string | undefined,
  exists: (p: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const s = setting?.trim();
  if (s) return s;
  return studioCandidates(sysdir, platform).find(exists);
}

/** Shell-like split: blanks separate, double/single quotes group, backslash is literal. */
export function splitArgs(str: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  let has = false;
  for (const c of str) {
    if (q) {
      if (c === q) q = ''; else cur += c;
    } else if (c === '"' || c === "'") {
      q = c; has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = ''; has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

export interface LaunchSpec { command: string; args: string[] }

/** Command line to start Studio on `file` (macOS .app bundles go through `open`). */
export function launchSpec(studio: string, extraArgs: string[], file: string, platform: NodeJS.Platform = process.platform): LaunchSpec {
  if (platform === 'darwin' && /\.app\/?$/i.test(studio)) {
    return { command: 'open', args: ['-a', studio, file, ...(extraArgs.length ? ['--args', ...extraArgs] : [])] };
  }
  return { command: studio, args: [...extraArgs, file] };
}
