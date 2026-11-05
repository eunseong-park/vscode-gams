// SPDX-License-Identifier: GPL-3.0-or-later
// Reusable virtualised data grid: fixed columns with resizable widths, rows served by a data
// source (loaded lazily), scaled scrolling for millions of rows, cell selection with keyboard
// navigation, search highlighting. Used by the GDX list view; independent of the viewer state so
// other views (e.g. a side-by-side compare) can build on it:
//
//   const grid = createGrid(container, source, { onSelectionChange, onContextMenu, ... });
//   grid.setColumns([{ id, title, width, align }]);  grid.refresh();
import { CellRange } from '../copy';
import { fitWidth } from '../columns';
import { firstWithPin, Pin, ScrollAxis } from '../scrollmap';
import { GridSelection } from '../selection';
import { addResizeHandle } from './colresize';
import { el, textMeasurer } from './dom';

export interface GridColumn {
  id: string;
  title: string;
  tooltip?: string;
  align?: 'left' | 'right';
  width: number;
  /** extra header width (sort mark, filter button) used by auto-fit */
  headerExtra?: number;
  /** add decorations (sort mark, filter button) to the header cell */
  decorate?: (cell: HTMLElement) => void;
  onClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
}

export interface GridRow {
  cells: readonly string[];
  /** cells to draw as special values (UNDF, EPS, ...) */
  special?: readonly boolean[];
  /** extra CSS classes per cell (e.g. compare highlighting) */
  cls?: readonly (string | undefined)[];
}

export interface GridSource {
  rowCount: number;
  /** undefined while the row is being loaded (the grid shows blanks and asks `prefetch`) */
  row(r: number): GridRow | undefined;
  prefetch?(first: number, last: number): void;
}

export interface GridOptions {
  rowHeight?: number;
  onResize?: (colId: string, width: number, final: boolean) => void;
  onSelectionChange?: (range: CellRange | undefined) => void;
  onContextMenu?: (e: MouseEvent, cell: { r: number; c: number } | undefined) => void;
  /** search highlight */
  isMatch?: (r: number, c: number, text: string) => boolean;
  /** the cell of the current search hit, drawn stronger */
  activeMatch?: () => { r: number; c: number } | undefined;
  /** whole-row selection (symbol table): a click or arrow key selects the row, not a cell */
  rowSelect?: boolean;
  /** empty-state text when rowCount is 0 */
  emptyText?: () => string;
}

export interface Grid {
  readonly el: HTMLElement;
  setColumns(cols: GridColumn[]): void;
  setSource(src: GridSource): void;
  /** re-layout and re-draw the visible rows (after data arrived) */
  refresh(): void;
  readonly selection: GridSelection;
  selectAll(): void;
  /** select a single cell and scroll it into view */
  goTo(r: number, c?: number): void;
  /** Select a cell and scroll only if it is not visible (no re-centering). */
  select(r: number, c?: number): void;
  setScrollTop(px: number): void;
  /** fit one column (or all) to the loaded content */
  autoFit(colIndex?: number): void;
  focus(): void;
  destroy(): void;
}

const DEFAULT_ROW_H = 22;

export function createGrid(container: HTMLElement, initial: GridSource, opts: GridOptions = {}): Grid {
  const ROW_H = opts.rowHeight ?? DEFAULT_ROW_H;
  let source = initial;
  let cols: GridColumn[] = [];
  const selection = new GridSelection(0, 0);
  let pin: Pin | undefined;
  let raf = 0;
  let dragging = false;

  const scroller = el('div', 'scroller grid');
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'grid');
  const hdr = el('div', 'hdr');
  const body = el('div', 'body');
  scroller.append(hdr, body);
  container.append(scroller);

  const totalWidth = (): number => cols.reduce((a, c) => a + c.width, 0);
  const template = (): string => cols.map((c) => `${c.width}px`).join(' ');

  function axis(): ScrollAxis {
    const hh = hdr.offsetHeight;
    return new ScrollAxis(source.rowCount, ROW_H, Math.max(ROW_H, scroller.clientHeight - hh));
  }

  function renderHeader(): void {
    hdr.textContent = '';
    const row = el('div', 'row h');
    row.style.gridTemplateColumns = template();
    row.style.width = `${totalWidth()}px`;
    cols.forEach((c, i) => {
      const cell = el('div', c.align === 'right' ? 'num' : undefined, c.title);
      cell.title = c.tooltip ?? c.title;
      cell.setAttribute('role', 'columnheader');
      if (c.onClick) cell.onclick = c.onClick;
      if (c.onContextMenu) cell.oncontextmenu = (e) => { e.preventDefault(); c.onContextMenu?.(e); };
      c.decorate?.(cell);
      addResizeHandle(cell, {
        width: () => c.width,
        onResize: (w, final) => { setWidth(i, w); opts.onResize?.(c.id, w, final); },
        onAutoFit: () => fit(i),
      });
      row.append(cell);
    });
    hdr.append(row);
  }

  function setWidth(i: number, w: number): void {
    cols[i].width = w;
    const hr = hdr.firstElementChild as HTMLElement | null;
    if (hr) { hr.style.gridTemplateColumns = template(); hr.style.width = `${totalWidth()}px`; }
    layout();
  }

  function fit(i?: number): void {
    const measure = textMeasurer(scroller);
    const bold = textMeasurer(scroller, true);
    const a = axis();
    const first = firstWithPin(a, scroller.scrollTop, pin);
    // sample the loaded rows around the viewport (all rows of a huge symbol cannot be measured)
    const from = Math.max(0, first - 200);
    const to = Math.min(source.rowCount, first + 600);
    const idx = i === undefined ? cols.map((_, k) => k) : [i];
    for (const k of idx) {
      const texts: string[] = [];
      for (let r = from; r < to; r++) {
        const t = source.row(r)?.cells[k];
        if (t !== undefined) texts.push(t);
      }
      const c = cols[k];
      const w = fitWidth(c.title, texts, (s) => measure(s), { headerExtra: c.headerExtra ?? 0, padding: 16 });
      const wh = bold(c.title) + (c.headerExtra ?? 0) + 16;
      cols[k].width = Math.max(w, Math.ceil(wh));
      opts.onResize?.(c.id, cols[k].width, true);
    }
    renderHeader();
    layout();
  }

  function normalizeRowSelect(): void {
    if (opts.rowSelect && selection.active) {
      selection.anchor = { r: selection.active.r, c: 0 };
      selection.active = { r: selection.active.r, c: Math.max(0, cols.length - 1) };
    }
  }

  function layout(): void {
    normalizeRowSelect();
    const a = axis();
    const scroll = scroller.scrollTop;
    const first = firstWithPin(a, scroll, pin);
    body.style.height = `${a.spacerPx}px`;
    body.style.width = `${totalWidth()}px`;
    const count = Math.min(source.rowCount - first, Math.ceil(a.viewPx / ROW_H) + 2);
    const from = Math.max(0, first - 3);
    const to = Math.min(source.rowCount, first + count + 3);
    source.prefetch?.(from, to);
    const tpl = template();
    const matchAt = opts.activeMatch?.();
    const frag = document.createDocumentFragment();
    for (let r = from; r < to; r++) {
      const data = source.row(r);
      const row = el('div', 'row');
      row.style.top = `${a.contentPos(r, first, scroll)}px`;
      row.style.gridTemplateColumns = tpl;
      row.style.width = `${totalWidth()}px`;
      row.setAttribute('role', 'row');
      for (let c = 0; c < cols.length; c++) {
        const text = data?.cells[c] ?? '';
        let cls = cols[c].align === 'right' ? 'num' : '';
        if (data?.special?.[c]) cls += ' special';
        if (data?.cls?.[c]) cls += ` ${data.cls[c]}`;
        if (selection.contains(r, c)) cls += ' selcell';
        if (selection.active && selection.active.r === r && selection.active.c === c) cls += ' activecell';
        if (data && opts.isMatch?.(r, c, text)) cls += matchAt && matchAt.r === r && matchAt.c === c ? ' match cur' : ' match';
        const d = el('div', cls.trim() || undefined, text);
        if (text) d.title = text;
        d.dataset.r = String(r);
        d.dataset.c = String(c);
        row.append(d);
      }
      frag.append(row);
    }
    body.textContent = '';
    body.append(frag);
    if (source.rowCount === 0) {
      const m = el('div', 'msg', opts.emptyText?.() ?? 'No records.');
      m.style.position = 'absolute';
      body.append(m);
    }
  }

  function schedule(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; layout(); });
  }
  scroller.addEventListener('scroll', schedule);
  const ro = new ResizeObserver(schedule);
  ro.observe(scroller);

  function notify(): void {
    normalizeRowSelect();
    opts.onSelectionChange?.(selection.range());
  }

  function revealCell(r: number, c: number): void {
    const a = axis();
    const first = firstWithPin(a, scroller.scrollTop, pin);
    if (a.scaled) {
      const nf = a.reveal(r, first);
      if (nf !== first) {
        scroller.scrollTop = a.scrollFor(nf);
        pin = { scroll: scroller.scrollTop, first: nf };
      }
    } else {
      const pos = a.viewPos(r, first, scroller.scrollTop);
      if (pos < 0) scroller.scrollTop = r * ROW_H;
      else if (pos + ROW_H > a.viewPx) scroller.scrollTop = (r + 1) * ROW_H - a.viewPx;
    }
    // horizontal: bring the column into view
    let x = 0;
    for (let k = 0; k < c && k < cols.length; k++) x += cols[k].width;
    const w = cols[c]?.width ?? 0;
    if (x < scroller.scrollLeft) scroller.scrollLeft = x;
    else if (x + w > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = x + w - scroller.clientWidth;
  }

  function cellOf(t: EventTarget | null): { r: number; c: number } | undefined {
    const d = (t as HTMLElement | null)?.closest?.('[data-r]') as HTMLElement | null;
    return d ? { r: Number(d.dataset.r), c: Number(d.dataset.c) } : undefined;
  }

  body.addEventListener('mousedown', (e) => {
    const c = cellOf(e.target);
    if (!c || e.button !== 0) return;
    dragging = true;
    selection.set(c.r, c.c, e.shiftKey);
    scroller.focus();
    layout();
    notify();
    e.preventDefault();
  });
  body.addEventListener('mouseover', (e) => {
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
  body.addEventListener('contextmenu', (e) => {
    const c = cellOf(e.target);
    e.preventDefault();
    if (c && !selection.contains(c.r, c.c)) { selection.set(c.r, c.c); layout(); notify(); }
    opts.onContextMenu?.(e, c);
  });

  scroller.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.target instanceof HTMLInputElement) return;
    const a = axis();
    const page = Math.max(1, a.viewItems - 1);
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': selection.move(1, 0, e.shiftKey); break;
      case 'ArrowUp': selection.move(-1, 0, e.shiftKey); break;
      case 'ArrowRight': selection.move(0, 1, e.shiftKey); break;
      case 'ArrowLeft': selection.move(0, -1, e.shiftKey); break;
      case 'PageDown': selection.move(page, 0, e.shiftKey); break;
      case 'PageUp': selection.move(-page, 0, e.shiftKey); break;
      case 'Home': mod ? selection.set(0, 0, e.shiftKey) : selection.set(selection.active?.r ?? 0, 0, e.shiftKey); break;
      case 'End': mod ? selection.set(source.rowCount - 1, cols.length - 1, e.shiftKey) : selection.set(selection.active?.r ?? 0, cols.length - 1, e.shiftKey); break;
      case 'a': case 'A':
        if (mod) selection.selectAll(); else handled = false;
        break;
      default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    if (selection.active) revealCell(selection.active.r, selection.active.c);
    layout();
    notify();
  });

  renderHeader();
  layout();

  return {
    el: scroller,
    selection,
    setColumns(c) { cols = c; selection.resize(source.rowCount, cols.length); renderHeader(); layout(); },
    setSource(s) { source = s; pin = undefined; selection.resize(s.rowCount, cols.length); scroller.scrollTop = 0; layout(); },
    refresh() { selection.resize(source.rowCount, cols.length); layout(); },
    selectAll() { selection.selectAll(); layout(); notify(); },
    goTo(r, c = 0) {
      if (source.rowCount === 0) return;
      selection.set(r, Math.min(c, Math.max(0, cols.length - 1)));
      const a = axis();
      if (a.scaled) {
        const nf = Math.max(0, Math.min(r - Math.floor(a.viewItems / 2), source.rowCount - 1));
        scroller.scrollTop = a.scrollFor(nf);
        pin = { scroll: scroller.scrollTop, first: nf };
      } else {
        scroller.scrollTop = Math.max(0, r * ROW_H - Math.floor(a.viewPx / 2));
      }
      revealCell(r, selection.active?.c ?? 0);
      layout();
      notify();
    },
    select(r, c = 0) {
      if (source.rowCount === 0) return;
      selection.set(r, Math.min(c, Math.max(0, cols.length - 1)));
      revealCell(r, selection.active?.c ?? 0);
      layout();
      notify();
    },
    setScrollTop(px) { scroller.scrollTop = px; },
    autoFit: (i) => fit(i),
    focus: () => scroller.focus(),
    destroy() {
      ro.disconnect();
      document.removeEventListener('mouseup', up);
      if (raf) cancelAnimationFrame(raf);
      scroller.remove();
    },
  };
}
