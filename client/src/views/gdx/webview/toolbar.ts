// SPDX-License-Identifier: GPL-3.0-or-later
// Toolbar of the data panel: one fixed-height row of icon buttons with tooltips; what does not
// fit moves into the "..." menu. Attributes / Preferences menus follow Studio's GdxSymbolView.
import { hasAttributes, ATTR_NAMES, canChart, canTable, invertAttrs, isSetLike, toggleAttr, ViewMode } from '../symview';
import { el, icon, iconButton } from './dom';
import { openMenu, OverflowToolbar, ToolItem } from './menus';
import { S } from './state';

export interface ToolbarActions {
  togglePanel(): void;
  toggleOrientation(): void;
  back(): void;
  forward(): void;
  setMode(m: ViewMode): void;
  attrsChanged(): void;
  prefsChanged(): void;
  reset(): void;
  toggleHeader(): void;
  exportCsv(): void;
  exportExcel(): void;
  copy(sep: ',' | '\t', labels: boolean): void;
  autoResize(): void;
  goToRow(): void;
}

export class Toolbar {
  readonly tb = new OverflowToolbar();
  private readonly items = new Map<string, ToolItem>();

  constructor(private readonly a: ToolbarActions) {
    const btn = (id: string, ic: string, label: string, run: (anchor: HTMLElement) => void, extra: Partial<ToolItem> = {}, text?: string): HTMLButtonElement => {
      const b = iconButton(ic, label, undefined, text);
      this.items.set(id, { el: b, label, run, ...extra });
      this.tb.add(this.items.get(id)!);
      return b;
    };
    const dropdown = (id: string, ic: string, label: string, text: string, open: (anchor: HTMLElement) => void): void => {
      const b = iconButton(ic, label, undefined, text);
      b.append(icon('down'));
      b.setAttribute('aria-haspopup', 'menu');
      this.items.set(id, { el: b, label, run: open });
      this.tb.add(this.items.get(id)!);
    };
    const sep = (): void => { this.tb.add({ el: el('span', 'vsep'), label: '', run: () => undefined, decoration: true }); };

    btn('panel', 'panel', 'Show / hide the symbol table', () => a.togglePanel(), { pinned: true });
    btn('back', 'back', 'Back to the previous symbol (Alt+Left)', () => a.back(), { label: 'Back' });
    btn('forward', 'forward', 'Forward to the next symbol (Alt+Right)', () => a.forward(), { label: 'Forward' });
    sep();
    btn('list', 'list', 'List view', () => a.setMode('list'), { label: 'List view', pinned: true }, 'List');
    btn('table', 'table', 'Table (pivot) view', () => a.setMode('table'), { label: 'Table view' }, 'Table');
    btn('chart', 'chart', 'Chart view', () => a.setMode('chart'), { label: 'Chart view' }, 'Chart');
    sep();
    dropdown('attrs', 'columns', 'Hide/Show specific value columns', 'Attributes', (anchor) => this.openAttributes(anchor));
    dropdown('prefs', 'prefs', 'Number format preferences', 'Preferences', (anchor) => this.openPrefs(anchor));
    btn('reset', 'reset', 'Reset symbol view to default', () => a.reset(), { label: 'Reset symbol view' }, 'Reset');
    btn('header', 'info', 'Hide/Show search bar and symbol info', () => a.toggleHeader(), { label: 'Hide/Show search bar and symbol info' });
    btn('export', 'export', 'Export the current view (with filters) to a CSV file', () => a.exportCsv(), { label: 'Export CSV' }, 'Export');
    btn('excel', 'export', 'Export symbols to an Excel file and a GAMS Connect file...', () => a.exportExcel(), { label: 'Export to Excel...' }, 'Excel');
    btn('copy', 'copy', 'Copy the selection (Ctrl+C comma-separated, Ctrl+Shift+C tab-separated)', (anchor) => this.openCopy(anchor), { label: 'Copy…' });
    btn('fit', 'fit', 'Auto Resize Columns (Ctrl+R)', () => a.autoResize(), { label: 'Auto Resize Columns' });
    btn('orient', 'orientH', 'Toggle side-by-side / stacked panels', () => a.toggleOrientation(), { label: 'Toggle panel orientation' });
  }

  private btn(id: string): HTMLElement {
    return this.items.get(id)!.el;
  }

  private openCopy(anchor: HTMLElement): void {
    openMenu(anchor, (m) => {
      m.item('Copy (comma-separated)', () => this.a.copy(',', true), { shortcut: 'Ctrl+C' });
      m.item('Copy (tab-separated)', () => this.a.copy('\t', true), { shortcut: 'Ctrl+Shift+C' });
      if (S.view.mode === 'table') {
        m.item('Copy Without Labels (comma-separated)', () => this.a.copy(',', false));
        m.item('Copy Without Labels (tab-separated)', () => this.a.copy('\t', false));
      }
    });
  }

  private openAttributes(anchor: HTMLElement): void {
    const s = S.selected;
    openMenu(anchor, (m) => {
      if (!s || !hasAttributes(s)) { m.item('Only variables and equations have attributes', () => undefined, { disabled: true }); return; }
      const rows: HTMLElement[] = [];
      const refresh = (): void => rows.forEach((r, i) => {
        r.querySelector('.mchk')!.textContent = S.view.attrs[i] ? '✓' : '';
        r.setAttribute('aria-checked', String(S.view.attrs[i]));
      });
      ATTR_NAMES.forEach((n, i) => {
        rows.push(m.item(n === 'Lower' ? 'Lower Bound' : n === 'Upper' ? 'Upper Bound' : n, () => { S.view.attrs = toggleAttr(S.view.attrs, i); refresh(); this.a.attrsChanged(); }, { checked: S.view.attrs[i], keepOpen: true }));
      });
      m.sep();
      m.item('Invert Selection', () => { S.view.attrs = invertAttrs(S.view.attrs); refresh(); this.a.attrsChanged(); }, { keepOpen: true });
      if (S.view.mode === 'table' || S.view.mode === 'chart') {
        m.widget(el('div', 'mnote', 'The table and chart show one attribute at a time (selector in their option row).'));
      }
    });
  }

  private openPrefs(anchor: HTMLElement): void {
    const s = S.selected;
    openMenu(anchor, (m) => {
      const box = el('div', 'prefs');
      const f = S.view.fmt;
      const fmt = el('select');
      fmt.title = 'g-format: automatic; f-format: fixed decimals; e-format: scientific';
      for (const [v, t] of [['g', 'g-format'], ['f', 'f-format'], ['e', 'e-format']]) { const o = el('option', undefined, t); o.value = v; fmt.append(o); }
      fmt.value = f.format;
      const prec = el('input');
      prec.type = 'number';
      prec.min = '0';
      const syncPrec = (): void => {
        prec.max = f.format === 'f' ? '14' : '17';
        prec.title = f.format === 'f' ? 'Decimals [0..14]' : 'Significant digits [1..17], 0 = Full';
        prec.value = String(f.precision);
      };
      syncPrec();
      const sq = el('input'); sq.type = 'checkbox';
      const syncSq = (): void => {
        const full = f.format !== 'f' && f.precision === 0;
        sq.checked = f.squeeze || full;
        sq.disabled = full; // precision Full has no trailing zeros (NumericalFormatController::update)
      };
      syncSq();
      const sqd = el('input'); sqd.type = 'checkbox'; sqd.checked = S.view.squeezeDefaults;
      sqd.disabled = !s || !hasAttributes(s);
      sqd.title = 'Hide value columns in which every record has the default value (variables and equations, list view)';
      const th = el('input'); th.type = 'checkbox'; th.checked = S.thousands;
      th.title = 'Group digits of displayed values (not applied to copy and export)';
      const row = (label: string, ctl: HTMLElement): HTMLElement => { const r = el('label', 'prow2'); r.append(ctl, label); return r; };
      const line = (label: string, ctl: HTMLElement): HTMLElement => { const r = el('div', 'prow2'); r.append(el('span', 'plabel2', label), ctl); return r; };
      fmt.onchange = () => { f.format = fmt.value as 'g' | 'f' | 'e'; f.precision = Math.min(f.precision, f.format === 'f' ? 14 : 17); syncPrec(); syncSq(); this.a.prefsChanged(); };
      prec.onchange = () => { f.precision = Math.max(0, Math.min(f.format === 'f' ? 14 : 17, Math.round(Number(prec.value) || 0))); syncPrec(); syncSq(); this.a.prefsChanged(); };
      sq.onchange = () => { f.squeeze = sq.checked; this.a.prefsChanged(); };
      sqd.onchange = () => { S.view.squeezeDefaults = sqd.checked; this.a.attrsChanged(); };
      th.onchange = () => { S.thousands = th.checked; this.a.prefsChanged(); };
      box.append(line('Format', fmt), line('Precision', prec), row('Squeeze Trailing Zeroes', sq), row('Squeeze Defaults', sqd), row('Thousands separator', th));
      m.widget(box);
    });
  }

  /** Reflect the current state in the buttons (enabled / pressed). */
  update(horizontal: boolean): void {
    const s = S.selected;
    const mode = S.view.mode;
    const set = (id: string, o: { on?: boolean; disabled?: boolean; hidden?: boolean }): void => {
      const b = this.btn(id) as HTMLButtonElement;
      if (o.on !== undefined) { b.classList.toggle('on', o.on); b.setAttribute('aria-pressed', String(o.on)); }
      if (o.disabled !== undefined) b.disabled = o.disabled;
      if (o.hidden !== undefined) b.hidden = o.hidden;
    };
    set('list', { on: mode === 'list', disabled: !s });
    set('table', { on: mode === 'table', disabled: !s || !canTable(s) });
    set('chart', { on: mode === 'chart', disabled: !s || !canChart(s) });
    set('attrs', { disabled: !s || !hasAttributes(s), hidden: !!s && isSetLike(s) });
    set('reset', { disabled: !s });
    set('prefs', { disabled: !s });
    set('export', { disabled: !s || mode === 'chart' });
    set('copy', { disabled: !s || mode === 'chart' });
    set('fit', { disabled: !s || mode === 'chart' });
    set('back', { disabled: !S.history.canBack });
    set('forward', { disabled: !S.history.canForward });
    set('panel', { on: !S.layout.collapsed });
    const orient = this.btn('orient');
    orient.replaceChildren(icon(horizontal ? 'orientH' : 'orientV'));
    set('header', { on: !S.layout.headerHidden });
    this.items.get('table')!.disabled = () => !s || !canTable(s);
    this.items.get('chart')!.disabled = () => !s || !canChart(s);
    this.items.get('back')!.disabled = () => !S.history.canBack;
    this.items.get('forward')!.disabled = () => !S.history.canForward;
    this.items.get('list')!.checked = () => mode === 'list';
    this.items.get('header')!.checked = () => !S.layout.headerHidden;
    this.tb.schedule();
  }
}
