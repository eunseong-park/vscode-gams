// SPDX-License-Identifier: GPL-3.0-or-later
// Pure data shaping for the chart view (extension feature beyond Studio). 1-D symbols are bars
// over the labels (records in the current sort / filter order); 2-D and higher use the pivot
// (`gams/gdxTable`): x axis = row tuples, series = column tuples, so filters apply and the
// series dimension is selectable. Special values: EPS plots as 0; UNDF / NA / +-INF leave a gap.
import { SV_EPS, SV_UNDEF } from './format';
import type { PivotState } from './pivot';

/** Caps keep the SVG small enough to stay responsive. */
export const MAX_POINTS = 2000;
export const MAX_SERIES = 50;
/** Upper bound of drawn marks (bars / points = x positions x series) so the SVG stays responsive. */
export const MAX_MARKS = 20000;

/** x positions that fit next to `series` series within the mark budget (at least 50, at most MAX_POINTS). */
export function pointCap(series: number): number {
  return Math.max(50, Math.min(MAX_POINTS, Math.floor(MAX_MARKS / Math.max(1, series))));
}

export function plotValue(v: number | string | null | undefined): number | null {
  if (typeof v !== 'number') return null;
  if (v === SV_EPS) return 0;
  if (v >= SV_UNDEF || v <= -SV_UNDEF || !Number.isFinite(v)) return null;
  return v;
}

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartData {
  labels: string[];
  series: ChartSeries[];
  /** rows / series available before capping */
  totalPoints: number;
  totalSeries: number;
  truncatedPoints: boolean;
  truncatedSeries: boolean;
}

export const joinLabels = (h: readonly string[] | undefined): string => (h && h.length ? h.join('.') : '');

/** 1-D: bars of value slot `slot`; `records` are the first loaded records of the (sorted / filtered) symbol. */
export function dataFromRecords(
  records: readonly { keys: readonly string[]; values: readonly (number | string)[] }[],
  total: number,
  slot: number,
  name: string,
  maxPoints = MAX_POINTS,
): ChartData {
  const n = Math.min(records.length, maxPoints);
  return {
    labels: records.slice(0, n).map((r) => joinLabels(r.keys)),
    series: [{ name, values: records.slice(0, n).map((r) => plotValue(r.values[slot])) }],
    totalPoints: total,
    totalSeries: 1,
    truncatedPoints: total > n,
    truncatedSeries: false,
  };
}

/** 2-D and higher: a window of the pivot (rows from 0, columns from 0). */
export function dataFromTable(
  t: {
    rowCount: number;
    colCount: number;
    rowHeaders: readonly (readonly string[])[];
    colHeaders: readonly (readonly string[])[];
    cells: readonly (readonly (number | string | null)[])[];
  },
  maxPoints = MAX_POINTS,
  maxSeries = MAX_SERIES,
): ChartData {
  const cols = Math.min(t.colHeaders.length > 0 ? t.colHeaders.length : (t.cells[0]?.length ?? 0), maxSeries);
  const rows = Math.min(t.rowHeaders.length, t.cells.length, maxPoints, pointCap(cols));
  const series: ChartSeries[] = [];
  for (let c = 0; c < cols; c++) {
    series.push({
      name: t.colHeaders.length > 0 ? joinLabels(t.colHeaders[c]) || 'Value' : 'Value',
      values: Array.from({ length: rows }, (_, r) => plotValue(t.cells[r]?.[c])),
    });
  }
  return {
    labels: Array.from({ length: rows }, (_, r) => joinLabels(t.rowHeaders[r])),
    series,
    totalPoints: t.rowCount,
    totalSeries: Math.max(t.colCount, series.length),
    truncatedPoints: t.rowCount > rows,
    truncatedSeries: t.colCount > cols,
  };
}

/** Pivot for a chart of a `dim`-dimensional symbol: `seriesDim` forms the series, all other dimensions the x axis. */
export function chartPivot(dim: number, seriesDim: number, valueField: number): PivotState {
  const sd = Math.min(Math.max(0, seriesDim), Math.max(0, dim - 1));
  const rowDims = Array.from({ length: dim }, (_, i) => i).filter((d) => d !== sd);
  return { rowDims, colDims: [sd], valueField };
}

export interface Scale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/** "Nice" axis scale covering [min, max] (always includes 0 for bar charts when `includeZero`). */
export function niceScale(min: number, max: number, target = 5, includeZero = true): Scale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (includeZero) { min = Math.min(min, 0); max = Math.max(max, 0); }
  if (min === max) { max = min + 1; }
  const raw = (max - min) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo, i = 0; v <= hi + step / 2 && i < 100; v += step, i++) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return { min: lo, max: hi, step, ticks };
}

/** Data extent over all series (ignores gaps); undefined when there is nothing to plot. */
export function extent(data: ChartData): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const s of data.series) for (const v of s.values) if (v !== null) { if (v < min) min = v; if (v > max) max = v; }
  return min <= max ? { min, max } : undefined;
}

export interface BarLayout {
  groupW: number;
  barW: number;
  /** left offset of the first bar inside a group */
  pad: number;
}

/** Bar sizes for `groups` x-positions with `series` bars each inside `plotW` px. */
export function barLayout(groups: number, series: number, plotW: number): BarLayout {
  const groupW = plotW / Math.max(1, groups);
  const inner = groupW * 0.8;
  const barW = Math.max(0.5, inner / Math.max(1, series));
  return { groupW, barW, pad: (groupW - barW * Math.max(1, series)) / 2 };
}

export function truncationNotice(d: ChartData): string {
  const parts: string[] = [];
  if (d.truncatedPoints) parts.push(`first ${d.labels.length.toLocaleString()} of ${d.totalPoints.toLocaleString()} points`);
  if (d.truncatedSeries) parts.push(`first ${d.series.length.toLocaleString()} of ${d.totalSeries.toLocaleString()} series`);
  return parts.length ? `Showing ${parts.join(' and ')}. Apply label filters to see the rest.` : '';
}
