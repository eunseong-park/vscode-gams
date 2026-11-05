// SPDX-License-Identifier: GPL-3.0-or-later
// Pure row building shared by the compare CSV and Excel exports (extension feature). One export row is
// `Status | key columns | per shown value slot: A, B, AbsDiff, RelDiff`. Numbers stay numbers (full
// precision), special values are text (EPS, INF, -INF, UNDEF, NA), labels are plain strings.
import { SPECIAL_EXPORT_NAMES } from '../gdx/csv';
import {
  CellFlag, CompareRecord, CompareSymbol, ROW_STATUS_LABEL, RowStatus, SymbolStatus, ValueColumn, keyFlag, valueColumns, valueFlag,
} from './model';

export interface CompareExportOptions {
  /** visible attribute slots of variables / equations */
  attrs: boolean[];
  /** write the AbsDiff / RelDiff columns */
  diffColumns: boolean;
  /** row filter applied by the server (default: all rows) */
  onlyDiff: boolean;
  statuses?: RowStatus[];
}

export const DEFAULT_EXPORT_OPTIONS: CompareExportOptions = { attrs: [true, true, true, true, true], diffColumns: true, onlyDiff: false };

export type ExportKind = 'status' | 'key' | 'text' | 'a' | 'b' | 'abs' | 'rel';

export interface ExportColumn {
  header: string;
  kind: ExportKind;
  /** value slot (a / b / abs / rel) or key dimension (key) */
  index: number;
}

export interface ExportCell {
  /** number, text (labels, status, special values) or null (empty cell) */
  value: number | string | null;
  /** text, never reinterpreted (labels, set texts, status) as opposed to a value cell */
  text: boolean;
  flag?: CellFlag;
}

/** Key column names: the domain names; relaxed `*` and repeated names get a position suffix. */
export function keyNames(domain: readonly string[], dim: number): string[] {
  const count = new Map<string, number>();
  for (let d = 0; d < dim; d++) count.set(domain[d] ?? '*', (count.get(domain[d] ?? '*') ?? 0) + 1);
  return Array.from({ length: dim }, (_, d) => {
    const n = domain[d] ?? '*';
    if (n === '*' || n === '') return `uni_${d + 1}`;
    return (count.get(n) ?? 0) > 1 ? `${n}_${d + 1}` : n;
  });
}

export function exportColumns(sym: Pick<CompareSymbol, 'kind' | 'dim' | 'domain' | 'slots'>, o: CompareExportOptions): ExportColumn[] {
  const cols: ExportColumn[] = [{ header: 'Status', kind: 'status', index: 0 }];
  keyNames(sym.domain, sym.dim).forEach((n, d) => cols.push({ header: n, kind: 'key', index: d }));
  const vc: ValueColumn[] = valueColumns(sym, o.attrs);
  const isSet = sym.kind === 'Set' || sym.kind === 'Alias';
  const multi = sym.kind === 'Variable' || sym.kind === 'Equation';
  for (const c of vc) {
    const sfx = multi ? ` ${c.label}` : '';
    cols.push({ header: `A${sfx}`, kind: isSet ? 'text' : 'a', index: c.slot });
    cols.push({ header: `B${sfx}`, kind: isSet ? 'text' : 'b', index: c.slot });
    // sets compare element text: the B column is a text as well
    if (isSet) cols[cols.length - 1] = { header: `B${sfx}`, kind: 'text', index: c.slot + 1000 };
    if (o.diffColumns && !isSet) {
      cols.push({ header: `AbsDiff${sfx}`, kind: 'abs', index: c.slot });
      cols.push({ header: `RelDiff${sfx}`, kind: 'rel', index: c.slot });
    }
  }
  return cols;
}

function valueCell(v: number | string | null | undefined, flag: CellFlag): ExportCell {
  if (v === null || v === undefined) return { value: null, text: false, flag };
  // strings in value cells are special values (EPS, -INF, ...), never labels
  return { value: v, text: false, flag };
}

export function exportRow(cols: readonly ExportColumn[], rec: CompareRecord): ExportCell[] {
  const kf = keyFlag(rec);
  return cols.map((c): ExportCell => {
    switch (c.kind) {
      case 'status':
        return { value: ROW_STATUS_LABEL[rec.status], text: true, flag: rec.status === 'changed' ? 'changed' : kf };
      case 'key':
        return { value: rec.keys[c.index] ?? '', text: true, flag: kf };
      case 'text': {
        // set element texts: index >= 1000 means the B side
        const b = c.index >= 1000;
        const v = (b ? rec.b : rec.a)?.[0];
        // an element without text is written empty (gdxdump style); the protocol's placeholder `Y` is not a text
        const none = v === null || v === undefined || (b ? rec.bNoText : rec.aNoText) === true;
        return { value: none ? null : String(v), text: true, flag: valueFlag(rec, 0) };
      }
      case 'a': return valueCell(rec.a?.[c.index], valueFlag(rec, c.index));
      case 'b': return valueCell(rec.b?.[c.index], valueFlag(rec, c.index));
      case 'abs': return valueCell(rec.abs?.[c.index], valueFlag(rec, c.index));
      case 'rel': return valueCell(rec.rel?.[c.index], valueFlag(rec, c.index));
    }
  });
}

/** Special-value text used in files (same names as the viewer's CSV export and Studio's export dialog). */
export function specialText(v: string): string {
  return SPECIAL_EXPORT_NAMES[v] ?? v;
}

// ---- summary ----

export const SUMMARY_HEADER = ['Symbol', 'Type', 'Dimension', 'Status', 'Changed', 'Added', 'Removed', 'Equal', 'Records A', 'Records B', 'Sheet / File', 'Note'];

export const SUMMARY_STATUS_TEXT: Record<SymbolStatus, string> = {
  onlyA: 'only in A', onlyB: 'only in B', equal: 'equal', different: 'different', unknown: 'not compared', pending: 'pending',
};

export interface SummaryRow {
  cells: (string | number | null)[];
  /** color of the status cell */
  flag?: CellFlag;
}

export function summaryFlag(s: SymbolStatus): CellFlag {
  return s === 'onlyA' ? 'removed' : s === 'onlyB' ? 'added' : s === 'different' ? 'changed' : undefined;
}

export function summaryRow(s: CompareSymbol, target: string): SummaryRow {
  const n = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : v);
  const note = s.mismatch ? `mismatch: ${s.mismatch}` : (s.note ?? '').replace(/^\[limit\]\s*/, '');
  return {
    cells: [s.name, s.kind, s.dim, SUMMARY_STATUS_TEXT[s.status], n(s.changed), n(s.added), n(s.removed), n(s.equal), n(s.aRecords), n(s.bRecords), target, note],
    flag: summaryFlag(s.status),
  };
}

/** Symbols that are exported by default: everything that differs (or could not be compared). */
export function defaultExportSymbols(symbols: readonly CompareSymbol[]): CompareSymbol[] {
  return symbols.filter((s) => s.status !== 'equal');
}

// ---- sheet names ----

export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_SHEET_NAME = 31;

/**
 * Sheet names as Studio's `generateSheetName`: names over 31 characters are cut and get `~1`, `~2`...
 * so they stay unique; characters Excel forbids are replaced by `_`. Names are unique case-insensitively
 * (also against `reserved`, e.g. the summary sheet).
 */
export function sheetNames(names: readonly string[], reserved: readonly string[] = []): string[] {
  const used = new Set(reserved.map((n) => n.toLowerCase()));
  return names.map((raw) => {
    const clean = raw.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '_') || '_';
    let name = clean.slice(0, EXCEL_MAX_SHEET_NAME);
    for (let n = 1; used.has(name.toLowerCase()); n++) {
      const sfx = `~${n}`;
      name = clean.slice(0, EXCEL_MAX_SHEET_NAME - sfx.length) + sfx;
    }
    used.add(name.toLowerCase());
    return name;
  });
}
