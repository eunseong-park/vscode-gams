// SPDX-License-Identifier: GPL-3.0-or-later
// Shared viewer state (one webview = one GDX file) and the hooks the view modules call back.
import { DEFAULT_FORMAT, FormatOptions, formatValue, localeSeparators } from '../format';
import type { GdxSymbolInfo } from '../model';
import { NavHistory } from '../nav';
import { buildQueryParams, QueryParams } from '../query';
import { NO_SEARCH, SearchOptions } from '../search';
import { DEFAULT_LAYOUT, LayoutState } from '../layout';
import {
  DEFAULT_SYM_FORMAT, defaultSymView, effectiveFormat, isSetLike, PersistedState, sanitizeSymView, serializeViews, SymFormat, SymView, visibleValueColumns,
} from '../symview';
import { vscodeApi } from './rpc';

export const ROW_H = 22;

export const S = {
  fileName: 'GDX',
  language: 'en',
  symbols: [] as GdxSymbolInfo[],
  selected: undefined as GdxSymbolInfo | undefined,
  view: defaultSymView({ dim: 0 }) as SymView,
  /** per-symbol view state, kept while switching symbols */
  views: new Map<string, SymView>(),
  /** persisted views not yet matched with a symbol (validated on first selection) */
  restored: {} as Record<string, unknown>,
  layout: { ...DEFAULT_LAYOUT, symWidths: {} } as LayoutState,
  thousands: false,
  /** numeric format of symbols without a view of their own (shared display preferences) */
  defaultFmt: { ...DEFAULT_SYM_FORMAT } as SymFormat,
  loadError: '',
  /** transient message line (warnings / info), e.g. truncation, reload, limits */
  notices: new Map<string, string>(),
  /** bumped whenever the data of the current view is invalidated; stale responses are dropped */
  gen: 0,
  /** per symbol index: value columns that only hold defaults (null = could not be determined) */
  allDefault: new Map<number, boolean[] | null>(),
  history: new NavHistory(),
  search: { ...NO_SEARCH } as SearchOptions,
  /** rows hidden by the Studio display limit */
  truncated: false,
};

/** Callbacks into main.ts (avoids import cycles between the view modules). */
export const hooks = {
  persist: (): void => undefined,
  /** (re)load the data of the current view */
  rebuild: (): void => undefined,
  /** refresh toolbar state, info line and status text */
  chrome: (): void => undefined,
  status: (_msg: string): void => undefined,
  openLabelFilter: (_dim: number, _anchor: HTMLElement): void => undefined,
  openValueFilter: (_slot: number, _anchor: HTMLElement): void => undefined,
  selectSymbol: (_s: GdxSymbolInfo, _record?: boolean): void => undefined,
  reloadFile: (): void => undefined,
  focusData: (): void => undefined,
  /** context menu of a list-view key column header (dim) */
  headerMenu: (_e: MouseEvent, _dim: number): void => undefined,
  /** context menu of the data cells */
  cellMenu: (_e: MouseEvent, _cell: { r: number; c: number } | undefined): void => undefined,
  /** a request failed because of a server memory guard: drop sort / filters and report */
  limitHit: (_msg: string): void => undefined,
};

export function setNotice(key: string, text: string): void {
  if (text) S.notices.set(key, text); else S.notices.delete(key);
}

/** Value slots shown in the list view of the current symbol. */
export function valueCols(): number[] {
  const s = S.selected;
  if (!s) return [];
  return visibleValueColumns(s.kind, S.view.attrs, S.allDefault.get(s.index) ?? undefined, S.view.squeezeDefaults);
}

/** Format used to display values: per-symbol preferences plus the optional thousands separator. */
export function displayFormat(): FormatOptions {
  const f = effectiveFormat(S.view.fmt);
  if (!S.thousands) return f;
  const sep = localeSeparators(S.language);
  return { ...f, group: sep.group, decSep: sep.decimal };
}

export function currentFormat(): FormatOptions {
  return S.selected ? effectiveFormat(S.view.fmt) : DEFAULT_FORMAT;
}

/**
 * Clipboard text of a value: formatted with the symbol's format / precision but never with the display
 * thousands separator (Studio copySelectionToString uses the EditRole = formatValue(val, true), which
 * differs from the display only in the decimal separator).
 */
export function copyValueText(v: number | string | null | undefined): string {
  return v === null || v === undefined ? '' : formatValue(v, currentFormat());
}

export function queryParams(withSort: boolean): QueryParams {
  const s = S.selected!;
  return buildQueryParams(s.dim, withSort ? S.view.sort : undefined, S.view.filters, isSetLike(s));
}

export function viewFor(s: GdxSymbolInfo): SymView {
  const known = S.views.get(s.name);
  if (known) return known;
  const raw = S.restored[s.name];
  const v = raw !== undefined ? sanitizeSymView(raw, s) : defaultSymView(s);
  if (raw === undefined) v.fmt = { ...S.defaultFmt };
  delete S.restored[s.name];
  S.views.set(s.name, v);
  return v;
}

export function persistNow(): void {
  const views = serializeViews(S.views, S.symbols);
  // views of symbols not seen in this session (e.g. file reloaded without them) stay untouched
  const state: PersistedState = {
    v: 1,
    selected: S.selected?.name,
    layout: S.layout,
    views: { ...(S.restored as Record<string, never>), ...views },
    thousands: S.thousands,
  };
  vscodeApi.setState(state);
}
