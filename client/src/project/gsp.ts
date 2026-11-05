// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Port of the GAMS Studio project file (.gsp) format: src/file/projectrepo.cpp
 * (getProjectMap, read, parseProjectFile) and pexgroupnode.cpp. Pure: no vscode imports.
 * Paths inside a .gsp are relative to the .gsp's directory.
 */
import * as path from 'path';
import { normalize, tokenize } from '../options/commandLine';

export interface GspProject {
  gspPath: string;
  name: string;
  /** Absolute main file ("file"), if any. */
  mainFile?: string;
  /** Absolute parameter file ("pf"), if any. */
  pf?: string;
  /** Absolute project base dir ("path"; default: dir of the .gsp). */
  baseDir: string;
  /** Absolute working dir ("workDir"; default: base dir). */
  workDir: string;
  /** Run parameter history strings, most recent last. */
  options: string[];
  /** Run parameters of the main file node's history, most recent last. */
  mainFileOptions: string[];
  dynamicMainFile: boolean;
  /** Absolute paths of all nodes (main file included). */
  files: string[];
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function abs(dir: string, rel: string | undefined): string | undefined {
  if (!rel) return undefined;
  return path.normalize(path.isAbsolute(rel) ? rel : path.join(dir, rel));
}

/** The project object of a .gsp text; the legacy `{ "projects": [ ... ] }` wrapper yields its first element. */
function projectObject(text: string): Json | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(doc)) return undefined;
  if (Array.isArray(doc.projects)) {
    const first: unknown = doc.projects[0];
    return isObj(first) ? first : undefined;
  }
  return doc;
}

export function parseGsp(text: string, gspPath: string): GspProject | undefined {
  const o = projectObject(text);
  if (!o) return undefined;
  const dir = path.dirname(gspPath);
  const baseDir = abs(dir, str(o.path)) ?? dir;
  const nodes = Array.isArray(o.nodes) ? o.nodes.filter(isObj) : [];
  const files: string[] = [];
  let mainFile = abs(dir, str(o.file));
  let mainFileOptions: string[] = [];
  for (const n of nodes) {
    const f = abs(dir, str(n.file));
    if (!f) continue;
    files.push(f);
    if (mainFile && samePath(f, mainFile)) mainFileOptions = strList(n.options);
  }
  // Studio: "Incomplete data for main file fixed" - the main file is always a node
  if (mainFile && !files.some((f) => samePath(f, mainFile as string))) files.unshift(mainFile);
  if (!mainFile && files.length) mainFile = files.find((f) => /\.gms$/i.test(f));
  return {
    gspPath,
    name: str(o.name) ?? path.basename(gspPath, path.extname(gspPath)),
    mainFile,
    pf: abs(dir, str(o.pf)),
    baseDir,
    workDir: abs(dir, str(o.workDir)) ?? baseDir,
    options: strList(o.options),
    mainFileOptions,
    dynamicMainFile: o.dynamicMainFile === true,
    files,
  };
}

export function samePath(a: string, b: string): boolean {
  const n = (p: string): string => (process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p));
  return n(a) === n(b);
}

export function projectOwnsFile(p: GspProject, file: string): boolean {
  return p.files.some((f) => samePath(f, file));
}

/** Current run parameters of the project as `key=value` strings: project options, else main file options (last history entry). */
export function projectParams(p: GspProject): string[] {
  const hist = p.options.length ? p.options : p.mainFileOptions;
  const last = hist.length ? hist[hist.length - 1] : '';
  return normalize(tokenize(last));
}

export interface GspChanges {
  mainFile?: string;
  /** Run parameter string; appended to the history (unless it equals the last entry). */
  options?: string;
  pf?: string | null;
}

function rel(dir: string, file: string): string {
  return path.relative(dir, file).split(path.sep).join('/') || '.';
}

/** Studio `getProjectMap` keys are written sorted (Qt JSON objects are ordered by key). */
function sortKeys(o: Json): Json {
  const r: Json = {};
  for (const k of Object.keys(o).sort()) r[k] = o[k];
  return r;
}

/**
 * Create or update .gsp text. With `existing`, unknown keys and nodes are kept (the legacy
 * wrapper is preserved); without it a new project in Studio's format is created.
 */
export function writeGsp(existing: string | undefined, gspPath: string, ch: GspChanges): string {
  const dir = path.dirname(gspPath);
  let doc: Json | undefined;
  if (existing !== undefined) {
    try {
      const d: unknown = JSON.parse(existing);
      if (isObj(d)) doc = d;
    } catch {
      doc = undefined;
    }
  }
  const wrapped = !!doc && Array.isArray(doc.projects) && isObj(doc.projects[0]);
  const proj: Json = wrapped ? ((doc as Json).projects as Json[])[0] : (doc ?? {});
  const isNew = existing === undefined || !doc;
  if (isNew) {
    proj.name = path.basename(gspPath, path.extname(gspPath));
    proj.path = '.';
    proj.workDir = '.';
    proj.projectType = 1;
  }
  const nodes: Json[] = Array.isArray(proj.nodes) ? (proj.nodes as unknown[]).filter(isObj) : [];
  if (ch.mainFile) {
    const r = rel(dir, ch.mainFile);
    proj.file = r;
    if (!nodes.some((n) => n.file === r)) {
      nodes.unshift({ file: r, name: path.basename(ch.mainFile), type: 'gms', encoding: 'UTF-8' });
    }
  }
  if (ch.pf === null) delete proj.pf;
  else if (ch.pf) {
    proj.pf = rel(dir, ch.pf);
  }
  if (ch.options !== undefined) {
    const hist = strList(proj.options);
    const t = ch.options.trim();
    if (t && hist[hist.length - 1] !== t) hist.push(t);
    proj.options = hist;
  }
  proj.nodes = nodes;
  const out = wrapped ? (doc as Json) : sortKeys(proj);
  return JSON.stringify(out, null, 4) + '\n';
}
