// SPDX-License-Identifier: GPL-3.0-or-later
// Pure (vscode-free) helpers for the Studio-style parenthesis highlighting.

export interface ParenColors { validBg: string; invalidBg: string; validFg: string; invalidFg: string }

/**
 * Studio's `Edit_parenthesesValid/Invalid{Fg,Bg}` (src/theme.cpp, themes "Light" and "Dark"):
 * Light: valid fg Qt::red, bg Qt::green.lighter(170) = #b2ffb2; invalid fg black, bg Qt::red.lighter(150) = #ff7f7f.
 * Dark: valid fg Qt::yellow.lighter(170) = #ffffb2, bg QColor(40,70,30); invalid fg black, bg Qt::red.darker(170) = #960000.
 */
export const PAREN_COLORS: Record<'light' | 'dark', ParenColors> = {
  light: { validFg: '#ff0000', validBg: '#b2ffb2', invalidFg: '#000000', invalidBg: '#ff7f7f' },
  dark: { validFg: '#ffffb2', validBg: '#28461e', invalidFg: '#000000', invalidBg: '#960000' },
};

/**
 * Colour set to use: an explicit Studio theme from `gams.studioColors` decides by its darkness
 * (`themeDark`; other Studio themes fall back to Light/Dark), otherwise the VS Code theme kind does.
 */
export function pickParenColors(themeDark: boolean | undefined, vscodeLight: boolean): ParenColors {
  const dark = themeDark ?? !vscodeLight;
  return PAREN_COLORS[dark ? 'dark' : 'light'];
}

/** Debounce with a version counter: `run` returns false when a newer call superseded this one. */
export class VersionedDebounce {
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly delayMs: number) {}

  schedule(fn: (isCurrent: () => boolean) => void): void {
    const v = ++this.version;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      fn(() => v === this.version);
    }, this.delayMs);
  }

  /** Invalidate pending work and in-flight results. */
  cancel(): void {
    this.version++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export interface PosJson { line: number; character: number }
export interface MatchResponse {
  open: { start: PosJson; end: PosJson };
  close?: { start: PosJson; end: PosJson };
  valid: boolean;
  origin: 'open' | 'close';
}

/** Studio's Ctrl+B target: just after the partner parenthesis (or after the parenthesis itself when unmatched). */
export function jumpTarget(r: MatchResponse): PosJson {
  if (!r.close) return r.open.end;
  return r.origin === 'open' ? r.close.end : r.open.end;
}
