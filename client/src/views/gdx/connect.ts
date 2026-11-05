// SPDX-License-Identifier: GPL-3.0-or-later
// GAMS Connect instructions for the Excel export of the GDX viewer. Port of Studio's
// src/gdxviewer/exportdriver.cpp (generateInstructions / generateGdxReader / generateFilters /
// generateProjections / generateExcelWriter / generateSheetName): GDXReader -> [Filter] -> [Projection]
// -> ExcelWriter. Pure. The extension itself writes the workbook natively (exportXlsx.ts), so the file
// is an equivalent recipe for `gamsconnect` / `$onEmbeddedCode Connect` and is validated against the
// Connect schema in the unit tests.
import type { SymbolKind } from './model';
import type { LabelFilterState, ValueFilterState } from './query';
import { isDefaultValueFilter } from './query';

export const PROJ_SUFFIX = '_proj_';
export const FILTER_SUFFIX = '_filter_';

export interface ConnectSymbol {
  name: string;
  /** name of the aliased set when this symbol is an alias */
  aliasOf?: string;
  dim: number;
  kind: SymbolKind;
  /** label filter per key dimension (0-based), value filter per value slot; only used with `applyFilters` */
  labelFilters?: Record<number, LabelFilterState>;
  valueFilters?: Record<number, ValueFilterState>;
  /** visible attributes (level, marginal, lower, upper, scale) of variables / equations */
  attrs: boolean[];
  /** table view active: number of column dimensions */
  tableColDims?: number;
}

export interface SpecialSubstitutions {
  eps: string;
  posInf: string;
  negInf: string;
  undef: string;
  na: string;
}

export const DEFAULT_SUBSTITUTIONS: SpecialSubstitutions = { eps: 'EPS', posInf: 'INF', negInf: '-INF', undef: 'UNDEF', na: 'NA' };

export interface ConnectOptions {
  gdxFile: string;
  excelFile: string;
  symbols: ConnectSymbol[];
  applyFilters: boolean;
  hiddenAttributes: boolean;
  substitutions: SpecialSubstitutions;
  /** the workbook gets a header row from the extension; Connect's ExcelWriter has no option for it */
  headerRow?: boolean;
}

export const HEADER_ROW_NOTE = [
  '# Note: the "Header row with domain names" option of the vscode-gams export adds the first row (domain / attribute',
  '# names, frozen, with autofilter) to the workbook only. GAMS Connect\'s ExcelWriter has no option for it',
  '# (columnDimension only spreads the last dimensions over header rows), so running this file writes no such row.\n',
].join('\n');

const isVarEqu = (k: SymbolKind): boolean => k === 'Variable' || k === 'Equation';

/** Single-quoted YAML scalar (embedded `'` doubled); control characters need a double-quoted (JSON-escaped) scalar. */
export function quoteSubstitution(v: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(v)) return JSON.stringify(v);
  return `'${v.replace(/'/g, "''")}'`;
}

export function hasActiveLabelFilter(s: ConnectSymbol): boolean {
  return Object.values(s.labelFilters ?? {}).length > 0;
}
export function hasActiveValueFilter(s: ConnectSymbol): boolean {
  return Object.values(s.valueFilters ?? {}).some((v) => !isDefaultValueFilter(v));
}
export function hasActiveFilter(s: ConnectSymbol): boolean {
  return hasActiveLabelFilter(s) || hasActiveValueFilter(s);
}

/** YAML scalar: plain when safe, else single-quoted. */
export function yamlScalar(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_./\\~-][^:#'"\n]*$/.test(s) && !/\s$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/^[-+]?[0-9.]/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** `(0,1,2)` index list of Studio's generateDomains. */
export function domains(dim: number): string {
  return dim > 0 ? `(${Array.from({ length: dim }, (_, i) => i).join(',')})` : '';
}

/** Studio generateSheetName: names over 31 characters are cut and numbered `~1`, `~2` ... */
export function sheetNameFor(name: string, used: string[]): string {
  if (name.length <= 31) return name;
  for (let n = 1; ; n++) {
    const sfx = `~${n}`;
    const cand = name.slice(0, 31 - sfx.length) + sfx;
    if (!used.includes(cand)) {
      used.push(cand);
      return cand;
    }
  }
}

const SUFFIX_NAMES = ['l', 'm', 'lo', 'up', 'scale'];
const ATTRIBUTE_NAMES = ['level', 'marginal', 'lower', 'upper', 'scale'];

/** Projection suffix of a variable / equation: `.all` or `.[l, m]`. */
export function attributeSuffix(attrs: readonly boolean[], hidden: boolean): string {
  if (hidden || attrs.every(Boolean)) return '.all';
  const list = SUFFIX_NAMES.filter((_, i) => attrs[i]);
  return list.length ? `.[${list.join(', ')}]` : '';
}

/** Studio formats numbers with the g-format at full precision. */
function num(v: number): string {
  return String(v);
}

function valueFilterYaml(slot: number, vf: ValueFilterState, kind: SymbolKind): string {
  const attr = isVarEqu(kind) ? ATTRIBUTE_NAMES[slot] : 'value';
  let y = `      - attribute: ${attr}\n`;
  const lo = vf.min !== undefined;
  const hi = vf.max !== undefined;
  // Studio always writes both bounds; an unset bound is simply left out
  if (vf.exclude) {
    const parts = [lo ? `(x<${num(vf.min!)})` : '', hi ? `(x>${num(vf.max!)})` : ''].filter(Boolean);
    y += `        rule: ${parts.length ? parts.join(' | ') : '(x!=x)'}\n`;
  } else {
    const parts = [lo ? `(x>=${num(vf.min!)})` : '', hi ? `(x<=${num(vf.max!)})` : ''].filter(Boolean);
    y += `        rule: ${parts.length ? parts.join(' & ') : '(x==x)'}\n`;
  }
  const reject: string[] = [];
  if (!vf.showEps) reject.push('EPS');
  if (!vf.showPInf) reject.push('INF');
  if (!vf.showMInf) reject.push('-INF');
  if (!vf.showNA) reject.push('NA');
  if (!vf.showUndef) reject.push('UNDEF');
  if (reject.length) y += `        rejectSpecialValues: [${reject.join(', ')}]\n`;
  return y;
}

export function generateConnectYaml(o: ConnectOptions): string {
  const sheets: string[] = [];
  const noAttributes = new Set<string>();
  let y = o.headerRow ? HEADER_ROW_NOTE : '';

  // GDXReader (+ Projection for aliases)
  y += `- GDXReader:\n    file: ${yamlScalar(o.gdxFile)}\n    symbols: \n`;
  let names = '';
  let aliasProj = '';
  for (const s of o.symbols) {
    names += `      - name: ${s.aliasOf ?? s.name}\n`;
    if (s.aliasOf) {
      const dom = domains(s.dim);
      aliasProj += `- Projection:\n    name: ${s.aliasOf}${dom}\n    newName: ${s.name}${dom}\n`;
    }
  }
  y += names + aliasProj;

  // Filters
  if (o.applyFilters) {
    for (const s of o.symbols) {
      if (!hasActiveFilter(s)) continue;
      y += `- Filter:\n    name: ${s.name}\n    newName: ${s.name}${FILTER_SUFFIX}\n`;
      const lf = Object.entries(s.labelFilters ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
      if (lf.length) {
        y += '    labelFilters:\n';
        for (const [d, f] of lf) {
          const labels = f.labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ');
          y += `      - dimension: ${Number(d) + 1}\n        ${f.mode === 'exclude' ? 'reject' : 'keep'}: [${labels}]\n`;
        }
      }
      const vf = Object.entries(s.valueFilters ?? {}).filter(([, v]) => !isDefaultValueFilter(v)).sort((a, b) => Number(a[0]) - Number(b[0]));
      if (vf.length) {
        y += '    valueFilters:\n';
        for (const [slot, f] of vf) y += valueFilterYaml(Number(slot), f, s.kind);
      }
    }
  }

  // Projections: variables / equations select attributes
  for (const s of o.symbols) {
    if (!isVarEqu(s.kind)) continue;
    const suffix = attributeSuffix(s.attrs, o.hiddenAttributes);
    const filtered = o.applyFilters && hasActiveFilter(s);
    const dom = domains(s.dim);
    y += `- Projection:\n    name: ${s.name}${filtered ? FILTER_SUFFIX : ''}${suffix}${dom}\n    newName: ${s.name}${PROJ_SUFFIX}${dom}\n`;
    if (!suffix) {
      noAttributes.add(s.name);
      y += '    asSet: True\n';
    }
  }

  // ExcelWriter
  const sub = o.substitutions;
  const list = [sub.eps, sub.posInf, sub.negInf, sub.undef, sub.na];
  const defaults = ['EPS', 'INF', '-INF', 'UNDEF', 'NA'];
  const quoted = list.map((v, i) => {
    if (v === defaults[i]) return v;
    if (v.trim() !== '' && Number.isFinite(Number(v))) return v;
    return quoteSubstitution(v);
  });
  y += `- ExcelWriter:\n    file: ${yamlScalar(o.excelFile)}\n    valueSubstitutions: {\n`;
  y += `      EPS: ${quoted[0]},\n      INF: ${quoted[1]},\n      -INF: ${quoted[2]},\n      UNDEF: ${quoted[3]},\n      NA: ${quoted[4]}\n    }\n    symbols:\n`;
  for (const s of o.symbols) {
    const filtered = o.applyFilters && hasActiveFilter(s);
    let name = filtered ? `${s.name}${FILTER_SUFFIX}` : s.name;
    let colDim = s.tableColDims ?? 0;
    if (isVarEqu(s.kind)) {
      name = `${s.name}${PROJ_SUFFIX}`;
      // the attribute index is the last (column) dimension; without attributes it is a set
      if (!noAttributes.has(s.name)) colDim += 1;
      else if (s.tableColDims) colDim = 0;
    }
    y += `      - name: ${name}\n        range: ${yamlScalar(`${sheetNameFor(s.name, sheets)}!A1`)}\n        columnDimension: ${colDim}\n`;
  }
  return y;
}
