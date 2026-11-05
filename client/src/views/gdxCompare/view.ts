// SPDX-License-Identifier: GPL-3.0-or-later
// Pure cell building of the compare grids (no DOM): the left grid shows `mark | keys | A values`, the
// right grid `B values | AbsDiff | RelDiff`, both with per-cell highlight classes.
import { FormatOptions, formatValue, formatDouble, SV_UNDEF } from '../gdx/format';
import { keyHeader } from '../gdx/model';
import {
  Cell, CellFlag, CompareRecord, CompareSymbol, ROW_STATUS_MARK, ValueColumn, keyFlag, valueFlag,
} from './model';

export interface GridCells {
  cells: string[];
  special: boolean[];
  cls: (string | undefined)[];
}

export interface SideLayout {
  sym: Pick<CompareSymbol, 'kind' | 'dim' | 'domain'>;
  vcols: ValueColumn[];
  showAbs: boolean;
  showRel: boolean;
}

export const flagClass = (f: CellFlag): string | undefined => (f ? `cf-${f}` : undefined);

const isSetKind = (k: string): boolean => k === 'Set' || k === 'Alias';

export function isSpecialCell(v: Cell): boolean {
  return (typeof v === 'number' && v >= SV_UNDEF) || (typeof v === 'string' && /^(UNDF|NA|\+INF|-INF|EPS)$/.test(v));
}

function valueText(v: Cell, fmt: FormatOptions, set: boolean): string {
  if (v === null || v === undefined) return '';
  return set ? String(v) : formatValue(v, fmt);
}

/** Relative difference as a percentage (`12.5%`). */
export function relText(v: Cell, fmt: FormatOptions): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'number') return String(v);
  return `${formatDouble(v * 100, { ...fmt, format: 'g', precision: Math.min(fmt.precision || 6, 6) })}%`;
}

export function leftHeaders(l: SideLayout, nameA: string): Array<{ id: string; title: string; align?: 'right' }> {
  const out: Array<{ id: string; title: string; align?: 'right' }> = [{ id: 'mark', title: '' }];
  for (let d = 0; d < l.sym.dim; d++) out.push({ id: `k${d}`, title: keyHeader(l.sym.domain, d) });
  for (const c of l.vcols) out.push({ id: `a${c.slot}`, title: `${nameA}: ${c.label}`, align: isSetKind(l.sym.kind) ? undefined : 'right' });
  return out;
}

export function rightHeaders(l: SideLayout, nameB: string): Array<{ id: string; title: string; align?: 'right' }> {
  const set = isSetKind(l.sym.kind);
  const out: Array<{ id: string; title: string; align?: 'right' }> = [];
  for (const c of l.vcols) out.push({ id: `b${c.slot}`, title: `${nameB}: ${c.label}`, align: set ? undefined : 'right' });
  if (!set && l.showAbs) for (const c of l.vcols) out.push({ id: `d${c.slot}`, title: `Δ ${c.label}`, align: 'right' });
  if (!set && l.showRel) for (const c of l.vcols) out.push({ id: `r${c.slot}`, title: `Δ% ${c.label}`, align: 'right' });
  return out;
}

export function leftCells(l: SideLayout, rec: CompareRecord, fmt: FormatOptions): GridCells {
  const set = isSetKind(l.sym.kind);
  const kf = flagClass(keyFlag(rec));
  const cells: string[] = [ROW_STATUS_MARK[rec.status]];
  const special: boolean[] = [false];
  const cls: (string | undefined)[] = [flagClass(rec.status === 'changed' ? 'changed' : keyFlag(rec))];
  for (let d = 0; d < l.sym.dim; d++) { cells.push(rec.keys[d] ?? ''); special.push(false); cls.push(kf); }
  for (const c of l.vcols) {
    const v = rec.a?.[c.slot];
    cells.push(valueText(v, fmt, set));
    special.push(set ? rec.aNoText === true : isSpecialCell(v)); // sets: the placeholder `Y` of an element without text
    cls.push(flagClass(valueFlag(rec, c.slot)) ?? (rec.a ? undefined : 'missing'));
  }
  return { cells, special, cls };
}

export function rightCells(l: SideLayout, rec: CompareRecord, fmt: FormatOptions): GridCells {
  const set = isSetKind(l.sym.kind);
  const cells: string[] = [];
  const special: boolean[] = [];
  const cls: (string | undefined)[] = [];
  for (const c of l.vcols) {
    const v = rec.b?.[c.slot];
    cells.push(valueText(v, fmt, set));
    special.push(set ? rec.bNoText === true : isSpecialCell(v));
    cls.push(flagClass(valueFlag(rec, c.slot)) ?? (rec.b ? undefined : 'missing'));
  }
  if (!set && l.showAbs) {
    for (const c of l.vcols) {
      const v = rec.abs?.[c.slot];
      cells.push(valueText(v, fmt, false));
      special.push(false);
      cls.push(flagClass(valueFlag(rec, c.slot)));
    }
  }
  if (!set && l.showRel) {
    for (const c of l.vcols) {
      cells.push(relText(rec.rel?.[c.slot], fmt));
      special.push(false);
      cls.push(flagClass(valueFlag(rec, c.slot)));
    }
  }
  return { cells, special, cls };
}
