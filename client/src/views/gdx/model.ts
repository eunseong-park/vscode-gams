// SPDX-License-Identifier: GPL-3.0-or-later
// Pure model helpers for the GDX viewer (sorting, symbol type text, value normalisation).
// Ported from Studio src/gdxviewer/gdxsymbol.cpp (sort, specVal2SortVal) and gdxsymboltablemodel.cpp (typeAsString).
import { SV_EPS, SV_MINF, SV_NA, SV_PINF, SV_UNDEF } from './format';

export type SymbolKind = 'Set' | 'Parameter' | 'Variable' | 'Equation' | 'Alias';

export interface GdxSymbolInfo {
  index: number;
  name: string;
  dim: number;
  kind: SymbolKind;
  records: number;
  text: string;
  domain: string[];
  subType?: number | string;
  /** for aliases: name of the aliased set */
  aliasOf?: string;
}

export interface GdxRecord {
  keys: string[];
  values: (number | string)[];
  /**
   * Sets: does the element have an explanatory text? `values[0]` is Studio's placeholder `Y` for an element
   * without text (`false`), which is not the same as the real text `Y` (`true`). Absent: unknown (older server).
   */
  hasText?: boolean;
}

export const VALUE_COLUMNS = ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'] as const;

const VAR_TYPES = ['Unknown', 'Binary', 'Integer', 'Positive', 'Negative', 'Free', 'SOS1', 'SOS2', 'SemiCont', 'SemiInt'];
const EQU_TYPES = ['=e=', '=g=', '=l=', '=n=', '=x=', '=c=', '=b='];

/** GdxSymbolTableModel::typeAsString (subType may be the numeric gclgms.h code or an already-textual name). */
export function typeAsString(s: Pick<GdxSymbolInfo, 'kind' | 'subType'>): string {
  const st = s.subType;
  let extra: string | undefined;
  if (typeof st === 'string' && st !== '') extra = st;
  else if (typeof st === 'number') {
    if (s.kind === 'Set') extra = st === 1 ? 'Singleton' : undefined;
    else if (s.kind === 'Variable') extra = VAR_TYPES[st];
    else if (s.kind === 'Equation') extra = EQU_TYPES[st];
  }
  return extra ? `${s.kind} (${extra})` : s.kind;
}

/** Number of value columns for a kind (GdxSymbol::mNumericalColumnCount; Set shows a Text column). */
export function valueColumnCount(kind: SymbolKind): number {
  return kind === 'Variable' || kind === 'Equation' ? 5 : 1;
}

const SPECIAL_NAMES: Record<string, number> = {
  UNDF: SV_UNDEF, NA: SV_NA, '+INF': SV_PINF, INF: SV_PINF, '-INF': SV_MINF, EPS: SV_EPS,
};

/** Accept servers that send special values as text. */
export function normalizeValue(v: number | string, kind: SymbolKind): number | string {
  if (typeof v === 'string' && kind !== 'Set' && v in SPECIAL_NAMES) return SPECIAL_NAMES[v];
  return v;
}

/** GdxSymbol::specVal2SortVal */
export function specVal2SortVal(v: number): number {
  if (v === SV_UNDEF) return 5e300;
  if (v === SV_NA) return 4e300;
  if (v === SV_PINF) return 3e300;
  if (v === SV_MINF) return -Number.MAX_VALUE;
  if (v === SV_EPS) return 4.94e-324;
  return v;
}

export function compareLabels(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}

export function compareNumbers(a: number | string, b: number | string): number {
  const x = specVal2SortVal(Number(a));
  const y = specVal2SortVal(Number(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export type SortColumn = { type: 'key'; dim: number } | { type: 'value'; idx: number };

/**
 * Stable sort of record indices (GdxSymbol::sort). Keys compare case-insensitively;
 * Set text values compare case-sensitively; numbers use special-value sort order.
 */
export function sortIndices(
  records: readonly GdxRecord[],
  indices: number[],
  col: SortColumn,
  ascending: boolean,
  kind: SymbolKind,
): number[] {
  const sign = ascending ? 1 : -1;
  const cmp = (i: number, j: number): number => {
    const a = records[i];
    const b = records[j];
    let c: number;
    if (col.type === 'key') c = compareLabels(a.keys[col.dim] ?? '', b.keys[col.dim] ?? '');
    else if (kind === 'Set' || kind === 'Alias') {
      const x = String(a.values[col.idx] ?? '');
      const y = String(b.values[col.idx] ?? '');
      c = x < y ? -1 : x > y ? 1 : 0;
    } else c = compareNumbers(a.values[col.idx] ?? 0, b.values[col.idx] ?? 0);
    return c * sign;
  };
  return indices.slice().sort(cmp);
}

const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
export function superscript(n: number): string {
  return String(n).replace(/\d/g, (d) => SUPERSCRIPTS[Number(d)]);
}

/** Key column header: `<domainName> <superscript index>` (Studio GdxSymbol::headerData). */
export function keyHeader(domain: string[], d: number): string {
  return `${domain[d] ?? '*'}${superscript(d + 1)}`;
}

/** Build a key-column filter predicate: regex if it parses (case-insensitive), else substring. Empty => accept all. */
export function makeTextFilter(text: string): ((s: string) => boolean) | undefined {
  if (text === '') return undefined;
  try {
    const re = new RegExp(text, 'i');
    return (s) => re.test(s);
  } catch {
    const t = text.toLowerCase();
    return (s) => s.toLowerCase().includes(t);
  }
}
