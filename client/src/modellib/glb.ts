// SPDX-License-Identifier: GPL-3.0-or-later
/** Pure GLB (model library index) parser. Port of Studio modeldialog/glbparser.cpp. No vscode imports. */
import * as fs from 'fs';
import * as path from 'path';

export interface GlbLibrary {
  name: string;
  version: number;
  columns: string[]; // column names indexed by column number - 1
  toolTips: string[];
  initialSort: number; // 0-based
  glbFile: string;
  models: GlbModel[];
}

export interface GlbModel {
  /** Values indexed by column number - 1. */
  values: string[];
  name: string;
  /** Name with `_N` suffix for duplicates (LibraryItem::nameWithSuffix), as passed to gamslib. */
  nameWithSuffix: string;
  files: string[];
  longDescription: string;
}

export class GlbError extends Error {}

function split2(line: string): [string, string] | undefined {
  const i = line.indexOf('=');
  return i < 0 ? undefined : [line.slice(0, i), line.slice(i + 1)];
}

export function parseGlb(text: string, glbFile = '<glb>'): GlbLibrary {
  const lines = text.split(/\r?\n/);
  let n = 0;
  const read = (): string | undefined => (n < lines.length ? lines[n++] : undefined);
  const fail = (msg?: string): never => {
    throw new GlbError(`Error while loading model library from GLB file: ${glbFile} (line ${n})${msg ? ': ' + msg : ''}`);
  };
  const keyed = (key: string): string => {
    const p = split2(read() ?? '');
    if (!p) return fail();
    if (!p![0].startsWith(key)) fail(`Expected '${key}' but found '${p![0]}'`);
    return p![1].trim();
  };
  const version = parseInt(keyed('Version'), 10) || 0;
  const name = keyed('LibraryName');
  const nCols = parseInt(keyed('Columns'), 10) || 0;
  const columns: string[] = new Array(nCols).fill('');
  const toolTips: string[] = new Array(nCols).fill('');
  let nameIdx = 0;
  for (let i = 0; i < nCols; i++) {
    const parts = (read() ?? '').split('|');
    const p = split2(parts[0]);
    if (!p) fail();
    const ord = parseInt(p![0].trim(), 10);
    if (!(ord >= 1 && ord <= nCols)) fail(`column number ${ord} out of range 1..${nCols}`);
    columns[ord - 1] = p![1].trim();
    toolTips[ord - 1] = parts.length === 2 ? parts[1].trim() : '';
    if (columns[ord - 1].toLowerCase() === 'name') nameIdx = ord - 1;
  }
  const initialSort = (parseInt(keyed('InitialSort'), 10) || 1) - 1;
  const models: GlbModel[] = [];
  const dup = new Map<string, number>();
  let line = read();
  while (line !== undefined) {
    if (!line.startsWith('*$*$*$')) {
      line = read();
      continue;
    }
    line = read();
    if (line === undefined || line.trim() === '') break; // gamslib and Studio stop at an empty line
    const fp = split2(line);
    if (!fp || !fp[0].startsWith('Files')) fail("Expected 'Files'");
    const files = fp![1].split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (!files.length) fail('empty file list');
    line = read();
    if (line?.startsWith('Directory')) line = read();
    let suffix = 0;
    const values: string[] = new Array(nCols).fill('');
    for (let i = 0; i < nCols; i++) {
      const p = split2(line ?? '');
      if (!p) fail();
      const idx = parseInt(p![0].trim(), 10);
      if (!(idx >= 1 && idx <= nCols)) fail(`column number ${idx} out of range 1..${nCols}`);
      const value = p![1].trim();
      values[idx - 1] = value;
      if (idx - 1 === nameIdx) {
        const key = value.toLowerCase();
        if (dup.has(key)) suffix = dup.get(key)! + 1;
        dup.set(key, suffix);
      }
      line = read();
    }
    let longDescription = '';
    while (line !== undefined && !line.startsWith('*$*$*$')) {
      longDescription += line + '\n';
      line = read();
    }
    const mname = values[nameIdx];
    models.push({
      values,
      name: mname,
      nameWithSuffix: suffix > 0 ? `${mname}_${suffix}` : mname,
      files,
      longDescription: longDescription.trim(),
    });
  }
  if (!models.length) fail('Library is empty but needs to contain at least one model');
  return { name, version, columns, toolTips, initialSort, glbFile, models };
}

export function parseGlbFile(file: string): GlbLibrary {
  return parseGlb(fs.readFileSync(file, 'utf8'), file);
}

/** Studio tab-name overrides (modeldialog.cpp). */
const LIB_LABELS: Record<string, string> = {
  gamslib: 'Model Library', testlib: 'Test Library', apilib: 'API Library', datalib: 'Data Utilities Library',
  emplib: 'EMP Library', finlib: 'FIN Library', noalib: 'NOA Library', psoptlib: 'PSO Library',
};

export function libraryLabel(lib: GlbLibrary): string {
  return LIB_LABELS[path.basename(lib.glbFile, '.glb').toLowerCase()] ?? lib.name;
}

/** All `*.glb` of `<sysdir>/*_ml/` (non-recursive). */
export function findSysdirGlbs(sysdir: string): string[] {
  const out: string[] = [];
  try {
    for (const d of fs.readdirSync(sysdir).sort()) {
      if (!d.endsWith('_ml')) continue;
      const dir = path.join(sysdir, d);
      try {
        for (const f of fs.readdirSync(dir)) if (f.toLowerCase().endsWith('.glb')) out.push(path.join(dir, f));
      } catch { /* not a dir */ }
    }
  } catch { /* ignore */ }
  return out;
}

/** All `*.glb` below a user library dir, recursively. */
export function findUserGlbs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.glb')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Main input file name after gamslib (MainWindow::openModelFromLib): numeric suffix -> `<base>.gms`. */
export function modelInputFile(model: GlbModel): string {
  const f = path.basename(model.files[0]);
  const ext = path.extname(f).slice(1);
  return /^\d+$/.test(ext) ? path.basename(f, '.' + ext) + '.gms' : f;
}

/** gamslib arguments (MainWindow::openModelFromLib / GamsLibProcess). */
export function gamslibArgs(glbFile: string, model: GlbModel, destDir: string): string[] {
  return ['-lib', glbFile, model.nameWithSuffix, destDir];
}

/**
 * Resolve a user-typed target folder: `~` / `~/x` expand to `home`, relative paths resolve against `base`
 * (workspace folder, or home when there is none). Returns an error text when the path is empty or is an existing file.
 */
export function resolveTargetDir(input: string, base: string, home: string): { dir: string } | { error: string } {
  const t = input.trim();
  if (!t) return { error: 'Enter a target folder.' };
  if (t.includes('\0')) return { error: 'Invalid path.' };
  let p = t;
  if (p === '~') p = home;
  else if (/^~[\\/]/.test(p)) p = path.join(home, p.slice(2));
  const dir = path.resolve(base, p);
  try {
    if (!fs.statSync(dir).isDirectory()) return { error: `${dir} is not a folder.` };
  } catch {
    // does not exist yet: it will be created
  }
  return { dir };
}
