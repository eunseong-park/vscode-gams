// SPDX-License-Identifier: GPL-3.0-or-later
/** Studio "Run with" flags (option/gamsparameterwidget.cpp, MainWindow runOptions bits 1/2/4). Pure. */
export interface RunFlags { gdx: boolean; ref: boolean; profile: boolean }

export function flagsFromBits(bits: number): RunFlags {
  return { gdx: !!(bits & 1), ref: !!(bits & 2), profile: !!(bits & 4) };
}
export function flagsToBits(f: RunFlags): number {
  return (f.gdx ? 1 : 0) + (f.ref ? 2 : 0) + (f.profile ? 4 : 0);
}

/**
 * Parameters Studio prepends for the checked flags unless the user already set the key.
 * `params` are normalized `key=value` strings. Compile has no profiling flag.
 */
export function withRunFlags(params: string[], flags: RunFlags, compile: boolean): string[] {
  const keys = new Set(params.map((p) => p.split('=')[0].trim().toLowerCase()));
  const pre: string[] = [];
  if (flags.gdx && !keys.has('gdx')) pre.push('GDX=default');
  if (flags.ref && !keys.has('rf')) pre.push('RF=default');
  if (!compile && flags.profile && !keys.has('profile')) pre.push('Profile=300');
  return [...pre, ...params];
}
