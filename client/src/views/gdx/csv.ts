// SPDX-License-Identifier: GPL-3.0-or-later
// CSV / clipboard text builders for the GDX viewer (pure).
// Clipboard quoting follows Studio's GdxSymbolView::copySelectionToString (gdxsymbolview.cpp): a cell
// containing the separator is wrapped in ' (or in " if it contains '). Files written by "Export CSV"
// use RFC 4180 quoting. Special values in files use the defaults of Studio's export dialog
// (exportdriver.cpp valueSubstitutions: EPS, INF, -INF, UNDEF, NA).

export type Cell = number | string | null | undefined;

/** Special value -> text in exported files (Studio export dialog defaults). */
export const SPECIAL_EXPORT_NAMES: Record<string, string> = { UNDF: 'UNDEF', '+INF': 'INF', '-INF': '-INF', EPS: 'EPS', NA: 'NA' };

/** Raw (unformatted, full precision) text of a cell for export / copy. */
export function rawText(v: Cell, forFile: boolean): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  return forFile ? (SPECIAL_EXPORT_NAMES[v] ?? v) : v;
}

/**
 * Element text of a set record in an exported file, like gdxdump: nothing for an element without text and the
 * real text otherwise (a genuine text `Y` stays; the viewer protocol shows Studio's placeholder `Y` for elements
 * without text, flagged by `hasText === false`).
 */
export function setTextForFile(v: Cell, hasText: boolean | undefined): string {
  if (hasText === false || v === null || v === undefined) return '';
  return String(v);
}

/** `hasText` marks of a pivot window (`TableResult.hasText`) at row `r`, column `c`: false = element without text. */
export function tableCellHasText(marks: readonly string[] | undefined, r: number, c: number): boolean | undefined {
  const m = marks?.[r]?.[c];
  return m === undefined ? undefined : m !== '0';
}

/**
 * CSV formula-injection guard for exported FILES: a label / text cell (set element, domain name, set text, header)
 * starting with = + - @ TAB or CR would be evaluated as a formula by spreadsheets, so it gets a leading '.
 * Applied only to labels and text, never to numeric value cells (negative numbers and the special values
 * -INF / EPS ... stay as they are). The clipboard copy (copyField/copyText) is deliberately NOT prefixed, to keep
 * Studio's copy behaviour (gdxsymbolview.cpp copySelectionToString) and exact round-tripping on paste.
 */
export function safeLabel(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** RFC 4180 field. */
export function csvField(s: string, sep = ','): string {
  return s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r') ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(fields: readonly string[], sep = ','): string {
  return fields.map((f) => csvField(f, sep)).join(sep) + '\n';
}

/** Studio clipboard quoting for one cell. */
export function copyField(s: string, sep: string): string {
  if (!s.includes(sep)) return s;
  return s.includes("'") ? `"${s}"` : `'${s}'`;
}

/** Rows of cells -> text joined with `sep` (no trailing newline), Studio clipboard style. */
export function copyText(rows: readonly (readonly string[])[], sep: string): string {
  return rows.map((r) => r.map((c) => copyField(c, sep)).join(sep)).join('\n');
}

export interface ListExportSpec {
  domain: string[];
  isSet: boolean;
  isParameter: boolean;
  valueNames: readonly string[];
  /** value slots to export */
  valueCols: number[];
}

export function listHeader(s: ListExportSpec): string[] {
  const keys = s.domain.map(safeLabel);
  if (s.isSet) return [...keys, 'Text'];
  if (s.isParameter) return [...keys, 'Value'];
  return [...keys, ...s.valueCols.map((i) => s.valueNames[i])];
}

export function listRow(s: ListExportSpec, keys: readonly string[], values: readonly Cell[], hasText?: boolean): string[] {
  const out = keys.map(safeLabel);
  if (s.isSet) out.push(safeLabel(setTextForFile(values[0], hasText)));
  else for (const i of s.valueCols) out.push(rawText(values[i], true));
  return out;
}

/**
 * Header rows of a pivot export: one row per column dimension with `rowDimCount` leading blanks
 * (the row-header columns), then one cell per column tuple.
 */
export function tableHeaderRows(
  rowDimNames: readonly string[],
  colDimCount: number,
  colHeaders: readonly (readonly string[])[],
): string[][] {
  if (colDimCount === 0) return [[...rowDimNames.map(safeLabel), 'Value']];
  const rows: string[][] = [];
  for (let k = 0; k < colDimCount; k++) {
    // row dimension names label the last header row, above the row-header columns
    const lead = rowDimNames.map((n) => (k === colDimCount - 1 ? safeLabel(n) : ''));
    rows.push([...lead, ...colHeaders.map((h) => safeLabel(h[k] ?? ''))]);
  }
  return rows;
}
