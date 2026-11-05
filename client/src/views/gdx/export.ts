// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LineWriter } from './lineWriter';
import { csvLine, safeLabel, listHeader, listRow, ListExportSpec, tableHeaderRows, rawText } from './csv';
import { VALUE_COLUMNS } from './model';
import type { ExportRequest, RecordsResult, TableResult } from './protocol';

type Request = <T>(method: string, params: unknown) => Promise<T>;

const LIST_PAGE = 20000;
const TABLE_ROWS = 500;

/**
 * Export the current view (with its sort / filters, taken from the whole symbol on the server)
 * to a CSV file. Port note: Studio exports via GAMS Connect (GDXReader + ExcelWriter,
 * src/gdxviewer/exportdriver.cpp); this implements the CSV subset natively.
 */
export async function exportCsv(req: ExportRequest, gdxPath: string, request: Request): Promise<string | undefined> {
  const def = vscode.Uri.file(path.join(path.dirname(gdxPath), `${req.symbol.name}.csv`));
  const target = await vscode.window.showSaveDialog({ defaultUri: def, filters: { CSV: ['csv'] }, title: `Export ${req.symbol.name} to CSV` });
  if (!target) return undefined;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Exporting ${req.symbol.name}…` },
    async () => {
      const w = new LineWriter(target.fsPath);
      let failure: unknown;
      try {
        if (req.view === 'table' && req.pivot && req.symbol.dim > 0) await writeTable(w, req, gdxPath, request);
        else await writeList(w, req, gdxPath, request);
      } catch (e) {
        failure = e;
      }
      try {
        await w.close();
      } catch (e) {
        failure ??= e;
      }
      if (failure) throw failure;
    },
  );
  const open = await vscode.window.showInformationMessage(`Exported ${req.symbol.name} to ${target.fsPath}`, 'Open');
  if (open === 'Open') void vscode.window.showTextDocument(target);
  return target.fsPath;
}

async function writeList(w: LineWriter, req: ExportRequest, gdxPath: string, request: Request): Promise<void> {
  const k = req.symbol.kind;
  const spec: ListExportSpec = {
    domain: req.symbol.domain,
    isSet: k === 'Set' || k === 'Alias',
    isParameter: k === 'Parameter',
    valueNames: VALUE_COLUMNS,
    valueCols: req.valueCols,
  };
  await w.write(csvLine(listHeader(spec)));
  for (let offset = 0; ; ) {
    const r = await request<RecordsResult>('gams/gdxRecords', {
      path: gdxPath, symbolIndex: req.symbol.index, offset, limit: LIST_PAGE, ...req.query,
    });
    let text = '';
    for (const rec of r.records) text += csvLine(listRow(spec, rec.keys, rec.values, rec.hasText));
    await w.write(text);
    offset += r.records.length;
    if (r.records.length === 0 || offset >= r.total) break;
  }
}

async function writeTable(w: LineWriter, req: ExportRequest, gdxPath: string, request: Request): Promise<void> {
  const p = req.pivot!;
  const base = { path: gdxPath, symbolIndex: req.symbol.index, rowDims: p.rowDims, colDims: p.colDims, valueField: p.valueField, ...req.query };
  delete (base as { sort?: unknown }).sort;
  const first = await request<TableResult>('gams/gdxTable', { ...base, rowOffset: 0, rowLimit: 0, colOffset: 0, colLimit: 1_000_000 });
  const rowNames = p.rowDims.map((d) => req.symbol.domain[d] ?? '*');
  for (const h of tableHeaderRows(rowNames, p.colDims.length, first.colHeaders)) await w.write(csvLine(h));
  for (let off = 0; off < first.rowCount; off += TABLE_ROWS) {
    const r = await request<TableResult>('gams/gdxTable', { ...base, rowOffset: off, rowLimit: TABLE_ROWS, colOffset: 0, colLimit: first.colCount });
    let text = '';
    r.rowHeaders.forEach((h, i) => { text += csvLine([...h.map(safeLabel), ...r.cells[i].map((c) => rawText(c, true))]); });
    await w.write(text);
  }
}
