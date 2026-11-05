// SPDX-License-Identifier: GPL-3.0-or-later
// Dropdown / context menus and the overflow toolbar of the GDX viewer.
import { el, iconButton } from './dom';

let current: { menu: HTMLElement; close: () => void } | undefined;

export function closeMenu(): void {
  current?.close();
}

export interface MenuBuilder {
  item(label: string, run: () => void, o?: { shortcut?: string; checked?: boolean; disabled?: boolean; radio?: boolean; keepOpen?: boolean }): HTMLElement;
  sep(): void;
  /** free-form content (e.g. number input) */
  widget(content: HTMLElement): void;
  close(): void;
}

/** Open a menu at an anchor element or point; `build` fills it. Closes on outside click, Escape or after an action. */
export function openMenu(anchor: HTMLElement | { x: number; y: number }, build: (m: MenuBuilder) => void): void {
  closeMenu();
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  const close = (): void => {
    menu.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    if (current?.menu === menu) current = undefined;
  };
  const onDown = (e: MouseEvent): void => { if (!menu.contains(e.target as Node)) close(); };
  const items = (): HTMLElement[] => Array.from(menu.querySelectorAll<HTMLElement>('.mi:not(.disabled)'));
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = items();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const n = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[n].focus();
      e.preventDefault();
    } else if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.classList.contains('mi')) {
      e.preventDefault();
      (document.activeElement as HTMLElement).click();
    }
  };
  const b: MenuBuilder = {
    item(label, run, o = {}) {
      const row = el('div', 'mi' + (o.disabled ? ' disabled' : ''));
      row.tabIndex = -1;
      row.setAttribute('role', o.radio ? 'menuitemradio' : o.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
      if (o.checked !== undefined) row.setAttribute('aria-checked', String(o.checked));
      row.append(el('span', 'mchk', o.checked ? (o.radio ? '●' : '✓') : ''), el('span', 'mlbl', label), el('span', 'msc', o.shortcut ?? ''));
      row.onclick = () => {
        if (o.disabled) return;
        if (!o.keepOpen) close();
        run();
      };
      menu.append(row);
      return row;
    },
    sep: () => { menu.append(el('div', 'msep')); },
    widget: (content) => { menu.append(content); },
    close,
  };
  build(b);
  document.body.append(menu);
  const ar = 'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect() : undefined;
  const x = ar ? ar.left : (anchor as { x: number }).x;
  const y = ar ? ar.bottom : (anchor as { y: number }).y;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(2, Math.min(x, window.innerWidth - w - 2))}px`;
  menu.style.top = `${Math.max(2, y + h > window.innerHeight - 2 ? Math.max(2, (ar ? ar.top : y) - h) : y)}px`;
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  current = { menu, close };
  (items()[0] ?? menu).focus?.();
}

export interface ToolItem {
  el: HTMLElement;
  /** text in the overflow menu */
  label: string;
  /** invoked by the button and by the overflow entry; `anchor` positions follow-up menus */
  run: (anchor: HTMLElement) => void;
  /** never moved into the overflow menu */
  pinned?: boolean;
  checked?: () => boolean;
  disabled?: () => boolean;
  /** layout-only element (separator / spacer) hidden together with its neighbours */
  decoration?: boolean;
}

/**
 * One fixed-height row of toolbar buttons; items that do not fit move, from the end, into a "..." menu.
 * Never wraps (flex-wrap: nowrap, overflow hidden).
 */
export class OverflowToolbar {
  readonly el = el('div', 'toolbar');
  private readonly items: ToolItem[] = [];
  private readonly more = iconButton('more', 'More actions');
  private hidden: ToolItem[] = [];
  private readonly ro: ResizeObserver;
  private raf = 0;

  constructor() {
    this.more.hidden = true;
    this.more.classList.add('more');
    this.more.onclick = () => this.openMore();
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(this.el);
    this.el.append(this.more);
  }

  add(item: ToolItem): void {
    this.items.push(item);
    if (!item.decoration) item.el.addEventListener('click', (e) => { e.stopPropagation(); item.run(item.el); });
    this.el.insertBefore(item.el, this.more);
    this.schedule();
  }

  /** Flexible gap pushing the following items to the right. */
  spacer(): void {
    this.add({ el: el('span', 'grow'), label: '', run: () => undefined, decoration: true, pinned: true });
  }

  schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.layout(); });
  }

  /** Re-measure (call after toggling item visibility / state). */
  layout(): void {
    for (const it of this.items) it.el.classList.remove('ovf');
    this.more.hidden = true;
    this.hidden = [];
    const fits = (): boolean => this.el.scrollWidth <= this.el.clientWidth + 1;
    if (fits()) return;
    this.more.hidden = false;
    for (let i = this.items.length - 1; i >= 0 && !fits(); i--) {
      const it = this.items[i];
      if (it.pinned || it.el.hidden) continue;
      it.el.classList.add('ovf');
      if (!it.decoration) this.hidden.unshift(it);
    }
    if (this.hidden.length === 0) this.more.hidden = true;
  }

  private openMore(): void {
    openMenu(this.more, (m) => {
      for (const it of this.hidden) {
        m.item(it.label, () => it.run(this.more), { checked: it.checked?.(), disabled: it.disabled?.() });
      }
    });
  }

  dispose(): void {
    this.ro.disconnect();
  }
}
