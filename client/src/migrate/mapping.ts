// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mapping of the v0.1.x settings (`GAMS.*`, extension eunseong-park.vscode-gams) to the 0.3 settings.
 * Pure (no vscode imports): the vscode side lives in settingsMigration.ts.
 */
import { normalize, tokenize } from '../options/commandLine';

export const LEGACY_KEYS = [
  'terminalCwd', 'executablePath', 'commandLineParameters', 'preserveFocus', 'runProject', 'runBatchPath',
  'projectLst', 'projectGDX', 'idePath', 'ideArguments', 'listingFileLocation',
] as const;
export type LegacyKey = (typeof LEGACY_KEYS)[number];

/** Values of the legacy keys in one scope (undefined = not set there). */
export type LegacyValues = Partial<Record<LegacyKey, unknown>>;
/** Values of the new keys (full names, e.g. `gams.sysdir`) in the same scope. */
export type NewValues = Record<string, unknown>;

export interface MigrationPlan {
  /** new key (full name) -> value to write */
  writes: Record<string, unknown>;
  /** legacy keys that were carried over */
  migrated: string[];
  /** legacy keys that are still honoured as they are (deprecated): runProject & co, terminalCwd, listing/focus */
  kept: string[];
  /** legacy keys that were set but have no counterpart (or whose new setting already has a value) */
  dropped: string[];
  /** legacy keys that were set (in this scope) */
  present: string[];
}

const isSet = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
const empty = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? '';
}
function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.substring(0, i) : '';
}

/** `GAMS.executablePath` -> sysdir: only a path to gams[.exe] with a directory part. */
export function sysdirFromExecutable(exe: string): string | undefined {
  const t = exe.trim();
  if (!/^gams(\.exe)?$/i.test(baseName(t))) return undefined;
  const d = dirName(t);
  return d || undefined;
}

/** Looks like a Studio executable (`gamside`, the 0.1.x default, is the classic IDE and not accepted). */
function isStudioPath(p: string): boolean {
  return /studio/i.test(baseName(p)) || /studio/i.test(p);
}

export function planMigration(old: LegacyValues, current: NewValues): MigrationPlan {
  const plan: MigrationPlan = { writes: {}, migrated: [], kept: [], dropped: [], present: [] };
  for (const k of LEGACY_KEYS) {
    const v = old[k];
    if (v === undefined || v === null) continue;
    plan.present.push(k);
    const target = (key: string, value: unknown): void => {
      if (empty(current[key])) {
        plan.writes[key] = value;
        plan.migrated.push(k);
      } else {
        plan.dropped.push(k); // the new setting already has a value
      }
    };
    switch (k) {
      case 'executablePath': {
        const d = typeof v === 'string' ? sysdirFromExecutable(v) : undefined;
        if (d) target('gams.sysdir', d);
        else plan.dropped.push(k);
        break;
      }
      case 'commandLineParameters': {
        if (!isSet(v)) { plan.present.pop(); break; }
        const items = normalize(tokenize(String(v)));
        if (items.length) target('gams.defaultParameters', items);
        else plan.dropped.push(k);
        break;
      }
      case 'idePath':
        if (typeof v === 'string' && isSet(v) && isStudioPath(v)) target('gams.studio.path', v.trim());
        else plan.dropped.push(k);
        break;
      case 'ideArguments':
        if (!isSet(v)) { plan.present.pop(); break; }
        target('gams.studio.arguments', String(v).trim());
        break;
      case 'runProject':
        if (v === true) plan.kept.push(k); else plan.present.pop();
        break;
      case 'runBatchPath': case 'projectLst': case 'projectGDX': case 'terminalCwd': case 'listingFileLocation':
        if (isSet(v)) plan.kept.push(k); else plan.present.pop();
        break;
      default: // preserveFocus (boolean)
        plan.kept.push(k);
    }
  }
  return plan;
}

/** Human readable notification text; undefined when there is nothing to tell. */
export function describePlans(plans: MigrationPlan[]): string | undefined {
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  const migrated = uniq(plans.flatMap((p) => p.migrated));
  const kept = uniq(plans.flatMap((p) => p.kept));
  const dropped = uniq(plans.flatMap((p) => p.dropped));
  const parts: string[] = [];
  const names = (xs: string[]): string => xs.map((x) => `GAMS.${x}`).join(', ');
  const targets = uniq(plans.flatMap((p) => Object.keys(p.writes)));
  if (migrated.length) parts.push(`Migrated ${names(migrated)} to ${targets.join(', ')}.`);
  if (kept.length) {
    parts.push(`${names(kept)} ${kept.length > 1 ? 'are' : 'is'} still supported (deprecated). Prefer projects (GAMS: Set as Main File), gams.editor.* settings and GAMS tasks (tasks.json). Removing them disables the legacy behavior.`);
  }
  if (dropped.length) parts.push(`Not carried over (no counterpart or already set): ${names(dropped)}.`);
  return parts.length ? `GAMS: settings of version 0.1.x found. ${parts.join(' ')}` : undefined;
}
