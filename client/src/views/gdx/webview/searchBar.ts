// SPDX-License-Identifier: GPL-3.0-or-later
// Search bar (Studio: line edit + "<" / ">" buttons, F3 / Shift+F3): finds the next / previous
// cell whose displayed text (or, in the table view, label) matches; matches are highlighted.
import { makeMatcher, SearchSpace, searchStep, startSearch } from '../search';
import { el, iconButton } from './dom';
import { ensurePage, PAGE, list, listColumnIds, listTexts, displayRows } from './listView';
import { setActiveMatch, setSearchOptions } from './searchState';
import { table, tableTexts, ensureBlock } from './tableView';
import { hooks, S } from './state';

interface Target {
  space(): SearchSpace;
  load(r: number, c: number): Promise<void>;
  current(): { r: number; c: number } | undefined;
  show(r: number, c: number): void;
}

function target(): Target | undefined {
  if (!S.selected) return undefined;
  if (S.view.mode === 'list' && list.grid) {
    const g = list.grid;
    return {
      space: () => ({ rows: displayRows(), cols: listColumnIds().length, texts: listTexts }),
      load: async (r) => { await ensurePage(Math.floor(r / PAGE)); },
      current: () => g.selection.active,
      show: (r, c) => g.goTo(r, c),
    };
  }
  if (S.view.mode === 'table' && table.grid) {
    const g = table.grid;
    return {
      space: () => ({ rows: table.rowCount, cols: table.colCount, texts: tableTexts }),
      load: (r, c) => ensureBlock(Math.floor(r / 100), Math.floor(c / 30)),
      current: () => g.selection.active,
      show: (r, c) => g.goTo(r, c),
    };
  }
  return undefined;
}

let token = 0;
let statusEl: HTMLElement | undefined;
const say = (t: string): void => { if (statusEl) statusEl.textContent = t; };

export function cancelSearch(): void {
  token++;
}

/** Go to the next (1) / previous (-1) match, loading data on demand. */
export async function searchNext(dir: 1 | -1): Promise<void> {
  const match = makeMatcher(S.search);
  if (!match) { say(S.search.text ? 'Invalid regular expression' : ''); return; }
  const tg = target();
  if (!tg) { say('Search is available in the list and table view.'); return; }
  const my = ++token;
  let cur = startSearch(tg.space(), tg.current(), dir);
  if (!cur) { say('Nothing to search'); return; }
  for (;;) {
    const sp = tg.space();
    const step = searchStep(sp, cur, dir, match);
    if (my !== token) return;
    if (step.kind === 'found') {
      setActiveMatch({ r: step.r, c: step.c });
      tg.show(step.r, step.c);
      say(`Match at row ${(step.r + 1).toLocaleString()}`);
      return;
    }
    if (step.kind === 'none') { say('No match'); return; }
    say(`Searching… row ${(step.r + 1).toLocaleString()} of ${sp.rows.toLocaleString()} (Esc cancels)`);
    await tg.load(step.r, step.c);
    if (S.loadError || my !== token) return;
    cur = step.cursor;
  }
}

export class SearchBar {
  readonly el = el('div', 'searchbar');
  readonly input = el('input');
  private readonly toggles: HTMLButtonElement[] = [];

  constructor() {
    this.input.placeholder = 'Search ...';
    this.input.title = 'Searches for labels and values in the data view';
    this.input.setAttribute('aria-label', 'Search labels and values in the data view');
    const mk = (label: string, title: string, key: 'regex' | 'caseSensitive' | 'exact'): HTMLButtonElement => {
      const b = el('button', 'tg', label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => { S.search[key] = !S.search[key]; b.setAttribute('aria-pressed', String(S.search[key])); b.classList.toggle('on', S.search[key]); this.changed(); };
      this.toggles.push(b);
      return b;
    };
    const prev = iconButton('up', 'Search backward (Shift+F3)', () => void searchNext(-1));
    const next = iconButton('down', 'Search forward (F3)', () => void searchNext(1));
    statusEl = el('span', 'status');
    this.el.append(
      this.input, mk('Aa', 'Match case', 'caseSensitive'), mk('.*', 'Regular expression', 'regex'), mk('ab', 'Whole cell must match', 'exact'),
      prev, next, statusEl,
    );
    this.input.oninput = () => { S.search.text = this.input.value; this.changed(); };
    this.input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void searchNext(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { cancelSearch(); this.input.blur(); hooks.focusData(); }
    };
  }

  private changed(): void {
    setSearchOptions(S.search);
    say(S.search.text && !makeMatcher(S.search) ? 'Invalid regular expression' : '');
    list.grid?.refresh();
    table.grid?.refresh();
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  /** Studio "Reset" clears the search field and its options. */
  clear(): void {
    this.input.value = '';
    S.search = { text: '', regex: false, caseSensitive: false, exact: false };
    for (const b of this.toggles) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }
    this.changed();
  }
}
