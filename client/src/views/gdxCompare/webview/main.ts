// SPDX-License-Identifier: GPL-3.0-or-later
// GDX compare webview (extension feature): symbol list with status badges and filter, two synchronized
// grids (A | B) built on the shared createGrid, next / previous difference, "only differences",
// attribute / column / tolerance / number-format menus, export buttons. Also shows the output file of
// gdxdiff (paired dif1/dif2/ins1/ins2 records) with the same widgets.
import { FormatOptions, localeSeparators } from '../../gdx/format';
import { DEFAULT_LAYOUT, LayoutState, sanitizeLayout } from '../../gdx/layout';
import { LruMap } from '../../gdx/pivot';
import { maxDisplayRecords } from '../../gdx/scrollmap';
import { DEFAULT_SYM_FORMAT, SymFormat, effectiveFormat } from '../../gdx/symview';
import { DisplayPrefs, sanitizeDisplayPrefs } from '../../gdx/prefs';
import { typeAsString } from '../../gdx/model';
import { el, icon, iconButton } from '../../gdx/webview/dom';
import { createGrid, Grid, GridColumn, GridRow, GridSource } from '../../gdx/webview/grid';
import { closeMenu, openMenu, OverflowToolbar } from '../../gdx/webview/menus';
import { SplitLayout } from '../../gdx/webview/splitter';
import { widthsFor } from '../../gdx/columns';
import {
  ALL_STATUSES, ATTR_LABELS, CompareOptions, CompareRecord, CompareSymbol, DEFAULT_COMPARE_OPTIONS, SYMBOL_STATUS_LABEL,
  SymbolStatus, isCancelled, mergeSymbols, pendingNames, fieldsFromFlags, filterSymbols, optionsChanged, parseTolerance, statusCounts, symbolSummary, toggleAttribute, valueColumns,
} from '../model';
import type { ToWebview } from '../protocol';
import { leftCells, leftHeaders, rightCells, rightHeaders, SideLayout } from '../view';
import { errText, isLimitError, rejectRpc, resolveRpc, rpc, send, vscodeApi } from './rpc';

const PAGE = 200;
const ROW_H = 22;

// ---- state ----
interface Persisted {
  v: 1;
  layout: LayoutState;
  opts: CompareOptions;
  attrs: boolean[];
  showAbs: boolean;
  showRel: boolean;
  onlyDiff: boolean;
  fmt: SymFormat;
  thousands: boolean;
  statuses: SymbolStatus[];
  selected?: string;
  widths: Record<string, number>;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function restore(raw: unknown): Persisted {
  const p: Persisted = {
    v: 1, layout: { ...DEFAULT_LAYOUT, symWidths: {} }, opts: { ...DEFAULT_COMPARE_OPTIONS }, attrs: [true, true, false, false, false],
    showAbs: true, showRel: true, onlyDiff: false, fmt: { ...DEFAULT_SYM_FORMAT }, thousands: false, statuses: [...ALL_STATUSES], widths: {},
  };
  if (!isObj(raw)) return p;
  p.layout = sanitizeLayout(raw.layout);
  if (isObj(raw.opts)) {
    const o = raw.opts;
    if (typeof o.eps === 'number' && o.eps >= 0) p.opts.eps = o.eps;
    if (typeof o.relEps === 'number' && o.relEps >= 0) p.opts.relEps = o.relEps;
    p.opts.ignoreSetText = o.ignoreSetText === true;
    p.opts.cmpDefaults = o.cmpDefaults === true;
    p.opts.cmpDomains = o.cmpDomains === true;
    if (Array.isArray(o.fields) && o.fields.every((f) => Number.isInteger(f) && f >= 0 && f < 5) && o.fields.length) p.opts.fields = o.fields as number[];
  }
  if (Array.isArray(raw.attrs) && raw.attrs.length === 5 && raw.attrs.some((a) => a === true)) p.attrs = raw.attrs.map((a) => a === true);
  p.showAbs = raw.showAbs !== false;
  p.showRel = raw.showRel !== false;
  p.onlyDiff = raw.onlyDiff === true;
  const prefs = sanitizeDisplayPrefs({ fmt: raw.fmt, thousands: raw.thousands });
  if (prefs) { p.fmt = prefs.fmt; p.thousands = prefs.thousands; }
  if (Array.isArray(raw.statuses)) p.statuses = raw.statuses.filter((s): s is SymbolStatus => (ALL_STATUSES as unknown[]).includes(s));
  // states saved before the `pending` status existed showed everything: keep showing the pending symbols
  if (Array.isArray(raw.statuses) && !raw.statuses.includes('pending') && ['different', 'onlyA', 'onlyB', 'equal', 'unknown'].every((x) => (raw.statuses as unknown[]).includes(x))) p.statuses.push('pending');
  if (typeof raw.selected === 'string') p.selected = raw.selected;
  if (isObj(raw.widths)) for (const [k, v] of Object.entries(raw.widths)) if (typeof v === 'number' && v >= 20 && v <= 2000) p.widths[k] = v;
  return p;
}

const fresh = vscodeApi.getState() === undefined;
const P = restore(vscodeApi.getState());

const S = {
  mode: 'files' as 'files' | 'diffFile',
  nameA: 'A',
  nameB: 'B',
  fileA: '',
  fileB: '',
  language: 'en',
  symbols: [] as CompareSymbol[],
  selected: undefined as CompareSymbol | undefined,
  filter: { text: '', statuses: new Set<SymbolStatus>(P.statuses) },
  loadError: '',
  loading: false,
  gen: 0,
  total: 0,
  rows: 0,
  differences: 0,
  pages: new LruMap<CompareRecord[]>(50),
  inflight: new Map<number, Promise<CompareRecord[] | undefined>>(),
  notice: '',
  pendingSelect: undefined as string | undefined,
};

function persist(): void {
  const st: Persisted = { ...P, statuses: [...S.filter.statuses], selected: S.selected?.name };
  vscodeApi.setState(st);
}
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const persistSoon = (): void => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 150);
};

function displayFormat(): FormatOptions {
  const f = { ...effectiveFormat(P.fmt) };
  if (!P.thousands) return f;
  const sep = localeSeparators(S.language);
  return { ...f, group: sep.group, decSep: sep.decimal };
}

const isDiffFile = (): boolean => S.mode === 'diffFile';

// ---- layout ----
const app = document.getElementById('app')!;
const splitRoot = el('div', 'split-root');
const symPane = el('div', 'pane symPane');
const dataPane = el('div', 'pane datapane');
const symBody = el('div', 'panebody');
const infoLine = el('div', 'infoline');
const noticeBox = el('div', 'notices');
const gridsWrap = el('div', 'cmpgrids');
const sideA = el('div', 'cmpside noscroll');
const sideB = el('div', 'cmpside');
const titleA = el('div', 'sidetitle');
const titleB = el('div', 'sidetitle');
const bodyA = el('div', 'sidebody');
const bodyB = el('div', 'sidebody');
sideA.append(titleA, bodyA);
sideB.append(titleB, bodyB);
gridsWrap.append(sideA, sideB);
const statusBar = el('div', 'statusbar');
const statusL = el('span', 'l');
const statusR = el('span', 'r');
statusBar.append(statusL, statusR);

let gridA: Grid | undefined;
let gridB: Grid | undefined;
let symGrid: Grid;
let shownSymbols: CompareSymbol[] = [];

const layout = (): SideLayout => ({
  sym: S.selected ?? { kind: 'Parameter', dim: 0, domain: [] },
  vcols: S.selected ? valueColumns(S.selected, P.attrs) : [],
  showAbs: P.showAbs,
  showRel: P.showRel,
});

// ---- symbol list ----
let silent = false;
const symTitle = el('span', 'title', 'Symbols');
const symFilterInput = el('input', 'symfilter');
symFilterInput.placeholder = 'Filter symbols (regex)';
symFilterInput.setAttribute('aria-label', 'Filter symbol names');
const statusFilterBtn = iconButton('filter', 'Show symbols by status');
const symBar = el('div', 'toolbar sym');
symBar.append(symTitle, symFilterInput, statusFilterBtn);
symPane.append(symBar, symBody);

const SYM_IDS = ['status', 'name', 'changed', 'added', 'removed', 'type'];
const SYM_TITLES = ['Status', 'Name', 'Changed', 'Added', 'Removed', 'Type'];
const SYM_DEFAULT = [86, 110, 70, 56, 66, 110];

function symRow(s: CompareSymbol): GridRow {
  const n = (v: number | null): string => (v === null || v === undefined ? '' : v.toLocaleString());
  const only = s.status === 'onlyA' || s.status === 'onlyB';
  return {
    cells: [SYMBOL_STATUS_LABEL[s.status], s.name, only ? '' : n(s.changed), n(s.added), n(s.removed), typeAsString({ kind: s.kind, subType: s.subType })],
    cls: [`st-${s.status}`, undefined, undefined, undefined, undefined, undefined],
  };
}

function symColumns(): GridColumn[] {
  const w = widthsFor(SYM_IDS, P.layout.symWidths, (id) => SYM_DEFAULT[SYM_IDS.indexOf(id)]);
  return SYM_IDS.map((id, i): GridColumn => ({
    id: `s_${id}`, title: SYM_TITLES[i], width: w[i], headerExtra: 8, align: i >= 2 && i <= 4 ? 'right' : 'left',
  }));
}

symGrid = createGrid(symBody, { rowCount: 0, row: () => undefined }, {
  rowSelect: true,
  onResize: (id, w, final) => { P.layout.symWidths[id.replace(/^s_/, '')] = w; if (final) persistSoon(); },
  onSelectionChange: (range) => {
    if (silent) return; // selection set by highlightSymbol
    const s = range ? shownSymbols[range.r0] : undefined;
    if (s && s !== S.selected) selectLater(s);
  },
  emptyText: () => (S.loading ? 'Comparing…' : S.loadError || (S.symbols.length ? 'No matching symbols.' : 'No symbols.')),
});
symGrid.setColumns(symColumns());

let selTimer: ReturnType<typeof setTimeout> | undefined;
function selectLater(s: CompareSymbol): void {
  if (selTimer) clearTimeout(selTimer);
  selTimer = setTimeout(() => selectSymbol(s), 90); // arrow-key repeat: load the symbol the user settles on
}

function renderSymbols(): void {
  shownSymbols = filterSymbols(S.symbols, S.filter);
  const rows = shownSymbols;
  symGrid.setColumns(symColumns());
  symGrid.setSource({ rowCount: rows.length, row: (r) => (rows[r] ? symRow(rows[r]) : undefined) });
  highlightSymbol();
  const c = statusCounts(S.symbols);
  symTitle.textContent = `Symbols (${S.symbols.length})`;
  symTitle.title = ALL_STATUSES.map((s) => `${SYMBOL_STATUS_LABEL[s]}: ${c[s]}`).join('\n');
  statusFilterBtn.classList.toggle('on', S.filter.statuses.size !== ALL_STATUSES.length);
}

function highlightSymbol(): void {
  const i = S.selected ? shownSymbols.findIndex((s) => s.name === S.selected!.name) : -1;
  silent = true;
  try {
    if (i >= 0) symGrid.goTo(i, 0); else { symGrid.selection.clear(); symGrid.refresh(); }
  } finally { silent = false; }
}

symFilterInput.oninput = () => { S.filter.text = symFilterInput.value; renderSymbols(); void resolveVisible(); };
statusFilterBtn.onclick = () => {
  const c = statusCounts(S.symbols);
  openMenu(statusFilterBtn, (m) => {
    for (const st of ALL_STATUSES) {
      m.item(`${SYMBOL_STATUS_LABEL[st]} (${c[st]})`, () => {
        if (S.filter.statuses.has(st)) S.filter.statuses.delete(st); else S.filter.statuses.add(st);
        renderSymbols();
        persistSoon();
      }, { checked: S.filter.statuses.has(st), keepOpen: true });
    }
  });
};

// ---- data grids ----
function pageOf(r: number): CompareRecord[] | undefined {
  return S.pages.get(Math.floor(r / PAGE));
}

function sourceFor(side: 'a' | 'b'): GridSource {
  return {
    get rowCount() { return Math.min(S.total, maxDisplayRecords(ROW_H)); },
    row(r: number): GridRow | undefined {
      const rec = pageOf(r)?.[r % PAGE];
      if (!rec) return undefined;
      return side === 'a' ? leftCells(layout(), rec, displayFormat()) : rightCells(layout(), rec, displayFormat());
    },
    prefetch(first: number, last: number): void {
      for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last - 1) / PAGE); p++) if (!S.pages.has(p)) void ensurePage(p);
    },
  };
}

function ensurePage(p: number): Promise<CompareRecord[] | undefined> {
  const cached = S.pages.get(p);
  if (cached) return Promise.resolve(cached);
  const inflight = S.inflight.get(p);
  if (inflight) return inflight;
  const sym = S.selected;
  if (!sym || S.loadError) return Promise.resolve(undefined);
  const g = S.gen;
  const prom = rpc('records', { name: sym.name, offset: p * PAGE, limit: PAGE, onlyDiff: P.onlyDiff, options: P.opts })
    .then((r) => {
      if (g !== S.gen) return undefined;
      S.pages.set(p, r.records);
      S.total = r.total;
      S.rows = r.rows;
      S.differences = r.differences;
      return r.records;
    })
    .catch((e: unknown) => {
      if (g !== S.gen) return undefined;
      S.loadError = errText(e);
      return undefined;
    })
    .finally(() => {
      if (g !== S.gen) return;
      S.inflight.delete(p);
      if (S.loadError) { buildGrids(); } else { gridA?.refresh(); gridB?.refresh(); }
      chrome();
    });
  S.inflight.set(p, prom);
  return prom;
}

function colsFor(headers: Array<{ id: string; title: string; align?: 'right' }>, side: 'a' | 'b'): GridColumn[] {
  const sym = S.selected;
  const defaults = (id: string): number => (id === 'mark' ? 30 : id.startsWith('k') ? 130 : sym && (sym.kind === 'Set') ? 220 : 110);
  const w = widthsFor(headers.map((h) => h.id), P.widths, defaults);
  void side;
  return headers.map((h, i): GridColumn => ({ id: h.id, title: h.title, tooltip: h.title, width: w[i], align: h.align, headerExtra: 8 }));
}

function destroyGrids(): void {
  gridA?.destroy();
  gridB?.destroy();
  gridA = undefined;
  gridB = undefined;
  bodyA.textContent = '';
  bodyB.textContent = '';
}

let syncing = false;
function linkScroll(a: Grid, b: Grid): void {
  const link = (from: Grid, to: Grid): void => {
    from.el.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      if (to.el.scrollTop !== from.el.scrollTop) to.el.scrollTop = from.el.scrollTop;
      syncing = false;
    });
  };
  link(a, b);
  link(b, a);
}

function buildGrids(): void {
  destroyGrids();
  const sym = S.selected;
  if (!sym) {
    bodyA.append(el('div', 'msg', S.loadError ? S.loadError : S.loading ? 'Comparing…' : 'Select a symbol in the symbol list.'));
    chrome();
    return;
  }
  if (S.loadError) {
    bodyA.append(el('div', 'msg err', S.loadError));
    chrome();
    return;
  }
  const l = layout();
  const opts = (side: 'a' | 'b') => ({
    rowHeight: ROW_H,
    onResize: (id: string, w: number, final: boolean) => { P.widths[id] = w; if (final) persistSoon(); },
    onSelectionChange: () => chrome(),
    onContextMenu: (e: MouseEvent) => cellMenu(e, side),
    emptyText: () => (S.mode === 'diffFile' ? 'No records.' : P.onlyDiff ? 'No differences.' : 'No records.'),
  });
  gridA = createGrid(bodyA, sourceFor('a'), opts('a'));
  gridB = createGrid(bodyB, sourceFor('b'), opts('b'));
  gridA.setColumns(colsFor(leftHeaders(l, S.nameA), 'a'));
  gridB.setColumns(colsFor(rightHeaders(l, S.nameB), 'b'));
  linkScroll(gridA, gridB);
  for (const g of [gridA, gridB]) g.el.addEventListener('keydown', onGridKey);
  S.pages.clear();
  S.inflight.clear();
  void ensurePage(0);
  chrome();
}

function selectSymbol(s: CompareSymbol, focus = false): void {
  S.selected = s;
  S.gen++;
  S.pages.clear();
  S.inflight.clear();
  S.loadError = '';
  S.total = P.onlyDiff ? (s.differences ?? 0) : (s.rows ?? 0);
  S.rows = s.rows ?? 0;
  S.differences = s.differences ?? 0;
  S.notice = s.mismatch ? `Symbol mismatch between the files: ${s.mismatch}. Records are not compared.` : s.note ? s.note.replace(/^\[limit\]\s*/, '') : '';
  if (s.note) S.loadError = S.notice;
  persistSoon();
  highlightSymbol();
  buildGrids();
  if (focus) gridA?.focus();
  if (s.status === 'pending') void resolveNames([s.name], -1);
}

// ---- lazy symbol statuses: the server merges only the symbols it is asked for ----
let bgGen = 0;
let computeId = 0;
let computing = false;
const VISIBLE_BATCH = 8;
const VISIBLE_MAX = 40;

function applySymbols(updates: CompareSymbol[]): void {
  S.symbols = mergeSymbols(S.symbols, updates);
  if (S.selected) {
    const cur = S.selected.name.toLowerCase();
    S.selected = S.symbols.find((x) => x.name.toLowerCase() === cur) ?? S.selected;
  }
  renderSymbols();
  chrome();
}

async function resolveNames(names: string[], gen: number): Promise<boolean> {
  try {
    const r = await rpc('symbols', { names, options: P.opts });
    if (gen >= 0 && gen !== bgGen) return false;
    applySymbols(r.symbols);
    return true;
  } catch {
    return false;
  }
}

/** Background: resolve the pending symbols of the first visible rows in small batches (selected symbol is handled on selection). */
async function resolveVisible(): Promise<void> {
  if (S.mode !== 'files') return;
  const gen = ++bgGen;
  const tried = new Set<string>();
  while (gen === bgGen && !computing) {
    const names = pendingNames(shownSymbols.slice(0, VISIBLE_MAX), VISIBLE_BATCH, tried);
    if (!names.length) break;
    for (const n of names) tried.add(n.toLowerCase());
    if (!(await resolveNames(names, gen))) break;
  }
}

/** "Compute all": exact statuses for every symbol; a second click cancels. */
async function computeAll(): Promise<void> {
  if (computing) { send({ type: 'cancel', reqId: computeId }); return; }
  computing = true;
  bgGen++;
  transient('Comparing all symbols… (click "Compute all" again to cancel)');
  chrome();
  try {
    const r = await rpc('symbols', { full: true, options: P.opts }, (id) => { computeId = id; });
    applySymbols(r.symbols);
    const left = r.symbols.filter((x) => x.status === 'pending').length;
    transient(r.truncated || left ? `Time limit reached: ${left} symbol(s) are still pending.` : 'All symbols compared');
  } catch (e) {
    transient(isCancelled(errText(e)) ? 'Cancelled' : errText(e));
  } finally {
    computing = false;
    chrome();
  }
}

// ---- difference navigation ----
async function gotoDifference(backward: boolean): Promise<void> {
  const s = S.selected;
  if (!s || !gridA || S.loadError) return;
  const cur = gridA.selection.active?.r ?? gridB?.selection.active?.r;
  try {
    let r = await rpc('next', { name: s.name, from: cur, backward, onlyDiff: P.onlyDiff, options: P.opts });
    if (r.index === null && r.differences > 0) {
      // wrap around
      r = await rpc('next', { name: s.name, from: undefined, backward, onlyDiff: P.onlyDiff, options: P.opts });
      if (r.index !== null) transient('Wrapped around');
    }
    if (r.index === null) { transient('No differences'); return; }
    gridA.goTo(r.index, 0);
    gridB?.goTo(r.index, 0);
    gridA.focus();
  } catch (e) {
    transient(errText(e));
  }
}

let transientText = '';
let transientTimer: ReturnType<typeof setTimeout> | undefined;
function transient(msg: string): void {
  transientText = msg;
  if (transientTimer) clearTimeout(transientTimer);
  transientTimer = setTimeout(() => { transientText = ''; chrome(); }, 4000);
  chrome();
}

function onGridKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    copySelection(e.target === gridB?.el ? 'b' : 'a');
  }
}

function copySelection(side: 'a' | 'b'): void {
  const g = side === 'a' ? gridA : gridB;
  const range = g?.selection.range();
  if (!g || !range) return;
  const src = sourceFor(side);
  const lines: string[] = [];
  for (let r = range.r0; r <= range.r1; r++) {
    const row = src.row(r);
    if (!row) continue;
    lines.push(row.cells.slice(range.c0, range.c1 + 1).join('\t'));
  }
  send({ type: 'clipboard', text: lines.join('\n') });
  transient(`Copied ${lines.length} row(s)`);
}

function cellMenu(e: MouseEvent, side: 'a' | 'b'): void {
  openMenu({ x: e.clientX, y: e.clientY }, (m) => {
    m.item('Copy (tab-separated)', () => copySelection(side), { shortcut: 'Ctrl+C' });
    m.sep();
    m.item('Next difference', () => void gotoDifference(false), { shortcut: 'F7' });
    m.item('Previous difference', () => void gotoDifference(true), { shortcut: 'Shift+F7' });
  });
}

// ---- toolbar ----
const tb = new OverflowToolbar();
const btn = (ic: string, title: string, run: (a: HTMLElement) => void, label?: string, pinned = false): HTMLButtonElement => {
  const b = iconButton(ic, title, undefined, label);
  tb.add({ el: b, label: title, run, pinned });
  return b;
};
const dropdown = (ic: string, title: string, label: string, run: (a: HTMLElement) => void): HTMLButtonElement => {
  const b = btn(ic, title, run, label);
  b.append(icon('down'));
  b.setAttribute('aria-haspopup', 'menu');
  return b;
};
const sep = (): void => tb.add({ el: el('span', 'vsep'), label: '', run: () => undefined, decoration: true });

const bPanel = btn('panel', 'Show / hide the symbol list', () => { P.layout.collapsed = !P.layout.collapsed; split.apply(); persistSoon(); chrome(); }, undefined, true);
sep();
const bPrev = btn('up', 'Previous difference (Shift+F7)', () => void gotoDifference(true), 'Prev');
const bNext = btn('down', 'Next difference (F7)', () => void gotoDifference(false), 'Next');
const bOnly = btn('diff', 'Show only the rows that differ', () => {
  P.onlyDiff = !P.onlyDiff;
  persistSoon();
  if (S.selected) selectSymbol(S.selected);
}, 'Only differences', true);
sep();
dropdown('columns', 'Choose the variable / equation attributes', 'Attributes', (a) => openAttributes(a));
dropdown('table', 'Show difference columns', 'Columns', (a) => openColumns(a));
const bOpts = dropdown('prefs', 'Comparison options: tolerances, set text, compared fields', 'Options', (a) => openOptions(a));
dropdown('prefs', 'Number format preferences', 'Format', (a) => openFormat(a));
sep();
btn('export', 'Export the comparison to CSV (a file, or a folder for several symbols)', () => doExport('csv'), 'CSV');
btn('export', 'Export the comparison to Excel (summary + one sheet per symbol)', () => doExport('xlsx'), 'Excel');
sep();
const bSwap = btn('swap', 'Swap A and B', () => send({ type: 'swap' }), 'Swap');
const bRaw = btn('raw', 'Show the raw GDX data in the GDX viewer', () => send({ type: 'openRaw' }), 'Raw view');
btn('fit', 'Auto resize columns', () => { gridA?.autoFit(); gridB?.autoFit(); });
btn('diff', 'Compare all symbols now (exact status for every symbol; click again to cancel)', () => void computeAll(), 'Compute all');
btn('reload', 'Compare again', () => void load(), 'Reload');

function doExport(format: 'csv' | 'xlsx'): void {
  send({
    type: 'export', format, current: S.selected?.name, options: P.opts, attrs: P.attrs, diffColumns: P.showAbs || P.showRel, onlyDiff: P.onlyDiff,
  });
}

function openAttributes(anchor: HTMLElement): void {
  const s = S.selected;
  openMenu(anchor, (m) => {
    if (!s || (s.kind !== 'Variable' && s.kind !== 'Equation')) { m.item('Only variables and equations have attributes', () => undefined, { disabled: true }); return; }
    const rows: HTMLElement[] = [];
    const refresh = (): void => rows.forEach((r, i) => { r.querySelector('.mchk')!.textContent = P.attrs[i] ? '✓' : ''; });
    ATTR_LABELS.forEach((n, i) => {
      rows.push(m.item(n, () => { P.attrs = toggleAttribute(P.attrs, i); refresh(); persistSoon(); buildGrids(); }, { checked: P.attrs[i], keepOpen: true }));
    });
  });
}

function openColumns(anchor: HTMLElement): void {
  openMenu(anchor, (m) => {
    m.item('Absolute difference (B − A)', () => { P.showAbs = !P.showAbs; persistSoon(); buildGrids(); }, { checked: P.showAbs });
    m.item('Relative difference (B − A) / |A|', () => { P.showRel = !P.showRel; persistSoon(); buildGrids(); }, { checked: P.showRel });
  });
}

function openFormat(anchor: HTMLElement): void {
  openMenu(anchor, (m) => {
    const box = el('div', 'prefs');
    const f = P.fmt;
    const fmt = el('select');
    for (const [v, t] of [['g', 'g-format'], ['f', 'f-format'], ['e', 'e-format']]) { const o = el('option', undefined, t); o.value = v; fmt.append(o); }
    fmt.value = f.format;
    const prec = el('input');
    prec.type = 'number';
    prec.min = '0';
    const syncPrec = (): void => { prec.max = f.format === 'f' ? '14' : '17'; prec.value = String(f.precision); };
    syncPrec();
    const sq = el('input'); sq.type = 'checkbox'; sq.checked = f.squeeze;
    const th = el('input'); th.type = 'checkbox'; th.checked = P.thousands;
    const line = (label: string, ctl: HTMLElement): HTMLElement => { const r = el('div', 'prow2'); r.append(el('span', 'plabel2', label), ctl); return r; };
    const row = (label: string, ctl: HTMLElement): HTMLElement => { const r = el('label', 'prow2'); r.append(ctl, label); return r; };
    const changed = (): void => {
      persistSoon();
      send({ type: 'prefs', prefs: { thousands: P.thousands, fmt: { ...P.fmt } } satisfies DisplayPrefs });
      gridA?.refresh();
      gridB?.refresh();
    };
    fmt.onchange = () => { f.format = fmt.value as 'g' | 'f' | 'e'; f.precision = Math.min(f.precision, f.format === 'f' ? 14 : 17); syncPrec(); changed(); };
    prec.onchange = () => { f.precision = Math.max(0, Math.min(f.format === 'f' ? 14 : 17, Math.round(Number(prec.value) || 0))); syncPrec(); changed(); };
    sq.onchange = () => { f.squeeze = sq.checked; changed(); };
    th.onchange = () => { P.thousands = th.checked; changed(); };
    box.append(line('Format', fmt), line('Precision', prec), row('Squeeze Trailing Zeroes', sq), row('Thousands separator', th));
    m.widget(box);
  });
}

function openOptions(anchor: HTMLElement): void {
  openMenu(anchor, (m) => {
    if (isDiffFile()) { m.item('The options were fixed when gdxdiff ran', () => undefined, { disabled: true }); return; }
    const box = el('div', 'optgrid');
    const eps = el('input'); eps.type = 'text'; eps.value = P.opts.eps ? String(P.opts.eps) : '';
    eps.placeholder = '0';
    eps.title = 'Absolute tolerance: values with |A − B| <= Eps are equal (gdxdiff Eps)';
    const rel = el('input'); rel.type = 'text'; rel.value = P.opts.relEps ? String(P.opts.relEps) : '';
    rel.placeholder = '0';
    rel.title = 'Relative tolerance: |A − B| / (1 + min(|A|, |B|)) <= RelEps is equal (gdxdiff RelEps)';
    const ign = el('input'); ign.type = 'checkbox'; ign.checked = P.opts.ignoreSetText;
    ign.title = 'Do not compare the explanatory text of set elements (gdxdiff SetDesc=0)';
    const cdef = el('input'); cdef.type = 'checkbox'; cdef.checked = P.opts.cmpDefaults;
    cdef.title = 'A parameter or variable record that exists in one file only counts as a difference even if it equals the default (0 / the default of the variable type). Off: it is ignored (gdxdiff CmpDefaults)';
    const cdom = el('input'); cdom.type = 'checkbox'; cdom.checked = P.opts.cmpDomains;
    cdom.title = 'Symbols whose domains differ are different; their records are not compared (gdxdiff CmpDomains)';
    const flags = [0, 1, 2, 3, 4].map((i) => { const c = el('input'); c.type = 'checkbox'; c.checked = P.opts.fields.includes(i); return c; });
    const err = el('div', 'err');
    box.append(el('span', undefined, 'Eps'), eps, el('span', undefined, 'RelEps'), rel, el('span', undefined, 'Set text'), (() => { const l = el('label'); l.append(ign, 'ignore'); return l; })(),
      el('span', undefined, 'Defaults'), (() => { const l = el('label'); l.append(cdef, 'compare'); return l; })(),
      el('span', undefined, 'Domains'), (() => { const l = el('label'); l.append(cdom, 'compare'); return l; })());
    const fl = el('div', 'prefs');
    fl.append(el('div', 'plabel', 'Variable / equation fields that decide a difference'));
    flags.forEach((c, i) => { const l = el('label', 'prow2'); l.append(c, ATTR_LABELS[i]); fl.append(l); });
    const apply = el('button', undefined, 'Apply');
    apply.onclick = () => {
      const e = parseTolerance(eps.value);
      const r = parseTolerance(rel.value);
      if (e === null || r === null) { err.textContent = 'Eps and RelEps must be numbers >= 0.'; return; }
      P.opts = { eps: e, relEps: r, ignoreSetText: ign.checked, fields: fieldsFromFlags(flags.map((c) => c.checked)), cmpDefaults: cdef.checked, cmpDomains: cdom.checked };
      closeMenu();
      persistSoon();
      void load();
    };
    const wrap = el('div', 'prefs');
    wrap.append(box, fl, err, apply);
    m.widget(wrap);
  });
}

// ---- chrome ----
function chrome(): void {
  const s = S.selected;
  bOnly.classList.toggle('on', P.onlyDiff);
  bOnly.setAttribute('aria-pressed', String(P.onlyDiff));
  bPanel.classList.toggle('on', !P.layout.collapsed);
  bPrev.disabled = bNext.disabled = !s || !!S.loadError || (S.differences === 0 && !s.differences);
  bSwap.hidden = isDiffFile();
  bRaw.hidden = !isDiffFile();
  bOpts.disabled = isDiffFile();
  bOpts.classList.toggle('on', optionsChanged(P.opts));
  tb.schedule();

  titleA.textContent = isDiffFile() ? `${S.nameA} (first file)` : `A: ${S.nameA}`;
  titleA.title = S.fileA;
  titleB.textContent = isDiffFile() ? `${S.nameB} (second file)` : `B: ${S.nameB}`;
  titleB.title = isDiffFile() ? S.fileB : S.fileB;

  infoLine.textContent = '';
  if (s) {
    const type = typeAsString({ kind: s.kind, subType: s.subType });
    infoLine.append(el('b', 'nm', s.name), el('span', 'dim', `${type} · ${s.dim}-dim`));
    const sum = el('span', 'legend2');
    const chip = (cls: string, text: string): void => { sum.append(el('span', `chip2 ${cls}`, text)); };
    if (s.changed) chip('cf-changed', `${s.changed.toLocaleString()} changed`);
    if (s.added) chip('cf-added', `${s.added.toLocaleString()} added`);
    if (s.removed) chip('cf-removed', `${s.removed.toLocaleString()} removed`);
    if (!s.changed && !s.added && !s.removed) sum.append(el('span', 'dim', symbolSummary(s)));
    infoLine.append(sum);
    if (s.text) { const t = el('span', 'desc', s.text); t.title = s.text; infoLine.append(t); }
    infoLine.title = `${s.name}: ${symbolSummary(s)}`;
  }
  infoLine.hidden = !s;

  noticeBox.textContent = '';
  if (S.notice && !S.loadError) {
    const n = el('div', 'notice warn');
    n.append(el('span', undefined, S.notice));
    noticeBox.append(n);
  }
  if (S.total > maxDisplayRecords(ROW_H)) {
    const n = el('div', 'notice warn');
    n.append(el('span', undefined, `Only the first ${maxDisplayRecords(ROW_H).toLocaleString()} rows can be displayed; export to see all of them.`));
    noticeBox.append(n);
  }

  const range = gridA?.selection.range() ?? gridB?.selection.range();
  statusL.textContent = transientText || (s && !S.loadError
    ? `${S.total.toLocaleString()} row${S.total === 1 ? '' : 's'}${P.onlyDiff ? ' (differences only)' : S.rows !== S.total ? ` of ${S.rows.toLocaleString()}` : ''} · ${S.differences.toLocaleString()} difference${S.differences === 1 ? '' : 's'}`
    : '');
  statusL.title = statusL.textContent;
  statusR.textContent = range ? `row ${(range.r0 + 1).toLocaleString()}` : '';
}

// ---- loading ----
async function load(): Promise<void> {
  S.loading = true;
  S.loadError = '';
  S.gen++;
  bgGen++;
  renderSymbols();
  try {
    const r = await rpc('symbols', { options: P.opts });
    if (r.fileA !== undefined) { S.nameA = r.fileA; S.nameB = r.fileB ?? 'B'; S.fileA = r.fileA; S.fileB = r.fileB ?? ''; }
    S.symbols = r.symbols;
    S.loading = false;
    renderSymbols();
    const want = S.pendingSelect ?? S.selected?.name ?? P.selected;
    S.pendingSelect = undefined;
    const found = (want ? S.symbols.find((s) => s.name.toLowerCase() === want.toLowerCase()) : undefined)
      ?? S.symbols.find((s) => s.status === 'different') ?? S.symbols.find((s) => s.status === 'pending') ?? S.symbols[0];
    if (found) selectSymbol(found); else { S.selected = undefined; buildGrids(); }
    void resolveVisible();
  } catch (e) {
    S.loading = false;
    S.symbols = [];
    S.selected = undefined;
    S.loadError = isLimitError(errText(e)) ? errText(e).replace(/^\[limit\]\s*/, '') : errText(e);
    renderSymbols();
    buildGrids();
  }
}

// ---- assemble ----
const toolbarWrap = tb.el;
dataPane.append(toolbarWrap, infoLine, noticeBox, gridsWrap, statusBar);
app.append(splitRoot);
const split = new SplitLayout(splitRoot, symPane, dataPane, () => P.layout, (final) => {
  if (final) persistSoon();
  chrome();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'F7') { e.preventDefault(); void gotoDifference(e.shiftKey); }
});

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      S.mode = m.mode;
      S.fileA = m.fileA;
      S.fileB = m.fileB;
      S.nameA = m.nameA;
      S.nameB = m.nameB;
      S.language = m.language || 'en';
      if (m.prefs && fresh) { P.fmt = { ...m.prefs.fmt }; P.thousands = m.prefs.thousands; }
      if (m.initialSymbol) S.pendingSelect = m.initialSymbol;
      split.apply();
      chrome();
      void load();
      break;
    case 'reload': void load(); break;
    case 'select': {
      const t = S.symbols.find((s) => s.name.toLowerCase() === m.name.toLowerCase());
      if (t) selectSymbol(t, true); else S.pendingSelect = m.name;
      break;
    }
    case 'rpcResult': resolveRpc(m.reqId, m.result); break;
    case 'rpcError': rejectRpc(m.reqId, m.message); break;
  }
});

split.apply();
renderSymbols();
buildGrids();
send({ type: 'ready' });
