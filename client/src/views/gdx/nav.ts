// SPDX-License-Identifier: GPL-3.0-or-later
// Symbol navigation helpers (extension feature beyond Studio): back / forward history over
// selected symbols and links from a symbol's domain names to the set symbols of the GDX file.
import type { GdxSymbolInfo } from './model';

export class NavHistory {
  private entries: string[] = [];
  private pos = -1;

  constructor(private readonly cap = 100) {}

  get current(): string | undefined {
    return this.entries[this.pos];
  }
  get canBack(): boolean {
    return this.pos > 0;
  }
  get canForward(): boolean {
    return this.pos >= 0 && this.pos < this.entries.length - 1;
  }

  /** Record a newly selected symbol; forward entries are dropped; re-selecting the current one is a no-op. */
  push(name: string): void {
    if (this.entries[this.pos] === name) return;
    this.entries.splice(this.pos + 1);
    this.entries.push(name);
    if (this.entries.length > this.cap) this.entries.shift();
    this.pos = this.entries.length - 1;
  }

  back(): string | undefined {
    if (!this.canBack) return undefined;
    return this.entries[--this.pos];
  }

  forward(): string | undefined {
    if (!this.canForward) return undefined;
    return this.entries[++this.pos];
  }

  /** Drop entries that no longer exist (after a reload). */
  prune(exists: (name: string) => boolean): void {
    const cur = this.current;
    const kept: string[] = [];
    let pos = -1;
    this.entries.forEach((e, i) => {
      if (!exists(e)) return;
      if (kept[kept.length - 1] === e) { if (i <= this.pos) pos = kept.length - 1; return; }
      kept.push(e);
      if (i <= this.pos) pos = kept.length - 1;
    });
    this.entries = kept;
    this.pos = kept.length === 0 ? -1 : Math.max(0, pos);
    if (cur && this.current !== cur && kept.length === 0) this.pos = -1;
  }
}

/**
 * For each domain name of `sym`: the set (or alias) symbol of that name in the file, if any.
 * Relaxed domains (`*`) and names that are not sets in this file are not linked.
 */
export function domainTargets(sym: Pick<GdxSymbolInfo, 'domain' | 'name'>, symbols: readonly GdxSymbolInfo[]): (GdxSymbolInfo | undefined)[] {
  const byName = new Map<string, GdxSymbolInfo>();
  for (const s of symbols) byName.set(s.name.toLowerCase(), s);
  return sym.domain.map((d) => {
    if (d === '*' || d === '') return undefined;
    const t = byName.get(d.toLowerCase());
    return t && (t.kind === 'Set' || t.kind === 'Alias') ? t : undefined;
  });
}
