// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers for the server-side sort / filter query of the GDX viewer (no DOM, no vscode).
// Semantics follow Studio's GdxSymbol::sort/filterRows, LabelFilter and ValueFilter
// (src/gdxviewer/{gdxsymbol,labelfilter,valuefilter,labelfilterdialog}.cpp). Column numbers are
// Studio's: 0..dim-1 are key columns, dim + i is value slot i.

export interface ViewSort {
  column: number;
  ascending: boolean;
}

/** Studio shows the checked labels; we send the smaller of the checked / unchecked sets. */
export interface LabelFilterState {
  mode: 'include' | 'exclude';
  labels: string[];
  regex?: string;
  caseSensitive?: boolean;
}

export interface ValueFilterState {
  min?: number;
  max?: number;
  exclude: boolean;
  showUndef: boolean;
  showNA: boolean;
  showPInf: boolean;
  showMInf: boolean;
  showEps: boolean;
  showAcronym: boolean;
}

export const DEFAULT_VALUE_FILTER: ValueFilterState = {
  exclude: false, showUndef: true, showNA: true, showPInf: true, showMInf: true, showEps: true, showAcronym: true,
};

export interface ViewFilters {
  /** key dimension -> label filter */
  labels: Record<number, LabelFilterState>;
  /** value slot -> value filter */
  values: Record<number, ValueFilterState>;
}

/** The query members of gams/gdxRecords and gams/gdxTable. */
export interface QueryParams {
  sort?: ViewSort;
  filters?: Record<string, LabelFilterState>;
  valueFilter?: Array<ValueFilterState & { column: number }>;
}

export function emptyFilters(): ViewFilters {
  return { labels: {}, values: {} };
}

export function hasFilters(f: ViewFilters): boolean {
  return Object.keys(f.labels).length > 0 || Object.keys(f.values).length > 0;
}

export function isDefaultValueFilter(v: ValueFilterState): boolean {
  return (
    v.min === undefined && v.max === undefined && !v.exclude &&
    v.showUndef && v.showNA && v.showPInf && v.showMInf && v.showEps && v.showAcronym
  );
}

/** Build the request members; `dim` shifts value slots to unified column numbers. */
export function buildQueryParams(dim: number, sort: ViewSort | undefined, f: ViewFilters, isSet = false): QueryParams {
  const q: QueryParams = {};
  if (sort) q.sort = { column: sort.column, ascending: sort.ascending };
  if (Object.keys(f.labels).length) {
    q.filters = {};
    for (const [d, lf] of Object.entries(f.labels)) q.filters[d] = lf;
  }
  const vf = Object.entries(f.values).filter(([, v]) => !isDefaultValueFilter(v));
  if (vf.length && !isSet) q.valueFilter = vf.map(([slot, v]) => ({ ...v, column: dim + Number(slot) }));
  return q;
}

/** Stable text key of a query (identifies a cached view). */
export function queryKey(q: QueryParams): string {
  return JSON.stringify(q);
}

/** Checked labels in the filter dialog for the current filter (no filter = everything checked). */
export function labelSelection(all: readonly string[], f: LabelFilterState | undefined): Set<string> {
  if (!f) return new Set(all);
  const set = new Set(f.labels);
  if (f.mode === 'include') return new Set(all.filter((l) => set.has(l)));
  return new Set(all.filter((l) => !set.has(l)));
}

/** Turn the dialog's checked set into a filter; undefined when everything is checked. */
export function filterFromSelection(all: readonly string[], checked: ReadonlySet<string>): LabelFilterState | undefined {
  const on = all.filter((l) => checked.has(l));
  if (on.length === all.length) return undefined;
  const off = all.filter((l) => !checked.has(l));
  return on.length <= off.length ? { mode: 'include', labels: on } : { mode: 'exclude', labels: off };
}

export interface MatchOptions {
  regex: boolean;
  caseSensitive: boolean;
  exact: boolean;
}

/**
 * The dialog's "select by pattern" (labelfilterdialog.cpp): plain text is a substring match,
 * `regex` a regular expression, `exact` whole-label match. An invalid regex matches nothing.
 */
export function matchLabels(labels: readonly string[], pattern: string, o: MatchOptions): string[] {
  if (pattern === '') return [...labels];
  let re: RegExp;
  try {
    const src = o.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(o.exact ? `^(?:${src})$` : src, o.caseSensitive ? '' : 'i');
  } catch {
    return [];
  }
  return labels.filter((l) => re.test(l));
}

export function isValidRegex(p: string): boolean {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse a number field of the value filter dialog ('' = unset; decimal comma accepted). */
export function parseBound(s: string): number | undefined | null {
  const t = s.trim().replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
