// SPDX-License-Identifier: GPL-3.0-or-later
// Drag handle on the right edge of a header cell: drag = resize, double-click = auto-fit
// (Studio QHeaderView: sectionResized / resizeColumnToContents).
import { el } from './dom';

export interface ResizeHandlers {
  width: () => number;
  /** called while dragging (final = false) and once on release (final = true) */
  onResize: (w: number, final: boolean) => void;
  onAutoFit: () => void;
  min?: number;
}

import { resizedWidth } from '../columns';

export function addResizeHandle(cell: HTMLElement, h: ResizeHandlers): HTMLElement {
  const rz = el('span', 'rz');
  rz.title = 'Drag to resize, double-click to fit';
  cell.append(rz);
  rz.addEventListener('click', (e) => e.stopPropagation());
  rz.addEventListener('mousedown', (e) => e.stopPropagation());
  rz.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); h.onAutoFit(); });
  rz.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // window-level listeners (not pointer capture): grids may rebuild their header cells while dragging
    const startX = e.clientX;
    const start = h.width();
    let last = start;
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent): void => {
      last = resizedWidth(start, ev.clientX - startX, h.min);
      h.onResize(last, false);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      h.onResize(last, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  return rz;
}
