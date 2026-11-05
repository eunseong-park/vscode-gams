// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Data model of the symbol tree view. Port of the tab layout of GAMS Studio's reference viewer
 * (src/reference/referenceviewer.cpp, symbolreferenceitem.cpp, reference.cpp addSymbolReferenceItem).
 * No vscode imports.
 */

export interface RefPosition { line: number; character: number }
export interface RefLocation { uri: string; range: { start: RefPosition; end: RefPosition } }

export type KindKey = 'declare' | 'define' | 'assign' | 'implicitAssign' | 'reference' | 'control' | 'index';

/** Order and captions of the reference list of a symbol (Studio: Declared, Defined, Assigned, Implicitly Assigned, Referenced, Controlled, Indexed). */
export const KINDS: readonly { key: KindKey; label: string }[] = [
  { key: 'declare', label: 'Declared' },
  { key: 'define', label: 'Defined' },
  { key: 'assign', label: 'Assigned' },
  { key: 'implicitAssign', label: 'Implicitly Assigned' },
  { key: 'reference', label: 'Referenced' },
  { key: 'control', label: 'Controlled' },
  { key: 'index', label: 'Indexed' },
];

export interface RefSymbol {
  id: number;
  name: string;
  type: string;
  dim: number;
  domain: string[];
  text: string;
  numElements: number;
  unused: boolean;
  locations: Record<KindKey, RefLocation[]>;
}

export interface RefFile {
  id: number;
  parentId: number;
  type: string;
  globalLine: string;
  localLine: string;
  uri: string;
}

/** Response of `gams/refSymbols`. */
export interface RefData {
  refPath: string | null;
  stale?: boolean;
  symbols: RefSymbol[];
  files: RefFile[];
}

export interface GroupDef {
  id: string;
  label: string;
  /** symbol type name (`refs::type_name`) or a synthetic selector */
  select: string;
}

/** Tabs of Studio's reference viewer, in tab order. */
export const GROUPS: readonly GroupDef[] = [
  { id: 'all', label: 'All Symbols', select: '*' },
  { id: 'set', label: 'Sets', select: 'Set' },
  { id: 'acronym', label: 'Acronyms', select: 'Acronym' },
  { id: 'variable', label: 'Variables', select: 'Variable' },
  { id: 'parameter', label: 'Parameters', select: 'Parameter' },
  { id: 'equation', label: 'Equations', select: 'Equation' },
  { id: 'model', label: 'Models', select: 'Model' },
  { id: 'file', label: 'Files', select: 'File' },
  { id: 'function', label: 'Functions', select: 'Function' },
  { id: 'macro', label: 'Macros', select: 'Macro' },
  { id: 'unused', label: 'Unused', select: '#unused' },
  { id: 'fileUsed', label: 'File Used', select: '#fileUsed' },
];

export function symbolsOfGroup(data: RefData, g: GroupDef): RefSymbol[] {
  if (g.select === '*') return data.symbols;
  if (g.select === '#unused') return data.symbols.filter((s) => s.unused);
  if (g.select === '#fileUsed') return [];
  return data.symbols.filter((s) => s.type === g.select);
}

/** Name filter: `/re/` (optionally `/re/i`) is a regular expression, anything else a case-insensitive substring. */
export function makeMatcher(filter: string): ((name: string) => boolean) | undefined {
  const f = filter.trim();
  if (!f) return undefined;
  const m = /^\/(.+)\/([a-z]*)$/.exec(f);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i');
      return (n) => re.test(n);
    } catch {
      // invalid regex: fall back to substring
    }
  }
  const low = f.toLowerCase();
  return (n) => n.toLowerCase().includes(low);
}

/** `Domain` column of Studio: `(i,j)` for dim > 0. */
export function domainText(s: RefSymbol): string {
  return s.dim > 0 && s.domain.length > 0 ? `(${s.domain.join(',')})` : '';
}

/** Description of a symbol node: dimension/domain and explanatory text. */
export function symbolDescription(s: RefSymbol, showType: boolean): string {
  const parts = [] as string[];
  if (showType) parts.push(s.type);
  const dom = domainText(s);
  if (dom) parts.push(dom);
  else if (s.dim > 0) parts.push(`dim ${s.dim}`);
  if (s.text) parts.push(s.text);
  return parts.join('  ');
}

export function totalLocations(s: RefSymbol): number {
  return KINDS.reduce((n, k) => n + (s.locations[k.key]?.length ?? 0), 0);
}

export function fileChildren(data: RefData, parentId: number): RefFile[] {
  return data.files.filter((f) => f.parentId === parentId && f.id !== 0);
}

/** Files-used row text (Studio columns: File Location, Type, Line). */
export function fileDescription(f: RefFile): string {
  const line = f.localLine && f.localLine !== '0' ? `line ${f.localLine}` : '';
  return [f.type, line].filter(Boolean).join('  ');
}
