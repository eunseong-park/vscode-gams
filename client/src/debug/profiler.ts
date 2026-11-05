// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Port of GAMS Studio src/gamscom/profiler.h/.cpp (gamscom::Profiler, ProfileData) and the
 * time/memory formatting of src/editors/editorhelper.cpp (EditorHelper::formatTime/formatMemory).
 * GPL-3.0-or-later. Pure module: no vscode imports.
 */
import type { ContinuousLineData } from './continuousLineData';
import type { IncludeLine } from './protocol';

/** profiler.h ProfileData */
export class ProfileData {
  timeInSec: number;
  timeInSecMin: number;
  timeInSecMax: number;
  memoryMin: number;
  memoryMax: number;
  lastMemoryDelta: number;
  rowsMin: number;
  rowsMax: number;
  steps = 1;

  constructor(readonly statement: string, time: number, mem: number, rows: number) {
    this.timeInSec = this.timeInSecMin = this.timeInSecMax = time;
    this.memoryMin = this.memoryMax = this.lastMemoryDelta = mem;
    this.rowsMin = this.rowsMax = rows;
  }

  add(time: number, mem: number, rows: number): void {
    if (this.timeInSecMin > time) this.timeInSecMin = time;
    if (this.timeInSecMax < time) this.timeInSecMax = time;
    this.timeInSec += time;
    if (this.memoryMin > mem) this.memoryMin = mem;
    if (this.memoryMax < mem) {
      this.lastMemoryDelta = mem - this.memoryMax;
      this.memoryMax = mem;
    }
    if (this.rowsMin > rows) this.rowsMin = rows;
    if (this.rowsMax < rows) this.rowsMax = rows;
    ++this.steps;
  }

  clone(): ProfileData {
    return Object.assign(Object.create(ProfileData.prototype) as ProfileData, this);
  }
}

export const C_TIME_UNITS = ['sec', 'mm:ss', 'hh:mm', 'day'];
export const C_MEMORY_UNITS = ['byte', 'KB', 'MB', 'GB', 'TB'];
/** Profiler::CAggStatements: compound statements whose time already contains their bodies */
export const C_AGG_STATEMENTS = ['for', 'loop', 'repeat', 'until', 'while'];
const C_MAX_ENTRIES = 10;

export interface LineProfile {
  timeSec: number;
  memory: number;
  rows: number;
  steps: number;
}

/** One row of Profiler::getProfileText (statement, "File SUM" or the "SUM" line). */
export interface ProfileTextRow {
  label: string;
  time: string;
  timePct: string;
  memory: string;
  rows: string;
  steps: number;
  stepsPct: string;
}

export class Profiler {
  private contLines?: ContinuousLineData;
  /** contLine -> statement -> data; "" is the line sum, "File SUM" the include sum */
  private profileData = new Map<number, Map<string, ProfileData>>();
  /** filename -> localLine -> [contLine, contLineEnd] (include statements) */
  private fileLine2Cln = new Map<string, Map<number, [number, number][]>>();
  private maxSingleTime: [number, ProfileData][] = [];
  private maxSingleSteps: [number, ProfileData][] = [];
  private mainFile = '';
  private maxCompoundTime = 0;
  private maxMemory = 0;
  private maxRows = 0;
  private maxSteps = 0;
  private sumTimeInSec = 0;
  private sumRows = 0;
  private sumSteps = 0;

  constructor(private readonly key: (file: string) => string = (f) => f) {}

  setMainFile(f: string): void {
    this.mainFile = this.key(f);
  }

  setContinuousLineData(c: ContinuousLineData): void {
    this.contLines = c;
  }

  clear(): void {
    this.mainFile = '';
    this.profileData.clear();
    this.fileLine2Cln.clear();
    this.maxSingleTime = [];
    this.maxSingleSteps = [];
    this.maxCompoundTime = 0;
    this.maxMemory = 0;
    this.maxRows = 0;
    this.maxSteps = 0;
    this.sumTimeInSec = 0;
    this.sumRows = 0;
    this.sumSteps = 0;
  }

  isEmpty(): boolean {
    return this.profileData.size === 0;
  }

  contLinesWithData(): number[] {
    return [...this.profileData.keys()].sort((a, b) => a - b);
  }

  add(contLine: number, statement: string, timeSec: number, memory: number, rows: number): void {
    let map = this.profileData.get(contLine);
    if (!map) {
      map = new Map();
      this.profileData.set(contLine, map);
    }
    const st = map.get(statement);
    if (!st) map.set(statement, new ProfileData(statement, timeSec, memory, rows));
    else st.add(timeSec, memory, rows);
    const lastMemDelta = map.get(statement)!.lastMemoryDelta;
    const sum = map.get('');
    if (!sum) map.set('', new ProfileData('', timeSec, memory, rows));
    else sum.add(timeSec, lastMemDelta, rows);

    // update max values
    if (!C_AGG_STATEMENTS.includes(statement.trim().toLowerCase())) {
      this.sumTimeInSec += timeSec;
      this.sumRows += rows;
      ++this.sumSteps;
      const cur = map.get('')!;
      this.maxSingleTime = this.maxSingleTime.filter(([c]) => c !== contLine);
      // Studio removes from mMaxSingleSteps without "i--" (skips the next entry); a contLine occurs at most once, so equivalent
      this.maxSingleSteps = this.maxSingleSteps.filter(([c]) => c !== contLine);
      let iTime = C_MAX_ENTRIES;
      let iSteps = C_MAX_ENTRIES;
      for (let i = 0; i < C_MAX_ENTRIES; ++i) {
        if (i >= this.maxSingleTime.length) {
          if (iTime === C_MAX_ENTRIES) iTime = i;
        } else if (iTime === C_MAX_ENTRIES && this.maxSingleTime[i][1].timeInSec < cur.timeInSec) iTime = i;
        if (i >= this.maxSingleSteps.length) {
          if (iSteps === C_MAX_ENTRIES) iSteps = i;
        } else if (iSteps === C_MAX_ENTRIES && this.maxSingleSteps[i][1].steps < cur.steps) iSteps = i;
      }
      if (iTime < C_MAX_ENTRIES) {
        this.maxSingleTime.splice(iTime, 0, [contLine, cur.clone()]);
        if (this.maxSingleTime.length > C_MAX_ENTRIES) this.maxSingleTime.pop();
      }
      if (iSteps < C_MAX_ENTRIES) {
        this.maxSingleSteps.splice(iSteps, 0, [contLine, cur.clone()]);
        if (this.maxSingleSteps.length > C_MAX_ENTRIES) this.maxSingleSteps.pop();
      }
      if (cur.timeInSecMax > this.maxCompoundTime) this.maxCompoundTime = cur.timeInSecMax;
      if (cur.steps > this.maxSteps) this.maxSteps = cur.steps;
    }
    if (timeSec > this.maxCompoundTime) this.maxCompoundTime = timeSec;
    if (memory > this.maxMemory) this.maxMemory = memory;
    if (rows > this.maxRows) this.maxRows = rows;

    // update include lines ("File SUM" at the include statement)
    for (const lines of this.fileLine2Cln.values()) {
      for (const pairs of lines.values()) {
        for (const [first, second] of pairs) {
          if (contLine > first && contLine <= second) {
            let m = this.profileData.get(first);
            if (!m) {
              m = new Map();
              this.profileData.set(first, m);
            }
            const fs = m.get('File SUM');
            if (!fs) m.set('File SUM', new ProfileData('', timeSec, memory, rows));
            else fs.add(timeSec, memory, rows);
            const s = m.get('');
            if (!s) m.set('', new ProfileData('', timeSec, memory, rows));
            else s.add(timeSec, memory, rows);
            const pd = m.get('')!;
            if (pd.timeInSecMax > this.maxCompoundTime) this.maxCompoundTime = pd.timeInSecMax;
            if (pd.memoryMax > this.maxMemory) this.maxMemory = pd.memoryMax;
            if (pd.rowsMax > this.maxRows) this.maxRows = pd.rowsMax;
            if (pd.steps > this.maxSteps) this.maxSteps = pd.steps;
          }
        }
      }
    }
  }

  getSums(): { timeSec: number; rows: number; steps: number } {
    return { timeSec: this.sumTimeInSec, rows: this.sumRows, steps: this.sumSteps };
  }

  /** Profiler::continuousLine: contLNs of a file line, falling back to include statements */
  continuousLine(filename: string, localLine: number): number[] {
    let res = this.contLines ? this.contLines.continuousLine(filename, localLine) : [];
    if (res.length === 0) res = (this.fileLine2Cln.get(this.key(filename))?.get(localLine) ?? []).map(([a]) => a);
    if (res.length === 0 && localLine === 1 && this.key(filename) === this.mainFile) res = [1];
    return res;
  }

  addIncludes(lines: readonly IncludeLine[]): void {
    for (const l of lines) {
      const f = this.key(l.parentFile);
      let m = this.fileLine2Cln.get(f);
      if (!m) {
        m = new Map();
        this.fileLine2Cln.set(f, m);
      }
      const arr = m.get(l.line) ?? [];
      arr.unshift([l.contLine, l.outerContLine]); // QMultiMap::insert: newest first
      m.set(l.line, arr);
    }
  }

  /** files that have include statements (keys used by addIncludes) */
  includeParents(): string[] {
    return [...this.fileLine2Cln.keys()];
  }

  /** include statement lines of a file */
  includeLines(filename: string): number[] {
    return [...(this.fileLine2Cln.get(this.key(filename))?.keys() ?? [])];
  }

  /** Profiler::getProfile (accumulating) */
  getProfile(contLine: number, acc: LineProfile): void {
    const prf = this.profileData.get(contLine)?.get('');
    if (!prf) return;
    acc.timeSec += prf.timeInSec;
    acc.memory += prf.memoryMax;
    acc.rows += prf.rowsMax;
    acc.steps += prf.steps;
  }

  /** FileMeta getProfileShort: the per-line values Studio paints in the profiler column */
  lineProfile(filename: string, line: number): LineProfile {
    const acc: LineProfile = { timeSec: 0, memory: 0, rows: 0, steps: 0 };
    let cls = this.contLines ? this.contLines.continuousLine(filename, line) : [];
    if (cls.length === 0) cls = this.continuousLine(filename, line);
    for (const c of cls) this.getProfile(c, acc);
    return acc;
  }

  /** Profiler::getProfileText as data rows (Studio renders them as an HTML tooltip table) */
  getProfileText(contLines: readonly number[]): ProfileTextRow[] {
    const out: ProfileTextRow[] = [];
    const pct = (v: number, of: number): string => (of > 0 ? ((v * 100) / of).toFixed(1) : '0.0');
    for (const cl of contLines) {
      const m = this.profileData.get(cl);
      if (!m) continue;
      let rows = 0;
      let sum: ProfileTextRow | undefined;
      for (const k of [...m.keys()].sort()) {
        const v = m.get(k)!;
        if (k === '' || k === 'File SUM') {
          const row: ProfileTextRow = {
            label: k === '' ? 'SUM' : 'File SUM',
            time: formatTime(v.timeInSec),
            timePct: pct(v.timeInSec, this.sumTimeInSec),
            memory: formatMemory(v.memoryMax).trim(),
            rows: '',
            steps: v.steps,
            stepsPct: pct(v.steps, this.sumSteps),
          };
          if (k === '') sum = row;
          else out.push(row);
        } else {
          const sTime = v.timeInSecMin === v.timeInSecMax ? formatTime(v.timeInSecMin)
            : `${formatTime(v.timeInSecMin)} - ${formatTime(v.timeInSecMax)}`;
          const sMem = v.memoryMin === v.memoryMax ? formatMemory(v.memoryMin).trim()
            : `${formatMemory(v.memoryMin).trim()} - ${formatMemory(v.memoryMax).trim()}`;
          const sRows = v.rowsMax > 0 ? '[' + (v.rowsMin === v.rowsMax ? `${v.rowsMin}` : `${v.rowsMin} - ${v.rowsMax}`) + ']' : '';
          out.push({ label: k, time: sTime, timePct: pct(v.timeInSec, this.sumTimeInSec), memory: sMem, rows: sRows, steps: v.steps, stepsPct: pct(v.steps, this.sumSteps) });
          ++rows;
        }
      }
      if (rows > 1 && sum) out.push(sum);
    }
    return out;
  }

  getMaxCompoundValues(): LineProfile {
    return { timeSec: this.maxCompoundTime, memory: this.maxMemory, rows: this.maxRows, steps: this.maxSteps };
  }

  /** top 10 contLines by time (Profiler::maxTime) */
  maxTime(): [number, number][] {
    return this.maxSingleTime.map(([c, d]) => [c, d.timeInSec]);
  }

  maxStepsList(): [number, number][] {
    return this.maxSingleSteps.map(([c, d]) => [c, d.steps]);
  }
}

/** EditorHelper::formatTime */
export function formatTime(timeSec: number, compact = false): string {
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  if (compact || timeSec < 10) {
    const roundSec = Math.round(timeSec);
    const roundMin = Math.round(timeSec / 60) % 60;
    return timeSec < 10 ? `${timeSec.toFixed(3)} s`
      : timeSec < 60 ? `${timeSec.toFixed(2)} s`
        : timeSec < 3600 ? `${Math.trunc(timeSec / 60)}:${pad2(roundSec % 60)} m`
          : timeSec < 86400 ? `${Math.trunc(timeSec / 3600)}:${pad2(roundMin)} h`
            : `${Math.trunc(timeSec / 3600)} h`;
  }
  const msec = Math.round(timeSec * 1000 - Math.trunc(timeSec) * 1000);
  return timeSec < 60 ? `${timeSec.toFixed(3)} s`
    : timeSec < 3600 ? `${Math.trunc(timeSec / 60)}:${pad2(Math.trunc(timeSec) % 60)}.${msec} m`
      : `${Math.trunc(timeSec / 3600)}:${pad2(Math.trunc(timeSec / 60) % 60)}:${pad2(Math.trunc(timeSec) % 60)}.${msec} h`;
}

/** EditorHelper::formatMemory */
export function formatMemory(bytes: number, compact = false): string {
  const r = bytes;
  if (compact || bytes < 1000) {
    const s = bytes < 1000 ? `${r} B `
      : bytes < 1e5 ? `${(r * 0.001).toFixed(2)} KB`
        : bytes < 1e6 ? `${(r * 0.001).toFixed(1)} KB`
          : bytes < 1e8 ? `${(r * 0.000001).toFixed(2)} MB`
            : bytes < 1e9 ? `${(r * 0.000001).toFixed(1)} MB`
              : bytes < 1e11 ? `${(r * 1e-9).toFixed(2)} GB`
                : bytes < 1e12 ? `${(r * 1e-9).toFixed(1)} GB`
                  : bytes < 1e14 ? `${(r * 1e-12).toFixed(2)} TB`
                    : `${(r * 1e-12).toFixed(1)} TB`;
    return s.padStart(8, ' ');
  }
  const s = bytes < 1e6 ? `${(r * 0.001).toFixed(3)} KB`
    : bytes < 1e9 ? `${(r * 0.000001).toFixed(3)} MB`
      : bytes < 1e12 ? `${(r * 1e-9).toFixed(3)} GB`
        : `${(r * 1e-12).toFixed(3)} TB`;
  return s.padStart(10, ' ');
}
