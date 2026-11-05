// SPDX-License-Identifier: GPL-3.0-or-later
// Scaled virtual scrolling: maps between a scroll offset and an item (row / column) index.
// Browsers clamp element sizes (Chromium ~33.5M px, Firefox ~17.9M px), so a list of N items of
// height h cannot simply use a spacer of N*h px. When N*h exceeds `maxPx` the spacer is capped
// and the scroll position is mapped proportionally (scrollbar thumb = fraction of all items);
// the rendered items are laid out relative to the viewport, so they stay exactly h px apart.
// Programmatic jumps (keyboard, "go to row") are "pinned" by the view layer so any item is
// reachable even where one scroll pixel spans several items. Pure: no DOM.

/** Spacer cap in px; below Chromium's and Firefox's element size limits. */
export const MAX_SPACER_PX = 10_000_000;

const INT_MAX = 2_147_483_647;
/** Studio gdxsymbolview.h RESERVE_PIXELS. */
const RESERVE_PIXELS = 32768;

/**
 * Studio's limit of displayable records (`GdxSymbolView::updateMaxDisplayRecords`:
 * (INT_MAX - RESERVE_PIXELS) / row height); above it the symbol is "visually truncated".
 */
export function maxDisplayRecords(rowHeightPx: number): number {
  return Math.floor((INT_MAX - RESERVE_PIXELS) / Math.max(1, Math.floor(rowHeightPx)));
}

export class ScrollAxis {
  constructor(
    /** number of items */
    readonly count: number,
    /** px per item */
    readonly itemPx: number,
    /** px of the viewport along this axis */
    readonly viewPx: number,
    readonly maxPx: number = MAX_SPACER_PX,
  ) {}

  get scaled(): boolean {
    return this.count * this.itemPx > this.maxPx;
  }

  /** Size of the scroll spacer element. */
  get spacerPx(): number {
    return Math.max(1, Math.min(this.count * this.itemPx, this.maxPx));
  }

  /** Items that fit completely into the viewport. */
  get viewItems(): number {
    return Math.max(1, Math.floor(this.viewPx / this.itemPx));
  }

  get maxScroll(): number {
    return Math.max(0, this.spacerPx - this.viewPx);
  }

  private get maxFirst(): number {
    return Math.max(0, this.count - this.viewItems);
  }

  /** First (partially) visible item at scroll offset `scroll`. */
  firstAt(scroll: number): number {
    if (this.count <= 0) return 0;
    if (!this.scaled) return Math.min(this.count - 1, Math.max(0, Math.floor(scroll / this.itemPx)));
    const t = this.maxScroll > 0 ? Math.min(1, Math.max(0, scroll / this.maxScroll)) : 0;
    return Math.round(t * this.maxFirst);
  }

  /** Scroll offset that places `item` at the top of the viewport (clamped). */
  scrollFor(item: number): number {
    const i = Math.min(Math.max(0, item), Math.max(0, this.count - 1));
    if (!this.scaled) return Math.min(this.maxScroll, i * this.itemPx);
    if (this.maxFirst === 0) return 0;
    return Math.min(this.maxScroll, (Math.min(i, this.maxFirst) / this.maxFirst) * this.maxScroll);
  }

  /** Position of `item` relative to the viewport start (negative = above). */
  viewPos(item: number, first: number, scroll: number): number {
    return this.scaled ? (item - first) * this.itemPx : item * this.itemPx - scroll;
  }

  /** Position of `item` inside the scroll spacer (where to place its element). */
  contentPos(item: number, first: number, scroll: number): number {
    return this.scaled ? scroll + (item - first) * this.itemPx : item * this.itemPx;
  }

  /** New first item so that `item` is fully visible (unchanged when it already is). */
  reveal(item: number, first: number): number {
    const i = Math.min(Math.max(0, item), Math.max(0, this.count - 1));
    if (i < first) return i;
    if (i >= first + this.viewItems) return i - this.viewItems + 1;
    return first;
  }
}

/** A programmatic scroll target that stays authoritative until the user scrolls elsewhere. */
export interface Pin {
  scroll: number;
  first: number;
}

/** First item for the current scroll offset, honouring a pin that still matches. */
export function firstWithPin(axis: ScrollAxis, scroll: number, pin: Pin | undefined): number {
  if (pin && Math.abs(scroll - pin.scroll) < 1) return Math.min(pin.first, Math.max(0, axis.count - 1));
  return axis.firstAt(scroll);
}
