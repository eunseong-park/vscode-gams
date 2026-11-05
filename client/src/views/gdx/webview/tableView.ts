// SPDX-License-Identifier: GPL-3.0-or-later
// Table (pivot) view: dimensions arranged in row / column areas (Studio TableViewModel /
// TableViewDomainModel), windows of the pivot fetched from the server in blocks.
import { cellCount, CellRange, MAX_COPY_CELLS, tableCopyRows } from '../copy';
import { widthsFor } from '../columns';
import { formatValue } from '../format';
import { keyHeader, normalizeValue } from '../model';
import { blocksFor, LruMap, moveDim, transpose, VALUE_FIELD_NAMES } from '../pivot';
import type { TableResult } from '../protocol';
import { isDefaultValueFilter } from '../query';
import { isSetLike } from '../symview';
import { el } from './dom';
import { createPivotGrid, PivotCell, PivotGrid } from './pivotGrid';
import { errText, isLimitError, rpc } from './rpc';
import { copyValueText, displayFormat, hooks, queryParams, S } from './state';
import { filterButton, isSpecial } from './listView';
import { activeMatch, isMatchText } from './searchState';

const TBL_ROWS = 100;
const TBL_COLS = 30;
export const COL_W = 110;
export const RHDR_W = 120;

export const table = {
  rowCount: 0,
  colCount: 0,
  blocks: new LruMap<TableResult>(120),
  blockReq: new Map<string, Promise<void>>(),
  rowHdr: new Map<number, string[]>(),
  colHdr: new Map<number, string[]>(),
  grid: undefined as PivotGrid | undefined,
};

const bkey = (br: number, bc: number): string => `${br},${bc}`;

function cellOf(r: number, c: number): number | string | null | undefined {
  const blk = table.blocks.get(bkey(Math.floor(r / TBL_ROWS), Math.floor(c / TBL_COLS)));
  return blk?.cells[r - blk.rowOffset]?.[c - blk.colOffset];
}

export function blockLoaded(r: number, c: number): boolean {
  return table.blocks.has(bkey(Math.floor(r / TBL_ROWS), Math.floor(c / TBL_COLS)));
}

export function ensureBlock(br: number, bc: number): Promise<void> {
  const key = bkey(br, bc);
  if (table.blocks.has(key) || !S.selected || S.loadError) return Promise.resolve();
  const inflight = table.blockReq.get(key);
  if (inflight) return inflight;
  const g = S.gen;
  const p = S.view.pivot;
  const prom = rpc<TableResult>('table', {
    symbolIndex: S.selected.index, rowDims: p.rowDims, colDims: p.colDims, valueField: p.valueField,
    rowOffset: br * TBL_ROWS, rowLimit: TBL_ROWS, colOffset: bc * TBL_COLS, colLimit: TBL_COLS, ...queryParams(false),
  }).then((m) => {
    if (g !== S.gen) return;
    const kind = S.selected!.kind;
    m.cells = m.cells.map((r) => r.map((v) => (v === null ? null : normalizeValue(v, kind))));
    table.blocks.set(key, m);
    table.rowCount = m.rowCount;
    table.colCount = m.colCount;
    m.rowHeaders.forEach((h, i) => table.rowHdr.set(m.rowOffset + i, h));
    m.colHeaders.forEach((h, i) => table.colHdr.set(m.colOffset + i, h));
  }).catch((e: unknown) => {
    if (g !== S.gen) return;
    const msg = errText(e);
    if (isLimitError(msg)) hooks.limitHit(msg); else S.loadError = msg;
  }).finally(() => {
    if (g !== S.gen) return;
    table.blockReq.delete(key);
    hooks.chrome();
    if (S.loadError) hooks.rebuild(); else table.grid?.refresh();
  });
  table.blockReq.set(key, prom);
  return prom;
}

const fmtCell = (v: number | string | null | undefined): string => (v === null || v === undefined ? '' : formatValue(v, displayFormat()));

function source() {
  const s = S.selected!;
  const p = S.view.pivot;
  return {
    get rowCount() { return table.rowCount; },
    get colCount() { return table.colCount; },
    rowDimCount: Math.max(1, p.rowDims.length),
    colDimCount: p.colDims.length,
    rowTitles: p.rowDims.length ? p.rowDims.map((d) => keyHeader(s.domain, d)) : [''],
    colFallback: 'Value',
    numeric: !isSetLike(s),
    cell(r: number, c: number): PivotCell | undefined {
      const v = cellOf(r, c);
      return v === undefined ? undefined : { text: fmtCell(v), special: isSpecial(v) };
    },
    rowHeader: (r: number) => table.rowHdr.get(r),
    colHeader: (c: number) => table.colHdr.get(c),
    prefetch(r0: number, r1: number, c0: number, c1: number): void {
      // before the first block arrives the counts are unknown: ask for block (0,0)
      const nr = table.rowCount || TBL_ROWS;
      const nc = table.colCount || TBL_COLS;
      for (const br of blocksFor(r0, r1, TBL_ROWS, nr)) for (const bc of blocksFor(c0, c1, TBL_COLS, nc)) void ensureBlock(br, bc);
    },
  };
}

function widths() {
  const p = S.view.pivot;
  const ids = p.rowDims.length ? p.rowDims.map((_, i) => `tr${i}`) : ['tr0'];
  return { colW: widthsFor(['tc'], S.view.widths, () => COL_W)[0], rowW: widthsFor(ids, S.view.widths, () => RHDR_W) };
}

export function mountTable(container: HTMLElement): void {
  const w = widths();
  table.grid = createPivotGrid(container, source(), {
    colWidth: w.colW,
    rowHdrWidths: w.rowW,
    onResize: (id, width, final) => { S.view.widths[id] = width; if (final) hooks.persist(); },
    onSelectionChange: () => hooks.chrome(),
    onContextMenu: (e, cell) => hooks.cellMenu(e, cell),
    isMatch: (r, c) => {
      const v = cellOf(r, c);
      return v !== undefined && isMatchText(fmtCell(v));
    },
    activeMatch,
    emptyText: () => 'No Data',
  });
}

export function resetTable(): void {
  S.gen++;
  table.blocks.clear();
  table.blockReq.clear();
  table.rowHdr.clear();
  table.colHdr.clear();
  table.rowCount = 0;
  table.colCount = 0;
  S.loadError = '';
  hooks.chrome();
  if (table.grid) {
    const w = widths();
    table.grid.setSource(source());
    table.grid.setWidths(w.colW, w.rowW);
  }
}

export function tableTexts(r: number, c: number): readonly string[] | undefined {
  const v = cellOf(r, c);
  if (v === undefined) return undefined;
  const out = [fmtCell(v)];
  // labels match at the first cell of their row / column (Studio matches every cell of a labelled row)
  if (c === 0) out.push(...(table.rowHdr.get(r) ?? []));
  if (r === 0) out.push(...(table.colHdr.get(c) ?? []));
  return out;
}

export function tableCopy(range: CellRange, withLabels: boolean): Promise<string[][] | undefined> {
  const s = S.selected!;
  const p = S.view.pivot;
  if (cellCount(range) > MAX_COPY_CELLS) { hooks.status('Selection too large to copy.'); return Promise.resolve(undefined); }
  return rpc<TableResult>('table', {
    symbolIndex: s.index, rowDims: p.rowDims, colDims: p.colDims, valueField: p.valueField,
    rowOffset: range.r0, rowLimit: range.r1 - range.r0 + 1, colOffset: range.c0, colLimit: range.c1 - range.c0 + 1, ...queryParams(false),
  }).then((m) => tableCopyRows(
    { r0: 0, r1: m.cells.length - 1, c0: 0, c1: (m.cells[0]?.length ?? 1) - 1 },
    {
      rowDimCount: p.rowDims.length,
      colDimCount: p.colDims.length,
      rowHeader: (r) => m.rowHeaders[r] ?? [],
      colHeader: (c) => m.colHeaders[c] ?? [],
      cell: (r, c) => { const v = m.cells[r]?.[c]; return copyValueText(v === null || v === undefined ? null : normalizeValue(v, s.kind)); },
    },
    withLabels,
  ));
}

/** Row / column dimension chips (drag to move between the areas, Studio TableViewDomainModel). */
export function renderPivotBar(bar: HTMLElement): void {
  bar.textContent = '';
  const s = S.selected;
  if (!s) return;
  const view = S.view;
  const p = view.pivot;
  const change = (): void => { hooks.persist(); hooks.rebuild(); };
  const zone = (title: string, dims: number[], target: 'row' | 'col'): HTMLElement => {
    const z = el('div', 'zone');
    z.append(el('span', 'zonelbl', title));
    const holder = el('span', 'chips');
    dims.forEach((d) => {
      const chip = el('span', 'chip');
      chip.draggable = true;
      chip.title = `Drag to reorder or move to ${target === 'row' ? 'columns' : 'rows'}`;
      chip.append(el('span', undefined, keyHeader(s.domain, d)));
      chip.append(filterButton(!!view.filters.labels[d], (b) => hooks.openLabelFilter(d, b)));
      const mv = el('span', 'fbtn', '⇄');
      mv.title = target === 'row' ? 'Move to columns' : 'Move to rows';
      mv.onclick = () => { view.pivot = moveDim(view.pivot, d, target === 'row' ? 'col' : 'row'); change(); };
      chip.append(mv);
      chip.ondragstart = (e) => { e.dataTransfer?.setData('text/plain', String(d)); e.dataTransfer!.effectAllowed = 'move'; };
      holder.append(chip);
    });
    z.append(holder);
    z.ondragover = (e) => { e.preventDefault(); z.classList.add('over'); };
    z.ondragleave = () => z.classList.remove('over');
    z.ondrop = (e) => {
      e.preventDefault();
      z.classList.remove('over');
      const d = Number(e.dataTransfer?.getData('text/plain'));
      if (!Number.isInteger(d) || d < 0 || d >= s.dim) return;
      const chips = Array.from(holder.children) as HTMLElement[];
      let pos = chips.findIndex((c) => e.clientX < c.getBoundingClientRect().left + c.offsetWidth / 2);
      if (pos < 0) pos = chips.length;
      const cur = (target === 'row' ? view.pivot.rowDims : view.pivot.colDims).indexOf(d);
      if (cur >= 0 && cur < pos) pos--;
      view.pivot = moveDim(view.pivot, d, target, pos);
      change();
    };
    return z;
  };
  bar.append(zone('Rows', p.rowDims, 'row'), zone('Columns', p.colDims, 'col'));
  const tr = el('button', undefined, 'Transpose');
  tr.title = 'Swap rows and columns';
  tr.onclick = () => { view.pivot = transpose(view.pivot); change(); };
  bar.append(tr);
  if (s.kind === 'Variable' || s.kind === 'Equation') {
    const sel = el('select');
    sel.title = 'Attribute shown in the table';
    VALUE_FIELD_NAMES.forEach((n, i) => { const o = el('option', undefined, n); o.value = String(i); sel.append(o); });
    sel.value = String(p.valueField);
    sel.onchange = () => { view.pivot = { ...view.pivot, valueField: Number(sel.value) }; change(); };
    const f = view.filters.values[p.valueField];
    bar.append(el('span', undefined, 'Attribute'), sel, filterButton(!!f && !isDefaultValueFilter(f), (b) => hooks.openValueFilter(view.pivot.valueField, b)));
  } else if (s.kind === 'Parameter') {
    const f = view.filters.values[0];
    bar.append(filterButton(!!f && !isDefaultValueFilter(f), (b) => hooks.openValueFilter(0, b)));
  }
}
