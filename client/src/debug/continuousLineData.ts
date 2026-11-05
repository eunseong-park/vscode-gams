// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Port of GAMS Studio src/gamscom/continuouslinedata.h/.cpp (gamscom::ContinuousLineData):
 * maps file/line <-> the "continuous line number" (contLN) CMEX works with, and keeps the
 * breakpoints of a project (active = adjusted to a valid line, aimed = requested -> active).
 * GPL-3.0-or-later. Pure module: no vscode imports.
 */

/** Smallest key >= k in an ascending array (QMap::lowerBound), or undefined. */
function lowerBoundKey(keys: readonly number[], k: number): number | undefined {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < k) lo = mid + 1;
    else hi = mid;
  }
  return lo < keys.length ? keys[lo] : undefined;
}

function sortedKeys<V>(m: Map<number, V>): number[] {
  return [...m.keys()].sort((a, b) => a - b);
}

/** QMultiMap<int,int>: line -> contLNs */
type MultiMap = Map<number, number[]>;
/** SortedIntMap (QMap<int,int>) */
export type SortedIntMap = Map<number, number>;

export class ContinuousLineData {
  /** ascending by contLN: [last contLN of a segment, file] (mLastCln4File) */
  private lastCln4File: [number, string][] = [];
  private cln2Line = new Map<number, number>();
  private fileLine2Cln = new Map<string, MultiMap>();
  private activeBp = new Map<string, SortedIntMap>();
  private aimedBp = new Map<string, SortedIntMap>();

  /** `key` normalizes file names (e.g. case folding on Windows); identity by default */
  constructor(private readonly key: (file: string) => string = (f) => f) {}

  clearLinesMap(): void {
    this.lastCln4File = [];
    this.cln2Line.clear();
    this.fileLine2Cln.clear();
  }

  addLinesMap(filename: string, fileLines: readonly number[], contLines: readonly number[]): boolean {
    if (fileLines.length === 0 || fileLines.length !== contLines.length) return false;
    const f = this.key(filename);
    const last = this.lastCln4File[this.lastCln4File.length - 1];
    if (last && last[1] === f) this.lastCln4File.pop();
    const last2 = this.lastCln4File[this.lastCln4File.length - 1];
    if (!last2 || last2[1] !== f) this.insertLast(contLines[contLines.length - 1], f);

    const rev: MultiMap = this.fileLine2Cln.get(f) ?? new Map();
    for (let i = 0; i < fileLines.length; ++i) {
      this.cln2Line.set(contLines[i], fileLines[i]);
      const arr = rev.get(fileLines[i]) ?? [];
      if (!arr.includes(contLines[i])) arr.push(contLines[i]);
      rev.set(fileLines[i], arr);
    }
    this.fileLine2Cln.set(f, rev);
    return true;
  }

  private insertLast(contLine: number, file: string): void {
    const i = this.lastCln4File.findIndex(([k]) => k >= contLine);
    if (i < 0) this.lastCln4File.push([contLine, file]);
    else if (this.lastCln4File[i][0] === contLine) this.lastCln4File[i] = [contLine, file];
    else this.lastCln4File.splice(i, 0, [contLine, file]);
  }

  hasLinesMap(): boolean {
    return this.fileLine2Cln.size > 0;
  }

  /** all contLNs of a file line (a file included several times has several) */
  continuousLine(filename: string, fileLine: number): number[] {
    return [...(this.fileLine2Cln.get(this.key(filename))?.get(fileLine) ?? [])];
  }

  /** valid (breakable) lines of a file, ascending */
  validLines(filename: string): number[] {
    const m = this.fileLine2Cln.get(this.key(filename));
    return m ? sortedKeys(m) : [];
  }

  files(): string[] {
    return [...this.fileLine2Cln.keys()];
  }

  filename(contLine: number): string {
    if (contLine < 0 || this.lastCln4File.length === 0) return '';
    const i = this.lastCln4File.findIndex(([k]) => k >= contLine);
    return i < 0 ? this.lastCln4File[this.lastCln4File.length - 1][1] : this.lastCln4File[i][1];
  }

  fileLine(contLine: number): number {
    return this.cln2Line.get(contLine) ?? -1;
  }

  bpFiles(): string[] {
    return [...this.activeBp.keys()];
  }

  /** after the linesMap arrived: move every breakpoint to the next valid line */
  adjustBreakpoints(): void {
    const newBp = new Map<string, SortedIntMap>();
    const newAim = new Map<string, SortedIntMap>();
    for (const [file, lines] of this.activeBp) {
      const bps: SortedIntMap = new Map();
      const aim: SortedIntMap = new Map();
      for (const line of sortedKeys(lines)) {
        const adj = this.adjustBreakpoint(file, line);
        bps.set(adj, adj);
        aim.set(line, adj);
      }
      newBp.set(file, bps);
      newAim.set(file, aim);
    }
    this.activeBp = newBp;
    this.aimedBp = newAim;
  }

  /** ContinuousLineData::adjustBreakpoint: next valid line >= fileLine, else the last valid line; -1 without lines */
  adjustBreakpoint(filename: string, fileLine: number): number {
    const map = this.fileLine2Cln.get(this.key(filename));
    if (!map || map.size === 0) return -1;
    const keys = sortedKeys(map);
    return lowerBoundKey(keys, fileLine) ?? keys[keys.length - 1];
  }

  /** returns the line the breakpoint is set to (adjusted only while running, like Studio) */
  addBreakpoint(filename: string, fileLine: number, isRunning = false): number {
    const f = this.key(filename);
    const map = this.fileLine2Cln.get(f);
    let resLine = fileLine;
    if (map && map.size > 0 && isRunning) {
      const keys = sortedKeys(map);
      resLine = lowerBoundKey(keys, fileLine) ?? keys[keys.length - 1];
    }
    const lines = this.activeBp.get(f) ?? new Map();
    lines.set(resLine, resLine);
    this.activeBp.set(f, lines);
    const aimed = this.aimedBp.get(f) ?? new Map();
    aimed.set(fileLine, resLine);
    this.aimedBp.set(f, aimed);
    return resLine;
  }

  delBreakpoint(filename: string, fileLine: number): void {
    const f = this.key(filename);
    const lines = this.activeBp.get(f);
    if (lines) {
      lines.delete(fileLine);
      if (lines.size === 0) this.activeBp.delete(f);
    }
    const aimed = this.aimedBp.get(f);
    if (aimed) {
      for (const [k, v] of [...aimed]) if (k === fileLine || v === fileLine) aimed.delete(k);
      if (aimed.size === 0) this.aimedBp.delete(f);
    }
  }

  clearBreakpoints(): void {
    this.activeBp.clear();
    this.aimedBp.clear();
  }

  resetAimedBreakpoints(): void {
    this.aimedBp = new Map([...this.activeBp].map(([f, m]) => [f, new Map(m)]));
  }

  bpFileLines(filename: string): SortedIntMap {
    return new Map(this.activeBp.get(this.key(filename)) ?? []);
  }

  bpAimedFileLines(filename: string): SortedIntMap {
    return new Map(this.aimedBp.get(this.key(filename)) ?? []);
  }

  bpContinuousLines(): number[] {
    const res: number[] = [];
    for (const [file, lines] of this.activeBp) {
      for (const line of sortedKeys(lines)) res.push(...this.continuousLine(file, line));
    }
    return res;
  }
}
