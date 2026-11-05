// SPDX-License-Identifier: GPL-3.0-or-later
import type { CompareNextResult, CompareOptions, CompareRecordsResult, CompareSymbolsResult } from './model';
import type { DisplayPrefs } from '../gdx/prefs';

/** What the panel compares: two GDX files, or the output file of gdxdiff. */
export type CompareSource = { kind: 'files'; a: string; b: string } | { kind: 'diffFile'; path: string };

export type CompareOp = 'symbols' | 'records' | 'next';

export interface CompareRpcParams {
  name?: string;
  offset?: number;
  limit?: number;
  onlyDiff?: boolean;
  statuses?: string[];
  from?: number;
  backward?: boolean;
  options?: CompareOptions;
  /** `symbols`: merge all symbols (exact statuses) / only these (default: none, statuses stay `pending`) */
  full?: boolean;
  names?: string[];
}

export interface CompareResults {
  symbols: CompareSymbolsResult;
  records: CompareRecordsResult;
  next: CompareNextResult;
}

export interface ExportRequest {
  format: 'csv' | 'xlsx';
  /** symbol on screen (preselected in the symbol picker) */
  current?: string;
  options: CompareOptions;
  attrs: boolean[];
  diffColumns: boolean;
  onlyDiff: boolean;
}

/** Webview -> extension */
export type ToExtension =
  | { type: 'ready' }
  | { type: 'rpc'; reqId: number; op: CompareOp; params: CompareRpcParams }
  | ({ type: 'export' } & ExportRequest)
  | { type: 'cancel'; reqId: number }
  | { type: 'openRaw' }
  | { type: 'swap' }
  | { type: 'prefs'; prefs: DisplayPrefs }
  | { type: 'clipboard'; text: string };

/** Extension -> webview */
export type ToWebview =
  | {
      type: 'init';
      mode: 'files' | 'diffFile';
      /** full paths (A / B; the diff file for `diffFile`) */
      fileA: string;
      fileB: string;
      nameA: string;
      nameB: string;
      language: string;
      prefs?: DisplayPrefs;
      initialSymbol?: string;
    }
  | { type: 'rpcResult'; reqId: number; result: unknown }
  | { type: 'rpcError'; reqId: number; message: string }
  | { type: 'reload' }
  | { type: 'select'; name: string };
