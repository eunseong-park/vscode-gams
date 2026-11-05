// SPDX-License-Identifier: GPL-3.0-or-later
// Excel (.xlsx) export of the compare view (extension feature) with exceljs' streaming writer: a
// `Summary` sheet and one sheet per symbol, header row frozen and filterable, added / removed rows and
// changed cells filled with the colors of the view, numbers as numbers, special values as text.
import * as ExcelJS from 'exceljs';
import { writeXlsxSafely } from '../gdx/xlsxCleanup';
import {
  CompareExportOptions, EXCEL_MAX_ROWS, ExportCell, ExportColumn, SUMMARY_HEADER, exportColumns, exportRow, sheetNames, specialText, summaryRow,
} from './exportModel';
import { SymbolRequest, Request, Progress, recordPages } from './exportCsv';
import { ColorKey, CompareSymbol, excelColor } from './model';

export interface XlsxMeta {
  fileA: string;
  fileB: string;
  eps: number;
  relEps: number;
  /** gdxdiff options CmpDefaults / CmpDomains (shown in the info block when on) */
  cmpDefaults?: boolean;
  cmpDomains?: boolean;
  /** extra lines for the info block under the summary */
  extra?: string[];
  /** sheet row limit (tests lower it; Excel: 1,048,576) */
  maxRows?: number;
}

const argb = (k: ColorKey): string => `FF${excelColor(k)}`;
const fill = (k: ColorKey): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(k) } });
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };

/** Cell value written to the sheet. */
export function xlsxValue(c: ExportCell): ExcelJS.CellValue {
  if (c.value === null) return null;
  if (typeof c.value === 'number') return c.value;
  return c.text ? c.value : specialText(c.value);
}

export function colWidth(header: string, kind: ExportColumn['kind']): number {
  return Math.max(10, Math.min(40, header.length + 4, kind === 'key' ? 24 : 40));
}

export interface SheetPlan {
  symbol: CompareSymbol;
  sheet: string;
}

export interface XlsxResult {
  sheets: SheetPlan[];
  /** symbols whose sheet was cut at the Excel row limit: [name, written, total] */
  truncated: Array<{ name: string; written: number; total: number }>;
}

export async function exportCompareXlsx(
  file: string, symbols: readonly CompareSymbol[], all: readonly CompareSymbol[], req: SymbolRequest, meta: XlsxMeta, request: Request, progress?: Progress,
): Promise<XlsxResult> {
  return writeXlsxSafely(file, (wb) => writeCompareXlsx(wb, symbols, all, req, meta, request, progress));
}

async function writeCompareXlsx(
  wb: ExcelJS.stream.xlsx.WorkbookWriter, symbols: readonly CompareSymbol[], all: readonly CompareSymbol[], req: SymbolRequest, meta: XlsxMeta, request: Request, progress?: Progress,
): Promise<XlsxResult> {
  const maxRows = meta.maxRows ?? EXCEL_MAX_ROWS;
  wb.creator = 'vscode-gams';
  const summary = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  const names = sheetNames(symbols.map((s) => s.name), ['Summary']);
  const sheets: SheetPlan[] = symbols.map((symbol, i) => ({ symbol, sheet: names[i] }));
  const truncated: XlsxResult['truncated'] = [];

  // summary
  summary.columns = SUMMARY_HEADER.map((h, i) => ({ width: i === 0 ? 24 : i === 11 ? 60 : 14 }));
  summary.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: SUMMARY_HEADER.length } };
  const h = summary.addRow(SUMMARY_HEADER);
  h.font = { bold: true };
  h.eachCell((c) => { c.fill = HEADER_FILL; });
  h.commit();
  const sheetOf = new Map(sheets.map((p) => [p.symbol.name, p.sheet]));
  // rows a sheet will get: header + visible rows; the limit is known up front from the symbol counts
  const visible = (s: CompareSymbol): number | null => (req.export.onlyDiff ? s.differences : s.rows);
  for (const s of all) {
    const sr = summaryRow(s, sheetOf.get(s.name) ?? '');
    const total = visible(s);
    if (sheetOf.has(s.name) && total !== null && total + 1 > maxRows) {
      const t = { written: maxRows - 1, total };
      sr.cells[11] = `${sr.cells[11] ? `${sr.cells[11]}; ` : ''}Sheet truncated at the Excel limit of ${maxRows.toLocaleString('en-US')} rows: ${t.written.toLocaleString('en-US')} of ${t.total.toLocaleString('en-US')} rows written (use "only differences" or CSV).`;
    }
    const row = summary.addRow(sr.cells);
    if (sr.flag) row.getCell(4).fill = fill(sr.flag);
    row.commit();
  }
  summary.addRow([]).commit();
  const info: Array<[string, string | number]> = [
    ['File A', meta.fileA], ['File B', meta.fileB], ['Eps (absolute)', meta.eps], ['RelEps (relative)', meta.relEps],
    ...(meta.cmpDefaults ? [['Compare defaults', 'yes (one-sided default records count as differences)'] as [string, string]] : []),
    ...(meta.cmpDomains ? [['Compare domains', 'yes (symbols with different domains are different)'] as [string, string]] : []),
    ['Rows', req.export.onlyDiff ? 'only differences' : 'all rows'], ['Legend', 'green = only in B (added), red = only in A (removed), yellow = changed value'],
    ...(meta.extra ?? []).map((x): [string, string] => ['Note', x]),
  ];
  for (const [k, v] of info) {
    const r = summary.addRow([k, v]);
    r.getCell(1).font = { bold: true };
    r.commit();
  }
  await summary.commit();

  // the symbol sheets follow in order (a streaming workbook writes its sheets one after the other)
  for (const { symbol, sheet } of sheets) {
    progress?.(symbol.name);
    const cols = exportColumns(symbol, req.export);
    const ws = wb.addWorksheet(sheet, {
      views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
    });
    ws.columns = cols.map((c) => ({ width: colWidth(c.header, c.kind) }));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    const head = ws.addRow(cols.map((c) => c.header));
    head.font = { bold: true };
    head.eachCell((cell) => { cell.fill = HEADER_FILL; });
    head.commit();
    let written = 0;
    let total = 0;
    for await (const page of recordPages(symbol, req, request)) {
      total = page.total;
      for (const rec of page.records) {
        if (written + 1 >= maxRows) break; // header row + data rows must fit the sheet
        const cells = exportRow(cols, rec);
        const row = ws.addRow(cells.map(xlsxValue));
        cells.forEach((c, i) => {
          if (c.flag) row.getCell(i + 1).fill = fill(c.flag);
        });
        row.commit();
        written++;
      }
      if (written + 1 >= maxRows) break;
    }
    if (total > written) truncated.push({ name: symbol.name, written, total });
    await ws.commit();
  }

  await wb.commit();
  return { sheets, truncated };
}

export type { CompareExportOptions };
