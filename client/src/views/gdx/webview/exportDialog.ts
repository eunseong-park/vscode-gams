// SPDX-License-Identifier: GPL-3.0-or-later
// Export dialog (Studio: gdxviewer/exportdialog.ui): choose symbols, "Export data with applied filters",
// "Include hidden attributes", target Excel file and Connect file, special value substitutions.
// "Export" writes the workbook and the Connect file, "Save Connect file only" just the latter.
import type { GdxSymbolInfo } from '../model';
import { typeAsString, makeTextFilter } from '../model';
import type { ExcelExportRequest, ExcelExportSymbol } from '../protocol';
import { buildQueryParams } from '../query';
import { canTable, isSetLike } from '../symview';
import { el } from './dom';
import { send } from './rpc';
import { S, viewFor } from './state';

let open: { close: () => void; setDefaults: (excel: string, connect: string) => void; setBrowsed: (k: 'excel' | 'connect', p: string) => void } | undefined;

let headerRowDefault = false;
/** Remembered state of the "Header row" option (sent by the host with `init`). */
export function setHeaderRowDefault(on: boolean): void {
  headerRowDefault = on;
}

export function onExportDefaults(excel: string, connect: string): void {
  open?.setDefaults(excel, connect);
}
export function onBrowsed(kind: 'excel' | 'connect', p: string): void {
  open?.setBrowsed(kind, p);
}

/** State of one symbol's view as the export needs it. */
export function exportSymbol(s: GdxSymbolInfo): ExcelExportSymbol {
  const v = viewFor(s);
  const table = v.mode === 'table' && canTable(s);
  return {
    index: s.index, name: s.name, aliasOf: s.aliasOf, dim: s.dim, kind: s.kind, domain: s.domain,
    view: table ? 'table' : 'list', pivot: table ? v.pivot : undefined, attrs: v.attrs,
    labelFilters: v.filters.labels, valueFilters: v.filters.values,
  };
}

export function hasActiveFilter(s: GdxSymbolInfo): boolean {
  const v = viewFor(s);
  const q = buildQueryParams(s.dim, undefined, v.filters, isSetLike(s));
  return !!q.filters || !!q.valueFilter;
}

export function openExportDialog(): void {
  open?.close();
  const back = el('div', 'dlgback');
  const dlg = el('div', 'dlg');
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-label', 'GDX Export');
  const title = el('div', 'dlgtitle', 'Export to Excel');

  // symbols
  const filter = el('input');
  filter.placeholder = 'Filter symbols (regex)';
  const list = el('div', 'dlglist');
  const checked = new Set<string>(S.selected ? [S.selected.name] : []);
  const render = (): void => {
    const f = makeTextFilter(filter.value);
    list.textContent = '';
    const frag = document.createDocumentFragment();
    for (const s of S.symbols) {
      if (f && !f(s.name)) continue;
      const row = el('label', 'dlgrow');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = checked.has(s.name);
      cb.onchange = () => { if (cb.checked) checked.add(s.name); else checked.delete(s.name); count(); };
      const filt = hasActiveFilter(s) ? ' (filtered)' : '';
      row.append(cb, el('span', 'dn', s.name), el('span', 'dt', `${typeAsString(s)} · ${s.dim}-dim · ${s.records.toLocaleString()}${filt}`));
      frag.append(row);
    }
    list.append(frag);
    count();
  };
  const countEl = el('span', 'status');
  const count = (): void => { countEl.textContent = `${checked.size} of ${S.symbols.length} symbols selected`; };
  filter.oninput = render;
  const all = el('button', undefined, 'Select All');
  all.onclick = () => { const f = makeTextFilter(filter.value); for (const s of S.symbols) if (!f || f(s.name)) checked.add(s.name); render(); };
  const none = el('button', undefined, 'Deselect All');
  none.onclick = () => { const f = makeTextFilter(filter.value); for (const s of S.symbols) if (!f || f(s.name)) checked.delete(s.name); render(); };
  const symBar = el('div', 'dlgbar');
  symBar.append(filter, all, none);

  // options
  const cbFilter = el('input'); cbFilter.type = 'checkbox'; cbFilter.checked = true;
  const lf = el('label'); lf.append(cbFilter, 'Apply Filters');
  lf.title = 'Export data with applied filters (the label / value filters of each symbol view)';
  const cbAttr = el('input'); cbAttr.type = 'checkbox';
  const la = el('label'); la.append(cbAttr, 'Hidden Attributes');
  la.title = 'Include hidden attributes in the exported data';
  const cbHead = el('input'); cbHead.type = 'checkbox'; cbHead.checked = headerRowDefault;
  const lh = el('label'); lh.append(cbHead, 'Header row with domain names');
  lh.title = 'Extension option (not in Studio): first row with the domain / attribute names, frozen and filterable. Only the workbook gets it; GAMS Connect cannot write it.';
  const opts = el('div', 'dlgbar'); opts.append(lf, la, lh);

  // files
  const excel = el('input'); const connect = el('input');
  excel.setAttribute('aria-label', 'Excel file');
  connect.setAttribute('aria-label', 'Connect file');
  const br = (kind: 'excel' | 'connect', input: HTMLInputElement): HTMLButtonElement => {
    const b = el('button', undefined, 'Browse...');
    b.onclick = () => send({ type: 'browse', kind, current: input.value });
    return b;
  };
  const files = el('div', 'dlggrid');
  files.append(el('span', undefined, 'Target Format:'), el('span', undefined, 'Excel'), el('span'));
  files.append(el('span', undefined, 'Excel File:'), excel, br('excel', excel));
  files.append(el('span', undefined, 'Connect File:'), connect, br('connect', connect));

  // special values
  const sv = el('div', 'dlgbar');
  const field = (label: string, def: string): HTMLInputElement => {
    const i = el('input'); i.value = def; i.size = 8;
    const l = el('label'); l.append(label, i);
    sv.append(l);
    return i;
  };
  const eps = field('EPS:', 'EPS'); const pinf = field('INF:', 'INF'); const minf = field('-INF:', '-INF');
  const undef = field('UNDEF:', 'UNDEF'); const na = field('NA:', 'NA');
  sv.title = 'Text (or number) written for the GAMS special values';

  const err = el('div', 'err');
  const submit = (connectOnly: boolean): void => {
    const symbols = S.symbols.filter((s) => checked.has(s.name)).map(exportSymbol);
    if (symbols.length === 0) { err.textContent = 'At least one symbol has to be selected for export'; return; }
    if (!excel.value.trim()) { err.textContent = 'Excel file can not be empty'; return; }
    const req: ExcelExportRequest = {
      symbols, applyFilters: cbFilter.checked, hiddenAttributes: cbAttr.checked, headerRow: cbHead.checked, excelFile: excel.value, connectFile: connect.value,
      substitutions: { eps: eps.value, posInf: pinf.value, negInf: minf.value, undef: undef.value, na: na.value }, connectOnly,
    };
    headerRowDefault = cbHead.checked;
    send({ type: 'exportExcel', ...req });
    close();
  };
  const bExport = el('button', 'primary', 'Export');
  bExport.title = 'Export the data and save the GAMS Connect file';
  bExport.onclick = () => submit(false);
  const bSave = el('button', undefined, 'Save Connect file only');
  bSave.title = 'Save the GAMS Connect file only (no data is exported)';
  bSave.onclick = () => submit(true);
  const bCancel = el('button', undefined, 'Cancel');
  const buttons = el('div', 'dlgbar end');
  buttons.append(bSave, bExport, bCancel);

  const close = (): void => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    open = undefined;
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  bCancel.onclick = close;
  back.onmousedown = (e) => { if (e.target === back) close(); };
  document.addEventListener('keydown', onKey, true);

  dlg.append(title, symBar, list, countEl, opts, files, sv, err, buttons);
  back.append(dlg);
  document.body.append(back);
  render();
  open = {
    close,
    setDefaults: (e, c) => { if (!excel.value) excel.value = e; if (!connect.value) connect.value = c; },
    setBrowsed: (k, p) => { (k === 'excel' ? excel : connect).value = p; },
  };
  send({ type: 'exportDefaults' });
  filter.focus();
}
