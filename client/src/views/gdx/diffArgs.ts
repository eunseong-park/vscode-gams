// SPDX-License-Identifier: GPL-3.0-or-later
// Pure part of the GDX diff command: argument construction and option rules.
// Ported from Studio src/gdxdiffdialog/gdxdiffdialog.cpp (gdxDiffParamters, on_cbFieldOnly_toggled,
// on_cbDiffOnly_toggled, on_cbFieldToCompare_currentIndexChanged, prepopulateDiff) and
// gdxdiffprocess.cpp (the diff file is taken from the "Output:" line of gdxdiff's stdout).
import * as path from 'path';

export const DIFF_FIELDS = ['All', 'L', 'M', 'Lo', 'Up', 'Prior', 'Scale'] as const;
export type DiffField = (typeof DIFF_FIELDS)[number];
export const DEFAULT_DIFF_FILE = 'diff.gdx';

export interface GdxDiffOptions {
  input1: string;
  input2: string;
  /** output file; empty = default `diff.gdx` in the working directory */
  diffFile: string;
  field: DiffField;
  eps: string;
  relEps: string;
  fieldOnly: boolean;
  diffOnly: boolean;
  ignoreSetText: boolean;
  cmpDefaults: boolean;
  cmpDomains: boolean;
  ignoreOrder: boolean;
}

export function defaultDiffOptions(): GdxDiffOptions {
  return {
    input1: '', input2: '', diffFile: '', field: 'All', eps: '', relEps: '',
    fieldOnly: false, diffOnly: false, ignoreSetText: false, cmpDefaults: false, cmpDomains: false, ignoreOrder: false,
  };
}

/** Studio's checkbox interplay: Field Only excludes Diff Only and needs a field other than All. */
export function normalizeDiffOptions(o: GdxDiffOptions, changed?: 'fieldOnly' | 'diffOnly' | 'field'): GdxDiffOptions {
  const r = { ...o };
  if (changed === 'fieldOnly' && r.fieldOnly) {
    r.diffOnly = false;
    if (r.field === 'All') r.field = 'L';
  } else if (changed === 'diffOnly' && r.diffOnly) {
    r.fieldOnly = false;
  } else if (changed === 'field' && r.field === 'All') {
    r.fieldOnly = false;
  }
  return r;
}

/** `gdxDiffParamters()`; paths are resolved against `workingDir` like Studio. */
export function gdxDiffArgs(o: GdxDiffOptions, workingDir: string): string[] {
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(workingDir, p));
  const args = [abs(o.input1), abs(o.input2)];
  const d = resolveDiffFile(o.diffFile, workingDir);
  if (d) args.push(d);
  args.push(`Field=${o.field}`);
  if (o.eps.trim()) args.push(`Eps=${o.eps.trim()}`);
  if (o.relEps.trim()) args.push(`RelEps=${o.relEps.trim()}`);
  if (o.fieldOnly) args.push('FldOnly');
  if (o.diffOnly) args.push('DiffOnly');
  if (o.ignoreSetText) args.push('SetDesc=0');
  if (o.cmpDefaults) args.push('CmpDefaults');
  if (o.cmpDomains) args.push('CmpDomains');
  if (o.ignoreOrder) args.push('IgnoreOrder');
  return args;
}

/** Empty -> working dir + diff.gdx; relative -> working dir; missing suffix -> `.gdx` (on_pbOK_clicked). */
export function resolveDiffFile(diffFile: string, workingDir: string): string {
  let f = diffFile.trim();
  if (!f) f = path.join(workingDir, DEFAULT_DIFF_FILE);
  else if (!path.isAbsolute(f)) f = path.join(workingDir, f);
  if (path.extname(f) === '') f += '.gdx';
  return f;
}

/** Studio prepopulates the diff file next to the first input. */
export function prepopulateDiff(input1: string, workingDir: string): string {
  return path.join(input1 ? path.dirname(input1) : workingDir, DEFAULT_DIFF_FILE);
}

/** `GdxDiffProcess::appendSystemLog`: the text after "Output:" is the diff file. */
export function parseDiffOutput(stdout: string, workingDir: string): string | undefined {
  let found: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.indexOf('Output:');
    if (i >= 0) found = line.slice(i + 'Output:'.length).trim();
  }
  if (!found) return undefined;
  return path.isAbsolute(found) ? path.normalize(found) : path.normalize(path.join(workingDir, found));
}

/** Validation messages as in on_pbOK_clicked ('' = ok). */
export function validateDiffInputs(o: Pick<GdxDiffOptions, 'input1' | 'input2'>): string {
  if (!o.input1.trim() || !o.input2.trim()) return 'Please specify two GDX files to be compared.';
  return '';
}
