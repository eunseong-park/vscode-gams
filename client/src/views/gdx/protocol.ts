// SPDX-License-Identifier: GPL-3.0-or-later
import type { GdxRecord, GdxSymbolInfo } from './model';
import type { PivotState } from './pivot';
import type { DisplayPrefs } from './prefs';
import type { QueryParams, ViewFilters } from './query';

export type RpcMethod = 'records' | 'labels' | 'table' | 'defaults';

/** Result of `gams/gdxRecords` (sorted / filtered when a query is given). */
export interface RecordsResult {
  total: number;
  unfiltered?: number;
  records: GdxRecord[];
}

/** Result of `gams/gdxDefaults`: per value column, every record has the default value (empty for non var / equ). */
export interface DefaultsResult {
  allDefault: boolean[];
}

/** Result of `gams/gdxTable`: one window of the pivot. */
export interface TableResult {
  rowCount: number;
  colCount: number;
  rowOffset: number;
  colOffset: number;
  rowDims: number[];
  colDims: number[];
  rowHeaders: string[][];
  colHeaders: string[][];
  cells: (number | string | null)[][];
  /** sets: per row one char per cell, `1` element with text, `0` without text (the cell shows the placeholder `Y`), `-` no element */
  hasText?: string[];
}

export interface ExportRequest {
  view: 'list' | 'table';
  symbol: Pick<GdxSymbolInfo, 'index' | 'name' | 'dim' | 'kind' | 'domain'>;
  query: QueryParams;
  /** value slots shown in the list view */
  valueCols: number[];
  pivot?: PivotState;
}

/** One symbol of the Excel export dialog with the state of its view (filters, layout, attributes). */
export interface ExcelExportSymbol {
  index: number;
  name: string;
  aliasOf?: string;
  dim: number;
  kind: GdxSymbolInfo['kind'];
  domain: string[];
  view: 'list' | 'table';
  pivot?: PivotState;
  /** visible attributes of the symbol's view */
  attrs: boolean[];
  labelFilters: ViewFilters['labels'];
  valueFilters: ViewFilters['values'];
}

export interface ExcelExportRequest {
  symbols: ExcelExportSymbol[];
  applyFilters: boolean;
  hiddenAttributes: boolean;
  /** extension option: first row with the domain names / attribute names, frozen and filterable (default off) */
  headerRow?: boolean;
  excelFile: string;
  connectFile: string;
  substitutions: { eps: string; posInf: string; negInf: string; undef: string; na: string };
  /** "Save Connect file only" */
  connectOnly: boolean;
}

/** Webview -> extension */
export type ToExtension =
  | { type: 'ready' }
  | { type: 'symbols' }
  | { type: 'rpc'; reqId: number; method: RpcMethod; params: Record<string, unknown> }
  | ({ type: 'exportCsv' } & ExportRequest)
  | { type: 'clipboard'; text: string }
  /** open this file (a gdxdiff result) in the colored GDX compare view */
  | { type: 'openDiffView' }
  | { type: 'exportDefaults' }
  | { type: 'browse'; kind: 'excel' | 'connect'; current: string }
  | ({ type: 'exportExcel' } & ExcelExportRequest)
  /** remember the display preferences (thousands separator, number format) for new views */
  | { type: 'prefs'; prefs: DisplayPrefs }
  /** save text (an SVG chart) via a save dialog */
  | { type: 'saveText'; suggestedName: string; text: string; filter: string };

/** Extension -> webview */
export type ToWebview =
  | { type: 'init'; fileName: string; /** vscode.env.language, used for the thousands separator */ language: string; prefs?: DisplayPrefs; exportHeaderRow?: boolean }
  | { type: 'symbols'; symbols: GdxSymbolInfo[] }
  | { type: 'symbolsError'; message: string }
  | { type: 'rpcResult'; reqId: number; result: unknown }
  | { type: 'rpcError'; reqId: number; message: string }
  | { type: 'reload' }
  | { type: 'deleted' }
  /** select a symbol by name (`gams.openGdxSymbol`); applied once the symbol list is loaded */
  | { type: 'select'; name: string }
  | { type: 'exportDefaults'; excelFile: string; connectFile: string }
  | { type: 'browsed'; kind: 'excel' | 'connect'; path: string };
