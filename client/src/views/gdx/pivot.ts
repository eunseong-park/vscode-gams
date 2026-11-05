// SPDX-License-Identifier: GPL-3.0-or-later
// Pure logic of the table (pivot) view: dimension assignment and block caching.
// Mirrors Studio TableViewModel::initTableView / TableViewDomainModel (src/gdxviewer/tableviewmodel.cpp,
// tableviewdomainmodel.cpp): the default has one column dimension (the last), the rest are rows;
// the user moves dimensions between the row and column area.

export interface PivotState {
  rowDims: number[];
  colDims: number[];
  /** value slot (0..4) shown for variables / equations; 0 otherwise */
  valueField: number;
}

export function defaultPivot(dim: number): PivotState {
  const all = Array.from({ length: dim }, (_, i) => i);
  return { rowDims: all.slice(0, Math.max(0, dim - 1)), colDims: all.slice(Math.max(0, dim - 1)), valueField: 0 };
}

export function isValidPivot(p: PivotState, dim: number): boolean {
  const all = [...p.rowDims, ...p.colDims].sort((a, b) => a - b);
  return all.length === dim && all.every((d, i) => d === i);
}

/** Move `dim` into the `target` area at position `pos` (end if omitted). Returns a new state. */
export function moveDim(p: PivotState, dim: number, target: 'row' | 'col', pos?: number): PivotState {
  const rowDims = p.rowDims.filter((d) => d !== dim);
  const colDims = p.colDims.filter((d) => d !== dim);
  const list = target === 'row' ? rowDims : colDims;
  list.splice(pos === undefined ? list.length : Math.max(0, Math.min(pos, list.length)), 0, dim);
  return { ...p, rowDims, colDims };
}

/** Swap rows and columns (transpose). */
export function transpose(p: PivotState): PivotState {
  return { ...p, rowDims: p.colDims, colDims: p.rowDims };
}

export const VALUE_FIELD_NAMES = ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'] as const;

/** Index of the block containing item `i` for a block size. */
export function blockIndex(i: number, size: number): number {
  return Math.floor(i / size);
}

/** Block indices needed to show items [first, last) (clamped to count). */
export function blocksFor(first: number, last: number, size: number, count: number): number[] {
  const out: number[] = [];
  const lo = Math.max(0, first);
  const hi = Math.min(count, last);
  for (let b = blockIndex(lo, size); lo < hi && b * size < hi; b++) out.push(b);
  return out;
}

/** Tiny LRU map used for record pages / table blocks. */
export class LruMap<V> {
  private readonly m = new Map<string | number, V>();
  constructor(private readonly cap: number) {}
  get(k: string | number): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  has(k: string | number): boolean {
    return this.m.has(k);
  }
  set(k: string | number, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as string | number);
  }
  clear(): void {
    this.m.clear();
  }
  get size(): number {
    return this.m.size;
  }
}
