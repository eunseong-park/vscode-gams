// SPDX-License-Identifier: GPL-3.0-or-later
// GDX viewer webview entry: assembles the panels (symbol table | splitter | data panel with toolbar,
// symbol info, search bar, list / table / chart view), routes messages and keyboard shortcuts.
// Behaviour follows Studio's GdxViewer / GdxSymbolView (see docs/dev/sources.md); the heavy lifting lives
// in the sibling modules (grid, pivotGrid, listView, tableView, chartView, ...).
import { clipboardText } from '../copy';
import { emptyFilters } from '../query';
import { domainTargets } from '../nav';
import type { ToWebview } from '../protocol';
import type { GdxSymbolInfo } from '../model';
import { detectGdxDiff } from '../../gdxCompare/model';
import { canChart, canTable, defaultSymView, hasAttributes, resetSymView, sanitizeState, ViewMode } from '../symview';
import { disposeChart, mountChart, renderChartBar } from './chartView';
import { el } from './dom';
import { closePopup, labelsCache, openLabelFilter, openValueFilter } from './filters';
import { onBrowsed, onExportDefaults, openExportDialog, setHeaderRowDefault } from './exportDialog';
import { InfoLine } from './infoLine';
import { list, listCopyRange, mountList, resetList, refreshListColumns, displayRows } from './listView';
import { closeMenu, openMenu } from './menus';
import { rejectRpc, errText, resolveRpc, rpc, send, vscodeApi } from './rpc';
import { cancelSearch, SearchBar, searchNext } from './searchBar';
import { SplitLayout } from './splitter';
import { hooks, persistNow, S, setNotice, valueCols, viewFor, queryParams } from './state';
import { SymbolPanel } from './symbolPanel';
import { mountTable, renderPivotBar, resetTable, table, tableCopy } from './tableView';
import { Toolbar } from './toolbar';
import type { DefaultsResult } from '../protocol';

// ---- layout ----
const app = document.getElementById('app')!;
const splitRoot = el('div', 'split-root');
const symbolPanel = new SymbolPanel();
const dataPane = el('div', 'pane datapane');
const infoLine = new InfoLine();
const searchBar = new SearchBar();
const headerGroup = el('div');
const optBar = el('div', 'optbar');
const noticeBox = el('div', 'notices');
const viewBody = el('div', 'viewbody');
const statusBar = el('div', 'statusbar');
const statusL = el('span', 'l');
const statusR = el('span', 'r');
statusBar.append(statusL, statusR);
headerGroup.append(infoLine.el, searchBar.el);

let split!: SplitLayout;
let toolbar!: Toolbar;
let transient = '';
let transientTimer: ReturnType<typeof setTimeout> | undefined;
let reloading = false;
/** symbol requested by `gams.openGdxSymbol` before the symbol list arrived */
let pendingSelect: string | undefined;

// ---- state persistence ----
let persistTimer: ReturnType<typeof setTimeout> | undefined;
hooks.persist = () => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 150);
};

hooks.status = (msg) => {
  transient = msg;
  if (transientTimer) clearTimeout(transientTimer);
  transientTimer = setTimeout(() => { transient = ''; updateStatus(); }, 4000);
  updateStatus();
};

// ---- chrome (toolbar state, info line, notices, status) ----
function selectionSummary(): string {
  const g = S.view.mode === 'table' ? table.grid : S.view.mode === 'list' ? list.grid : undefined;
  const r = g?.selection.range();
  if (!r) return '';
  const rows = r.r1 - r.r0 + 1;
  const cols = r.c1 - r.c0 + 1;
  return rows * cols > 1 ? `${rows.toLocaleString()} × ${cols.toLocaleString()} cells selected` : `row ${(r.r0 + 1).toLocaleString()}, column ${r.c0 + 1}`;
}

function updateStatus(): void {
  const s = S.selected;
  if (!s) { statusL.textContent = ''; statusR.textContent = ''; return; }
  let t: string;
  if (S.view.mode === 'table') t = `${table.rowCount.toLocaleString()} rows × ${table.colCount.toLocaleString()} columns`;
  else if (S.view.mode === 'chart') t = '';
  else {
    t = `${list.total.toLocaleString()} records`;
    if (list.total !== list.unfiltered) t += ` shown of ${list.unfiltered.toLocaleString()}`;
  }
  statusL.textContent = transient || t;
  statusL.title = statusL.textContent;
  statusR.textContent = selectionSummary();
}

function renderNotices(): void {
  noticeBox.textContent = '';
  for (const [key, text] of S.notices) {
    const n = el('div', 'notice' + (key === 'reloaded' ? '' : ' warn'));
    const sp = el('span', undefined, text);
    sp.title = text;
    const x = el('button', undefined, '×');
    x.title = 'Dismiss';
    x.setAttribute('aria-label', 'Dismiss');
    x.onclick = () => { setNotice(key, ''); renderNotices(); };
    if (key === 'diffview') {
      const open = el('button', undefined, 'Open colored diff view');
      open.title = 'Pairs the dif1 / dif2 / ins1 / ins2 records and colors the differences (the raw data stays available)';
      open.onclick = () => send({ type: 'openDiffView' });
      n.append(sp, open, x);
    } else n.append(sp, x);
    noticeBox.append(n);
  }
}

hooks.chrome = () => {
  const s = S.selected;
  headerGroup.hidden = S.layout.headerHidden;
  infoLine.update();
  infoLine.el.hidden = !s;
  toolbar.update(split.effectiveOrientation === 'horizontal');
  symbolPanel.title.textContent = S.fileName;
  symbolPanel.title.title = S.fileName;
  optBar.hidden = !s || (S.view.mode === 'list');
  renderNotices();
  updateStatus();
};

// ---- view area ----
function renderView(): void {
  closePopup();
  closeMenu();
  cancelSearch();
  list.grid?.destroy();
  table.grid?.destroy();
  list.grid = undefined;
  table.grid = undefined;
  disposeChart();
  viewBody.textContent = '';
  optBar.textContent = '';
  const s = S.selected;
  if (!s) {
    viewBody.append(S.loadError ? el('div', 'msg err', S.loadError) : el('div', 'msg', 'Select a symbol in the symbol table.'));
    hooks.chrome();
    return;
  }
  if (S.loadError) viewBody.append(el('div', 'msg err', S.loadError));
  const mode = S.view.mode;
  optBar.className = mode === 'table' ? 'optbar pivotbar' : 'optbar';
  if (mode === 'table') { mountTable(viewBody); renderPivotBar(optBar); resetTable(); }
  else if (mode === 'chart') { if (!S.loadError) { renderChartBar(optBar); mountChart(viewBody); } }
  else { mountList(viewBody); resetList(); void ensureDefaults(); }
  hooks.chrome();
}
hooks.rebuild = renderView;

hooks.limitHit = (msg) => {
  // sorting / filtering / pivoting the whole symbol exceeded the server's memory guard: fall back to plain paging
  S.view.sort = undefined;
  S.view.filters = emptyFilters();
  setNotice('limit', msg.replace(/^\[limit\]\s*/, ''));
  if (S.view.mode !== 'list') S.view.mode = 'list';
  hooks.persist();
  setTimeout(renderView, 0);
};

/** "Squeeze Defaults" needs to know which value columns hold only defaults (server-side scan). */
async function ensureDefaults(): Promise<void> {
  const s = S.selected;
  if (!s || !S.view.squeezeDefaults || !hasAttributes(s) || S.allDefault.has(s.index)) return;
  try {
    const r = await rpc<DefaultsResult>('defaults', { symbolIndex: s.index });
    S.allDefault.set(s.index, r.allDefault.length === 5 ? r.allDefault : null);
  } catch (e) {
    S.allDefault.set(s.index, null);
    setNotice('defaults', `Squeeze Defaults unavailable: ${errText(e).replace(/^\[limit\]\s*/, '')}`);
  }
  if (S.selected === s && S.view.mode === 'list' && list.grid) { refreshListColumns(); list.grid.refresh(); }
  hooks.chrome();
}

// ---- symbol selection ----
function selectSymbol(s: GdxSymbolInfo, record = false): void {
  S.selected = s;
  S.view = viewFor(s);
  if (S.view.mode === 'table' && !canTable(s)) S.view.mode = 'list';
  if (S.view.mode === 'chart' && !canChart(s)) S.view.mode = 'list';
  if (record) S.history.push(s.name);
  setNotice('limit', '');
  setNotice('defaults', '');
  setNotice('chart', '');
  S.loadError = '';
  hooks.persist();
  symbolPanel.highlight();
  renderView();
}
hooks.selectSymbol = selectSymbol;

function navigate(name: string | undefined): void {
  const s = name ? S.symbols.find((x) => x.name === name) : undefined;
  if (s) selectSymbol(s, false);
}

// ---- copy ----
async function copySelection(sep: ',' | '\t', labels = true): Promise<void> {
  const s = S.selected;
  const mode = S.view.mode;
  const range = (mode === 'table' ? table.grid : list.grid)?.selection.range();
  if (!s || (mode !== 'list' && mode !== 'table')) return;
  if (!range) { hooks.status('Select cells first (click / drag / shift-click).'); return; }
  try {
    const rows = mode === 'list' ? await listCopyRange(range) : await tableCopy(range, labels);
    if (!rows) return;
    send({ type: 'clipboard', text: clipboardText(rows, sep) });
    hooks.status(`Copied ${rows.length.toLocaleString()} row(s)`);
  } catch (e) {
    hooks.status(errText(e));
  }
}

function autoResize(): void {
  if (S.view.mode === 'list') list.grid?.autoFit();
  else if (S.view.mode === 'table') table.grid?.autoFit();
}

function selectAll(): void {
  if (S.view.mode === 'list') list.grid?.selectAll();
  else if (S.view.mode === 'table') table.grid?.selectAll();
}

function goToRow(): void {
  const anchor = toolbar.tb.el;
  const count = S.view.mode === 'table' ? table.rowCount : displayRows();
  if (S.view.mode === 'chart' || count === 0) return;
  openMenu(anchor, (m) => {
    const box = el('div', 'prefs');
    const inp = el('input');
    inp.type = 'number';
    inp.min = '1';
    inp.max = String(count);
    inp.placeholder = `1 – ${count.toLocaleString()}`;
    inp.setAttribute('aria-label', 'Row number');
    inp.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const n = Math.min(count, Math.max(1, Math.floor(Number(inp.value) || 1)));
      m.close();
      (S.view.mode === 'table' ? table.grid : list.grid)?.goTo(n - 1, 0);
    };
    box.append(el('span', undefined, 'Go to row'), inp);
    m.widget(box);
    setTimeout(() => inp.focus(), 0);
  });
}

hooks.cellMenu = (e, _cell) => {
  openMenu({ x: e.clientX, y: e.clientY }, (m) => {
    m.item('Copy (comma-separated)', () => void copySelection(','), { shortcut: 'Ctrl+C' });
    m.item('Copy (tab-separated)', () => void copySelection('\t'), { shortcut: 'Ctrl+Shift+C' });
    if (S.view.mode === 'table') {
      m.item('Copy Without Labels (comma-separated)', () => void copySelection(',', false));
      m.item('Copy Without Labels (tab-separated)', () => void copySelection('\t', false));
    }
    m.sep();
    m.item('Auto Resize Columns', autoResize, { shortcut: 'Ctrl+R' });
    m.item('Select All', selectAll, { shortcut: 'Ctrl+A' });
    m.item('Go to row…', goToRow, { shortcut: 'Ctrl+G' });
  });
};

hooks.headerMenu = (e, dim) => {
  const s = S.selected;
  if (!s) return;
  const target = domainTargets(s, S.symbols)[dim];
  openMenu({ x: e.clientX, y: e.clientY }, (m) => {
    m.item(target ? `Go to domain set ${target.name}` : 'Go to domain set', () => target && selectSymbol(target, true), { disabled: !target });
    m.item('Filter…', () => {
      const cell = (e.target as HTMLElement).closest('.row > div') as HTMLElement | null;
      void openLabelFilter(dim, cell ?? toolbar.tb.el);
    });
    m.sep();
    m.item('Auto Resize Columns', autoResize, { shortcut: 'Ctrl+R' });
  });
};
hooks.openLabelFilter = (d, a) => void openLabelFilter(d, a);
hooks.openValueFilter = openValueFilter;

// ---- toolbar ----
toolbar = new Toolbar({
  togglePanel: () => { S.layout.collapsed = !S.layout.collapsed; split.apply(); hooks.persist(); hooks.chrome(); },
  toggleOrientation: () => {
    S.layout.orientation = split.effectiveOrientation === 'horizontal' ? 'vertical' : 'horizontal';
    split.apply();
    hooks.persist();
    hooks.chrome();
  },
  back: () => navigate(S.history.back()),
  forward: () => navigate(S.history.forward()),
  setMode: (m: ViewMode) => {
    const s = S.selected;
    if (!s || S.view.mode === m) return;
    if ((m === 'table' && !canTable(s)) || (m === 'chart' && !canChart(s))) return;
    S.view.mode = m;
    hooks.persist();
    renderView();
  },
  attrsChanged: () => {
    hooks.persist();
    if (S.view.mode === 'list') { void ensureDefaults(); refreshListColumns(); list.grid?.refresh(); }
    hooks.chrome();
  },
  prefsChanged: () => {
    hooks.persist();
    if (S.selected) send({ type: 'prefs', prefs: { thousands: S.thousands, fmt: { ...S.view.fmt } } });
    if (S.view.mode === 'chart') renderView(); else { list.grid?.refresh(); table.grid?.refresh(); }
  },
  reset: () => {
    const s = S.selected;
    if (!s) return;
    const fresh = resetSymView(s);
    if (S.view.mode !== 'list' && fresh.mode === 'list') fresh.mode = 'list';
    S.views.set(s.name, fresh);
    S.view = fresh;
    searchBar.clear();
    setNotice('limit', '');
    hooks.persist();
    renderView();
  },
  toggleHeader: () => { S.layout.headerHidden = !S.layout.headerHidden; hooks.persist(); hooks.chrome(); split.apply(); },
  exportCsv: () => {
    const s = S.selected;
    if (!s) return;
    send({
      type: 'exportCsv', view: S.view.mode === 'table' ? 'table' : 'list',
      symbol: { index: s.index, name: s.name, dim: s.dim, kind: s.kind, domain: s.domain },
      query: queryParams(S.view.mode !== 'table'), valueCols: valueCols(), pivot: S.view.mode === 'table' ? S.view.pivot : undefined,
    });
  },
  exportExcel: () => openExportDialog(),
  copy: (sep, labels) => void copySelection(sep, labels),
  autoResize,
  goToRow,
});
toolbar.tb.spacer();

dataPane.append(toolbar.tb.el, headerGroup, optBar, noticeBox, viewBody, statusBar);
app.append(splitRoot);
split = new SplitLayout(splitRoot, symbolPanel.el, dataPane, () => S.layout, (final) => {
  if (final) hooks.persist();
  toolbar.update(split.effectiveOrientation === 'horizontal');
});

hooks.focusData = () => (S.view.mode === 'table' ? table.grid?.focus() : list.grid?.focus());
hooks.reloadFile = () => { reloading = true; send({ type: 'symbols' }); };

// ---- keyboard ----
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const t = e.target as HTMLElement;
  const inField = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
  if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    navigate(e.key === 'ArrowLeft' ? S.history.back() : S.history.forward());
  } else if (e.key === 'F3') {
    e.preventDefault();
    void searchNext(e.shiftKey ? -1 : 1);
  } else if (mod && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    if (S.layout.headerHidden) { S.layout.headerHidden = false; hooks.chrome(); split.apply(); }
    searchBar.focus();
  } else if (mod && !inField && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    void copySelection(e.shiftKey ? '\t' : ',');
  } else if (mod && (e.key === 'r' || e.key === 'R') && !e.shiftKey) {
    e.preventDefault();
    autoResize();
  } else if (mod && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault();
    goToRow();
  } else if (e.key === 'Escape' && !inField) {
    cancelSearch();
  }
});

// ---- messages ----
function applySymbols(symbols: GdxSymbolInfo[]): void {
  S.loadError = '';
  S.symbols = symbols;
  labelsCache.clear();
  S.allDefault.clear();
  S.history.prune((n) => symbols.some((s) => s.name === n));
  if (reloading) setNotice('reloaded', 'GDX file has been modified and was reloaded.');
  reloading = false;
  setNotice('diffview', detectGdxDiff(symbols).isDiffFile ? 'This file is the output of gdxdiff.' : '');
  symbolPanel.render();
  const prev = pendingSelect ?? S.selected?.name ?? restoreName;
  const fromCommand = pendingSelect !== undefined;
  pendingSelect = undefined;
  restoreName = undefined;
  const found = prev ? symbols.find((s) => s.name === prev) : undefined;
  if (found) { selectSymbol(found, fromCommand || S.history.current === undefined); } else { S.selected = undefined; S.view = defaultSymView({ dim: 0 }); renderView(); }
}

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      S.fileName = m.fileName;
      S.language = m.language || 'en';
      if (m.prefs) {
        S.defaultFmt = { ...m.prefs.fmt };
        if (freshWebview) S.thousands = m.prefs.thousands;
      }
      setHeaderRowDefault(m.exportHeaderRow === true);
      hooks.chrome();
      break;
    case 'reload':
      reloading = true;
      send({ type: 'symbols' });
      break;
    case 'deleted':
      S.gen++;
      S.loadError = 'The GDX file was deleted.';
      renderView();
      break;
    case 'select': {
      const target = S.symbols.find((x) => x.name === m.name) ?? S.symbols.find((x) => x.name.toLowerCase() === m.name.toLowerCase());
      if (target) { selectSymbol(target, true); hooks.focusData(); }
      else if (S.symbols.length === 0) pendingSelect = m.name; // symbol list not loaded yet
      break;
    }
    case 'exportDefaults': onExportDefaults(m.excelFile, m.connectFile); break;
    case 'browsed': onBrowsed(m.kind, m.path); break;
    case 'symbols': applySymbols(m.symbols); break;
    case 'symbolsError': symbolPanel.setError(m.message); break;
    case 'rpcResult': resolveRpc(m.reqId, m.result); break;
    case 'rpcError': rejectRpc(m.reqId, m.message); break;
  }
});

// ---- restore the previous state of this webview and start ----
const freshWebview = vscodeApi.getState() === undefined;
const restored = sanitizeState(vscodeApi.getState());
S.layout = restored.layout;
S.thousands = restored.thousands;
S.restored = restored.views as Record<string, unknown>;
let restoreName: string | undefined = restored.selected;
split.apply();
hooks.chrome();
renderView();
send({ type: 'ready' });
send({ type: 'symbols' });
