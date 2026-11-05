// SPDX-License-Identifier: GPL-3.0-or-later
// CSV export of the compare view (extension feature): one file for one symbol; for several symbols a
// folder with one CSV per symbol plus summary.csv. Numbers are written with full precision, special
// values as text, labels with the formula guard of the viewer's CSV export (safeLabel).
import * as fs from 'fs';
import * as path from 'path';
import { csvLine, safeLabel } from '../gdx/csv';
import { LineWriter } from '../gdx/lineWriter';
import {
  CompareExportOptions, ExportCell, ExportColumn, SUMMARY_HEADER, exportColumns, exportRow, specialText, summaryRow,
} from './exportModel';
import { optionParams } from './model';
import type { CompareOptions, CompareRecordsResult, CompareSymbol } from './model';

export { optionParams };

export type Request = <T>(method: string, params: unknown) => Promise<T>;
export type Progress = (message: string) => void;

export const EXPORT_PAGE = 5000;

/** Text of one cell in a CSV file. */
export function csvCell(c: ExportCell): string {
  if (c.value === null) return '';
  if (typeof c.value === 'number') return String(c.value);
  return c.text ? safeLabel(c.value) : specialText(c.value);
}

export function csvHeader(cols: readonly ExportColumn[]): string {
  return csvLine(cols.map((c) => safeLabel(c.header)));
}

export function csvRecordLine(cols: readonly ExportColumn[], rec: Parameters<typeof exportRow>[1]): string {
  return csvLine(exportRow(cols, rec).map(csvCell));
}

export function csvSummary(symbols: readonly CompareSymbol[], fileOf: (s: CompareSymbol) => string): string {
  let t = csvLine(SUMMARY_HEADER);
  for (const s of symbols) t += csvLine(summaryRow(s, fileOf(s)).cells.map((c) => (c === null ? '' : typeof c === 'number' ? String(c) : safeLabel(c))));
  return t;
}

export interface SymbolRequest {
  base: Record<string, unknown>;
  method: string;
  options: CompareOptions;
  export: CompareExportOptions;
}

/** Pages of one symbol's merged records. */
export async function* recordPages(
  sym: CompareSymbol, req: SymbolRequest, request: Request, maxRows = Number.POSITIVE_INFINITY,
): AsyncGenerator<CompareRecordsResult> {
  for (let offset = 0; offset < maxRows; ) {
    const limit = Math.min(EXPORT_PAGE, maxRows - offset);
    const r = await request<CompareRecordsResult>(req.method, {
      ...req.base, ...optionParams(req.options), name: sym.name, offset, limit, onlyDiff: req.export.onlyDiff,
      ...(req.export.statuses ? { statuses: req.export.statuses } : {}),
    });
    yield r;
    offset += r.records.length;
    if (r.records.length === 0 || offset >= r.total) break;
  }
}


async function writeSymbolCsv(file: string, sym: CompareSymbol, req: SymbolRequest, request: Request): Promise<void> {
  const cols = exportColumns(sym, req.export);
  const w = new LineWriter(file);
  let failure: unknown;
  try {
    await w.write(csvHeader(cols));
    for await (const page of recordPages(sym, req, request)) {
      let text = '';
      for (const rec of page.records) text += csvRecordLine(cols, rec);
      await w.write(text);
    }
  } catch (e) {
    failure = e;
  }
  try {
    await w.close();
  } catch (e) {
    failure ??= e;
  }
  if (failure) throw failure;
}

/** File name of a symbol's CSV (symbol names are alphanumeric in GAMS, still sanitized). */
export function csvFileName(name: string): string {
  return `${name.replace(/[^\w.-]+/g, '_')}.csv`;
}

/** `name.csv` unless taken (case-insensitive): then `name_1.csv`, `name_2.csv`, ...; records the result in `used`. */
export function uniqueCsvName(file: string, used: Set<string>): string {
  const base = file.replace(/\.csv$/i, '');
  let f = file;
  for (let i = 1; used.has(f.toLowerCase()); i++) f = `${base}_${i}.csv`;
  used.add(f.toLowerCase());
  return f;
}

/** Single symbol -> `target` is the CSV file; otherwise `target` is a folder (created) with one CSV per symbol and summary.csv. */
export async function exportCompareCsv(
  target: string, symbols: readonly CompareSymbol[], all: readonly CompareSymbol[], req: SymbolRequest, request: Request, progress?: Progress,
): Promise<string[]> {
  if (symbols.length === 1) {
    await writeSymbolCsv(target, symbols[0], req, request);
    return [target];
  }
  await fs.promises.mkdir(target, { recursive: true });
  const written: string[] = [];
  const files = new Map<string, string>();
  const usedNames = new Set<string>(['summary.csv']); // reserved for the summary
  for (const s of symbols) {
    progress?.(s.name);
    const f = uniqueCsvName(csvFileName(s.name), usedNames);
    files.set(s.name, f);
    await writeSymbolCsv(path.join(target, f), s, req, request);
    written.push(path.join(target, f));
  }
  const summaryFile = path.join(target, 'summary.csv');
  await fs.promises.writeFile(summaryFile, csvSummary(all, (s) => files.get(s.name) ?? ''), 'utf8');
  written.push(summaryFile);
  return written;
}
