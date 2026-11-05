// SPDX-License-Identifier: GPL-3.0-or-later
// GDX workspace search: pure query parsing / filtering / sorting (no vscode dependency).
// Extension addition, not part of GAMS Studio.

export interface GdxSymbolInfo {
  name: string;
  type: string;
  dim: number;
  records: number;
  text: string;
  domain: string[];
}

export interface IndexedSymbol extends GdxSymbolInfo {
  /** absolute file path */
  file: string;
  /** workspace-relative path with forward slashes (for display and globs) */
  rel: string;
  /** modification time in ms since the epoch */
  mtime: number;
}

export const SYMBOL_TYPES = ['Set', 'Parameter', 'Variable', 'Equation', 'Alias'] as const;
export type SortBy = 'name' | 'file' | 'mtime';
export const SORTS: SortBy[] = ['name', 'file', 'mtime'];

export interface SymbolQuery {
  /** substrings that must all occur in the symbol name or its text (case-insensitive) */
  words: string[];
  /** allowed types (empty = all) */
  types: string[];
  dims: number[];
  fileGlobs: RegExp[];
  regex?: RegExp;
  error?: string;
}

/** Glob (`*` any chars except `/`, `**` any chars, `?` one char) as an anchored case-insensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') i++;
        re += '(?:.*/)?';
        if (glob[i + 1] === undefined) re = re.slice(0, -'(?:.*/)?'.length) + '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function matchType(token: string): string | undefined {
  const t = token.toLowerCase();
  if (!t) return undefined;
  return SYMBOL_TYPES.find((s) => s.toLowerCase().startsWith(t));
}

/** Prefix syntax: `type:par,var`, `dim:2`, `file:glob`, `/regex/` (flags `i` default; `s` = case-sensitive), other words = substrings. */
export function parseSymbolQuery(input: string): SymbolQuery {
  const q: SymbolQuery = { words: [], types: [], dims: [], fileGlobs: [] };
  for (const tok of input.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(type|t|dim|d|file|f):(.*)$/i.exec(tok);
    if (m) {
      const key = m[1].toLowerCase()[0];
      const val = m[2];
      if (!val) continue; // still typing
      if (key === 't') {
        for (const part of val.split(',').filter(Boolean)) {
          const t = matchType(part);
          if (t) {
            if (!q.types.includes(t)) q.types.push(t);
          } else q.error = `Unknown type "${part}"`;
        }
      } else if (key === 'd') {
        for (const part of val.split(',').filter(Boolean)) {
          const n = Number(part);
          if (Number.isInteger(n) && n >= 0) q.dims.push(n);
          else q.error = `Invalid dimension "${part}"`;
        }
      } else {
        const g = val.replace(/\\/g, '/');
        // without wildcards: case-insensitive substring of the relative path
        q.fileGlobs.push(/[*?]/.test(g) ? globToRegExp(g) : new RegExp(g.replace(/[.+^${}()|[\]\\]/g, '\\$&'), 'i'));
      }
      continue;
    }
    const r = /^\/(.+)\/([is]*)$/.exec(tok);
    if (r) {
      try {
        q.regex = new RegExp(r[1], r[2].includes('s') ? '' : 'i');
      } catch (e) {
        q.error = `Invalid regular expression: ${(e as Error).message}`;
      }
      continue;
    }
    q.words.push(tok.toLowerCase());
  }
  return q;
}

export function matchesSymbol(s: IndexedSymbol, q: SymbolQuery): boolean {
  if (q.types.length && !q.types.includes(s.type)) return false;
  if (q.dims.length && !q.dims.includes(s.dim)) return false;
  if (q.fileGlobs.length) {
    const base = s.rel.slice(s.rel.lastIndexOf('/') + 1);
    // a glob matches the whole relative path or the base name
    if (!q.fileGlobs.every((g) => g.test(s.rel) || g.test(base))) return false;
  }
  if (q.regex && !q.regex.test(s.name)) return false;
  if (q.words.length) {
    const hay = (s.name + '\n' + s.text).toLowerCase();
    if (!q.words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

export function filterSymbols(all: IndexedSymbol[], q: SymbolQuery): IndexedSymbol[] {
  return all.filter((s) => matchesSymbol(s, q));
}

const cmp = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

/** Sorted copy: by name, by file (then name) or by modification time (newest first, then file, name). */
export function sortSymbols(list: IndexedSymbol[], by: SortBy): IndexedSymbol[] {
  const out = [...list];
  const byName = (a: IndexedSymbol, b: IndexedSymbol): number => cmp(a.name, b.name) || cmp(a.rel, b.rel);
  const byFile = (a: IndexedSymbol, b: IndexedSymbol): number => cmp(a.rel, b.rel) || cmp(a.name, b.name);
  if (by === 'name') out.sort(byName);
  else if (by === 'file') out.sort(byFile);
  else out.sort((a, b) => b.mtime - a.mtime || byFile(a, b));
  return out;
}

export function nextSort(by: SortBy): SortBy {
  return SORTS[(SORTS.indexOf(by) + 1) % SORTS.length];
}

/** `Parameter · 2D · 1,234 records` pieces joined as shown in the picker / tree. */
export function symbolDescription(s: Pick<GdxSymbolInfo, 'type' | 'dim' | 'records'>): string {
  return `${s.type} · ${s.dim}D · ${s.records.toLocaleString('en-US')} rec`;
}

export interface ElementQuery {
  label: string;
  regex: boolean;
  caseSensitive: boolean;
  error?: string;
}

/** `label`, `/regex/` or `case:label` / `case:/regex/` (case-sensitive; default is case-insensitive). */
export function parseElementQuery(input: string): ElementQuery {
  let s = input.trim();
  let caseSensitive = false;
  if (/^case:/i.test(s)) {
    caseSensitive = true;
    s = s.slice(5).trim();
  }
  const r = /^\/(.+)\/$/.exec(s);
  if (r) {
    try {
      new RegExp(r[1]);
    } catch (e) {
      return { label: r[1], regex: true, caseSensitive, error: `Invalid regular expression: ${(e as Error).message}` };
    }
    return { label: r[1], regex: true, caseSensitive };
  }
  return { label: s, regex: false, caseSensitive, error: s ? undefined : 'Enter a label' };
}

export interface ElementMatch {
  path: string;
  symbol: string;
  type: string;
  dim: number;
  dims: number[];
  labels: string[];
}

/** Text for the dimension positions of a match, e.g. `dim 1, 3` (1-based). */
export function dimsText(dims: number[]): string {
  return (dims.length === 1 ? 'dim ' : 'dims ') + dims.map((d) => d + 1).join(', ');
}

/** Group paths by directory for the tree (`dirname` uses forward slashes; '' = root). */
export function splitDir(rel: string): { dir: string; base: string } {
  const i = rel.lastIndexOf('/');
  return i < 0 ? { dir: '', base: rel } : { dir: rel.slice(0, i), base: rel.slice(i + 1) };
}

/** One `files.exclude`-style glob combining the enabled keys of several exclude maps and extra globs. */
export function combineExcludes(maps: Array<Record<string, boolean | unknown> | undefined>, extra: string[]): string | undefined {
  const globs = new Set<string>();
  for (const m of maps) {
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) if (v === true) globs.add(k);
  }
  for (const g of extra) if (g.trim()) globs.add(g.trim());
  if (!globs.size) return undefined;
  const list = [...globs];
  return list.length === 1 ? list[0] : `{${list.join(',')}}`;
}
