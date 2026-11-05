// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * GAMScom protocol between the IDE and a GAMS process started with DebugPort=/ComPort=.
 * Port of GAMS Studio src/gamscom/server.h / server.cpp (the parsing half of gamscom::Server):
 * calls (IDE -> GAMS) are encoded by `encodeCall` (Server::callProcedure), replies
 * (GAMS -> IDE) are decoded by `GamsComParser` (Server::newConnection readyRead lambda,
 * Server::handleReply, parseLinesMap, getPair, addInclude*, parseProfileData).
 * GPL-3.0-or-later. Pure module: no vscode imports.
 */

/** server.h ComFeature */
export const enum ComFeature {
  NoCom = 0,
  RunDebug = 1,
  StepDebug = 2 + 1,
  Profiler = 4,
}

/** server.h DebugState */
export type DebugState = 'None' | 'Prepare' | 'Running' | 'Paused' | 'Finished';

/** server.h CallReply: calls sent to GAMS */
export type CallKeyword = 'invalidReply' | 'addBP' | 'delBP' | 'run' | 'stepLine' | 'pause' | 'writeGDX';
/** server.h CallReply: replies received from GAMS */
export type ReplyKeyword = 'invalidCall' | 'features' | 'linesMap' | 'linesMapDone' | 'paused' | 'gdxReady' | 'profileData';

const REPLIES: ReadonlySet<string> = new Set<ReplyKeyword>([
  'invalidCall', 'features', 'linesMap', 'linesMapDone', 'paused', 'gdxReady', 'profileData',
]);

/** server.cpp CFirstDebugPort / CLastDebugPort */
export const FIRST_DEBUG_PORT = 3563;
export const LAST_DEBUG_PORT = 4563;

/**
 * Server::callProcedure: keyword, then one argument per line; a single packet must stay
 * below 255 characters, longer argument lists are split into several packets that repeat
 * the keyword. Each packet is terminated by a TAB. Returns the packets (with the TAB).
 * Arguments that can never fit are dropped (Studio logs "Call line too long").
 */
export function encodeCall(keyword: CallKeyword, args: readonly string[] = [], log?: (m: string) => void): string[] {
  const res: string[] = [];
  const remain = [...args];
  let ready: string = keyword;
  let progress = true;
  while (remain.length > 0 || progress) {
    if (remain.length > 0 && ready.length + 2 + remain[0].length < 255) {
      ready += '\n' + remain.shift();
      progress = true;
    }
    if (!progress) {
      log?.(`GAMScom-Server: Call line too long. Can't send more than 255 characters at once '${keyword}:${remain[0]}'`);
      break;
    }
    if (remain.length === 0 || ready.length + 2 + remain[0].length >= 255) {
      // deviation: Studio would also send a bare keyword here when the first argument is too long
      // (for delBP/addBP that means "all"); skip such a packet
      if (ready !== keyword || args.length === 0) res.push(ready + '\t');
      ready = keyword;
      progress = false;
    }
  }
  return res;
}

/** Server::toBpString: contLNs joined by '|'. */
export function toBpString(lines: readonly number[]): string {
  return lines.join('|');
}

/** Max length of one '|'-joined addBP argument: with the keyword and separators it stays below the 255 character packet limit. */
export const MAX_BP_ARG = 240;

/**
 * Like toBpString, but split into several '|'-joined arguments of at most `max` characters each.
 * encodeCall packs the arguments into packets (a single joined argument of >= ~245 characters would not fit
 * into any packet and be dropped).
 */
export function splitBpArgs(lines: readonly number[], max = MAX_BP_ARG): string[] {
  const res: string[] = [];
  let cur = '';
  for (const l of lines) {
    const s = String(l);
    if (cur && cur.length + 1 + s.length > max) {
      res.push(cur);
      cur = s;
    } else cur = cur ? cur + '|' + s : s;
  }
  if (cur) res.push(cur);
  return res;
}

/** profiler.h IncludeLine */
export interface IncludeLine {
  parentFile: string;
  /** line of the include statement in parentFile */
  line: number;
  /** continuous line of the include statement */
  contLine: number;
  /** continuous line of the last included line (int max until the '?' marker arrives) */
  outerContLine: number;
  childFile: string;
}

export const INT_MAX = 2147483647;

export function includeLine(parentFile: string, line?: number, contLine?: number): IncludeLine {
  // IncludeLine(file) is the main-file pseudo include: line 1, contLine 1, outerContLine 1
  if (line === undefined || contLine === undefined) return { parentFile, line: 1, contLine: 1, outerContLine: 1, childFile: '' };
  return { parentFile, line, contLine, outerContLine: INT_MAX, childFile: '' };
}

export interface ProfileEntry {
  contLine: number;
  statement: string;
  timeSec: number;
  /** bytes (Studio: qRound64(MB / .000001)) */
  memory: number;
  rows: number;
}

export interface GamsComEvents {
  /** "features" reply: flags (+1 debug, +2 profiler) */
  features?(flags: number): void;
  /** Server::signalLinesMap */
  linesMap?(file: string, fileLines: number[], contLines: number[]): void;
  /** linesMapDone; includes are the collected IncludeLine list (Studio passes them to the profiler in profiler mode) */
  linesMapDone?(includes: IncludeLine[]): void;
  paused?(contLine: number): void;
  gdxReady?(file: string): void;
  profileData?(e: ProfileEntry): void;
  /** Server::logMessage */
  log?(message: string): void;
  /** the parser asks to send a call back to GAMS (invalidReply) */
  reply?(packets: string[]): void;
}

type ParseResult = 'ok' | 'incomplete' | 'error';

function toInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) return undefined;
  return parseInt(t, 10);
}

function toDouble(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t === '' || isNaN(Number(t))) return undefined;
  return Number(t);
}

const fromNativeSeparators = (p: string): string => p.replace(/\\/g, '/');

/** Decoder for the GAMS -> IDE stream of one socket connection. */
export class GamsComParser {
  private incompletePacket = '';
  private remainData = '';
  private lastReply: ReplyKeyword | undefined;
  private breakLinesFile = '';
  readonly includes: IncludeLine[] = [];

  constructor(
    private readonly ev: GamsComEvents,
    /** ComFeatures the server was started with (Profiler adds the include bookkeeping on linesMapDone) */
    private readonly comFeatures: number = ComFeature.NoCom,
    /** gdxReady: Studio checks QFile::exists; injectable for tests */
    private readonly fileExists: (p: string) => boolean = () => true,
  ) {}

  /** Server::newConnection readyRead: packets are separated by NUL; a packet is complete when it ends with '\n'. */
  push(data: string): void {
    const packets = data.split('\0');
    for (const packet of packets) {
      if (packet.length === 0) continue;
      this.incompletePacket += packet;
      if (this.incompletePacket[this.incompletePacket.length - 1] !== '\n') return;
      const ret = this.handleReply(this.incompletePacket);
      if (ret !== 'ok' && !this.incompletePacket.includes('invalidCall')) {
        this.ev.reply?.(encodeCall('invalidReply', [this.incompletePacket]));
      }
      if (ret !== 'incomplete') this.incompletePacket = '';
    }
  }

  private log(m: string): void {
    this.ev.log?.(m);
  }

  /** Server::handleReply */
  handleReply(replyData: string): ParseResult {
    const reList = replyData.split('\n').filter((s) => s.length > 0);
    let reply: ReplyKeyword | undefined;
    if (reList.length > 0) {
      reply = REPLIES.has(reList[0]) ? (reList[0] as ReplyKeyword) : undefined;
      if (reply === undefined && this.lastReply === 'linesMap') {
        reply = this.lastReply; // continuation packet of a linesMap
      } else if (reply !== undefined) {
        reList.shift();
        this.lastReply = reply;
      }
    }
    const data = reList.length > 0 ? reList[0].split('|') : [];

    switch (reply) {
      case 'invalidCall':
        this.log('GAMScom-Server: GAMS refused to process this request: ' + reList.join(', '));
        break;
      case 'features': {
        if (reList.length < 1) return 'incomplete';
        if (reList.length > 1) this.log('GAMScom-Server: [features] Only one entry expected. Additional data ignored.');
        const flags = toInt(data[0]);
        if (flags === undefined) {
          this.log("GAMScom-Server: [features] Can't parse continuous line number: " + data[0]);
          return 'error';
        }
        this.ev.features?.(flags);
        break;
      }
      case 'linesMap':
        if (reList.length < 1) return 'incomplete';
        for (const line of reList) this.parseLinesMap(line);
        break;
      case 'linesMapDone': {
        if (this.remainData.length > 0) this.parseLinesMap(' ');
        if (this.comFeatures & ComFeature.Profiler) {
          if (this.includes.length === 0) {
            if (this.breakLinesFile) this.includes.push(includeLine(this.breakLinesFile));
          } else if (this.includes[0].contLine === 1 && this.includes[0].outerContLine === INT_MAX) {
            this.includes[0].outerContLine = 1;
          } else {
            this.includes.unshift(includeLine(this.includes[0].parentFile));
          }
        }
        this.ev.linesMapDone?.(this.includes);
        break;
      }
      case 'paused': {
        if (reList.length < 1) return 'incomplete';
        if (reList.length > 1) this.log('GAMScom-Server: [paused] Only one entry expected. Additional data ignored.');
        const line = toInt(data[0]);
        if (line === undefined) {
          this.log("GAMScom-Server: [paused] Can't parse continuous line number: " + data[0]);
          return 'error';
        }
        this.ev.paused?.(line);
        break;
      }
      case 'gdxReady': {
        const file = reList.length > 0 ? fromNativeSeparators(data[0]) : '';
        if (!file) {
          this.log('GAMScom-Server: [gdxReady] Missing name for GDX file.');
          return 'incomplete';
        }
        if (!this.fileExists(file)) {
          this.log('GAMScom-Server: [gdxReady] File not found: ' + file);
          return 'error';
        }
        this.ev.gdxReady?.(file);
        break;
      }
      case 'profileData':
        if (reList.length < 1) return 'incomplete';
        if (reList.length > 1) this.log('GAMScom-Server: [profileData] Only one entry expected. Additional data ignored.');
        return this.parseProfileData(reList[0]);
      default:
        this.log('GAMScom-Server: Unknown GAMS request: ' + reList.join(', '));
        return 'error';
    }
    return 'ok';
  }

  /** Server::parseProfileData: contLN|statement|execTime|memory(MB)[|rows] */
  private parseProfileData(raw: string): ParseResult {
    const d = raw.split('|');
    if (d.length < 4) return 'incomplete';
    const contLine = toInt(d[0]);
    const sec = toDouble(d[2]);
    const mb = toDouble(d[3]);
    if (contLine === undefined || sec === undefined || mb === undefined) return 'error';
    let rows = 0;
    if (d.length > 4) rows = toInt(d[4]) ?? 0;
    this.ev.profileData?.({ contLine, statement: d[1], timeSec: sec, memory: Math.round(mb / 0.000001), rows });
    return 'ok';
  }

  /** Server::parseLinesMap: one line of a linesMap reply ("file|line=contLN|..."), possibly split across packets. */
  private parseLinesMap(breakData: string): void {
    if (breakData.length === 0) return;
    let data: string[] = [];
    const c = breakData[0];
    if (this.remainData.length === 0) {
      data = breakData.split('|');
    } else if ((c < '0' || c > '9') && c !== '=' && c !== '|') {
      // probably a filename: the remaining data is complete
      const acc = this.newAcc();
      if (this.getPair(this.remainData, acc)) {
        this.applyIncludes(acc);
        if (acc.lines.length > 0) this.ev.linesMap?.(this.breakLinesFile, acc.lines, acc.coLNs);
      } else {
        this.log('GAMScom-Server: breakLines parse error: ' + this.remainData);
      }
      this.remainData = '';
      if (breakData !== ' ') data = breakData.split('|');
    } else {
      data = ('|' + this.remainData + breakData).split('|');
    }
    this.remainData = data.length > 0 ? data.pop()! : '';
    if (data.length === 0) return;

    if (data[0].length > 0) this.breakLinesFile = fromNativeSeparators(data[0]);
    const lines: number[] = [];
    const coLNs: number[] = [];
    for (let i = 1; i < data.length; ++i) {
      const acc = { lines, coLNs, incLines: [] as number[], firstLines: [] as number[], retLines: [] as number[] };
      const ok = this.getPair(data[i], acc);
      this.applyIncludes(acc);
      if (!ok) this.log('GAMScom-Server: breakLines parse error: ' + data[i]);
    }
    if (lines.length > 0) this.ev.linesMap?.(this.breakLinesFile, lines, coLNs);
  }

  private newAcc(): PairAcc {
    return { lines: [], coLNs: [], incLines: [], firstLines: [], retLines: [] };
  }

  private applyIncludes(acc: PairAcc): void {
    if (!this.breakLinesFile) return;
    if (acc.incLines.length > 0) this.addInclude(this.breakLinesFile, acc.incLines);
    else if (acc.firstLines.length > 0) this.addIncludeFrom(this.breakLinesFile, acc.firstLines[acc.firstLines.length - 1]);
    else if (acc.retLines.length > 0) this.addIncludeEnd(this.breakLinesFile, acc.retLines);
  }

  /** Server::getPair: "[!|?]line=contLN" */
  private getPair(assignment: string, acc: PairAcc): boolean {
    const isInc = assignment.startsWith('!');
    const isRet = assignment.startsWith('?');
    const pair = (isInc || isRet ? assignment.substring(1) : assignment).split('=');
    if (pair.length !== 2 || pair[1].length === 0) return false;
    const line = toInt(pair[0]);
    const coLN = toInt(pair[1]);
    if (line === undefined || coLN === undefined) return false;
    if (isInc) acc.incLines.push(line, coLN);
    else if (isRet) acc.retLines.push(line, coLN);
    else if (!line) acc.firstLines.push(line, coLN);
    else {
      acc.lines.push(line);
      acc.coLNs.push(coLN);
    }
    return true;
  }

  private addInclude(filename: string, incLine: number[]): void {
    this.includes.push(includeLine(filename, incLine[0], incLine[1]));
  }

  private addIncludeFrom(filename: string, contLine: number): void {
    const last = this.includes[this.includes.length - 1];
    if (!last || last.childFile) {
      this.log(`GamsCom warning: Unexpected include start for ${filename}:0 [${contLine}]. Data ignored.`);
      return;
    }
    if (last.contLine !== contLine) {
      this.log(`GamsCom warning: Include start at ${contLine} doesn't match expected ${last.contLine}. Data ignored.`);
      return;
    }
    last.childFile = filename;
  }

  private addIncludeEnd(filename: string, incLine: number[]): void {
    for (let i = this.includes.length - 1; i >= 0; --i) {
      const inc = this.includes[i];
      if (inc.line === incLine[0] && inc.parentFile === filename) {
        inc.outerContLine = incLine[incLine.length - 1];
        break;
      }
      if (inc.line < incLine[0] && inc.parentFile === filename) {
        this.log(`GamsCom warning: Missing Include for ${inc.parentFile}:${inc.line}`);
        break;
      }
    }
  }
}

interface PairAcc {
  lines: number[];
  coLNs: number[];
  incLines: number[];
  firstLines: number[];
  retLines: number[];
}
