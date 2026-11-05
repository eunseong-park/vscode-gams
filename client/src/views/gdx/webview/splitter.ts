// SPDX-License-Identifier: GPL-3.0-or-later
// Draggable splitter between the symbol panel and the data panel (Studio: QSplitter in
// gdxviewer.ui). Supports side-by-side and stacked orientation, collapsing the symbol panel,
// keyboard resizing and a responsive fallback to stacked when the editor is narrow.
import { effectiveOrientation, LayoutState, MIN_DATA_PX, MIN_SYM_PX, Orientation, ratioAfterDrag, SPLITTER_PX, symbolPanelPx, DEFAULT_LAYOUT } from '../layout';
import { el } from './dom';

export class SplitLayout {
  readonly bar = el('div', 'splitter');
  private orientation: Orientation = 'horizontal';
  private readonly ro: ResizeObserver;

  constructor(
    private readonly root: HTMLElement,
    private readonly first: HTMLElement,
    private readonly second: HTMLElement,
    private readonly layout: () => LayoutState,
    private readonly onChange: (final: boolean) => void,
  ) {
    this.bar.setAttribute('role', 'separator');
    this.bar.tabIndex = 0;
    this.bar.title = 'Drag to resize (double-click to reset)';
    root.append(first, this.bar, second);
    this.ro = new ResizeObserver(() => this.apply());
    this.ro.observe(root);
    this.bar.addEventListener('pointerdown', (e) => this.startDrag(e));
    this.bar.addEventListener('dblclick', () => {
      this.layout().ratio = DEFAULT_LAYOUT.ratio;
      this.apply();
      this.onChange(true);
    });
    this.bar.addEventListener('keydown', (e) => this.onKey(e));
    this.apply();
  }

  get effectiveOrientation(): Orientation {
    return this.orientation;
  }

  private total(): number {
    return this.orientation === 'horizontal' ? this.root.clientWidth : this.root.clientHeight;
  }

  /** Re-apply sizes after the layout state or the container size changed. */
  apply(): void {
    const l = this.layout();
    this.orientation = effectiveOrientation(l, this.root.clientWidth);
    const horiz = this.orientation === 'horizontal';
    this.root.classList.toggle('horiz', horiz);
    this.root.classList.toggle('vert', !horiz);
    this.bar.setAttribute('aria-orientation', horiz ? 'vertical' : 'horizontal');
    this.bar.hidden = l.collapsed;
    this.first.hidden = l.collapsed;
    if (l.collapsed) {
      this.second.style.flex = '1 1 0';
      return;
    }
    const px = symbolPanelPx(this.total(), l.ratio);
    this.first.style.flex = `0 0 ${px}px`;
    this.first.style.minWidth = horiz ? `${Math.min(MIN_SYM_PX, px)}px` : '0';
    this.first.style.minHeight = horiz ? '0' : `${Math.min(MIN_SYM_PX / 2, px)}px`;
    this.second.style.flex = '1 1 0';
    this.second.style.minWidth = horiz ? `${MIN_DATA_PX}px` : '0';
    this.second.style.minHeight = horiz ? '0' : '120px';
  }

  private startDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    try { this.bar.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    this.bar.classList.add('drag');
    const horiz = this.orientation === 'horizontal';
    const rect = this.root.getBoundingClientRect();
    const move = (ev: PointerEvent): void => {
      const pos = (horiz ? ev.clientX - rect.left : ev.clientY - rect.top) - SPLITTER_PX / 2;
      this.layout().ratio = ratioAfterDrag(this.total(), pos);
      this.apply();
      this.onChange(false);
    };
    const up = (ev: PointerEvent): void => {
      try { this.bar.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
      this.bar.classList.remove('drag');
      this.bar.removeEventListener('pointermove', move);
      this.bar.removeEventListener('pointerup', up);
      this.bar.removeEventListener('pointercancel', up);
      this.onChange(true);
    };
    this.bar.addEventListener('pointermove', move);
    this.bar.addEventListener('pointerup', up);
    this.bar.addEventListener('pointercancel', up);
  }

  private onKey(e: KeyboardEvent): void {
    const horiz = this.orientation === 'horizontal';
    const dec = horiz ? 'ArrowLeft' : 'ArrowUp';
    const inc = horiz ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    const l = this.layout();
    const cur = symbolPanelPx(this.total(), l.ratio);
    l.ratio = ratioAfterDrag(this.total(), cur + (e.key === inc ? 1 : -1) * (e.shiftKey ? 80 : 16));
    this.apply();
    this.onChange(true);
  }

  dispose(): void {
    this.ro.disconnect();
  }
}
