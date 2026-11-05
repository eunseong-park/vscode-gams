// SPDX-License-Identifier: GPL-3.0-or-later
// Pure model of the GDX compare view (extension feature, not part of GAMS Studio): result types of the
// `gams/gdxCompare*` / `gams/gdxDiffFile*` server requests, status / color rules shared by the webview
// and the exports, symbol list filtering and the detection of gdxdiff output files.
// The comparison semantics follow the gdxdiff tool of the GAMS system directory (docs/dev/sources.md).
import type { GdxSymbolInfo, SymbolKind } from '../gdx/model';

export type SymbolStatus = 'onlyA' | 'onlyB' | 'equal' | 'different' | 'unknown' | 'pending';
export type RowStatus = 'equal' | 'changed' | 'added' | 'removed';
export type Cell = number | string | null | undefined;

/**
 * Options sent with every compare request (gdxdiff: Eps, RelEps, SetDesc, Field, CmpDefaults,
 * CmpDomains; gdxdiff's IgnoreOrder only changes the order of its output file and has no meaning here).
 */
export interface CompareOptions {
  eps: number;
  relEps: number;
  ignoreSetText: boolean;
  /** Var / Equ value slots (0 level .. 4 scale) that decide whether a record differs */
  fields: number[];
  /**
   * A parameter / variable record that exists in one file only counts as a difference even if it equals the
   * default record (0 / the default of the variable type). Off (like gdxdiff): such a record is ignored.
   */
  cmpDefaults: boolean;
  /** Symbols whose domains differ are different (their records are not compared) */
  cmpDomains: boolean;
}

export const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  eps: 0, relEps: 0, ignoreSetText: false, fields: [0, 1, 2, 3, 4], cmpDefaults: false, cmpDomains: false,
};

/** Is any option different from gdxdiff's defaults? (highlights the Options button) */
export function optionsChanged(o: CompareOptions): boolean {
  return o.eps > 0 || o.relEps > 0 || o.ignoreSetText || o.fields.length !== 5 || o.cmpDefaults || o.cmpDomains;
}

/** Request parameters for the options (`gams/gdxCompare*`). */
export function optionParams(o: CompareOptions): Record<string, unknown> {
  return { eps: o.eps, relEps: o.relEps, ignoreSetText: o.ignoreSetText, fields: o.fields, cmpDefaults: o.cmpDefaults, cmpDomains: o.cmpDomains };
}

export interface CompareSymbol {
  name: string;
  kind: SymbolKind;
  dim: number;
  domain: string[];
  text: string;
  status: SymbolStatus;
  slots?: number;
  rows: number | null;
  differences: number | null;
  changed: number | null;
  added: number | null;
  removed: number | null;
  equal: number | null;
  aRecords?: number | null;
  bRecords?: number | null;
  /** type or dimension of the symbol differs between the files */
  mismatch?: string | null;
  /** why no counts are available (memory guard, unexpected labels) */
  note?: string;
  subType?: number;
  /** gdxdiff output only: `normal`, `diffOnly` (Diff Only option) or `fieldOnly` (Field Only option) */
  mode?: 'normal' | 'diffOnly' | 'fieldOnly';
}

export interface CompareRecord {
  keys: string[];
  status: RowStatus;
  /** values of the shown slots (null = the record does not exist in that file) */
  a: Cell[] | null;
  b: Cell[] | null;
  /** B - A and (B - A) / |A| per slot; null where not defined */
  abs?: Cell[] | null;
  rel?: Cell[] | null;
  /** per slot: the value differs (and is compared) */
  diff: boolean[];
  /** sets: the element has no text; the shown `Y` is Studio's placeholder (a real text `Y` is not flagged) */
  aNoText?: boolean;
  bNoText?: boolean;
}

export interface CompareSymbolsResult {
  symbols: CompareSymbol[];
  /** the deadline was reached while merging (`full`): the rest stays `pending` */
  truncated?: boolean;
  /** gdxdiff output only: the compared files recorded in the set FilesCompared */
  fileA?: string;
  fileB?: string;
}

export interface CompareRecordsResult {
  /** rows visible with the requested filter */
  total: number;
  /** all merged rows */
  rows: number;
  differences: number;
  offset: number;
  records: CompareRecord[];
  mismatch?: string | null;
}

export interface CompareNextResult {
  index: number | null;
  total: number;
  differences: number;
}

// ---- status text and colors ----

export const SYMBOL_STATUS_LABEL: Record<SymbolStatus, string> = {
  onlyA: 'Only in A',
  onlyB: 'Only in B',
  equal: 'Equal',
  different: 'Different',
  unknown: 'Not compared',
  pending: 'Pending',
};

export const ROW_STATUS_LABEL: Record<RowStatus, string> = { equal: 'equal', changed: 'changed', added: 'added', removed: 'removed' };

/** One-character mark for the status column of the grid. */
export const ROW_STATUS_MARK: Record<RowStatus, string> = { equal: '', changed: '≠', added: '+', removed: '−' };

/**
 * Highlight colors, shared by the webview (as translucent overlays, so they work on any theme) and the
 * Excel export (blended onto white). `row` colors whole added / removed rows, `cell` marks a changed value.
 */
export const STATUS_COLORS = {
  added: { rgb: [46, 160, 67], alpha: 0.28 },
  removed: { rgb: [248, 81, 73], alpha: 0.28 },
  changed: { rgb: [210, 153, 34], alpha: 0.38 },
} as const;

export type ColorKey = keyof typeof STATUS_COLORS;

const hex2 = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).toUpperCase().padStart(2, '0');

/** CSS rgba() of a status color (webview). */
export function cssColor(k: ColorKey): string {
  const { rgb, alpha } = STATUS_COLORS[k];
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/** Solid RRGGBB of a status color on a white sheet (Excel fills; no alpha in spreadsheets). */
export function excelColor(k: ColorKey): string {
  const { rgb, alpha } = STATUS_COLORS[k];
  return rgb.map((c) => hex2(255 * (1 - alpha) + c * alpha)).join('');
}

/** How a cell of a merged row is highlighted. */
export type CellFlag = ColorKey | undefined;

/** Row-level color: added / removed rows are colored as a whole, changed rows only in their changed cells. */
export function rowFlag(s: RowStatus): CellFlag {
  return s === 'added' ? 'added' : s === 'removed' ? 'removed' : undefined;
}

/**
 * Flag of a value cell. `side` is the file the cell belongs to; difference columns (`delta`) follow the
 * changed flag of the slot. Added / removed rows color every cell of the row, changed rows only the
 * slots that differ, equal rows nothing.
 */
export function valueFlag(rec: Pick<CompareRecord, 'status' | 'diff'>, slot: number): CellFlag {
  if (rec.status === 'added' || rec.status === 'removed') return rec.status;
  if (rec.status === 'changed' && rec.diff[slot]) return 'changed';
  return undefined;
}

/** Flag of a key cell. */
export function keyFlag(rec: Pick<CompareRecord, 'status'>): CellFlag {
  return rowFlag(rec.status);
}

// ---- symbol list ----

export interface SymbolFilter {
  text: string;
  /** symbol statuses to show */
  statuses: ReadonlySet<SymbolStatus>;
}

export const ALL_STATUSES: SymbolStatus[] = ['different', 'onlyA', 'onlyB', 'equal', 'unknown', 'pending'];

export function defaultSymbolFilter(): SymbolFilter {
  return { text: '', statuses: new Set(ALL_STATUSES) };
}

/** Regex (case-insensitive) when the text parses as one, else substring; empty = everything. */
export function matchName(text: string): (name: string) => boolean {
  if (!text) return () => true;
  try {
    const re = new RegExp(text, 'i');
    return (n) => re.test(n);
  } catch {
    const t = text.toLowerCase();
    return (n) => n.toLowerCase().includes(t);
  }
}

export function filterSymbols(symbols: readonly CompareSymbol[], f: SymbolFilter): CompareSymbol[] {
  const m = matchName(f.text);
  return symbols.filter((s) => f.statuses.has(s.status) && m(s.name));
}

/** Count of symbols per status (for the filter menu labels). */
export function statusCounts(symbols: readonly CompareSymbol[]): Record<SymbolStatus, number> {
  const c: Record<SymbolStatus, number> = { onlyA: 0, onlyB: 0, equal: 0, different: 0, unknown: 0, pending: 0 };
  for (const s of symbols) c[s.status]++;
  return c;
}

/** `3 changed, 1 added, 2 removed` style summary of a symbol. */
export function symbolSummary(s: CompareSymbol): string {
  if (s.status === 'pending') return 'not compared yet';
  if (s.mismatch) return `mismatch: ${s.mismatch}`;
  if (s.note) return s.note.replace(/^\[limit\]\s*/, '');
  if (s.status === 'onlyA') return `only in A (${(s.removed ?? s.aRecords ?? 0).toLocaleString()} records)`;
  if (s.status === 'onlyB') return `only in B (${(s.added ?? s.bRecords ?? 0).toLocaleString()} records)`;
  const parts: string[] = [];
  if (s.changed) parts.push(`${s.changed.toLocaleString()} changed`);
  if (s.added) parts.push(`${s.added.toLocaleString()} added`);
  if (s.removed) parts.push(`${s.removed.toLocaleString()} removed`);
  return parts.length ? parts.join(', ') : 'no differences';
}

// ---- value columns of a compared symbol ----

export const ATTR_LABELS = ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'] as const;

export interface ValueColumn {
  /** value slot in the record arrays */
  slot: number;
  label: string;
}

/** Value slots shown for a symbol: sets / parameters have one, variables / equations the selected attributes. */
export function valueColumns(sym: Pick<CompareSymbol, 'kind' | 'slots'>, attrs: readonly boolean[]): ValueColumn[] {
  if (sym.kind === 'Set' || sym.kind === 'Alias') return [{ slot: 0, label: 'Text' }];
  if (sym.kind === 'Parameter') return [{ slot: 0, label: 'Value' }];
  const out = ATTR_LABELS.map((label, slot) => ({ slot, label })).filter((c) => attrs[c.slot]);
  return out.length ? out : [{ slot: 0, label: ATTR_LABELS[0] }];
}

/** Toggle an attribute; at least one stays selected. */
export function toggleAttribute(attrs: readonly boolean[], i: number): boolean[] {
  const next = attrs.slice();
  if (i < 0 || i >= next.length) return next;
  if (next[i] && next.filter(Boolean).length <= 1) return next;
  next[i] = !next[i];
  return next;
}

/** Slot numbers of the checked attributes (the request's `fields`). */
export function fieldsFromFlags(flags: readonly boolean[]): number[] {
  const f = flags.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
  return f.length ? f : [0, 1, 2, 3, 4];
}

/** Parse a tolerance field ('' = 0, decimal comma accepted); null = invalid. */
export function parseTolerance(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---- gdxdiff output ----

export interface DiffFileDetection {
  isDiffFile: boolean;
  /** symbols carrying differences (all but FilesCompared) */
  diffSymbols: string[];
}

/**
 * Does a symbol list belong to the output of gdxdiff? gdxdiff always writes the one-dimensional set
 * `FilesCompared` (elements File1 / File2 whose texts are the compared file names) plus, per differing
 * symbol, a symbol of the same name with one extra last dimension (labels dif1 / dif2 / ins1 / ins2) and
 * the explanatory text "Differences" ("Differences Only" with DiffOnly, "Differences Field = ..." with
 * FldOnly). Verified against the output of the gdxdiff shipped with GAMS 54.6 (docs/dev/sources.md).
 */
export function detectGdxDiff(symbols: readonly Pick<GdxSymbolInfo, 'name' | 'kind' | 'dim' | 'records' | 'text'>[]): DiffFileDetection {
  const files = symbols.find((s) => s.name.toLowerCase() === 'filescompared');
  if (!files || files.kind !== 'Set' || files.dim !== 1 || files.records !== 2) return { isDiffFile: false, diffSymbols: [] };
  const others = symbols.filter((s) => s !== files && s.kind !== 'Alias');
  const diffSymbols = others.filter((s) => s.dim >= 1 && /^Differences\b/.test(s.text)).map((s) => s.name);
  // a file with only FilesCompared is the output of a comparison without differences
  const isDiffFile = diffSymbols.length > 0 || others.length === 0;
  return { isDiffFile, diffSymbols: isDiffFile ? diffSymbols : [] };
}

// ---- lazy statuses (the server only merges the symbols it is asked for) ----

/**
 * Fold the symbols of a (partial) summary into the list: a `pending` row never overwrites a symbol whose status is
 * already known (a request for `names` returns every other symbol as `pending`).
 */
export function mergeSymbols(current: readonly CompareSymbol[], updates: readonly CompareSymbol[]): CompareSymbol[] {
  const upd = new Map(updates.map((u) => [u.name.toLowerCase(), u]));
  const out = current.map((c) => {
    const u = upd.get(c.name.toLowerCase());
    if (!u || (u.status === 'pending' && c.status !== 'pending')) return c;
    return u;
  });
  const have = new Set(current.map((c) => c.name.toLowerCase()));
  for (const u of updates) if (!have.has(u.name.toLowerCase())) out.push(u);
  return out;
}

/** Names of the first `limit` still pending symbols among `rows` (visible rows first), skipping `skip`. */
export function pendingNames(rows: readonly CompareSymbol[], limit: number, skip: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const s of rows) {
    if (out.length >= limit) break;
    if (s.status === 'pending' && !skip.has(s.name.toLowerCase())) out.push(s.name);
  }
  return out;
}

export const isCancelled = (msg: string): boolean => msg.startsWith('[cancelled]');
export const isTimeout = (msg: string): boolean => msg.startsWith('[timeout]');
