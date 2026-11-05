// SPDX-License-Identifier: GPL-3.0-or-later
// Symbol table (Studio GdxSymbolTableModel / GdxSymbolTableView): sortable, filterable, resizable
// columns; Up/Down select the symbol, Enter moves to the data, typing selects by name prefix.
import { fitWidth, widthsFor } from '../columns';
import { GdxSymbolInfo, makeTextFilter, typeAsString } from '../model';
import { el, iconButton, textMeasurer } from './dom';
import { createGrid, Grid, GridColumn, GridRow } from './grid';
import { hooks, S } from './state';

const COLS = ['Entry', 'Name', 'Type', 'Dim', 'Records', 'Text'];
const IDS = ['entry', 'name', 'type', 'dim', 'records', 'text'];
const DEFAULT_W = [56, 110, 124, 46, 84, 300];

function keyOf(s: GdxSymbolInfo, col: number): number | string {
  switch (col) {
    case 0: return s.index;
    case 1: return s.name.toLowerCase();
    case 2: return typeAsString(s).toLowerCase();
    case 3: return s.dim;
    case 4: return s.records;
    default: return s.text.toLowerCase();
  }
}

export class SymbolPanel {
  readonly el = el('div', 'pane symPane');
  readonly title = el('span', 'title', 'GDX');
  readonly filter = el('input');
  private readonly body = el('div', 'panebody');
  private grid!: Grid;
  private shown: GdxSymbolInfo[] = [];
  private sort = { col: 1, asc: true };
  private filterText = '';
  private typed = '';
  private typedTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private silent = false;
  private message = '';

  constructor() {
    const bar = el('div', 'toolbar sym');
    this.filter.placeholder = 'Filter symbols (regex)';
    this.filter.setAttribute('aria-label', 'Filter symbol names');
    this.filter.oninput = () => { this.filterText = this.filter.value; this.render(); };
    const reload = iconButton('reload', 'Reload the GDX file', () => hooks.reloadFile());
    this.title.title = 'GDX file';
    bar.append(this.title, this.filter, reload);
    this.el.append(bar, this.body);
    this.grid = createGrid(this.body, this.source(), {
      rowSelect: true,
      onResize: (id, w, final) => { S.layout.symWidths[id] = w; if (final) hooks.persist(); },
      onSelectionChange: (range) => this.onSelect(range?.r0),
      emptyText: () => this.message || (S.symbols.length ? 'No matching symbols.' : 'No symbols.'),
    });
    this.grid.el.addEventListener('keydown', (e) => this.onKey(e));
    this.grid.setColumns(this.columns());
  }

  private source() {
    return {
      get rowCount() { return 0; },
      row: (_r: number): GridRow | undefined => undefined,
    };
  }

  private rowSource() {
    const shown = this.shown;
    return {
      rowCount: shown.length,
      row: (r: number): GridRow | undefined => {
        const s = shown[r];
        return s ? { cells: [String(s.index), s.name, typeAsString(s), String(s.dim), s.records.toLocaleString(), s.text] } : undefined;
      },
    };
  }

  private columns(): GridColumn[] {
    const w = widthsFor(IDS, S.layout.symWidths, (id) => DEFAULT_W[IDS.indexOf(id)]);
    return COLS.map((t, i): GridColumn => ({
      id: IDS[i], width: w[i], title: t + (this.sort.col === i ? (this.sort.asc ? ' ▲' : ' ▼') : ''), tooltip: t, headerExtra: 16,
      align: i === 0 || i === 3 || i === 4 ? 'right' : 'left',
      onClick: () => { this.sort = { col: i, asc: this.sort.col === i ? !this.sort.asc : true }; this.render(); },
    }));
  }

  setError(msg: string): void {
    this.message = msg;
    this.shown = [];
    this.grid.setSource(this.rowSource());
  }

  /** Rebuild the list from S.symbols (after load, filter or sort changes) and keep the selection. */
  render(): void {
    this.message = '';
    const filt = makeTextFilter(this.filterText);
    this.shown = S.symbols.filter((s) => !filt || filt(s.name));
    this.shown.sort((a, b) => {
      const x = keyOf(a, this.sort.col);
      const y = keyOf(b, this.sort.col);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return this.sort.asc ? c : -c;
    });
    this.grid.setColumns(this.columns());
    this.grid.setSource(this.rowSource());
    this.highlight();
  }

  /** Show `S.selected` as the selected row (no selection event). */
  highlight(): void {
    const i = S.selected ? this.shown.findIndex((s) => s.index === S.selected!.index) : -1;
    this.silent = true;
    try {
      // only scroll when the row is off-screen: re-centering on every click made the list jump
      if (i >= 0) this.grid.select(i, 0); else this.grid.selection.clear();
      if (i < 0) this.grid.refresh();
    } finally { this.silent = false; }
  }

  focusList(): void {
    this.grid.focus();
  }

  fitColumns(): void {
    const m = textMeasurer(this.grid.el);
    COLS.forEach((c, i) => {
      const texts = this.shown.slice(0, 500).map((s) => this.rowSource().row(this.shown.indexOf(s))?.cells[i] ?? '');
      S.layout.symWidths[IDS[i]] = fitWidth(c, texts, m, { headerExtra: 16, padding: 16 });
    });
    this.grid.setColumns(this.columns());
    hooks.persist();
  }

  private onSelect(row: number | undefined): void {
    if (this.silent || row === undefined) return;
    const s = this.shown[row];
    if (!s || s.index === S.selected?.index) return;
    if (this.pending) clearTimeout(this.pending);
    // arrow-key repeat: only load the symbol the user settles on
    this.pending = setTimeout(() => hooks.selectSymbol(s, true), 90);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const s = this.shown[this.grid.selection.active?.r ?? -1];
      if (s) { if (this.pending) clearTimeout(this.pending); hooks.selectSymbol(s, true); }
      hooks.focusData();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === ' ') return;
    // type-to-select: jump to the next symbol whose name starts with the typed prefix
    this.typed += e.key.toLowerCase();
    if (this.typedTimer) clearTimeout(this.typedTimer);
    this.typedTimer = setTimeout(() => { this.typed = ''; }, 900);
    const start = Math.max(0, this.grid.selection.active?.r ?? 0);
    const order = [...this.shown.keys()].map((k) => (start + (this.typed.length > 1 ? 0 : 1) + k) % Math.max(1, this.shown.length));
    const hit = order.find((i) => this.shown[i]?.name.toLowerCase().startsWith(this.typed));
    if (hit !== undefined) { this.grid.goTo(hit, 0); e.preventDefault(); }
  }
}
