// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Port of GAMS Studio src/editors/logparser.cpp (LogParser::extractLinks and
 * LogParser::quickParse) and the href splitting of PExProjectNode::resolveHRef
 * (src/file/pexgroupnode.cpp). Pure module: no vscode imports.
 * Original: Copyright (c) 2017-2026 GAMS Software GmbH / GAMS Development Corp., GPL-3.0-or-later.
 */

export interface ErrorData {
  text: string;
  lstLine: number;
  errNr: number;
}

export interface MarkData {
  /** Content of the last link tag, e.g. `LST:34` or `FIL:"a.gms",5,2`. */
  hRef: string;
  lstLine: number;
  /** Content of the leading error link tag (first bracket of a "*** Error" line). */
  errRef: string;
  errNr: number;
}

export interface MarksBlockState {
  marks: MarkData;
  errData: ErrorData;
  /** Set when a `[LS2:"file"]` tag switched the secondary lst file. */
  switchLst: string;
}

export interface ExtractResult {
  /** Line text with all link tags stripped. `null` for `[TIT:...]` lines (hidden by Studio). */
  text: string | null;
  hasError: boolean;
  state: MarksBlockState;
}

export function newState(): MarksBlockState {
  return {
    marks: { hRef: '', lstLine: 0, errRef: '', errNr: 0 },
    errData: { text: '', lstLine: 0, errNr: 0 },
    switchLst: '',
  };
}

/** QString::toInt() semantics: whole string must be a (possibly signed) integer, else 0. */
function toInt(s: string): number {
  const t = s.trim();
  return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : 0;
}

function fromNativeSeparators(s: string): string {
  return s.replace(/\\/g, '/');
}

/**
 * Port of LogParser::extractLinks. `state` may be passed to carry errData between
 * lines like Studio does (errData.errNr persists only within a call, marks are reset).
 */
export function extractLinks(line: string, prev?: MarksBlockState): ExtractResult {
  const st = prev ?? newState();
  st.marks = { hRef: '', lstLine: 0, errRef: '', errNr: 0 };
  st.switchLst = '';
  let hasError = false;
  if (!line.endsWith(']') || line.length < 5 || line.startsWith('[')) {
    return { text: line, hasError, state: st };
  }

  st.errData.errNr = 0;
  let result = '';
  let posA = 0;
  let posB = 0;

  const capture = (offset: number, ch: string): string => {
    posA = posB + offset;
    posB = line.indexOf(ch, posA);
    if (posB < 0) posB = line.length;
    return line.substring(posA, posB);
  };

  if (line.startsWith('*** Error ')) {
    hasError = true;
    st.errData.lstLine = -1;
    st.errData.text = '';
    posB = 0;
    if (line.substr(9, 9) === ' at line ') {
      result = capture(0, ':');
      st.errData.errNr = -1;
      if (posB + 2 < line.length) {
        const subLen = (line.includes('[') ? line.indexOf('[') : line.length) - (posB + 2);
        st.errData.text = line.substr(posB + 2, subLen);
      }
    } else {
      posA = 9;
      while (posA < line.length && (line[posA] < '0' || line[posA] > '9')) posA++;
      posB = posA;
      while (posB < line.length && line[posB] >= '0' && line[posB] <= '9') posB++;
      const digits = line.substring(posA, posB);
      const ok = digits.length > 0;
      const errNr = ok ? parseInt(digits, 10) : 0;
      result = capture(-posB, '[');
      ++posB;
      let end = posB + 1;
      end = line.indexOf(']', end);
      if (end < 0) end = line.length;
      st.errData.errNr = ok ? errNr : 0;
      st.marks.errRef = line.substring(posB, end);
      st.marks.errNr = st.errData.errNr;
      posB = end + 1;
    }
  }

  // Now we should have a system output
  while (posA < line.length) {
    result += capture(0, '[');

    if (posB + 5 < line.length) {
      const start = posB + 1;
      const tag4 = line.substr(posB + 1, 4);
      if (line.substr(posB + 1, 5) === 'LS2:"') {
        // secondary LST file switch: [LS2:"file"]
        const fName = fromNativeSeparators(capture(6, '"'));
        st.switchLst = fName;
        ++posB;
        st.marks.hRef = line.substring(start, posB);
        st.marks.lstLine = 0;
        // Studio only skips one char here; we skip to the closing bracket so a
        // `,n` suffix cannot leak into the visible text.
        const close = line.indexOf(']', posB);
        posB = close < 0 ? line.length : close + 1;
      } else if (tag4 === 'LST:' || tag4 === 'LS2:') {
        const lineNr = toInt(capture(5, ']'));
        st.errData.lstLine = lineNr;
        st.marks.hRef = line.substring(start, posB);
        st.marks.lstLine = lineNr;
        if (st.errData.errNr < 0) st.marks.errNr = st.errData.errNr;
        ++posB;
      } else if (tag4 === 'FIL:' || tag4 === 'REF:' || tag4 === 'ERR:' || tag4 === 'DIR:') {
        capture(6, ']'); // value (unused, the whole tag is kept as href)
        st.marks.hRef = line.substring(start, posB);
        st.marks.lstLine = 0;
        ++posB;
      } else if (tag4 === 'TIT:') {
        return { text: null, hasError, state: st };
      } else {
        // no link reference: restore missing braces
        result += '[' + capture(1, ']') + ']';
        posB++;
      }
    } else {
      if (posB < line.length) result += line.substring(posB);
      break;
    }
  }
  return { text: result, hasError, state: st };
}

/**
 * Port of LogParser::quickParse operating on a string: strips trailing link tags
 * and reports where they start and the lst line (second-to-last tag assumption:
 * two links are always ERR followed by LST).
 */
export function quickParse(
  data: string,
  start = 0,
  end = data.length,
): { line: string; linkStart: number; lstLine: number } {
  let linkStart = -1;
  let lstLine = -1;
  if (end < start + 7 || data[end - 1] !== ']') {
    return { line: data.substring(start, end), linkStart, lstLine };
  }
  let inQuote = 0;
  let cutEnd = end;
  for (let i = end - 2; i > start; --i) {
    switch (data[i]) {
      case "'":
        if (inQuote !== 2) inQuote = inQuote ? 0 : 1;
        break;
      case '"':
        if (inQuote !== 1) inQuote = inQuote ? 0 : 2;
        break;
      case '[':
        if (!inQuote) {
          if (data[i + 4] === ':') {
            cutEnd = i;
            if (linkStart < 0) linkStart = i;
            if (i - 1 > start && data[i - 1] === ']') {
              const s = data.substring(i + 5, end - 1);
              lstLine = /^\d+$/.test(s) ? parseInt(s, 10) : -1;
              --i; // another link found
            } else inQuote = -1;
          } else {
            inQuote = -1;
          }
        }
        break;
      default:
        break;
    }
    if (inQuote < 0) break;
  }
  return { line: data.substring(start, cutEnd), linkStart, lstLine };
}

// ---------------------------------------------------------------------------
// href resolution (PExProjectNode::resolveHRef)
// ---------------------------------------------------------------------------

export type HRefTag = 'LST' | 'LS2' | 'INC' | 'LIB' | 'SYS' | 'DIR' | 'FIL' | 'REF' | 'ERR' | 'OTHER';

export interface ParsedHRef {
  tag: HRefTag;
  /** File name (quotes removed) for FIL/INC/LIB/SYS/DIR/REF; empty for LST/LS2. */
  name: string;
  line: number;
  col: number;
}

/** Splits an href such as `FIL:"C:/a b.gms",12,3` or `LST:34`. */
export function parseHRef(href: string): ParsedHRef | undefined {
  if (href.length < 5) return undefined;
  const code = href.substring(0, 3);
  const body = href.substring(4);
  const tag: HRefTag = (['LST', 'LS2', 'INC', 'LIB', 'SYS', 'DIR', 'FIL', 'REF', 'ERR'] as string[]).includes(code)
    ? (code as HRefTag)
    : 'OTHER';
  if (tag === 'LST' || tag === 'LS2') {
    return { tag, name: '', line: toInt(body), col: 0 };
  }
  // parts are split from the rear: trailing numeric fields, then the (quoted) name
  let m = /^"(.*)"(?:,(\d+))?(?:,(\d+))?$/.exec(body);
  if (m) return { tag, name: m[1], line: m[2] ? parseInt(m[2], 10) : 0, col: m[3] ? parseInt(m[3], 10) : 0 };
  m = /^(.*?)(?:,(\d+))?(?:,(\d+))?$/.exec(body);
  if (!m) return undefined;
  return { tag, name: m[1], line: m[2] ? parseInt(m[2], 10) : 0, col: m[3] ? parseInt(m[3], 10) : 0 };
}

export interface HRefContext {
  workDir: string;
  /** Primary listing file (parameter "lst"). Mutable: LS2 switches `ls2`. */
  lst: string;
  ls2?: string;
  inputDirs?: string[];
  sysDir?: string;
  libDirs?: string[];
}

export interface ResolvedTarget {
  file: string;
  line: number;
  col: number;
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function join(dir: string, name: string): string {
  return dir.replace(/[\\/]+$/, '') + '/' + name;
}

/**
 * Resolve a link tag to a file target. `exists` is injected for testability.
 * INC/LIB/SYS search order mirrors Studio (workdir + InputDir for INC; sysdir for SYS;
 * libincdir + sysdir/inclib for LIB), with the `.gms` fallback suffix.
 */
export function resolveHRef(
  href: string,
  ctx: HRefContext,
  exists: (path: string) => boolean,
): ResolvedTarget | undefined {
  const p = parseHRef(href);
  if (!p) return undefined;
  switch (p.tag) {
    case 'LST':
      return exists(ctx.lst) ? { file: ctx.lst, line: p.line, col: 0 } : undefined;
    case 'LS2': {
      const f = ctx.ls2 ?? '';
      return f && exists(f) ? { file: f, line: p.line, col: 0 } : undefined;
    }
    case 'DIR':
      return { file: p.name, line: 0, col: 0 };
    case 'INC':
    case 'SYS':
    case 'LIB': {
      let locations: string[] = [];
      if (p.tag === 'INC') locations = [ctx.workDir, ...(ctx.inputDirs ?? [])];
      else if (p.tag === 'SYS') locations = [ctx.sysDir ?? ''];
      else locations = [...(ctx.libDirs ?? []), ...(ctx.sysDir ? [join(ctx.sysDir, 'inclib')] : [])];
      for (let loc of locations) {
        if (!isAbsolute(loc)) loc = join(ctx.workDir, loc);
        let f = join(loc, p.name);
        if (exists(f)) return { file: f, line: p.line, col: p.col };
        f += '.gms';
        if (exists(f)) return { file: f, line: p.line, col: p.col };
      }
      return undefined;
    }
    default: {
      // FIL / REF: quoted name relative to the work dir
      if (!p.name) return undefined;
      const f = isAbsolute(p.name) ? p.name : join(ctx.workDir, p.name);
      return exists(f) ? { file: f, line: p.line, col: p.col } : undefined;
    }
  }
}
