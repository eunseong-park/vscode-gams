// SPDX-License-Identifier: GPL-3.0-or-later
// Data search of the GDX symbol view (pure). Studio: GdxSymbolView::onSearch / matchAndSelect
// (gdxsymbolview.cpp): the search field matches the *displayed* text of cells (list and table
// view) and, in the table view, the row / column labels; F3 / Shift+F3 go to the next / previous
// match, wrapping around; matches are highlighted in the grid (GdxSymbol::data, searchRegEx).
// The search space is walked in row-major order; cells that are not loaded yet are reported as
// "need" so the caller can fetch them and resume (no server-side search needed).

export interface SearchOptions {
  text: string;
  regex: boolean;
  caseSensitive: boolean;
  /** whole cell text must match */
  exact: boolean;
}

export const NO_SEARCH: SearchOptions = { text: '', regex: false, caseSensitive: false, exact: false };

/** Test function for the options, or undefined when the text is empty or not a valid regular expression. */
export function makeMatcher(o: SearchOptions): ((s: string) => boolean) | undefined {
  if (o.text === '') return undefined;
  const src = o.regex ? o.text : o.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const re = new RegExp(o.exact ? `^(?:${src})$` : src, o.caseSensitive ? '' : 'i');
    return (s) => re.test(s);
  } catch {
    return undefined;
  }
}

export interface SearchSpace {
  rows: number;
  cols: number;
  /** texts to test for a cell (its value, plus row / column labels in the table view); undefined = not loaded */
  texts(r: number, c: number): readonly string[] | undefined;
}

export interface SearchCursor {
  /** linear cell index (row * cols + col) examined next */
  pos: number;
  /** cells still to examine */
  remaining: number;
}

export type SearchStep =
  | { kind: 'found'; r: number; c: number }
  | { kind: 'need'; r: number; c: number; cursor: SearchCursor }
  | { kind: 'none' };

/** Cursor for a search starting after `current` (or at the first / last cell when nothing is current). */
export function startSearch(space: Pick<SearchSpace, 'rows' | 'cols'>, current: { r: number; c: number } | undefined, dir: 1 | -1): SearchCursor | undefined {
  const total = space.rows * space.cols;
  if (total <= 0) return undefined;
  if (!current) return { pos: dir === 1 ? 0 : total - 1, remaining: total };
  const cur = Math.min(total - 1, Math.max(0, current.r * space.cols + current.c));
  return { pos: (cur + dir + total) % total, remaining: total };
}

/** Examine cells from `cur` until a match, an unloaded cell or the end of the (wrapped) walk. */
export function searchStep(space: SearchSpace, cur: SearchCursor, dir: 1 | -1, match: (s: string) => boolean): SearchStep {
  const total = space.rows * space.cols;
  let { pos, remaining } = cur;
  while (remaining > 0) {
    const r = Math.floor(pos / space.cols);
    const c = pos % space.cols;
    const t = space.texts(r, c);
    if (t === undefined) return { kind: 'need', r, c, cursor: { pos, remaining } };
    if (t.some(match)) return { kind: 'found', r, c };
    pos = (pos + dir + total) % total;
    remaining--;
  }
  return { kind: 'none' };
}
