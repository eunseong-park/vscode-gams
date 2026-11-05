// SPDX-License-Identifier: GPL-3.0-or-later
// Pure (vscode-free) logic for the "gams.studioColors" setting: builds the semantic token / TextMate rules
// for a Studio theme and merges them into / removes them from the user's existing settings values.
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, SLOT_TOKEN_TYPES, STUDIO_THEMES, StudioSlot, StudioTheme } from './studioThemes';

export const SEMANTIC_KEY = 'editor.semanticTokenColorCustomizations';
export const TEXTMATE_KEY = 'editor.tokenColorCustomizations';

/**
 * TextMate scopes per Studio slot (mirrors package.json contributes.semanticTokenScopes). They are the scopes
 * of syntaxes/gams.tmLanguage.json whose text Studio paints with the slot (so the Studio colors apply before the
 * language server sends semantic tokens), plus a few fallback scopes the grammar does not produce. The first
 * scope is the one ordinary themes color the semantic token type with.
 */
export const SLOT_SCOPES: Record<StudioSlot, string[]> = {
  dco: ['keyword.control.directive.gams', 'punctuation.definition.directive.gams'],
  dcoBody: ['string.unquoted.argument.gams'],
  comment: ['comment.line.asterisk.gams', 'comment.block.gams', 'comment.line.double-exclamation.gams', 'comment.line.asterisk.mpsge.gams'],
  title: ['string.unquoted.title.gams'],
  // Studio: compile-time / run-time system attributes and %user% variables (the embedded code body itself is
  // left to the embedded language's grammar)
  embedded: [
    'support.function.embedded.gams',
    'support.variable.system.compile-time.gams',
    'support.constant.system.compile-time.gams',
    'variable.other.compile-time.gams',
    'support.variable.system.gams',
  ],
  // Studio paints quoted strings with the assignment label slot
  assignLabel: ['variable.other.enummember.gams', 'string.quoted.single.gams', 'string.quoted.double.gams'],
  assignValue: ['constant.numeric.gams'],
  keyword: [
    'keyword.other.reserved.gams',
    'keyword.control.solve.gams',
    'keyword.other.solve.gams',
    'support.type.model.gams',
    'keyword.control.option.gams',
    'variable.parameter.option.gams',
    'keyword.other.put.gams',
    'keyword.other.execute.gams',
    'keyword.control.embedded.gams',
  ],
  declaration: ['storage.type.declaration.gams'],
  identifier: ['variable.other.declaration.gams'],
  description: ['comment.block.documentation.gams', 'comment.line.exclamation.mpsge.gams'],
  tableHeader: ['variable.other.enummember.table-header.gams'],
  // extension (MPSGE blocks): colored like Studio's declaration keyword / keyword slots, see studioThemes.ts
  mpsgeSection: ['storage.type.section.mpsge.gams'],
  mpsgeField: ['keyword.other.field.mpsge.gams'],
};

/** Marker in `name` of the TextMate rules we own. */
export const RULE_NAME_PREFIX = 'GAMS Studio colors: ';

const SLOTS = Object.keys(SLOT_TOKEN_TYPES) as StudioSlot[];
const OUR_TOKEN_TYPES = new Set<string>(Object.values(SLOT_TOKEN_TYPES));

export type SettingValue = 'off' | 'auto' | string;
export interface SemanticRule { foreground: string; bold: boolean; italic: boolean }
export interface TextMateRule { name: string; scope: string[]; settings: { foreground: string; fontStyle: string } }
type Obj = Record<string, unknown>;

export function getTheme(id: string): StudioTheme | undefined {
  return STUDIO_THEMES.find((t) => t.id === id);
}

/** Theme to apply for a setting value; undefined means "off" (or an unknown id). `light` = VS Code kind is Light/HC light. */
export function resolveTheme(value: SettingValue, light: boolean): StudioTheme | undefined {
  if (value === 'off') return undefined;
  if (value === 'auto') return getTheme(light ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME);
  return getTheme(value);
}

export function semanticRules(theme: StudioTheme): Record<string, SemanticRule> {
  const out: Record<string, SemanticRule> = {};
  for (const s of SLOTS) {
    const { foreground, bold, italic } = theme.slots[s];
    out[SLOT_TOKEN_TYPES[s]] = { foreground, bold, italic };
  }
  return out;
}

export function textMateRules(theme: StudioTheme): TextMateRule[] {
  return SLOTS.map((s) => {
    const { foreground, bold, italic } = theme.slots[s];
    return { name: RULE_NAME_PREFIX + s, scope: SLOT_SCOPES[s], settings: { foreground, fontStyle: [bold ? 'bold' : '', italic ? 'italic' : ''].filter(Boolean).join(' ') } };
  });
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Obj)[k], (b as Obj)[k]));
}

export interface MergeResult<T> {
  /** New value to write (undefined = remove the setting). Only meaningful when `changed`. */
  value: T | undefined;
  changed: boolean;
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Merge our rules into the global value of `editor.semanticTokenColorCustomizations`.
 * theme === undefined removes only our token types (and leaves everything else, incl. theme-scoped blocks, alone).
 */
export function mergeSemantic(existing: unknown, theme: StudioTheme | undefined): MergeResult<Obj> {
  const base: Obj = isObj(existing) ? existing : {};
  const oldRules: Obj = isObj(base['rules']) ? (base['rules'] as Obj) : {};
  const kept: Obj = {};
  for (const [k, v] of Object.entries(oldRules)) if (!OUR_TOKEN_TYPES.has(k)) kept[k] = v;
  const hadOurs = Object.keys(oldRules).length !== Object.keys(kept).length;
  if (!theme) {
    if (!hadOurs) return { value: existing as Obj | undefined, changed: false };
    const next: Obj = { ...base };
    if (Object.keys(kept).length) next['rules'] = kept; else delete next['rules'];
    return { value: Object.keys(next).length ? next : undefined, changed: true };
  }
  const rules = { ...kept, ...semanticRules(theme) };
  const next: Obj = { ...base, rules };
  // Compare our entries only (key order within rules is irrelevant).
  const same = isObj(base['rules']) && Object.keys(oldRules).length === Object.keys(rules).length && deepEqual(oldRules, rules);
  return same ? { value: existing as Obj, changed: false } : { value: next, changed: true };
}

const isOurs = (r: unknown): boolean => isObj(r) && typeof r['name'] === 'string' && (r['name'] as string).startsWith(RULE_NAME_PREFIX);

/** Same discipline for `editor.tokenColorCustomizations`: only `textMateRules` entries named by us are touched. */
export function mergeTextMate(existing: unknown, theme: StudioTheme | undefined): MergeResult<Obj> {
  const base: Obj = isObj(existing) ? existing : {};
  const oldRules: unknown[] = Array.isArray(base['textMateRules']) ? (base['textMateRules'] as unknown[]) : [];
  const oldOurs = oldRules.filter(isOurs);
  const others = oldRules.filter((r) => !isOurs(r));
  if (!theme) {
    if (!oldOurs.length) return { value: existing as Obj | undefined, changed: false };
    const next: Obj = { ...base };
    if (others.length) next['textMateRules'] = others; else delete next['textMateRules'];
    return { value: Object.keys(next).length ? next : undefined, changed: true };
  }
  const ours = textMateRules(theme);
  if (deepEqual(oldOurs, ours)) return { value: existing as Obj, changed: false };
  return { value: { ...base, textMateRules: [...others, ...ours] }, changed: true };
}
