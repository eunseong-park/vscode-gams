// SPDX-License-Identifier: GPL-3.0-or-later
// Column width helpers shared by the symbol table, list view and table view (pure).
// Studio resizes with QHeaderView (drag, double-click = resizeColumnToContents, "Auto Resize
// Columns" = resizeColumnsToContents; gdxsymbolview.cpp autoResize*Columns).

export const MIN_COL_W = 40;
export const MAX_COL_W = 1200;

export function clampWidth(w: number, min = MIN_COL_W, max = MAX_COL_W): number {
  if (!Number.isFinite(w)) return min;
  return Math.round(Math.min(max, Math.max(min, w)));
}

/** New width while dragging a header edge: start width + pointer movement. */
export function resizedWidth(startWidth: number, dx: number, min = MIN_COL_W, max = MAX_COL_W): number {
  return clampWidth(startWidth + dx, min, max);
}

export interface FitOptions {
  /** cell padding left + right and border */
  padding?: number;
  /** extra px for header decorations (sort mark, filter button) added to the header only */
  headerExtra?: number;
  min?: number;
  max?: number;
}

/** Width that shows the widest of `header` and `texts` completely. `measure` returns text width in px. */
export function fitWidth(header: string, texts: Iterable<string>, measure: (s: string) => number, o: FitOptions = {}): number {
  const pad = o.padding ?? 14;
  let w = measure(header) + (o.headerExtra ?? 0);
  for (const t of texts) {
    const m = measure(t);
    if (m > w) w = m;
  }
  return clampWidth(Math.ceil(w + pad), o.min, o.max);
}

/** Saved widths (keyed by column id) overlaid on defaults; invalid entries are dropped. */
export function widthsFor(ids: readonly string[], saved: Record<string, number> | undefined, defaults: (id: string) => number): number[] {
  return ids.map((id) => {
    const w = saved?.[id];
    return typeof w === 'number' && Number.isFinite(w) ? clampWidth(w) : defaults(id);
  });
}

/** Keep only plausible entries of an untrusted widths record. */
export function sanitizeWidths(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && k.length < 24) out[k] = clampWidth(v);
    }
  }
  return out;
}
