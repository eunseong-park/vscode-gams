// SPDX-License-Identifier: GPL-3.0-or-later
// Small DOM helpers for the GDX webview (no framework; CSP allows no inline styles, so styles are
// set through the CSSOM and classes).
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 16x16 stroke icons (codicons are not available offline; these are simple original shapes). */
const ICONS: Record<string, string> = {
  list: 'M2 4h12M2 8h12M2 12h12',
  table: 'M2.5 3.5h11v9h-11zM2.5 7h11M6.5 3.5v9',
  chart: 'M3 2.5v11h10.5M6 12V8M9 12V5M12 12V9',
  back: 'M10 3 5 8l5 5',
  forward: 'M6 3l5 5-5 5',
  panel: 'M2.5 3.5h11v9h-11zM6.5 3.5v9',
  orientH: 'M2.5 3.5h11v9h-11zM8 3.5v9',
  orientV: 'M2.5 3.5h11v9h-11zM2.5 8h11',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3 14 14',
  info: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 7v4M8 5v.1',
  reload: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3',
  export: 'M8 2v8M5 7l3 3 3-3M3 13.5h10',
  reset: 'M6 3.5 3 6.5l3 3M3 6.5h6a3.5 3.5 0 0 1 0 7H6',
  columns: 'M2.5 3.5h11v9h-11zM6.2 3.5v9M9.8 3.5v9',
  prefs: 'M2 5h12M2 11h12M5 3v4M11 9v4',
  copy: 'M5.5 5.5h8v8h-8zM3 10.5V3h7.5',
  more: 'M3 8h.1M8 8h.1M13 8h.1',
  down: 'M4 6l4 4 4-4',
  fit: 'M2 8h12M2 8l2.5-2.5M2 8l2.5 2.5M14 8l-2.5-2.5M14 8l-2.5 2.5',
  close: 'M4 4l8 8M12 4l-8 8',
  up: 'M3 10l5-5 5 5',
  svg: 'M3 13.5h10M8 2v8M5 7l3 3 3-3',
  filter: 'M2.5 3h11L9.5 8v4.5l-3 1.5V8z',
  swap: 'M3 5h10M10 2l3 3-3 3M13 11H3M6 8l-3 3 3 3',
  diff: 'M5 3v10M3 8h4M11 3v10M9 5h4M9 11h4',
  raw: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11',
};

export function icon(name: keyof typeof ICONS | string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ico');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  svg.append(p);
  return svg;
}

/** Icon button with a tooltip (also its accessible name). */
export function iconButton(name: string, title: string, onclick?: (e: MouseEvent) => void, label?: string): HTMLButtonElement {
  const b = el('button', 'tb');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(icon(name));
  if (label) b.append(el('span', 'tl', label));
  if (onclick) b.onclick = onclick;
  return b;
}

let ctx: CanvasRenderingContext2D | null | undefined;
/** Text width in px for the font of `ref` (falls back to a rough estimate without canvas support). */
export function textMeasurer(ref: HTMLElement, bold = false): (s: string) => number {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
  const cs = getComputedStyle(ref);
  const font = `${bold ? '600 ' : ''}${cs.fontSize} ${cs.fontFamily}`;
  if (!ctx) return (s) => s.length * 7;
  const c = ctx;
  return (s) => {
    c.font = font;
    return c.measureText(s).width;
  };
}
