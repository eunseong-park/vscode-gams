// SPDX-License-Identifier: GPL-3.0-or-later
// Virtualised pivot (table view) grid: nested row / column headers, uniform data column width,
// per-dimension row header widths, scaled scrolling on both axes, cell selection with keyboard
// navigation. Same design as grid.ts (data source + options, no viewer state).
import { fitWidth } from '../columns';
import { CellRange } from '../copy';
import { firstWithPin, Pin, ScrollAxis } from '../scrollmap';
import { GridSelection } from '../selection';
import { addResizeHandle } from './colresize';
import { el, textMeasurer } from './dom';

export interface PivotCell {
  text: string;
  special?: boolean;
}

export interface PivotSource {
  rowCount: number;
  colCount: number;
  /** number of row header columns (>= 1) and column header rows (>= 1) */
  rowDimCount: number;
  colDimCount: number;
  /** corner labels, one per row header column */
  rowTitles: readonly string[];
  /** header text when there are no column dimensions */
  colFallback: string;
  numeric: boolean;
  cell(r: number, c: number): PivotCell | undefined;
  rowHeader(r: number): readonly string[] | undefined;
  colHeader(c: number): readonly string[] | undefined;
  prefetch?(r0: number, r1: number, c0: number, c1: number): void;
}

export interface PivotOptions {
  rowHeight?: number;
  colWidth: number;
  /** one width per row header column */
  rowHdrWidths: number[];
  onResize?: (id: string, width: number, final: boolean) => void;
  onSelectionChange?: (range: CellRange | undefined) => void;
  onContextMenu?: (e: MouseEvent, cell: { r: number; c: number } | undefined) => void;
  isMatch?: (r: number, c: number) => boolean;
  activeMatch?: () => { r: number; c: number } | undefined;
  emptyText?: () => string;
}

export interface PivotGrid {
  readonly el: HTMLElement;
  readonly selection: GridSelection;
  setSource(src: PivotSource): void;
  /** call after widths or dimension counts changed */
  setWidths(colWidth: number, rowHdrWidths: number[]): void;
  refresh(): void;
  goTo(r: number, c: number): void;
  selectAll(): void;
  autoFit(): void;
  focus(): void;
  destroy(): void;
}

export function createPivotGrid(container: HTMLElement, initial: PivotSource, opts: PivotOptions): PivotGrid {
  const ROW_H = opts.rowHeight ?? 22;
  let src = initial;
  let colW = opts.colWidth;
  let rowW = opts.rowHdrWidths.slice();
  const selection = new GridSelection(0, 0);
  let pinY: Pin | undefined;
  let pinX: Pin | undefined;
  let raf = 0;
  let dragging = false;

  const wrap = el('div', 'tblwrap');
  const corner = el('div', 'tblcorner');
  const colClip = el('div', 'tblclip');
  const colLayer = el('div', 'tbllayer');
  const rowClip = el('div', 'tblclip');
  const rowLayer = el('div', 'tbllayer');
  const scroll = el('div', 'tblscroll');
  scroll.tabIndex = 0;
  const sizer = el('div', 'tblsizer');
  const cells = el('div', 'tblcells');
  colClip.append(colLayer);
  rowClip.append(rowLayer);
  sizer.append(cells);
  scroll.append(sizer);
  wrap.append(corner, colClip, rowClip, scroll);
  container.append(wrap);

  const hh = (): number => Math.max(1, src.colDimCount) * ROW_H;
  const hw = (): number => rowW.reduce((a, b) => a + b, 0);
  const rowX = (k: number): number => rowW.slice(0, k).reduce((a, b) => a + b, 0);

  function geometry(): void {
    corner.style.cssText = `left:0;top:0;width:${hw()}px;height:${hh()}px`;
    colClip.style.cssText = `left:${hw()}px;top:0;right:0;height:${hh()}px`;
    rowClip.style.cssText = `left:0;top:${hh()}px;width:${hw()}px;bottom:0`;
    scroll.style.cssText = `left:${hw()}px;top:${hh()}px;right:0;bottom:0`;
  }

  function renderCorner(): void {
    corner.textContent = '';
    src.rowTitles.forEach((t, i) => {
      const c = el('div', 'tblh', t);
      c.title = t;
      c.style.cssText = `left:${rowX(i)}px;top:${hh() - ROW_H}px;width:${rowW[i]}px`;
      addResizeHandle(c, {
        width: () => rowW[i],
        onResize: (w, final) => { rowW[i] = w; geometry(); renderCorner(); layout(); opts.onResize?.(`tr${i}`, w, final); },
        onAutoFit: () => fit(`tr${i}`),
      });
      corner.append(c);
    });
  }

  const axes = (): { ay: ScrollAxis; ax: ScrollAxis } => ({
    ay: new ScrollAxis(src.rowCount, ROW_H, Math.max(ROW_H, scroll.clientHeight)),
    ax: new ScrollAxis(src.colCount, colW, Math.max(colW, scroll.clientWidth)),
  });

  function layout(): void {
    const { ay, ax } = axes();
    const top = scroll.scrollTop;
    const left = scroll.scrollLeft;
    const fy = firstWithPin(ay, top, pinY);
    const fx = firstWithPin(ax, left, pinX);
    sizer.style.width = `${ax.spacerPx}px`;
    sizer.style.height = `${ay.spacerPx}px`;
    const r0 = Math.max(0, fy - 2);
    const r1 = Math.min(src.rowCount, fy + Math.ceil(ay.viewPx / ROW_H) + 3);
    const c0 = Math.max(0, fx - 1);
    const c1 = Math.min(src.colCount, fx + Math.ceil(ax.viewPx / colW) + 2);
    // before the first block arrives the counts are unknown: always ask for the first cell
    src.prefetch?.(r0, Math.max(r1, r0 + 1), c0, Math.max(c1, c0 + 1));
    const matchAt = opts.activeMatch?.();
    const frag = document.createDocumentFragment();
    for (let r = r0; r < r1; r++) {
      const y = ay.contentPos(r, fy, top);
      for (let c = c0; c < c1; c++) {
        const pc = src.cell(r, c);
        let cls = 'tblc' + (src.numeric ? ' num' : '');
        if (pc?.special) cls += ' special';
        if (selection.contains(r, c)) cls += ' selcell';
        if (selection.active && selection.active.r === r && selection.active.c === c) cls += ' activecell';
        if (opts.isMatch?.(r, c)) cls += matchAt && matchAt.r === r && matchAt.c === c ? ' match cur' : ' match';
        const d = el('div', cls, pc?.text ?? '');
        if (pc?.text) d.title = pc.text;
        d.style.cssText = `left:${ax.contentPos(c, fx, left)}px;top:${y}px;width:${colW}px`;
        d.dataset.r = String(r);
        d.dataset.c = String(c);
        frag.append(d);
      }
    }
    cells.textContent = '';
    cells.append(frag);
    if (src.rowCount === 0) {
      const m = el('div', 'msg', opts.emptyText?.() ?? 'No Data');
      m.style.position = 'absolute';
      cells.append(m);
    }
    // headers (positions relative to the viewport; they do not scroll natively)
    colLayer.textContent = '';
    rowLayer.textContent = '';
    const ch = document.createDocumentFragment();
    const nCol = Math.max(1, src.colDimCount);
    for (let c = c0; c < c1; c++) {
      const h = src.colHeader(c);
      for (let k = 0; k < nCol; k++) {
        const text = src.colDimCount === 0 ? src.colFallback : (h?.[k] ?? '');
        const d = el('div', 'tblh', text);
        d.title = text;
        d.style.cssText = `left:${ax.viewPos(c, fx, left)}px;top:${k * ROW_H}px;width:${colW}px`;
        if (k === nCol - 1) {
          addResizeHandle(d, { width: () => colW, onResize: (w, final) => { colW = w; layout(); opts.onResize?.('tc', w, final); }, onAutoFit: () => fit('tc') });
        }
        ch.append(d);
      }
    }
    colLayer.append(ch);
    const rh = document.createDocumentFragment();
    for (let r = r0; r < r1; r++) {
      const h = src.rowHeader(r);
      for (let k = 0; k < Math.max(1, src.rowDimCount); k++) {
        const text = h?.[k] ?? '';
        const d = el('div', 'tblh', text);
        d.title = text;
        d.style.cssText = `left:${rowX(k)}px;top:${ay.viewPos(r, fy, top)}px;width:${rowW[k] ?? colW}px`;
        rh.append(d);
      }
    }
    rowLayer.append(rh);
  }

  function fit(id: string): void {
    const measure = textMeasurer(scroll);
    const { ay, ax } = axes();
    const fy = firstWithPin(ay, scroll.scrollTop, pinY);
    const fx = firstWithPin(ax, scroll.scrollLeft, pinX);
    const rEnd = Math.min(src.rowCount, fy + 400);
    const cEnd = Math.min(src.colCount, fx + 60);
    if (id === 'tc') {
      const texts: string[] = [];
      for (let c = fx; c < cEnd; c++) {
        for (const t of src.colHeader(c) ?? []) texts.push(t);
        for (let r = Math.max(0, fy - 50); r < rEnd; r++) {
          const t = src.cell(r, c)?.text;
          if (t) texts.push(t);
        }
      }
      colW = fitWidth('', texts, measure, { padding: 16, min: 50 });
      opts.onResize?.('tc', colW, true);
    } else {
      const k = Number(id.slice(2));
      const texts: string[] = [];
      for (let r = Math.max(0, fy - 50); r < rEnd; r++) {
        const t = src.rowHeader(r)?.[k];
        if (t) texts.push(t);
      }
      rowW[k] = fitWidth(src.rowTitles[k] ?? '', texts, measure, { padding: 16, min: 50 });
      opts.onResize?.(id, rowW[k], true);
      geometry();
      renderCorner();
    }
    layout();
  }

  function schedule(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; layout(); });
  }
  scroll.addEventListener('scroll', schedule);
  const ro = new ResizeObserver(schedule);
  ro.observe(scroll);

  const notify = (): void => opts.onSelectionChange?.(selection.range());

  function reveal(r: number, c: number): void {
    const { ay, ax } = axes();
    const fy = firstWithPin(ay, scroll.scrollTop, pinY);
    const fx = firstWithPin(ax, scroll.scrollLeft, pinX);
    if (ay.scaled) {
      const nf = ay.reveal(r, fy);
      if (nf !== fy) { scroll.scrollTop = ay.scrollFor(nf); pinY = { scroll: scroll.scrollTop, first: nf }; }
    } else {
      const pos = ay.viewPos(r, fy, scroll.scrollTop);
      if (pos < 0) scroll.scrollTop = r * ROW_H;
      else if (pos + ROW_H > ay.viewPx) scroll.scrollTop = (r + 1) * ROW_H - ay.viewPx;
    }
    if (ax.scaled) {
      const nf = ax.reveal(c, fx);
      if (nf !== fx) { scroll.scrollLeft = ax.scrollFor(nf); pinX = { scroll: scroll.scrollLeft, first: nf }; }
    } else {
      const pos = ax.viewPos(c, fx, scroll.scrollLeft);
      if (pos < 0) scroll.scrollLeft = c * colW;
      else if (pos + colW > ax.viewPx) scroll.scrollLeft = (c + 1) * colW - ax.viewPx;
    }
  }

  const cellOf = (t: EventTarget | null): { r: number; c: number } | undefined => {
    const d = (t as HTMLElement | null)?.closest?.('[data-r]') as HTMLElement | null;
    return d ? { r: Number(d.dataset.r), c: Number(d.dataset.c) } : undefined;
  };
  cells.addEventListener('mousedown', (e) => {
    const c = cellOf(e.target);
    if (!c || e.button !== 0) return;
    dragging = true;
    selection.set(c.r, c.c, e.shiftKey);
    scroll.focus();
    layout();
    notify();
    e.preventDefault();
  });
  cells.addEventListener('mouseover', (e) => {
    if (!dragging) return;
    const c = cellOf(e.target);
    if (c && selection.anchor && (selection.active?.r !== c.r || selection.active?.c !== c.c)) {
      selection.set(c.r, c.c, true);
      layout();
      notify();
    }
  });
  const up = (): void => { dragging = false; };
  document.addEventListener('mouseup', up);
  cells.addEventListener('contextmenu', (e) => {
    const c = cellOf(e.target);
    e.preventDefault();
    if (c && !selection.contains(c.r, c.c)) { selection.set(c.r, c.c); layout(); notify(); }
    opts.onContextMenu?.(e, c);
  });
  scroll.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, axes().ay.viewItems - 1);
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': selection.move(1, 0, e.shiftKey); break;
      case 'ArrowUp': selection.move(-1, 0, e.shiftKey); break;
      case 'ArrowRight': selection.move(0, 1, e.shiftKey); break;
      case 'ArrowLeft': selection.move(0, -1, e.shiftKey); break;
      case 'PageDown': selection.move(page, 0, e.shiftKey); break;
      case 'PageUp': selection.move(-page, 0, e.shiftKey); break;
      case 'Home': mod ? selection.set(0, 0, e.shiftKey) : selection.set(selection.active?.r ?? 0, 0, e.shiftKey); break;
      case 'End': mod ? selection.set(src.rowCount - 1, src.colCount - 1, e.shiftKey) : selection.set(selection.active?.r ?? 0, src.colCount - 1, e.shiftKey); break;
      case 'a': case 'A': if (mod) selection.selectAll(); else handled = false; break;
      default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    if (selection.active) reveal(selection.active.r, selection.active.c);
    layout();
    notify();
  });

  geometry();
  renderCorner();
  selection.resize(src.rowCount, src.colCount);
  layout();

  return {
    el: wrap,
    selection,
    setSource(s) {
      src = s; pinX = pinY = undefined;
      selection.resize(s.rowCount, s.colCount);
      geometry(); renderCorner(); layout();
    },
    setWidths(cw, rw) { colW = cw; rowW = rw.slice(); geometry(); renderCorner(); layout(); },
    refresh() { selection.resize(src.rowCount, src.colCount); layout(); },
    goTo(r, c) { selection.set(r, c); reveal(r, c); layout(); notify(); },
    selectAll() { selection.selectAll(); layout(); notify(); },
    autoFit() { fit('tc'); for (let k = 0; k < src.rowDimCount; k++) fit(`tr${k}`); },
    focus: () => scroll.focus(),
    destroy() {
      ro.disconnect();
      document.removeEventListener('mouseup', up);
      if (raf) cancelAnimationFrame(raf);
      wrap.remove();
    },
  };
}
