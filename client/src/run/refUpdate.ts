// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Compile-only run (ACTION=C) that refreshes the reference data of a model; used by the opt-in setting
 * `gams.updateReferencesOnSave`. Same argument construction as a normal Compile (buildGamsArgs), but the listing and
 * reference output go to a private temp directory (o=, rf=) so the user's <stem>.lst/.ref are never overwritten
 * and a concurrent normal run cannot clash. Uses a GAMS license session per call. No vscode imports.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildGamsArgs, GamsProcess, resolveDefaultFileParams } from './gamsProcess';

const OUTPUT_KEYS = ['o', 'output', 'rf', 'reference'];

/** Compile arguments with o=/rf= redirected into `tmpDir` (user o=/rf= are dropped; the last value would win in GAMS). */
export function buildRefCompileArgs(gmsFile: string, userParams: string[], tmpDir: string): { args: string[]; refPath: string } {
  const stem = path.basename(gmsFile, path.extname(gmsFile));
  const base = resolveDefaultFileParams(buildGamsArgs(gmsFile, userParams, true), stem).filter((a) => {
    const i = a.indexOf('=');
    return !(i > 0 && OUTPUT_KEYS.includes(a.substring(0, i).toLowerCase()));
  });
  const refPath = path.join(tmpDir, stem + '.ref');
  return { args: [...base, `o="${path.join(tmpDir, stem + '.lst')}"`, `rf="${refPath}"`], refPath };
}

export interface RefCompileResult {
  refPath: string;
  /** ms since epoch when the compile was spawned */
  startedAt: number;
  /** remove the temp directory (call once the consumer has read the ref file) */
  cleanup(): void;
}

/** Resolves with the temp .ref written by GAMS, or undefined when GAMS wrote none. */
export function compileForReference(
  sysdir: string,
  gmsFile: string,
  userParams: string[],
  workDir: string = path.dirname(gmsFile),
): Promise<RefCompileResult | undefined> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gams-ref-'));
  const cleanup = (): void => fs.rmSync(tmpDir, { recursive: true, force: true });
  const { args, refPath } = buildRefCompileArgs(gmsFile, userParams, tmpDir);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const proc = new GamsProcess(sysdir, args, workDir);
    // drain the pipes so GAMS never blocks on a full buffer
    proc.on('stdout', () => undefined);
    proc.on('stderr', () => undefined);
    proc.on('error', (e) => {
      cleanup();
      reject(e);
    });
    proc.on('close', () => {
      if (fs.existsSync(refPath)) resolve({ refPath, startedAt, cleanup });
      else {
        cleanup();
        resolve(undefined);
      }
    });
    proc.start();
  });
}
