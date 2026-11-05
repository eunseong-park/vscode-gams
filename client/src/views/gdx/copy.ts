// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard text of a cell selection (pure). Studio: GdxSymbolView::copySelectionToString
// (gdxsymbolview.cpp): the list view copies the selected cells; the table view additionally
// copies the row / column labels unless "Copy Without Labels" is used. Values are copied as
// `formatValue` text of the symbol's format (EditRole) - never with the display thousands separator.
import { copyText } from './csv';

export interface CellRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** Guard against selections that would produce unreasonably large clipboard text. */
export const MAX_COPY_CELLS = 5_000_000;

export function cellCount(r: CellRange): number {
  return (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
}

export function normalizeRange(a: { r: number; c: number }, b: { r: number; c: number }): CellRange {
  return { r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) };
}

export function listCopyRows(range: CellRange, cell: (r: number, c: number) => string): string[][] {
  const rows: string[][] = [];
  for (let r = range.r0; r <= range.r1; r++) {
    const line: string[] = [];
    for (let c = range.c0; c <= range.c1; c++) line.push(cell(r, c));
    rows.push(line);
  }
  return rows;
}

export interface TableCopySource {
  rowDimCount: number;
  colDimCount: number;
  rowHeader(r: number): readonly string[];
  colHeader(c: number): readonly string[];
  cell(r: number, c: number): string;
}

/** Table view rows: with labels, one header line per column dimension (leading blanks over the row labels) and the row labels in front of each row. */
export function tableCopyRows(range: CellRange, src: TableCopySource, withLabels: boolean): string[][] {
  const rows: string[][] = [];
  if (withLabels) {
    for (let k = 0; k < src.colDimCount; k++) {
      const line: string[] = Array.from({ length: src.rowDimCount }, () => '');
      for (let c = range.c0; c <= range.c1; c++) line.push(src.colHeader(c)[k] ?? '');
      rows.push(line);
    }
  }
  for (let r = range.r0; r <= range.r1; r++) {
    const line: string[] = withLabels ? [...src.rowHeader(r)] : [];
    for (let c = range.c0; c <= range.c1; c++) line.push(src.cell(r, c));
    rows.push(line);
  }
  return rows;
}

/** Final clipboard text: cells containing the separator are quoted as Studio does. */
export function clipboardText(rows: readonly (readonly string[])[], sep: ',' | '\t'): string {
  return copyText(rows, sep);
}
