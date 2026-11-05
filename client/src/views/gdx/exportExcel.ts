// SPDX-License-Identifier: GPL-3.0-or-later
// Host side of the viewer's Excel export (port of Studio's ExportDialog / ExportDriver flow): validation,
// request -> Connect symbols / native sheet specs, writing the Connect file and the workbook.
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_SUBSTITUTIONS, ConnectOptions, ConnectSymbol, generateConnectYaml } from './connect';
import type { ExcelExportRequest, ExcelExportSymbol } from './protocol';
import { buildQueryParams } from './query';
import { isSetLike } from './symview';
import type { XlsxSymbolSpec } from './exportXlsx';

/** Default file names next to the GDX file (`<name>_export.xlsx` / `<name>_export.yaml`, exportdialog.cpp). */
export function defaultExportFiles(gdxPath: string): { excelFile: string; connectFile: string } {
  const dir = path.dirname(gdxPath);
  const base = path.basename(gdxPath, path.extname(gdxPath));
  return { excelFile: path.join(dir, `${base}_export.xlsx`), connectFile: path.join(dir, `${base}_export.yaml`) };
}

/**
 * An alias of the universe (`Alias (u, *)`) is not exported: the Connect GDXReader fails on it
 * ("UniverseAlias not supported"), so neither the Connect file nor the workbook contains it.
 */
export function isUniverseAlias(s: Pick<ExcelExportSymbol, 'kind' | 'aliasOf'>): boolean {
  return s.kind === 'Alias' && !s.aliasOf;
}

/** The selected symbols that are exported, and the names of those that are left out. */
export function splitExportSymbols(r: Pick<ExcelExportRequest, 'symbols'>): { symbols: ExcelExportSymbol[]; skipped: string[] } {
  return { symbols: r.symbols.filter((s) => !isUniverseAlias(s)), skipped: r.symbols.filter(isUniverseAlias).map((s) => s.name) };
}

/** Note for the user about left-out symbols ('' = none). */
export function skippedNote(skipped: readonly string[]): string {
  return skipped.length ? ` Not exported (aliases of the universe are not supported by GAMS Connect): ${skipped.join(', ')}.` : '';
}

/** Validation of the dialog (ExportDialog::save); '' = ok. Relative Excel paths resolve against the GDX folder. */
export function validateExport(r: Pick<ExcelExportRequest, 'symbols' | 'excelFile' | 'connectFile' | 'connectOnly'>, gdxPath: string): { error: string; excelFile: string; connectFile: string } {
  const dir = path.dirname(gdxPath);
  let excel = r.excelFile.trim();
  if (!excel) return { error: 'Excel file can not be empty', excelFile: '', connectFile: '' };
  if (!path.isAbsolute(excel)) excel = path.join(dir, excel);
  if (path.extname(excel) === '') excel += '.xlsx';
  if (path.extname(excel).toLowerCase() !== '.xlsx') {
    return { error: `File extension of Excel file needs to be 'xlsx' but is '${path.extname(excel).slice(1)}'`, excelFile: excel, connectFile: '' };
  }
  let connect = r.connectFile.trim();
  if (!connect) return { error: 'Connect file can not be empty', excelFile: excel, connectFile: '' };
  if (!path.isAbsolute(connect)) connect = path.join(dir, connect);
  if (splitExportSymbols(r).symbols.length === 0) {
    return { error: r.symbols.length ? `Aliases of the universe cannot be exported (not supported by GAMS Connect): ${splitExportSymbols(r).skipped.join(', ')}` : 'At least one symbol has to be selected for export', excelFile: excel, connectFile: connect };
  }
  return { error: '', excelFile: excel, connectFile: connect };
}

/**
 * Attribute slots written for a variable / equation (all with hidden attributes). None selected gives `[]`:
 * Studio then projects the symbol to a set (`asSet`), i.e. only its labels are written.
 */
export function exportSlots(attrs: readonly boolean[], hidden: boolean): number[] {
  if (hidden) return [0, 1, 2, 3, 4];
  return [0, 1, 2, 3, 4].filter((i) => attrs[i]);
}

export function connectSymbols(r: ExcelExportRequest): ConnectSymbol[] {
  return splitExportSymbols(r).symbols.map((s: ExcelExportSymbol): ConnectSymbol => ({
    name: s.name,
    aliasOf: s.kind === 'Alias' ? s.aliasOf : undefined,
    dim: s.dim,
    kind: s.kind,
    labelFilters: r.applyFilters ? s.labelFilters : undefined,
    valueFilters: r.applyFilters ? s.valueFilters : undefined,
    attrs: s.attrs,
    tableColDims: s.view === 'table' && s.pivot && s.dim > 1 ? s.pivot.colDims.length : undefined,
  }));
}

export function buildConnectYaml(r: ExcelExportRequest, gdxPath: string, excelFile: string): string {
  const o: ConnectOptions = {
    gdxFile: gdxPath, excelFile, symbols: connectSymbols(r), applyFilters: r.applyFilters, hiddenAttributes: r.hiddenAttributes,
    substitutions: { ...DEFAULT_SUBSTITUTIONS, ...r.substitutions }, headerRow: r.headerRow === true,
  };
  return generateConnectYaml(o);
}

export function xlsxSpecs(r: ExcelExportRequest): XlsxSymbolSpec[] {
  return splitExportSymbols(r).symbols.map((s): XlsxSymbolSpec => ({
    index: s.index,
    name: s.name,
    dim: s.dim,
    kind: s.kind,
    domain: s.domain,
    headerRow: r.headerRow === true,
    view: s.view === 'table' && s.pivot && s.dim > 1 ? 'table' : 'list',
    pivot: s.pivot,
    slots: s.kind === 'Variable' || s.kind === 'Equation' ? exportSlots(s.attrs, r.hiddenAttributes) : [0],
    query: r.applyFilters ? buildQueryParams(s.dim, undefined, { labels: s.labelFilters, values: s.valueFilters }, isSetLike(s)) : {},
  }));
}

export async function writeConnectFile(file: string, text: string): Promise<void> {
  await fs.promises.writeFile(file, text, 'utf8');
}
