// SPDX-License-Identifier: GPL-3.0-or-later
// Port of GAMS Studio src/numerics/doubleFormat.c (x2gfmt / x2fixed / x2efmt) and
// GdxSymbol::formatValue (src/gdxviewer/gdxsymbol.cpp). GPL-3.0-or-later.
// Pure module: no vscode / DOM dependencies (used by extension tests and the webview bundle).

export const SV_UNDEF = 1e300;
export const SV_NA = 2e300;
export const SV_PINF = 3e300;
export const SV_MINF = 4e300;
export const SV_EPS = 5e300;
export const SV_ACR = 10e300;

export type NumFormat = 'g' | 'f' | 'e';

export interface FormatOptions {
  format: NumFormat;
  /** g/e: significant digits 1..17, 0 = Full; f: decimals 0..17 */
  precision: number;
  squeeze: boolean;
  decSep: string;
  /** Extension feature (not in Studio): thousands separator inserted into the integer digits of
   * displayed values. Undefined / '' = off (Studio-identical output). Never used for copy / export. */
  group?: string;
}

/** Studio defaults (settings.cpp: gdxDefaultFormat=0 (g), gdxDefaultPrecision=6, gdxDefaultSqueezeZeroes=true). */
export const DEFAULT_FORMAT: FormatOptions = { format: 'g', precision: 6, squeeze: true, decSep: '.' };

interface Digits {
  digits: string; // no trailing zeros; '0' for zero
  decPt: number;
  neg: boolean;
}

function isNeg(v: number): boolean {
  return v < 0 || Object.is(v, -0);
}

/**
 * Exact decimal expansion of a finite double: `0.d1d2d3... * 10^decPt` (no leading or trailing zeros).
 * A double is `m * 2^e`: for `e >= 0` it is an integer, otherwise `m * 5^-e / 10^-e`.
 */
function exactDigits(a: number): { digits: string; decPt: number } {
  if (a === 0) return { digits: '0', decPt: 1 };
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, a);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const be = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (be === 0) e = -1074;
  else {
    m |= 1n << 52n;
    e = be - 1075;
  }
  let str: string;
  let shift = 0; // decimal places moved: value = str * 10^-shift
  if (e >= 0) str = (m << BigInt(e)).toString();
  else {
    str = (m * 5n ** BigInt(-e)).toString();
    shift = -e;
  }
  const decPt = str.length - shift;
  str = str.replace(/0+$/, '');
  return { digits: str, decPt };
}

/** Round the digit string to `keep` leading digits, ties to even (dtoa without ROUND_BIASED). */
function roundDigits(d: { digits: string; decPt: number }, keep: number): Digits0 {
  const { digits, decPt } = d;
  if (keep >= digits.length) return d;
  if (keep < 0) return { digits: '0', decPt: 1 };
  const next = digits.charCodeAt(keep) - 48;
  const restNonZero = digits.length > keep + 1; // digits has no trailing zeros
  const prevOdd = keep > 0 && (digits.charCodeAt(keep - 1) - 48) % 2 === 1;
  const up = next > 5 || (next === 5 && (restNonZero || prevOdd));
  let head = digits.slice(0, keep);
  if (!up) return head === '' || /^0*$/.test(head) ? { digits: '0', decPt: 1 } : { digits: head.replace(/0+$/, ''), decPt };
  if (head === '') return { digits: '1', decPt: decPt + 1 };
  // add one to the head, propagating the carry
  const chars = head.split('');
  let i = chars.length - 1;
  while (i >= 0 && chars[i] === '9') chars[i--] = '0';
  if (i < 0) return { digits: '1', decPt: decPt + 1 };
  chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
  head = chars.join('').replace(/0+$/, '');
  return { digits: head, decPt };
}
type Digits0 = { digits: string; decPt: number };

/** dtoa mode 0 (shortest round trip) and mode 2 (n significant digits, ties to even). */
function digitsSig(v: number, nSig: number): Digits {
  const a = Math.abs(v);
  if (nSig > 0 && a !== 0) {
    // JS rounds exact binary ties up; only a result of n+1 digits ending in 5 that parses back to
    // the very same double can be a tie, and only then the exact expansion is needed
    const probe = a.toExponential(nSig);
    if (/5e[+-]\d+$/.test(probe) && Number(probe) === a) {
      const r = roundDigits(exactDigits(a), nSig);
      return { digits: r.digits, decPt: r.decPt, neg: isNeg(v) };
    }
  }
  const s = nSig <= 0 ? a.toExponential() : a.toExponential(nSig - 1);
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return { digits: '0', decPt: 1, neg: isNeg(v) };
  let digits = (m[1] + (m[2] ?? '')).replace(/0+$/, '');
  let decPt = parseInt(m[3], 10) + 1;
  if (digits === '') { digits = '0'; decPt = 1; }
  return { digits, decPt, neg: isNeg(v) };
}

/** dtoa mode 3 (nDecimals digits past the decimal point, ties to even). */
function digitsFixed(v: number, nDec: number): Digits {
  const a = Math.abs(v);
  // toFixed switches to exponent notation from 1e21 on
  const probe = a < 1e21 ? a.toFixed(nDec + 1) : '5';
  if (a !== 0 && probe.endsWith('5') && (a >= 1e21 || Number(probe) === a)) {
    const e = exactDigits(a);
    const r = roundDigits(e, e.decPt + nDec);
    return { digits: r.digits, decPt: r.decPt, neg: isNeg(v) };
  }
  const s = a.toFixed(nDec);
  const [ip, fp = ''] = s.split('.');
  let all = ip + fp;
  let decPt = ip.length;
  const lead = /^0*/.exec(all)![0].length;
  all = all.slice(lead);
  decPt -= lead;
  all = all.replace(/0+$/, '');
  if (all === '') return { digits: '0', decPt: 1, neg: isNeg(v) };
  return { digits: all, decPt, neg: isNeg(v) };
}

function zeros(n: number): string {
  return n > 0 ? '0'.repeat(n) : '';
}

function dig2Exp(d: Digits, nSigFigs: number, zeroPad: boolean, decSep: string): string | undefined {
  const n = d.digits.length;
  if (n < 1 || n > 20) return undefined;
  const k = nSigFigs - n;
  let out = d.neg ? '-' : '';
  out += d.digits[0];
  const rest = d.digits.slice(1);
  if (rest.length > 0 || (zeroPad && k > 0)) out += decSep;
  out += rest;
  if (zeroPad && k > 0) out += zeros(k);
  let e = d.decPt - 1;
  out += 'e';
  if (e < 0) { e = -e; out += '-'; } else out += '+';
  out += e <= 99 ? String(e).padStart(2, '0') : String(e);
  return out;
}

function dig2Fixed(d: Digits, nDecimals: number, zeroPad: boolean, decSep: string): string | undefined {
  const n = d.digits.length;
  const { decPt, digits } = d;
  if (n < 1 || n > 21) return undefined;
  if (decPt > 22 || decPt < -18) return undefined;
  let out = d.neg ? '-' : '';
  if (decPt > n) {
    out += digits + zeros(decPt - n);
    if (zeroPad && nDecimals > 0) out += decSep + zeros(nDecimals);
  } else if (decPt === n) {
    out += digits;
    if (zeroPad && nDecimals > 0) out += decSep + zeros(nDecimals);
  } else if (decPt > 0) {
    const k = n - decPt;
    out += digits.slice(0, decPt) + decSep + digits.slice(decPt);
    if (zeroPad && k < nDecimals) out += zeros(nDecimals - k);
  } else if (decPt === 0) {
    out += '0' + decSep + digits;
    if (zeroPad && n < nDecimals) out += zeros(nDecimals - n);
  } else {
    out += '0' + decSep + zeros(-decPt) + digits;
    if (zeroPad) {
      const k = n - decPt;
      if (k < nDecimals) out += zeros(nDecimals - k);
    }
  }
  return out;
}

export function x2efmt(v: number, nSigFigs: number, squeeze: boolean, decSep = '.'): string | undefined {
  if (nSigFigs > 17) nSigFigs = 17;
  if (nSigFigs <= 0) nSigFigs = 0;
  if (!Number.isFinite(v)) return undefined;
  return dig2Exp(digitsSig(v, nSigFigs), nSigFigs, !squeeze, decSep);
}

export function x2fixed(v: number, nDecimals: number, squeeze: boolean, decSep = '.'): string | undefined {
  if (nDecimals > 17) nDecimals = 17;
  if (nDecimals < 0) nDecimals = 0;
  if (!Number.isFinite(v)) return undefined;
  const vMax = Math.pow(10, 21 - nDecimals);
  if (Math.abs(v) > vMax) return dig2Exp(digitsSig(v, 0), 17, !squeeze, decSep);
  return dig2Fixed(digitsFixed(v, nDecimals), nDecimals, !squeeze, decSep);
}

const MAXTRAILZEROS = 5;

export function x2gfmt(v: number, nSigFigs: number, squeeze: boolean, decSep = '.'): string | undefined {
  if (nSigFigs > 17) nSigFigs = 17;
  if (nSigFigs <= 0) nSigFigs = 0;
  if (!Number.isFinite(v)) return undefined;
  const d = digitsSig(v, nSigFigs);
  let sigFigs = d.digits.length;
  if (nSigFigs <= 0) {
    if (sigFigs < d.decPt) sigFigs += Math.min(d.decPt - d.digits.length, MAXTRAILZEROS);
  } else if (sigFigs < nSigFigs) {
    sigFigs = nSigFigs;
  }
  if (d.decPt < -3 || d.decPt - sigFigs >= 1) return dig2Exp(d, nSigFigs, !squeeze, decSep);
  return dig2Fixed(d, nSigFigs - d.decPt, !squeeze, decSep);
}

/** Insert `sep` between groups of three digits of the leading integer part (`-1234567.5e+3` -> `-1,234,567.5e+3`). */
export function groupThousands(s: string, sep: string): string {
  const m = /^(-?)(\d+)(.*)$/s.exec(s);
  if (!m || m[2].length < 4) return s;
  return m[1] + m[2].replace(/\B(?=(\d{3})+$)/g, sep) + m[3];
}

/** Grouping and decimal characters of a locale (`vscode.env.language`), e.g. de -> `.` and `,`. */
export function localeSeparators(lang: string | undefined): { group: string; decimal: string } {
  try {
    const parts = new Intl.NumberFormat(lang || undefined).formatToParts(1234567.5);
    return {
      group: parts.find((p) => p.type === 'group')?.value ?? ',',
      decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    };
  } catch {
    return { group: ',', decimal: '.' };
  }
}

/** DoubleFormatter::format */
export function formatDouble(v: number, o: FormatOptions = DEFAULT_FORMAT): string {
  const r =
    o.format === 'g' ? x2gfmt(v, o.precision, o.squeeze, o.decSep)
      : o.format === 'f' ? x2fixed(v, o.precision, o.squeeze, o.decSep)
        : x2efmt(v, o.precision, o.squeeze, o.decSep);
  if (r === undefined) return 'FORMAT_ERROR';
  return o.group ? groupThousands(r, o.group) : r;
}

/** GdxSymbol::formatValue: special values replace numbers >= UNDEF. */
export function formatValue(v: number | string, o: FormatOptions = DEFAULT_FORMAT): string {
  if (typeof v === 'string') return v;
  if (v < SV_UNDEF) return formatDouble(v, o);
  if (v === SV_UNDEF) return 'UNDF';
  if (v === SV_NA) return 'NA';
  if (v === SV_PINF) return '+INF';
  if (v === SV_MINF) return '-INF';
  if (v === SV_EPS) return 'EPS';
  if (v >= SV_ACR) return 'ACRONYM'; // Studio asks gdxAcronymName; not available over the protocol
  return String(v);
}
