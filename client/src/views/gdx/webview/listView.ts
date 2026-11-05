// SPDX-License-Identifier: GPL-3.0-or-later
// List view: one row per record (keys + value columns), paged from the server.
import { MAX_COPY_CELLS, cellCount, CellRange } from '../copy';
import { formatValue, SV_UNDEF } from '../format';
import { GdxRecord, keyHeader, normalizeValue, VALUE_COLUMNS } from '../model';
import { LruMap } from '../pivot';
import type { RecordsResult } from '../protocol';
import { isDefaultValueFilter } from '../query';
import { maxDisplayRecords } from '../scrollmap';
import { isSetLike } from '../symview';
import { el, icon } from './dom';
import { createGrid, Grid, GridColumn, GridRow } from './grid';
import { errText, isLimitError, rpc } from './rpc';
import { copyValueText, displayFormat, hooks, queryParams, ROW_H, S, setNotice, valueCols } from './state';
import { activeMatch, isMatchText } from './searchState';
import { widthsFor } from '../columns';

export const PAGE = 200;

export const list = {
  total: 0,
  unfiltered: 0,
  pages: new LruMap<GdxRecord[]>(60),
  pageReq: new Map<number, Promise<GdxRecord[] | undefined>>(),
  grid: undefined as Grid | undefined,
};

export function isSpecial(v: unknown): boolean {
  return (typeof v === 'number' && v >= SV_UNDEF) || (typeof v === 'string' && /^(UNDF|NA|\+INF|-INF|EPS)$/.test(v));
}

const cellText = (v: number | string | null | undefined): string => (v === null || v === undefined ? '' : formatValue(v, displayFormat()));

/** Rows the grid shows: all records up to Studio's display limit (GdxSymbolView::updateMaxDisplayRecords). */
export function displayRows(): number {
  return Math.min(list.total, maxDisplayRecords(ROW_H));
}

export function listColumnIds(): string[] {
  const s = S.selected;
  if (!s) return [];
  const ids = Array.from({ length: s.dim }, (_, d) => `k${d}`);
  return isSetLike(s) ? [...ids, 'text'] : [...ids, ...valueCols().map((i) => `v${i}`)];
}

function sortMark(col: number): string {
  const so = S.view.sort;
  return so && so.column === col ? (so.ascending ? ' ▲' : ' ▼') : '';
}

function toggleSort(col: number): void {
  const so = S.view.sort;
  S.view.sort = { column: col, ascending: so && so.column === col ? !so.ascending : true };
  hooks.persist();
  resetList();
}

function filterButton(active: boolean, onclick: (b: HTMLElement) => void): HTMLElement {
  const b = el('span', 'fbtn' + (active ? ' active' : ''));
  b.append(icon('filter'));
  b.title = active ? 'Filter active' : 'Filter';
  b.onmousedown = (e) => e.stopPropagation();
  b.onclick = (e) => { e.stopPropagation(); onclick(b); };
  return b;
}

export { filterButton };

export function listColumns(): GridColumn[] {
  const s = S.selected!;
  const ids = listColumnIds();
  const widths = widthsFor(ids, S.view.widths, (id) => (id === 'text' ? 400 : id.startsWith('k') ? 140 : 120));
  return ids.map((id, i): GridColumn => {
    if (id.startsWith('k')) {
      const d = Number(id.slice(1));
      return {
        id, width: widths[i], title: keyHeader(s.domain, d) + sortMark(d), tooltip: `${s.domain[d] ?? '*'} (click to sort, right-click for more)`,
        headerExtra: 34,
        onClick: () => toggleSort(d),
        onContextMenu: (e) => hooks.headerMenu(e, d),
        decorate: (cell) => cell.append(filterButton(!!S.view.filters.labels[d], (b) => hooks.openLabelFilter(d, b))),
      };
    }
    if (id === 'text') {
      return { id, width: widths[i], title: 'Text' + sortMark(s.dim), onClick: () => toggleSort(s.dim), headerExtra: 18 };
    }
    const slot = Number(id.slice(1));
    const col = s.dim + slot;
    const name = s.kind === 'Parameter' ? 'Value' : VALUE_COLUMNS[slot];
    return {
      id, width: widths[i], align: 'right', title: name + sortMark(col), tooltip: `${name} (click to sort)`, headerExtra: 34,
      onClick: () => toggleSort(col),
      decorate: (cell) => cell.append(filterButton(!!S.view.filters.values[slot] && !isDefaultValueFilter(S.view.filters.values[slot]), (b) => hooks.openValueFilter(slot, b))),
    };
  });
}

function rowCells(rec: GdxRecord): GridRow {
  const s = S.selected!;
  const cells: string[] = [...rec.keys.slice(0, s.dim)];
  const special: boolean[] = cells.map(() => false);
  if (isSetLike(s)) { cells.push(String(rec.values[0] ?? '')); special.push(false); } else {
    for (const i of valueCols()) { const v = rec.values[i]; cells.push(cellText(v)); special.push(isSpecial(v)); }
  }
  return { cells, special };
}

function source() {
  return {
    get rowCount() { return displayRows(); },
    row(r: number): GridRow | undefined {
      const rec = list.pages.get(Math.floor(r / PAGE))?.[r % PAGE];
      return rec ? rowCells(rec) : undefined;
    },
    prefetch(first: number, last: number): void {
      for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last - 1) / PAGE); p++) if (!list.pages.has(p)) void ensurePage(p);
    },
  };
}

export function mountList(container: HTMLElement): void {
  list.grid = createGrid(container, source(), {
    rowHeight: ROW_H,
    onResize: (id, w, final) => { S.view.widths[id] = w; if (final) hooks.persist(); },
    onSelectionChange: () => hooks.chrome(),
    onContextMenu: (e, cell) => hooks.cellMenu(e, cell),
    isMatch: (_r, _c, text) => isMatchText(text),
    activeMatch,
    emptyText: () => (list.unfiltered ? 'No records match the filters.' : 'No records.'),
  });
  list.grid.setColumns(listColumns());
}

/** Rebuild the header after column set / sort / filter state changed (data stays). */
export function refreshListColumns(): void {
  list.grid?.setColumns(listColumns());
}

export function listLoaded(r: number): boolean {
  return list.pages.has(Math.floor(r / PAGE));
}

export function listTexts(r: number, c: number): readonly string[] | undefined {
  const rec = list.pages.get(Math.floor(r / PAGE))?.[r % PAGE];
  return rec ? [rowCells(rec).cells[c] ?? ''] : undefined;
}

export function ensurePage(p: number): Promise<GdxRecord[] | undefined> {
  const cached = list.pages.get(p);
  if (cached) return Promise.resolve(cached);
  const inflight = list.pageReq.get(p);
  if (inflight) return inflight;
  // after a request error stop refetching until reload / reset clears it
  if (S.loadError) return Promise.resolve(undefined);
  const g = S.gen;
  const s = S.selected!;
  const prom = rpc<RecordsResult>('records', { symbolIndex: s.index, offset: p * PAGE, limit: PAGE, ...queryParams(true) })
    .then((m) => {
      if (g !== S.gen) return undefined;
      for (const r of m.records) r.values = r.values.map((v) => normalizeValue(v, s.kind));
      list.pages.set(p, m.records);
      list.total = m.total;
      list.unfiltered = m.unfiltered ?? m.total;
      updateTruncation();
      return m.records;
    })
    .catch((e: unknown) => {
      if (g !== S.gen) return undefined;
      const msg = errText(e);
      if (isLimitError(msg)) hooks.limitHit(msg); else S.loadError = msg;
      return undefined;
    })
    .finally(() => {
      if (g !== S.gen) return;
      list.pageReq.delete(p);
      hooks.chrome();
      if (S.loadError) hooks.rebuild(); else list.grid?.refresh();
    });
  list.pageReq.set(p, prom);
  return prom;
}

/** Studio: "Symbol exceeds the maximum number of records (%1) that can be displayed and is visually truncated." */
export function updateTruncation(): void {
  const limit = maxDisplayRecords(ROW_H);
  S.truncated = list.total > limit;
  setNotice('truncated', S.truncated
    ? `Symbol exceeds the maximum number of records (${limit.toLocaleString()}) that can be displayed and is visually truncated.`
    : '');
}

export function resetList(): void {
  S.gen++;
  list.pages.clear();
  list.pageReq.clear();
  S.loadError = '';
  const s = S.selected;
  list.total = s ? s.records : 0;
  list.unfiltered = list.total;
  updateTruncation();
  hooks.chrome();
  if (list.grid) {
    refreshListColumns();
    list.grid.setSource(source());
  }
  if (s) void ensurePage(0);
}

/** Cells of the selected block of the list view (unformatted full precision); pages are fetched one by one. */
export async function listCopyRange(range: CellRange): Promise<string[][] | undefined> {
  const s = S.selected!;
  if (cellCount(range) > MAX_COPY_CELLS) { hooks.status('Selection too large to copy.'); return undefined; }
  const vcols = valueCols();
  const rows: string[][] = [];
  for (let p = Math.floor(range.r0 / PAGE); p <= Math.floor(range.r1 / PAGE); p++) {
    const recs = await ensurePage(p);
    if (!recs) throw new Error('Could not load records');
    const from = Math.max(range.r0, p * PAGE);
    const to = Math.min(range.r1, p * PAGE + PAGE - 1);
    for (let r = from; r <= to; r++) {
      const rec = recs[r - p * PAGE];
      const line: string[] = [];
      for (let c = range.c0; c <= range.c1; c++) {
        if (!rec) line.push('');
        else if (c < s.dim) line.push(rec.keys[c] ?? '');
        else line.push(copyValueText(rec.values[isSetLike(s) ? 0 : vcols[c - s.dim]]));
      }
      rows.push(line);
    }
  }
  return rows;
}
