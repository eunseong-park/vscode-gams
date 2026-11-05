// SPDX-License-Identifier: GPL-3.0-or-later
// Native Excel export of the GDX viewer: port of Studio's export dialog (src/gdxviewer/exportdialog.cpp,
// exportdriver.cpp). Studio writes a GAMS Connect file and runs Connect (GDXReader -> Filter ->
// Projection -> ExcelWriter) with GAMS; this extension cannot start GAMS without a license, so it writes
// the workbook itself with exceljs (one sheet per symbol, named like Studio's `generateSheetName`) and
// writes the Connect file separately (connect.ts) as an equivalent recipe.
//
// The workbook reproduces what the Connect ExcelWriter (gams/connect/agents/excelwriter.py) writes, cell by
// cell, so that running the generated Connect file gives the same sheets:
//  * `columnDimension` = number of trailing dimensions spread over the columns. The list view is
//    columnDimension 0: NO header row, one row per record (labels, then the value or - for sets - the
//    element text, left out when the element has none); a scalar is one cell. Domain names are never written.
//  * variables / equations get their attributes as one more column dimension: one header row whose label
//    cells are blank and whose attribute cells are `level`, `marginal`, ...; the table view uses its own
//    column dimensions, one header row each (blank above the row labels, repeated column labels filled in).
//  * numbers are written with 16 significant digits (openpyxl writes `%.16g`), special values as text.
//  * aliases are written like the set they alias; an alias of the universe `*` is not exported (the
//    Connect GDXReader does not support it, see exportExcel.ts).
import * as ExcelJS from 'exceljs';
import { writeXlsxSafely } from './xlsxCleanup';
import { setTextForFile } from './csv';
import { SpecialSubstitutions, sheetNameFor } from './connect';
import type { RecordsResult, TableResult } from './protocol';
import type { SymbolKind } from './model';
import type { PivotState } from './pivot';
import { keyNames } from '../gdxCompare/exportModel';
import type { QueryParams } from './query';

export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLS = 16_384;
const PAGE = 20_000;
const TABLE_ROWS = 500;
export const ATTRIBUTE_LABELS = ['level', 'marginal', 'lower', 'upper', 'scale'] as const;

export interface XlsxSymbolSpec {
  index: number;
  name: string;
  dim: number;
  kind: SymbolKind;
  domain: string[];
  /** list layout, or the table (pivot) layout of the view */
  view: 'list' | 'table';
  pivot?: PivotState;
  /** attribute slots to write for variables / equations */
  slots: number[];
  /** extension option: header row (domain / attribute names), frozen with autofilter */
  headerRow?: boolean;
  /** label / value filters (never the sort) */
  query: QueryParams;
}

export type Request = <T>(method: string, params: unknown) => Promise<T>;

export interface XlsxExportResult {
  sheets: Array<{ name: string; sheet: string }>;
  /** sheets cut at the Excel row / column limit */
  truncated: Array<{ name: string; reason: string }>;
}

const SPECIAL_KEYS: Record<string, keyof SpecialSubstitutions> = { EPS: 'eps', '+INF': 'posInf', '-INF': 'negInf', UNDF: 'undef', NA: 'na' };

/** openpyxl (GAMS Connect's Excel writer) writes numbers with `%.16g`: 16 significant digits. */
export function round16(v: number): number {
  return Number.isInteger(v) && Math.abs(v) < 1e16 ? v : Number(v.toPrecision(16));
}

/**
 * Cell value: numbers stay numbers (rounded to 16 digits like Connect's writer), special values are text (or the
 * user's substitution; numeric text becomes a number).
 */
export function cellValue(v: number | string | null | undefined, sub: SpecialSubstitutions): ExcelJS.CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return round16(v);
  // a string that is no special value is an acronym name: GAMS Transfer (Connect) reads acronyms as UNDEF
  const key = SPECIAL_KEYS[v] ?? 'undef';
  const text = sub[key];
  const asNum = Number(text);
  return text.trim() !== '' && Number.isFinite(asNum) ? round16(asNum) : text;
}

/**
 * Set element text like gdxdump writes it: empty for an element without text, the real text otherwise (a genuine
 * `Y` stays). The viewer protocol returns Studio's placeholder `Y` for elements without text and flags it with
 * `hasText === false`.
 */
export function setText(v: number | string | undefined, hasText?: boolean): string {
  return setTextForFile(v, hasText);
}

/**
 * Header rows of a pivot sheet like the Connect ExcelWriter writes them: one row per column dimension, `rowDimCount`
 * blank cells (above the row labels) and then the column labels, repeated labels filled in. Row dimension names
 * are not written.
 */
export function pivotHeaderRows(rowDimCount: number, colDimCount: number, colHeaders: readonly (readonly string[])[]): (string | null)[][] {
  return Array.from({ length: colDimCount }, (_, k) => [
    ...Array<null>(rowDimCount).fill(null),
    ...colHeaders.map((h) => h[k] ?? ''),
  ]);
}

export function exportSheetName(name: string, used: string[]): string {
  return sheetNameFor(name, used);
}

export async function exportGdxXlsx(
  file: string, gdxPath: string, specs: readonly XlsxSymbolSpec[], sub: SpecialSubstitutions, request: Request,
  progress?: (name: string) => void, limits: { maxRows?: number; maxCols?: number } = {},
): Promise<XlsxExportResult> {
  const maxRows = limits.maxRows ?? EXCEL_MAX_ROWS;
  const maxCols = limits.maxCols ?? EXCEL_MAX_COLS;
  return writeXlsxSafely(file, (wb) => writeGdxXlsx(wb, gdxPath, specs, sub, request, progress, maxRows, maxCols));
}

async function writeGdxXlsx(
  wb: ExcelJS.stream.xlsx.WorkbookWriter, gdxPath: string, specs: readonly XlsxSymbolSpec[], sub: SpecialSubstitutions, request: Request,
  progress: ((name: string) => void) | undefined, maxRows: number, maxCols: number,
): Promise<XlsxExportResult> {
  wb.creator = 'vscode-gams';
  const used: string[] = [];
  const result: XlsxExportResult = { sheets: [], truncated: [] };
  for (const s of specs) {
    progress?.(s.name);
    const sheet = exportSheetName(s.name, used);
    result.sheets.push({ name: s.name, sheet });
    const isVE = s.kind === 'Variable' || s.kind === 'Equation';
    const isSet = s.kind === 'Set' || s.kind === 'Alias';
    // no attribute selected: Studio projects the variable / equation to a set (the labels only), as a list
    const keysOnly = isVE && s.slots.length === 0;
    const table = s.view === 'table' && !!s.pivot && s.pivot.colDims.length > 0 && s.dim > 1 && !keysOnly;
    const hdr = s.headerRow === true;
    // header rows of the ON option: frozen, with an autofilter on the last header row
    const frozenRows = table ? s.pivot!.colDims.length + (isVE ? 1 : 0) : 1;
    const ws = wb.addWorksheet(sheet, hdr ? { views: [{ state: 'frozen', xSplit: table ? s.pivot!.rowDims.length : 0, ySplit: frozenRows }] } : undefined);
    const names = keyNames(s.domain, s.dim);
    let lastCol = 0;
    let rowsWritten = 0;
    const add = (cells: ExcelJS.CellValue[]): boolean => {
      if (rowsWritten >= maxRows) return false;
      const row = ws.addRow(cells.length > maxCols ? cells.slice(0, maxCols) : cells);
      row.commit();
      rowsWritten++;
      return true;
    };
    let cutRows = false;
    let cutCols = false;
    if (!table) {
      // list view (columnDimension 0): no header; variables / equations: one header row with the attributes
      if (hdr) {
        const head: string[] = isVE ? [...names, ...s.slots.map((i) => ATTRIBUTE_LABELS[i])] : [...names, isSet ? 'text' : 'value'];
        add(head);
        lastCol = Math.min(head.length, maxCols);
      } else if (isVE && !keysOnly) add([...Array<null>(s.dim).fill(null), ...s.slots.map((i) => ATTRIBUTE_LABELS[i])]);
      for (let offset = 0; ; ) {
        const r = await request<RecordsResult>('gams/gdxRecords', { symbolIndex: s.index, offset, limit: PAGE, ...s.query, sort: undefined, path: gdxPath });
        for (const rec of r.records) {
          const cells: ExcelJS.CellValue[] = rec.keys.slice(0, s.dim);
          if (isSet) cells.push(setText(rec.values[0], rec.hasText) || null);
          else if (keysOnly) { /* labels only */ }
          else if (isVE) for (const i of s.slots) cells.push(cellValue(rec.values[i], sub));
          else cells.push(cellValue(rec.values[0], sub));
          if (!add(cells)) { cutRows = true; break; }
        }
        offset += r.records.length;
        if (cutRows || r.records.length === 0 || offset >= r.total) break;
      }
    } else {
      const p = s.pivot!;
      const slots = isVE ? s.slots : [p.valueField];
      const base = { symbolIndex: s.index, rowDims: p.rowDims, colDims: p.colDims, ...s.query, sort: undefined, path: gdxPath };
      const first = await request<TableResult>('gams/gdxTable', { ...base, valueField: slots[0], rowOffset: 0, rowLimit: 0, colOffset: 0, colLimit: 1_000_000 });
      // column tuples; variables / equations get the attribute as one more (last) column dimension
      const heads: string[][] = isVE ? first.colHeaders.flatMap((h) => slots.map((i) => [...h, ATTRIBUTE_LABELS[i]])) : first.colHeaders;
      if (heads.length > maxCols - p.rowDims.length) { cutCols = true; heads.length = Math.max(0, maxCols - p.rowDims.length); }
      const headerRows = pivotHeaderRows(p.rowDims.length, p.colDims.length + (isVE ? 1 : 0), heads);
      if (hdr) p.rowDims.forEach((d, k) => { headerRows[headerRows.length - 1][k] = names[d] ?? `uni_${d + 1}`; });
      for (const h of headerRows) add(h);
      lastCol = Math.min(p.rowDims.length + heads.length, maxCols);
      const colCount = isVE ? Math.floor(heads.length / slots.length) : heads.length;
      outer: for (let off = 0; off < first.rowCount; off += TABLE_ROWS) {
        const blocks = await Promise.all(slots.map((slot) => request<TableResult>('gams/gdxTable', {
          ...base, valueField: slot, rowOffset: off, rowLimit: TABLE_ROWS, colOffset: 0, colLimit: first.colCount,
        })));
        const n = blocks[0].rowHeaders.length;
        for (let r = 0; r < n; r++) {
          const cells: ExcelJS.CellValue[] = [...blocks[0].rowHeaders[r]];
          // sets: the cells hold element texts (`Y` where an element has none, like Connect's table layout)
          for (let c = 0; c < colCount; c++) for (const b of blocks) cells.push(isSet ? (b.cells[r][c] === null ? null : String(b.cells[r][c])) : cellValue(b.cells[r][c], sub));
          if (!add(cells)) { cutRows = true; break outer; }
        }
      }
    }
    if (cutRows) result.truncated.push({ name: s.name, reason: `rows cut at the Excel limit of ${maxRows.toLocaleString('en-US')}` });
    if (cutCols) result.truncated.push({ name: s.name, reason: `columns cut at the Excel limit of ${maxCols.toLocaleString('en-US')}` });
    if (hdr && lastCol > 0) ws.autoFilter = { from: { row: frozenRows, column: 1 }, to: { row: frozenRows, column: lastCol } };
    await ws.commit();
  }
  if (specs.length === 0) wb.addWorksheet('Sheet1').commit();
  await wb.commit();
  return result;
}
