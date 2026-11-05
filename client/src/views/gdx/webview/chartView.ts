// SPDX-License-Identifier: GPL-3.0-or-later
// Chart view (extension feature beyond Studio): hand-written SVG bar / line chart of a numeric
// symbol. 1-D symbols: bars over the labels in the current sort / filter order. 2-D and higher:
// grouped bars or lines, series = chosen dimension, x axis = the remaining dimensions.
import { barLayout, ChartData, chartPivot, dataFromRecords, dataFromTable, extent, MAX_POINTS, MAX_SERIES, niceScale, truncationNotice } from '../chart';
import { formatValue } from '../format';
import { keyHeader, normalizeValue, VALUE_COLUMNS } from '../model';
import type { RecordsResult, TableResult } from '../protocol';
import { el, icon } from './dom';
import { errText, isLimitError, rpc, send } from './rpc';
import { displayFormat, hooks, queryParams, S, setNotice } from './state';

const NS = 'http://www.w3.org/2000/svg';
const FALLBACK = ['#3794ff', '#4ec9b0', '#d7ba7d', '#c586c0', '#f48771', '#89d185', '#75beff', '#e5c07b'];
const VARS = ['--vscode-charts-blue', '--vscode-charts-green', '--vscode-charts-orange', '--vscode-charts-purple', '--vscode-charts-red', '--vscode-charts-yellow'];

let host: HTMLElement | undefined;
let data: ChartData | undefined;
let ro: ResizeObserver | undefined;
let tip: HTMLElement | undefined;
let svgEl: SVGSVGElement | undefined;
let legendEl: HTMLElement | undefined;
let chartTitle = '';

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Series colour i: the VS Code chart colours first, then rotated hues. */
export function seriesColor(i: number): string {
  if (i < VARS.length) return cssVar(VARS[i], FALLBACK[i % FALLBACK.length]);
  return `hsl(${(i * 47) % 360} 55% 58%)`;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const fmt = (v: number): string => formatValue(v, displayFormat());

export function mountChart(container: HTMLElement): void {
  host = el('div', 'chartwrap');
  tip = el('div', 'charttip');
  tip.hidden = true;
  legendEl = el('div', 'legend');
  const plot = el('div', 'chartplot');
  host.append(plot, legendEl, tip);
  container.append(host);
  ro?.disconnect();
  ro = new ResizeObserver(() => draw());
  ro.observe(plot);
  void load();
}

export function disposeChart(): void {
  ro?.disconnect();
  ro = undefined;
  host = undefined;
  data = undefined;
  svgEl = undefined;
}

export async function load(): Promise<void> {
  const s = S.selected;
  if (!s || !host) return;
  const g = ++S.gen;
  S.loadError = '';
  const v = S.view;
  const slot = s.kind === 'Variable' || s.kind === 'Equation' ? v.pivot.valueField : 0;
  const attr = s.kind === 'Variable' || s.kind === 'Equation' ? VALUE_COLUMNS[slot] : s.kind === 'Parameter' ? 'Value' : 'Value';
  chartTitle = `${s.name}${s.kind === 'Variable' || s.kind === 'Equation' ? ` (${attr})` : ''}`;
  try {
    if (s.dim === 1) {
      const m = await rpc<RecordsResult>('records', { symbolIndex: s.index, offset: 0, limit: MAX_POINTS, ...queryParams(true) });
      if (g !== S.gen) return;
      for (const r of m.records) r.values = r.values.map((x) => normalizeValue(x, s.kind));
      data = dataFromRecords(m.records, m.total, slot, attr);
    } else {
      const p = chartPivot(s.dim, v.chart.seriesDim, slot);
      const t = await rpc<TableResult>('table', {
        symbolIndex: s.index, rowDims: p.rowDims, colDims: p.colDims, valueField: p.valueField,
        rowOffset: 0, rowLimit: MAX_POINTS, colOffset: 0, colLimit: MAX_SERIES, ...queryParams(false),
      });
      if (g !== S.gen) return;
      t.cells = t.cells.map((r) => r.map((x) => (x === null ? null : normalizeValue(x, s.kind))));
      data = dataFromTable(t);
    }
    setNotice('chart', truncationNotice(data));
  } catch (e) {
    if (g !== S.gen) return;
    const msg = errText(e);
    data = undefined;
    if (isLimitError(msg)) hooks.limitHit(msg); else S.loadError = msg;
  }
  hooks.chrome();
  if (S.loadError) { hooks.rebuild(); return; }
  draw();
}

function legend(d: ChartData): void {
  if (!legendEl) return;
  legendEl.textContent = '';
  legendEl.hidden = d.series.length <= 1;
  d.series.forEach((s, i) => {
    const item = el('span', 'lg');
    const sw = el('span', 'sw');
    sw.style.background = seriesColor(i);
    item.append(sw, document.createTextNode(s.name));
    item.title = s.name;
    legendEl!.append(item);
  });
}

function draw(): void {
  if (!host) return;
  const plot = host.querySelector('.chartplot') as HTMLElement;
  plot.textContent = '';
  const s = S.selected;
  const d = data;
  if (!s || !d) { return; }
  legend(d);
  const W = Math.max(200, plot.clientWidth);
  const H = Math.max(140, plot.clientHeight);
  const fg = cssVar('--vscode-foreground', '#ccc');
  const grid = cssVar('--vscode-editorWidget-border', cssVar('--vscode-panel-border', '#555'));
  const dim = cssVar('--vscode-descriptionForeground', '#999');
  const font = cssVar('--vscode-font-family', 'sans-serif');
  const fsz = 11;
  const ext = extent(d);
  const el0 = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Chart of ${chartTitle}`, 'font-family': font, 'font-size': fsz });
  svgEl = el0;
  const n = d.labels.length;
  if (!ext || n === 0) {
    el0.append(svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: dim }, 'Nothing to plot (no numeric values).'));
    plot.append(el0);
    return;
  }
  const bars = S.view.chart.type === 'bar';
  const sc = niceScale(ext.min, ext.max, Math.max(2, Math.floor(H / 50)), bars);
  const tickLabels = sc.ticks.map(fmt);
  const left = Math.min(110, 12 + Math.max(...tickLabels.map((t) => t.length)) * (fsz * 0.62));
  const labelMax = Math.min(14, Math.max(...d.labels.slice(0, 200).map((l) => l.length)));
  const rot = n > 12;
  const bottom = rot ? 8 + labelMax * fsz * 0.55 : 26;
  const top = 10;
  const right = 12;
  const pw = W - left - right;
  const ph = H - top - bottom;
  const y = (v: number): number => top + ph - ((v - sc.min) / (sc.max - sc.min)) * ph;
  // grid + value axis
  for (const t of sc.ticks) {
    const yy = y(t);
    el0.append(svg('line', { x1: left, x2: left + pw, y1: yy, y2: yy, stroke: grid, 'stroke-width': t === 0 ? 1.5 : 0.5, opacity: t === 0 ? 1 : 0.6 }));
    el0.append(svg('text', { x: left - 5, y: yy + fsz / 3, 'text-anchor': 'end', fill: dim }, fmt(t)));
  }
  const bl = barLayout(n, bars ? d.series.length : 1, pw);
  const x0 = (i: number): number => left + i * bl.groupW;
  // x labels (thinned so they do not overlap)
  const step = Math.max(1, Math.ceil((rot ? fsz * 1.3 : Math.min(labelMax, 12) * fsz * 0.6 + 6) / Math.max(1, bl.groupW)));
  for (let i = 0; i < n; i += step) {
    const cx = x0(i) + bl.groupW / 2;
    const txt = d.labels[i].length > 14 ? `${d.labels[i].slice(0, 13)}…` : d.labels[i];
    const t = svg('text', rot
      ? { x: cx, y: top + ph + 8, 'text-anchor': 'end', fill: dim, transform: `rotate(-45 ${cx} ${top + ph + 8})` }
      : { x: cx, y: top + ph + 16, 'text-anchor': 'middle', fill: dim }, txt);
    el0.append(t);
  }
  // series
  const zero = y(Math.max(sc.min, Math.min(0, sc.max)));
  d.series.forEach((ser, si) => {
    const color = seriesColor(si);
    if (bars) {
      ser.values.forEach((v, i) => {
        if (v === null) return;
        const yy = y(v);
        el0.append(svg('rect', {
          x: x0(i) + bl.pad + si * bl.barW, y: Math.min(yy, zero), width: Math.max(0.5, bl.barW - (bl.barW > 4 ? 1 : 0)), height: Math.max(0.5, Math.abs(zero - yy)), fill: color,
        }));
      });
    } else {
      let seg: string[] = [];
      const flush = (): void => {
        if (seg.length > 1) el0.append(svg('polyline', { points: seg.join(' '), fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
        seg = [];
      };
      ser.values.forEach((v, i) => {
        if (v === null) { flush(); return; }
        const px = x0(i) + bl.groupW / 2;
        seg.push(`${px.toFixed(1)},${y(v).toFixed(1)}`);
        if (n <= 120) el0.append(svg('circle', { cx: px, cy: y(v), r: 2.5, fill: color }));
      });
      flush();
    }
  });
  // hover band + tooltip
  const band = svg('rect', { y: top, height: ph, width: Math.max(1, bl.groupW), fill: fg, opacity: 0.08, 'pointer-events': 'none' });
  band.setAttribute('display', 'none');
  el0.append(band);
  const hit = svg('rect', { x: left, y: top, width: pw, height: ph, fill: 'transparent' });
  el0.append(hit);
  hit.addEventListener('mousemove', (e) => {
    const r = el0.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left - left) / bl.groupW)));
    band.setAttribute('x', String(x0(i)));
    band.removeAttribute('display');
    showTip(e, i, d);
  });
  hit.addEventListener('mouseleave', () => { band.setAttribute('display', 'none'); if (tip) tip.hidden = true; });
  plot.append(el0);
}

function showTip(e: MouseEvent, i: number, d: ChartData): void {
  if (!tip || !host) return;
  tip.textContent = '';
  tip.append(el('div', 'tt', d.labels[i]));
  const maxLines = 12;
  d.series.slice(0, maxLines).forEach((s, si) => {
    const row = el('div', 'tr');
    const sw = el('span', 'sw');
    sw.style.background = seriesColor(si);
    const v = s.values[i];
    row.append(sw, el('span', undefined, d.series.length > 1 ? `${s.name}: ` : ''), el('b', undefined, v === null ? '–' : fmt(v)));
    tip!.append(row);
  });
  if (d.series.length > maxLines) tip.append(el('div', 'tr', `… ${d.series.length - maxLines} more series`));
  tip.hidden = false;
  const hr = host.getBoundingClientRect();
  const x = e.clientX - hr.left + 14;
  const y = e.clientY - hr.top + 14;
  tip.style.left = `${Math.min(x, hr.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${Math.min(y, hr.height - tip.offsetHeight - 4)}px`;
}

/** Standalone SVG document of the current chart (colours are already resolved to concrete values). */
export function chartSvgText(): string | undefined {
  if (!svgEl) return undefined;
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', NS);
  const bg = cssVar('--vscode-editor-background', '#1e1e1e');
  const bgRect = svg('rect', { x: 0, y: 0, width: svgEl.getAttribute('width') ?? '800', height: svgEl.getAttribute('height') ?? '400', fill: bg });
  clone.insertBefore(bgRect, clone.firstChild);
  const title = document.createElementNS(NS, 'title');
  title.textContent = chartTitle;
  clone.insertBefore(title, clone.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
}

export function exportChartSvg(): void {
  const text = chartSvgText();
  if (text) send({ type: 'saveText', suggestedName: `${S.selected?.name ?? 'chart'}.svg`, text, filter: 'SVG image' });
}

/** Chart options row: bar / line, series dimension, attribute. */
export function renderChartBar(bar: HTMLElement): void {
  bar.textContent = '';
  const s = S.selected;
  if (!s) return;
  const v = S.view;
  const change = (): void => { hooks.persist(); void load(); renderChartBar(bar); };
  const type = el('select');
  type.title = 'Chart type';
  for (const [k, t] of [['bar', 'Bars'], ['line', 'Lines']]) { const o = el('option', undefined, t); o.value = k; type.append(o); }
  type.value = v.chart.type;
  type.onchange = () => { v.chart.type = type.value as 'bar' | 'line'; hooks.persist(); draw(); };
  bar.append(el('span', undefined, 'Chart'), type);
  if (s.dim >= 2) {
    const sd = el('select');
    sd.title = 'Dimension that forms the series; the other dimensions form the x axis';
    for (let d = 0; d < s.dim; d++) { const o = el('option', undefined, keyHeader(s.domain, d)); o.value = String(d); sd.append(o); }
    sd.value = String(v.chart.seriesDim);
    sd.onchange = () => { v.chart.seriesDim = Number(sd.value); change(); };
    bar.append(el('span', undefined, 'Series'), sd);
  }
  if (s.kind === 'Variable' || s.kind === 'Equation') {
    const at = el('select');
    at.title = 'Attribute plotted';
    VALUE_COLUMNS.forEach((n, i) => { const o = el('option', undefined, n); o.value = String(i); at.append(o); });
    at.value = String(v.pivot.valueField);
    at.onchange = () => { v.pivot = { ...v.pivot, valueField: Number(at.value) }; change(); };
    bar.append(el('span', undefined, 'Attribute'), at);
  }
  const ex = el('button', 'tb');
  ex.title = 'Export the chart as an SVG file';
  ex.append(icon('svg'), el('span', 'tl', 'SVG'));
  ex.onclick = exportChartSvg;
  bar.append(el('span', 'grow'), ex);
}
