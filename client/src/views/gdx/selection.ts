// SPDX-License-Identifier: GPL-3.0-or-later
// Cell selection model shared by the list grid and the pivot grid (pure).
// Studio uses QTableView with ContiguousSelection (gdxsymbolview.ui): one rectangular range,
// extended with Shift+click / Shift+arrows / drag.
import { CellRange, normalizeRange } from './copy';

export interface Cell {
  r: number;
  c: number;
}

export class GridSelection {
  anchor?: Cell;
  active?: Cell;

  constructor(public rows = 0, public cols = 0) {}

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    if (this.active && (this.active.r >= rows || this.active.c >= cols)) this.clear();
  }

  clear(): void {
    this.anchor = undefined;
    this.active = undefined;
  }

  private clampCell(r: number, c: number): Cell {
    return { r: Math.min(Math.max(0, r), Math.max(0, this.rows - 1)), c: Math.min(Math.max(0, c), Math.max(0, this.cols - 1)) };
  }

  /** Make (r, c) active; with `extend` the anchor stays so the range grows. */
  set(r: number, c: number, extend = false): void {
    if (this.rows <= 0 || this.cols <= 0) return;
    const cell = this.clampCell(r, c);
    if (!extend || !this.anchor) this.anchor = cell;
    this.active = cell;
  }

  /** Move the active cell by (dr, dc); without an active cell the first move lands on the origin. */
  move(dr: number, dc: number, extend = false): void {
    if (!this.active) { this.set(0, 0); return; }
    this.set(this.active.r + dr, this.active.c + dc, extend);
  }

  selectAll(): void {
    if (this.rows <= 0 || this.cols <= 0) return;
    this.anchor = { r: 0, c: 0 };
    this.active = { r: this.rows - 1, c: this.cols - 1 };
  }

  range(): CellRange | undefined {
    return this.anchor && this.active ? normalizeRange(this.anchor, this.active) : undefined;
  }

  contains(r: number, c: number): boolean {
    const g = this.range();
    return !!g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
  }
}
