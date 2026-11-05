// SPDX-License-Identifier: GPL-3.0-or-later
// Per-symbol view state of the GDX viewer and its rules (pure; no DOM).
// Studio keeps this per symbol in GdxSymbolView / GdxSymbolViewState (gdxsymbolviewstate.cpp):
// list / table view, sort, filters, hidden value columns ("Attributes" menu), numeric format
// ("Preferences" menu), squeeze defaults, column widths. "Reset" (Ctrl+R in the Studio toolbar
// button "Reset symbol view to default") restores the defaults (gdxsymbolview.cpp resetSortFilter).
import { DEFAULT_FORMAT, FormatOptions } from './format';
import { DEFAULT_LAYOUT, LayoutState, sanitizeLayout } from './layout';
import type { GdxSymbolInfo } from './model';
import { defaultPivot, isValidPivot, PivotState } from './pivot';
import { sanitizeWidths } from './columns';
import { emptyFilters, ViewFilters, ViewSort, LabelFilterState, ValueFilterState, DEFAULT_VALUE_FILTER } from './query';

export type ViewMode = 'list' | 'table' | 'chart';

export interface ChartState {
  type: 'bar' | 'line';
  /** dimension that forms the series (2-D and more); the other dimensions form the x axis */
  seriesDim: number;
}

/** The numeric format part kept per symbol (Studio: mValFormat / mPrecision / mSqZeroes). */
export interface SymFormat {
  format: FormatOptions['format'];
  precision: number;
  squeeze: boolean;
}

export interface SymView {
  mode: ViewMode;
  sort?: ViewSort;
  filters: ViewFilters;
  pivot: PivotState;
  /** visible value columns Level / Marginal / Lower / Upper / Scale (list view of variables / equations) */
  attrs: boolean[];
  /** hide value columns in which every record has the default value */
  squeezeDefaults: boolean;
  fmt: SymFormat;
  /** column widths by column id (`k0..`, `v0..`, `text`, `tc` table data column, `tr0..` table row headers) */
  widths: Record<string, number>;
  chart: ChartState;
}

export const ATTR_NAMES = ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'] as const;

export const DEFAULT_SYM_FORMAT: SymFormat = { format: DEFAULT_FORMAT.format, precision: DEFAULT_FORMAT.precision, squeeze: DEFAULT_FORMAT.squeeze };

export const isSetLike = (s: Pick<GdxSymbolInfo, 'kind'>): boolean => s.kind === 'Set' || s.kind === 'Alias';
export const hasAttributes = (s: Pick<GdxSymbolInfo, 'kind'>): boolean => s.kind === 'Variable' || s.kind === 'Equation';

/** Studio offers the table view for dim >= 2. */
export const canTable = (s: Pick<GdxSymbolInfo, 'dim'>): boolean => s.dim >= 2;
/** Charts need numbers: parameters, variables and equations with at least one dimension. */
export const canChart = (s: Pick<GdxSymbolInfo, 'dim' | 'kind'>): boolean => s.dim >= 1 && !isSetLike(s);

export function defaultSymView(s: Pick<GdxSymbolInfo, 'dim'>): SymView {
  return {
    mode: 'list',
    filters: emptyFilters(),
    pivot: defaultPivot(s.dim),
    attrs: [true, true, true, true, true],
    squeezeDefaults: false,
    fmt: { ...DEFAULT_SYM_FORMAT },
    widths: {},
    chart: { type: 'bar', seriesDim: Math.max(0, s.dim - 1) },
  };
}

/** Studio "Reset symbol view to default": everything but the remembered widths. */
export function resetSymView(s: Pick<GdxSymbolInfo, 'dim'>): SymView {
  return defaultSymView(s);
}

/** Toggle one attribute; the last remaining checked attribute cannot be unchecked. */
export function toggleAttr(attrs: readonly boolean[], i: number): boolean[] {
  const next = attrs.slice();
  if (i < 0 || i >= next.length) return next;
  if (next[i] && next.filter(Boolean).length <= 1) return next;
  next[i] = !next[i];
  return next;
}

/** "Invert Selection" of the Attributes menu; an empty result is rejected (at least one stays checked). */
export function invertAttrs(attrs: readonly boolean[]): boolean[] {
  const inv = attrs.map((a) => !a);
  return inv.some(Boolean) ? inv : attrs.slice();
}

/**
 * Value slots shown in the list view: the checked attributes minus, with "squeeze defaults" on,
 * those whose values are the default in every record (`GdxSymbolView::toggleSqueezeDefaults`).
 * Sets / parameters have one value column. If squeezing would hide every column the first
 * checked attribute stays (an empty grid would be useless).
 */
export function visibleValueColumns(
  kind: GdxSymbolInfo['kind'],
  attrs: readonly boolean[],
  allDefault: readonly boolean[] | undefined,
  squeeze: boolean,
): number[] {
  if (kind !== 'Variable' && kind !== 'Equation') return [0];
  const checked = [0, 1, 2, 3, 4].filter((i) => attrs[i]);
  if (checked.length === 0) return [0];
  if (!squeeze || !allDefault || allDefault.length < 5) return checked;
  const kept = checked.filter((i) => !allDefault[i]);
  return kept.length > 0 ? kept : [checked[0]];
}

/** Numeric format actually applied: precision "Full" (0) forces squeezing for g / e (NumericalFormatController::update). */
export function effectiveFormat(f: SymFormat): FormatOptions {
  const max = f.format === 'f' ? 14 : 17;
  const precision = Math.max(0, Math.min(max, Math.round(Number.isFinite(f.precision) ? f.precision : DEFAULT_FORMAT.precision)));
  const full = f.format !== 'f' && precision === 0;
  return { ...DEFAULT_FORMAT, format: f.format, precision, squeeze: f.squeeze || full };
}

// ---- persistence (vscode.setState) ----

export interface PersistedState {
  v: 1;
  selected?: string;
  layout: LayoutState;
  views: Record<string, SymView>;
  /** extension feature: thousands separator in value display */
  thousands: boolean;
  searchHistory?: string;
}

export const MAX_PERSISTED_VIEWS = 200;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function sanitizeLabelFilter(raw: unknown): LabelFilterState | undefined {
  if (!isObj(raw) || !Array.isArray(raw.labels) || !raw.labels.every((l) => typeof l === 'string')) return undefined;
  const f: LabelFilterState = { mode: raw.mode === 'exclude' ? 'exclude' : 'include', labels: raw.labels as string[] };
  if (typeof raw.regex === 'string') f.regex = raw.regex;
  if (typeof raw.caseSensitive === 'boolean') f.caseSensitive = raw.caseSensitive;
  return f;
}

function sanitizeValueFilter(raw: unknown): ValueFilterState | undefined {
  if (!isObj(raw)) return undefined;
  const f: ValueFilterState = { ...DEFAULT_VALUE_FILTER };
  if (typeof raw.min === 'number') f.min = raw.min;
  if (typeof raw.max === 'number') f.max = raw.max;
  f.exclude = raw.exclude === true;
  for (const k of ['showUndef', 'showNA', 'showPInf', 'showMInf', 'showEps', 'showAcronym'] as const) {
    if (typeof raw[k] === 'boolean') f[k] = raw[k] as boolean;
  }
  return f;
}

/** Validate an untrusted (restored) per-symbol state against the symbol; anything invalid falls back to the default. */
export function sanitizeSymView(raw: unknown, s: Pick<GdxSymbolInfo, 'dim' | 'kind'>): SymView {
  const v = defaultSymView(s);
  if (!isObj(raw)) return v;
  if (raw.mode === 'list' || raw.mode === 'table' || raw.mode === 'chart') v.mode = raw.mode;
  if (v.mode === 'table' && !canTable(s)) v.mode = 'list';
  if (v.mode === 'chart' && !canChart(s)) v.mode = 'list';
  if (isObj(raw.sort) && typeof raw.sort.column === 'number' && raw.sort.column >= 0 && raw.sort.column < s.dim + 5) {
    v.sort = { column: Math.floor(raw.sort.column), ascending: raw.sort.ascending !== false };
  }
  if (isObj(raw.filters)) {
    if (isObj(raw.filters.labels)) {
      for (const [k, lf] of Object.entries(raw.filters.labels)) {
        const d = Number(k);
        const f = sanitizeLabelFilter(lf);
        if (Number.isInteger(d) && d >= 0 && d < s.dim && f) v.filters.labels[d] = f;
      }
    }
    if (isObj(raw.filters.values)) {
      for (const [k, vf] of Object.entries(raw.filters.values)) {
        const i = Number(k);
        const f = sanitizeValueFilter(vf);
        if (Number.isInteger(i) && i >= 0 && i < 5 && f) v.filters.values[i] = f;
      }
    }
  }
  if (isObj(raw.pivot)) {
    const p: PivotState = {
      rowDims: Array.isArray(raw.pivot.rowDims) ? (raw.pivot.rowDims as number[]) : [],
      colDims: Array.isArray(raw.pivot.colDims) ? (raw.pivot.colDims as number[]) : [],
      valueField: typeof raw.pivot.valueField === 'number' ? Math.max(0, Math.min(4, Math.floor(raw.pivot.valueField))) : 0,
    };
    if (isValidPivot(p, s.dim)) v.pivot = p;
  }
  if (Array.isArray(raw.attrs) && raw.attrs.length === 5 && raw.attrs.some((a) => a === true)) v.attrs = raw.attrs.map((a) => a === true);
  v.squeezeDefaults = raw.squeezeDefaults === true;
  if (isObj(raw.fmt)) {
    const f = raw.fmt;
    const format = f.format === 'f' || f.format === 'e' || f.format === 'g' ? f.format : v.fmt.format;
    v.fmt = {
      format,
      precision: typeof f.precision === 'number' ? Math.max(0, Math.min(format === 'f' ? 14 : 17, Math.floor(f.precision))) : v.fmt.precision,
      squeeze: typeof f.squeeze === 'boolean' ? f.squeeze : v.fmt.squeeze,
    };
  }
  v.widths = sanitizeWidths(raw.widths);
  if (isObj(raw.chart)) {
    v.chart.type = raw.chart.type === 'line' ? 'line' : 'bar';
    if (typeof raw.chart.seriesDim === 'number' && raw.chart.seriesDim >= 0 && raw.chart.seriesDim < Math.max(1, s.dim)) {
      v.chart.seriesDim = Math.floor(raw.chart.seriesDim);
    }
  }
  return v;
}

/** Whether a view differs from the default (only those are worth persisting). */
export function isDefaultView(v: SymView, s: Pick<GdxSymbolInfo, 'dim'>): boolean {
  return JSON.stringify({ ...v, widths: {} }) === JSON.stringify({ ...defaultSymView(s), widths: {} }) && Object.keys(v.widths).length === 0;
}

export function emptyState(): PersistedState {
  return { v: 1, layout: { ...DEFAULT_LAYOUT, symWidths: {} }, views: {}, thousands: false };
}

/** Restore the webview state (any older shape - e.g. `{selected, fmt, levelOnly}` - is accepted and migrated best-effort). */
export function sanitizeState(raw: unknown): PersistedState {
  const st = emptyState();
  if (!isObj(raw)) return st;
  if (typeof raw.selected === 'string') st.selected = raw.selected;
  st.layout = sanitizeLayout(raw.layout);
  st.thousands = raw.thousands === true;
  if (isObj(raw.views)) {
    // symbol info is unknown until the symbols arrive: keep raw objects, validated in `restoreView`
    let n = 0;
    for (const [name, v] of Object.entries(raw.views)) {
      if (n++ >= MAX_PERSISTED_VIEWS) break;
      st.views[name] = v as SymView;
    }
  }
  return st;
}

/** Entries to persist: non-default views only, newest `MAX_PERSISTED_VIEWS`. */
export function serializeViews(views: ReadonlyMap<string, SymView>, symbols: readonly Pick<GdxSymbolInfo, 'name' | 'dim'>[]): Record<string, SymView> {
  const out: Record<string, SymView> = {};
  const dims = new Map(symbols.map((s) => [s.name, s.dim] as const));
  const entries = [...views.entries()].filter(([name, v]) => !isDefaultView(v, { dim: dims.get(name) ?? 0 }));
  for (const [name, v] of entries.slice(-MAX_PERSISTED_VIEWS)) out[name] = v;
  return out;
}
