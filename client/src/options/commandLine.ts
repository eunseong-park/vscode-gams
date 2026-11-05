// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Port of GAMS Studio command line parameter handling: OptionTokenizer::tokenize/format/normalize
 * (src/option/optiontokenizer.cpp) and Option::getValueErrorType (src/option/option.cpp).
 * No vscode imports.
 */

/** optOptionType (optcc.h). */
export const enum OptType {
  Integer = 0,
  Double = 1,
  String = 2,
  Boolean = 3,
  EnumStr = 4,
  EnumInt = 5,
  MultiList = 6,
  StrList = 7,
  Macro = 8,
  Immediate = 9,
}

export interface EnumValue {
  value: string;
  description: string;
  hidden: boolean;
}

/** Option as delivered by the server request `gams/optionDefinitions`. */
export interface OptionDef {
  nr: number;
  name: string;
  description: string;
  group: number;
  type: number;
  typeName: string;
  deprecated: boolean;
  hidden: boolean;
  synonyms: string[];
  default: string;
  lower: string | null;
  upper: string | null;
  enums: EnumValue[];
}

export interface OptionDefinitions {
  file: string;
  options: OptionDef[];
  synonyms: { synonym: string; option: string; deprecated: boolean }[];
  groups: { nr: number; name: string; description: string; hidden: boolean }[];
}

/** One `key[=]value` entry (Studio OptionItem). Positions are character offsets, -1 if absent. */
export interface OptionItem {
  key: string;
  value: string;
  keyPosition: number;
  valuePosition: number;
  /** same option given more than once (not for immediate options) */
  recurrent: boolean;
}

export interface ParamIssue {
  start: number;
  length: number;
  message: string;
  severity: 'error' | 'warning';
}

const MAX_INT = 2147483647;
const MAX_DOUBLE = 1e300;

/** Case-insensitive lookup of names and synonyms (Option::isValid / isASynonym / getNameFromSynonym). */
export class OptionIndex {
  private readonly byName = new Map<string, OptionDef>();
  private readonly synonym = new Map<string, string>();
  private readonly deprecatedSynonym = new Set<string>();

  constructor(readonly defs: OptionDefinitions) {
    for (const o of defs.options) this.byName.set(o.name.toUpperCase(), o);
    for (const s of defs.synonyms) {
      this.synonym.set(s.synonym.toUpperCase(), s.option.toUpperCase());
      if (s.deprecated) this.deprecatedSynonym.add(s.synonym.toUpperCase());
    }
  }

  /** Valid = defined and not hidden (helpContext != 0). */
  isValid(name: string): boolean {
    const o = this.byName.get(name.toUpperCase());
    return !!o && !o.hidden;
  }

  isSynonym(name: string): boolean {
    return this.synonym.has(name.toUpperCase());
  }

  isDeprecated(name: string): boolean {
    const o = this.byName.get(name.toUpperCase());
    if (o) return o.deprecated;
    return this.deprecatedSynonym.has(name.toUpperCase());
  }

  /** Resolve a name or synonym to its definition. */
  resolve(name: string): OptionDef | undefined {
    const up = name.toUpperCase();
    if (this.isValid(up)) return this.byName.get(up);
    const real = this.synonym.get(up);
    return real ? this.byName.get(real) : undefined;
  }
}

/** Studio `OptionTokenizer::tokenize`: key up to blank or `=`; blanks and at most one `=`; value (quoted values run to the closing quote). */
export function tokenize(str: string): OptionItem[] {
  const items: OptionItem[] = [];
  const n = str.length;
  let o = 0;
  while (o < n && str[o] === ' ') o++;
  while (o < n) {
    let key = '';
    let value = '';
    const keyPosition = o;
    let valuePosition = -1;
    while (o < n && str[o] !== ' ' && str[o] !== '=') key += str[o++];
    if (o >= n) {
      items.push({ key, value, keyPosition, valuePosition, recurrent: false });
      break;
    }
    let seenEq = false;
    while (o < n && (str[o] === ' ' || str[o] === '=')) {
      if (str[o] === '=') {
        if (seenEq) break;
        seenEq = true;
      }
      o++;
    }
    if (o >= n) {
      items.push({ key, value, keyPosition, valuePosition, recurrent: false });
      break;
    }
    // value
    let quoted = false;
    let closed = false;
    if (str[o] === '"') {
      quoted = true;
      valuePosition = o;
      value += str[o++];
    }
    while (o < n) {
      if (!quoted) {
        if (str[o] === ' ') break;
      } else if (closed && str[o] === ' ') {
        break;
      } else if (str[o] === '"') {
        closed = true;
      }
      if (valuePosition === -1) valuePosition = o;
      value += str[o++];
    }
    items.push({ key, value, keyPosition, valuePosition, recurrent: false });
    while (o < n && str[o] === ' ') o++;
  }
  return items;
}

const DOUBLE_DASH = /^[-/][-/](\S*)$/;
const DOUBLE_DASH_NAME = /^[a-zA-Z]+[_a-zA-Z0-9]*$/;
const OPTION_KEY_PREFIX = /^[-/]+/;
const VERSION = /^[1-9][0-9](\.([0-9])(\.([0-9]))?)?$/;

export function isDoubleDashed(key: string): boolean {
  return DOUBLE_DASH.test(key);
}

export function isDoubleDashedName(name: string): boolean {
  return DOUBLE_DASH_NAME.test(name);
}

/** Version field of gamsconfig.yaml entries (Option::isConformantVersion). */
export function isConformantVersion(v: string): boolean {
  return VERSION.test(v);
}

/** Option name without leading `-`/`/` characters (Option::getOptionKey). */
export function optionKey(key: string): string {
  return key.replace(OPTION_KEY_PREFIX, '');
}

/** `key=value` list; empty keys/values are not generated here. Double-dash keys are kept as typed (Studio normalize). */
export function normalize(items: OptionItem[]): string[] {
  return items.map((it) => {
    const k = isDoubleDashed(it.key) ? it.key : it.key.replace(/^[-/]/, '');
    return it.value === '' ? k : `${k}=${it.value}`;
  });
}

/** Qt QString::toInt: whole string must be a (signed) decimal integer. */
function toInt(s: string): number | undefined {
  return /^[+-]?\d+$/.test(s) ? Number(s) : undefined;
}

/** Qt QString::toDouble (decimal and scientific notation). */
function toDouble(s: string): number | undefined {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : undefined;
}

function bound(s: string | null, dflt: number): number {
  if (s === null) return dflt;
  const l = s.toLowerCase();
  if (l === 'maxint' || l === 'maxdouble') return l === 'maxint' ? MAX_INT : MAX_DOUBLE;
  if (l === 'minint') return -MAX_INT - 1;
  if (l === 'mindouble') return -MAX_DOUBLE;
  const n = Number(s);
  return Number.isNaN(n) ? dflt : n;
}

export type ValueError = 'none' | 'type' | 'range' | 'missing';

/** Option::getValueErrorType for a non-deprecated, known option. */
export function valueError(o: OptionDef, rawValue: string): ValueError {
  const value = rawValue;
  if (value.trim() === '') return 'missing';
  const lo = (d: number) => bound(o.lower, d);
  const hi = (d: number) => bound(o.upper, d);
  switch (o.type) {
    case OptType.Immediate:
      return 'none';
    case OptType.EnumInt: {
      const n = toInt(value);
      if (n === undefined) return 'type';
      return o.enums.some((e) => toInt(e.value) === n) ? 'none' : 'range';
    }
    case OptType.EnumStr:
      return o.enums.some((e) => e.value.replace(/^"|"$/g, '').toLowerCase() === value.toLowerCase()) ? 'none' : 'range';
    case OptType.Integer: {
      let n = toInt(value);
      if (n === undefined) {
        const l = value.toLowerCase();
        if (l === 'maxint') n = MAX_INT;
        else if (l === 'minint') n = -MAX_INT - 1;
        else {
          const d = toDouble(value);
          if (d === undefined) return 'type';
          const iv = Math.trunc(d);
          if (Math.abs(d - iv) < 0.01) n = iv;
          else return 'type';
        }
      }
      return n < lo(-MAX_INT - 1) || hi(MAX_INT) < n ? 'range' : 'none';
    }
    case OptType.Double: {
      let d = toDouble(value);
      if (d === undefined) {
        const l = value.toLowerCase();
        if (l === 'eps') return 'none';
        if (l === 'maxdouble') d = MAX_DOUBLE;
        else if (l === 'mindouble') d = -MAX_DOUBLE;
        else return 'type';
      }
      return d < lo(-MAX_DOUBLE) || hi(MAX_DOUBLE) < d ? 'range' : 'none';
    }
    case OptType.Boolean: {
      const n = toInt(value);
      return n === 0 || n === 1 ? 'none' : 'type';
    }
    default:
      return 'none';
  }
}

/** Studio `OptionTokenizer::format`: validation messages for a tokenized command line. */
export function validate(items: OptionItem[], index: OptionIndex): ParamIssue[] {
  const out: ParamIssue[] = [];
  const seen = new Map<string, OptionItem[]>();
  for (const item of items) {
    if (isDoubleDashed(item.key)) {
      const name = optionKey(item.key);
      if (!isDoubleDashedName(name)) {
        out.push({
          start: item.keyPosition,
          length: item.key.length,
          message: `${name} (Either start with other character than [a-z or A-Z], or a subsequent character is not one of (a-z, A-Z, 0-9, or _))`,
          severity: 'error',
        });
      }
      continue;
    }
    let key = item.key;
    if (key.startsWith('-') || key.startsWith('/')) key = key.substring(1);
    if (key === '') {
      out.push({ start: item.valuePosition, length: item.value.length, message: `${item.value} (Option keyword expected for value "${item.value}")`, severity: 'error' });
      continue;
    }
    if (!index.isValid(key) && !index.isSynonym(key)) {
      out.push({ start: item.keyPosition, length: item.key.length, message: `${key} (Unknown option)`, severity: 'error' });
      continue;
    }
    const def = index.resolve(key);
    const span = item.value === '' ? item.key.length : item.valuePosition + item.value.length - item.keyPosition;
    if (index.isDeprecated(key)) {
      const bad = def && item.value !== '' && ['type', 'range'].includes(valueError(def, item.value));
      out.push({
        start: item.keyPosition,
        length: span,
        message: bad
          ? `${item.value} (Invalid value for deprecated option "${key}", option will be eventually ignored)`
          : `${key} (Deprecated option, will be ignored)`,
        severity: 'warning',
      });
      continue;
    }
    if (!def) continue;
    const list = seen.get(def.name.toUpperCase()) ?? [];
    list.push(item);
    seen.set(def.name.toUpperCase(), list);

    if (item.value.trim() === '') {
      out.push({ start: item.keyPosition, length: item.key.length, message: `"" (missing defined value for option "${item.key}")`, severity: 'error' });
      continue;
    }
    let value = item.value;
    if (value.startsWith('"') && value.endsWith('"')) value = value.substring(1, value.length - 1);
    if (value.includes('"')) {
      out.push({ start: item.valuePosition, length: item.value.length, message: `${item.value} (value error, bad double quoted value)`, severity: 'error' });
      continue;
    }
    const at = { start: item.valuePosition, length: item.value.length, severity: 'error' as const };
    if (def.enums.length > 0 && (def.type === OptType.EnumInt || def.type === OptType.EnumStr)) {
      if (valueError(def, value) !== 'none') {
        const possible = def.enums.filter((e) => !e.hidden).map((e) => e.value.replace(/^"|"$/g, ''));
        out.push({ ...at, message: `${value} (unknown value for option "${key}"), Possible values are ${possible.join(' ')} ` });
      }
    } else {
      const err = valueError(def, item.value);
      if (err === 'range') {
        out.push({ ...at, message: `${value} (value error for option "${key}"), not in range [${def.lower ?? ''},${def.upper ?? ''}]` });
      } else if (err === 'type' && def.type === OptType.Boolean) {
        // Studio reports nothing here (its type check only looks at integer/double parsing)
        out.push({ ...at, message: `${value} (value error for option "${key}"), 0 or 1 expected` });
      } else if (err === 'type') {
        const what = def.type === OptType.Integer ? 'Integer' : 'Double';
        if (def.type === OptType.Integer ? toInt(value) === undefined : toDouble(value) === undefined) {
          out.push({ ...at, message: `${value} (value error for option "${key}"), ${what} expected` });
        }
      }
    }
  }
  for (const [name, list] of seen) {
    const def = index.resolve(name);
    if (!def || def.type === OptType.Immediate || list.length < 2) continue;
    for (const item of list) item.recurrent = true;
    for (const item of list) {
      out.push({ start: item.keyPosition, length: item.key.length, message: `${item.key} (Recurrent), only last entry of same parameter will not be ignored`, severity: 'warning' });
    }
  }
  return out;
}

export interface Completion {
  label: string;
  detail: string;
  documentation: string;
  /** replaces [start, end) of the command line */
  start: number;
  end: number;
  insert: string;
  deprecated?: boolean;
}

/**
 * Completion for the token under `cursor` (end of text when omitted): option names and synonyms
 * for the key position, enum / boolean values for the value position. Deprecated options are
 * offered but marked; hidden options are not.
 */
export function complete(text: string, index: OptionIndex, cursor = text.length): Completion[] {
  const before = text.substring(0, cursor);
  const items = tokenize(before);
  const last = items[items.length - 1];
  const out: Completion[] = [];
  let mode: 'key' | 'value' = 'key';
  let item: OptionItem | undefined;
  if (last) {
    const openQuote = last.value.startsWith('"') && (last.value.length === 1 || !last.value.endsWith('"'));
    if (last.value !== '') {
      if (openQuote || !before.endsWith(' ')) {
        mode = 'value';
        item = last;
      } // else: a complete pair followed by a blank starts a new key
    } else if (/[ =]$/.test(before)) {
      mode = 'value';
      item = last;
    } else {
      item = last;
    }
  }
  if (mode === 'key') {
    const start = item ? item.keyPosition : cursor;
    const prefix = (item ? item.key : '').replace(/^[-/]/, '');
    const lead = item && /^[-/]/.test(item.key) ? 1 : 0;
    const up = prefix.toUpperCase();
    for (const o of index.defs.options) {
      if (o.hidden) continue;
      const names = [o.name, ...o.synonyms];
      for (const n of names) {
        if (!n.toUpperCase().startsWith(up)) continue;
        out.push({
          label: n,
          detail: n === o.name ? o.typeName : `synonym of ${o.name}`,
          documentation: describe(o),
          start: start + lead,
          end: cursor,
          insert: n + '=',
          deprecated: o.deprecated,
        });
      }
    }
    return out;
  }
  const def = index.resolve(item!.key.replace(/^[-/]/, ''));
  if (!def) return out;
  const start = item!.value !== '' ? item!.valuePosition : cursor;
  const prefix = item!.value.replace(/^"/, '').toLowerCase();
  let vals = def.enums.filter((e) => !e.hidden).map((e) => ({ v: e.value.replace(/^"|"$/g, ''), d: e.description }));
  if (vals.length === 0 && def.type === OptType.Boolean) vals = [{ v: '0', d: 'off' }, { v: '1', d: 'on' }];
  for (const { v, d } of vals) {
    if (!v.toLowerCase().startsWith(prefix)) continue;
    out.push({ label: v, detail: d, documentation: d, start, end: cursor, insert: /\s/.test(v) ? `"${v}"` : v });
  }
  return out;
}

/** Plain-text description for completion docs (Studio definition tree columns: type, range, default). */
export function describe(o: OptionDef): string {
  const parts = [o.description];
  const meta = [`Type: ${o.typeName}`];
  if (o.lower !== null && o.upper !== null) meta.push(`Range: [${o.lower}, ${o.upper}]`);
  if (o.default !== '') meta.push(`Default: ${o.default}`);
  if (o.synonyms.length) meta.push(`Synonyms: ${o.synonyms.join(', ')}`);
  if (o.deprecated) meta.push('Deprecated');
  parts.push(meta.join('; '));
  return parts.join('\n');
}
