// SPDX-License-Identifier: GPL-3.0-or-later
// Pane layout of the GDX viewer: symbol panel next to (or above) the data panel with a draggable
// splitter. Studio: QSplitter between the symbol table and the symbol view (gdxviewer.ui,
// horizontal). Pure geometry helpers; the DOM part is webview/splitter.ts.

export type Orientation = 'horizontal' | 'vertical';

export interface LayoutState {
  /** horizontal = symbol panel left of the data panel (Studio default) */
  orientation: Orientation;
  /** share of the container taken by the symbol panel (0..1) */
  ratio: number;
  collapsed: boolean;
  /** Studio "Hide/Show search bar and symbol info" */
  headerHidden: boolean;
  /** symbol table column widths by column id */
  symWidths: Record<string, number>;
}

export const DEFAULT_LAYOUT: LayoutState = { orientation: 'horizontal', ratio: 0.32, collapsed: false, headerHidden: false, symWidths: {} };

/** Minimum sizes (px) of the panes along the split axis. */
export const MIN_SYM_PX = 140;
export const MIN_DATA_PX = 200;
/** Below this container width a side-by-side layout is shown stacked (the saved preference is kept). */
export const NARROW_PX = 560;
export const SPLITTER_PX = 5;

export function effectiveOrientation(l: Pick<LayoutState, 'orientation'>, containerWidth: number): Orientation {
  return l.orientation === 'horizontal' && containerWidth < NARROW_PX ? 'vertical' : l.orientation;
}

/** Size (px) of the symbol panel for `ratio`, honouring both minimum sizes; 0 when there is no room for both. */
export function symbolPanelPx(total: number, ratio: number, minSym = MIN_SYM_PX, minData = MIN_DATA_PX): number {
  const avail = total - SPLITTER_PX;
  if (avail < minSym + minData) return Math.max(0, Math.min(avail / 2, avail));
  return Math.round(Math.min(avail - minData, Math.max(minSym, ratio * total)));
}

/** Ratio after dragging the splitter to `px` (clamped to the minimum sizes). */
export function ratioAfterDrag(total: number, px: number, minSym = MIN_SYM_PX, minData = MIN_DATA_PX): number {
  if (total <= 0) return DEFAULT_LAYOUT.ratio;
  const avail = total - SPLITTER_PX;
  const clamped = avail < minSym + minData ? avail / 2 : Math.min(avail - minData, Math.max(minSym, px));
  return Math.round((clamped / total) * 1000) / 1000;
}

export function sanitizeLayout(raw: unknown): LayoutState {
  const l: LayoutState = { ...DEFAULT_LAYOUT, symWidths: {} };
  if (!raw || typeof raw !== 'object') return l;
  const r = raw as Record<string, unknown>;
  if (r.orientation === 'vertical' || r.orientation === 'horizontal') l.orientation = r.orientation;
  if (typeof r.ratio === 'number' && r.ratio > 0.05 && r.ratio < 0.95) l.ratio = r.ratio;
  l.collapsed = r.collapsed === true;
  l.headerHidden = r.headerHidden === true;
  if (r.symWidths && typeof r.symWidths === 'object') {
    for (const [k, v] of Object.entries(r.symWidths as Record<string, unknown>)) {
      if (typeof v === 'number' && v >= 20 && v <= 2000) l.symWidths[k] = v;
    }
  }
  return l;
}
