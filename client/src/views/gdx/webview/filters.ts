// SPDX-License-Identifier: GPL-3.0-or-later
// Label and value filter dialogs (Studio LabelFilterDialog / ValueFilterDialog) as small popups.
import { keyHeader, VALUE_COLUMNS } from '../model';
import {
  DEFAULT_VALUE_FILTER, filterFromSelection, isDefaultValueFilter, labelSelection, matchLabels, parseBound, ValueFilterState,
} from '../query';
import { el } from './dom';
import { errText, rpc } from './rpc';
import { hooks, S } from './state';

const popup = el('div', 'popup');
popup.hidden = true;
document.body.append(popup);

export const labelsCache = new Map<string, string[]>();

export function closePopup(): void {
  popup.hidden = true;
  popup.textContent = '';
}

function showPopup(anchorEl: HTMLElement): void {
  popup.hidden = false;
  const r = anchorEl.getBoundingClientRect();
  popup.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - 330))}px`;
  popup.style.top = `${Math.min(r.bottom + 2, Math.max(4, window.innerHeight - 380))}px`;
}

document.addEventListener('mousedown', (e) => {
  if (!popup.hidden && !popup.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.fbtn')) closePopup();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });

async function labelsOf(dim: number): Promise<string[]> {
  const s = S.selected!;
  const key = `${s.index}:${dim}`;
  let l = labelsCache.get(key);
  if (!l) {
    l = (await rpc<{ labels: string[] }>('labels', { symbolIndex: s.index, column: dim })).labels;
    labelsCache.set(key, l);
  }
  return l;
}

function apply(): void {
  hooks.persist();
  closePopup();
  hooks.rebuild();
}

export async function openLabelFilter(dim: number, anchorEl: HTMLElement): Promise<void> {
  const s = S.selected!;
  const view = S.view;
  popup.textContent = '';
  popup.append(el('div', 'msg', 'Loading labels…'));
  showPopup(anchorEl);
  let all: string[];
  try { all = await labelsOf(dim); } catch (e) {
    popup.textContent = '';
    popup.append(el('div', 'msg err', errText(e)));
    return;
  }
  const checked = labelSelection(all, view.filters.labels[dim]);
  popup.textContent = '';
  popup.append(el('div', 'ptitle', `Filter ${keyHeader(s.domain, dim)} (${all.length.toLocaleString()} labels)`));
  const search = el('input');
  search.placeholder = 'Search labels';
  const rx = el('input'); rx.type = 'checkbox';
  const cs = el('input'); cs.type = 'checkbox';
  const ex = el('input'); ex.type = 'checkbox';
  const opts = el('div', 'prow');
  const l1 = el('label'); l1.append(rx, 'Regex');
  const l2 = el('label'); l2.append(cs, 'Case');
  const l3 = el('label'); l3.append(ex, 'Exact');
  opts.append(l1, l2, l3);
  const list = el('div', 'plist');
  const info = el('div', 'status');
  const shown = (): string[] => matchLabels(all, search.value, { regex: rx.checked, caseSensitive: cs.checked, exact: ex.checked });
  const MAXROWS = 400;
  const infoText = (n: number): string =>
    `${checked.size.toLocaleString()} of ${all.length.toLocaleString()} checked; ${n.toLocaleString()} match${n > MAXROWS ? ` (first ${MAXROWS} listed)` : ''}`;
  const draw = (): void => {
    list.textContent = '';
    const sh = shown();
    for (const l of sh.slice(0, MAXROWS)) {
      const row = el('label', 'plabel');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = checked.has(l);
      cb.onchange = () => { if (cb.checked) checked.add(l); else checked.delete(l); info.textContent = infoText(sh.length); };
      row.append(cb, l);
      list.append(row);
    }
    info.textContent = infoText(sh.length);
  };
  const act = (name: string, fn: (l: string) => void): HTMLButtonElement => {
    const b = el('button', undefined, name);
    b.onclick = () => { for (const l of shown()) fn(l); draw(); };
    return b;
  };
  const bar = el('div', 'prow');
  bar.append(
    act('Check matches', (l) => checked.add(l)),
    act('Uncheck matches', (l) => checked.delete(l)),
    act('Invert matches', (l) => { if (checked.has(l)) checked.delete(l); else checked.add(l); }),
  );
  const ok = el('button', undefined, 'Apply');
  ok.onclick = () => {
    const f = filterFromSelection(all, checked);
    if (f) view.filters.labels[dim] = f; else delete view.filters.labels[dim];
    apply();
  };
  const clr = el('button', undefined, 'Clear');
  clr.onclick = () => { delete view.filters.labels[dim]; apply(); };
  const cancel = el('button', undefined, 'Cancel');
  cancel.onclick = closePopup;
  const foot = el('div', 'prow');
  foot.append(ok, clr, cancel);
  search.oninput = draw; rx.onchange = draw; cs.onchange = draw; ex.onchange = draw;
  popup.append(search, opts, bar, list, info, foot);
  draw();
  search.focus();
}

export function openValueFilter(slot: number, anchorEl: HTMLElement): void {
  const view = S.view;
  const cur: ValueFilterState = { ...DEFAULT_VALUE_FILTER, ...(view.filters.values[slot] ?? {}) };
  popup.textContent = '';
  const name = S.selected!.kind === 'Parameter' ? 'Value' : VALUE_COLUMNS[slot];
  popup.append(el('div', 'ptitle', `Filter ${name}`));
  const num = (v: number | undefined): HTMLInputElement => { const i = el('input'); i.value = v === undefined ? '' : String(v); i.size = 10; return i; };
  const min = num(cur.min);
  const max = num(cur.max);
  const r1 = el('div', 'prow');
  r1.append('Min', min, 'Max', max);
  const exc = el('input'); exc.type = 'checkbox'; exc.checked = cur.exclude;
  const l = el('label');
  l.append(exc, 'Exclude range (hide values inside [min, max])');
  popup.append(r1, l);
  const flags: [keyof ValueFilterState, string][] = [
    ['showUndef', 'UNDF'], ['showNA', 'NA'], ['showPInf', '+INF'], ['showMInf', '-INF'], ['showEps', 'EPS'], ['showAcronym', 'Acronyms'],
  ];
  const boxes = flags.map(([k, t]) => {
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = cur[k] as boolean;
    const lb = el('label'); lb.append(cb, t);
    return [k, cb, lb] as const;
  });
  const sp = el('div', 'prow');
  sp.append(el('span', undefined, 'Show:'), ...boxes.map(([, , lb]) => lb));
  popup.append(sp);
  const msg = el('div', 'msg err');
  const ok = el('button', undefined, 'Apply');
  ok.onclick = () => {
    const mn = parseBound(min.value);
    const mx = parseBound(max.value);
    if (mn === null || mx === null) { msg.textContent = 'Min / max must be numbers.'; return; }
    const f: ValueFilterState = { ...DEFAULT_VALUE_FILTER, min: mn, max: mx, exclude: exc.checked };
    for (const [k, cb] of boxes) (f as unknown as Record<string, unknown>)[k] = cb.checked;
    if (isDefaultValueFilter(f)) delete view.filters.values[slot]; else view.filters.values[slot] = f;
    apply();
  };
  const clr = el('button', undefined, 'Clear');
  clr.onclick = () => { delete view.filters.values[slot]; apply(); };
  const cancel = el('button', undefined, 'Cancel');
  cancel.onclick = closePopup;
  const foot = el('div', 'prow');
  foot.append(ok, clr, cancel);
  popup.append(msg, foot);
  showPopup(anchorEl);
}
