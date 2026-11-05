// SPDX-License-Identifier: GPL-3.0-or-later
// Display preferences shared by the GDX viewer and the GDX compare view (extension feature): the
// last numeric format and the thousands separator choice are remembered per user (extension
// globalState) and used as the defaults of newly opened views. Pure.
import type { SymFormat } from './symview';

export interface DisplayPrefs {
  thousands: boolean;
  fmt: SymFormat;
}

export const DISPLAY_PREFS_KEY = 'gams.gdx.displayPrefs';

/** Validate untrusted stored preferences; undefined when nothing usable is stored. */
export function sanitizeDisplayPrefs(raw: unknown): DisplayPrefs | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const f = (r.fmt && typeof r.fmt === 'object' ? r.fmt : {}) as Record<string, unknown>;
  const format = f.format === 'f' || f.format === 'e' || f.format === 'g' ? f.format : 'g';
  const max = format === 'f' ? 14 : 17;
  const precision = typeof f.precision === 'number' && Number.isFinite(f.precision) ? Math.max(0, Math.min(max, Math.floor(f.precision))) : 6;
  return { thousands: r.thousands === true, fmt: { format, precision, squeeze: typeof f.squeeze === 'boolean' ? f.squeeze : true } };
}

/** Minimal Memento surface (vscode.Memento) so tests need no vscode module. */
export interface PrefsStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

let store: PrefsStore | undefined;
export function setPrefsStore(s: PrefsStore | undefined): void {
  store = s;
}
export function loadDisplayPrefs(): DisplayPrefs | undefined {
  return sanitizeDisplayPrefs(store?.get(DISPLAY_PREFS_KEY));
}
export function saveDisplayPrefs(p: unknown): void {
  const clean = sanitizeDisplayPrefs(p);
  if (clean && store) void store.update(DISPLAY_PREFS_KEY, clean);
}

/** Export dialog option "Header row with domain names" (remembered per user, default off = Studio's layout). */
export const EXPORT_HEADER_KEY = 'gams.gdx.exportHeaderRow';
export function loadExportHeaderRow(): boolean {
  return store?.get<unknown>(EXPORT_HEADER_KEY) === true;
}
export function saveExportHeaderRow(on: boolean): void {
  if (store) void store.update(EXPORT_HEADER_KEY, on === true);
}
