// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * GAMS debug adapter (DAP server side), modelled on GAMS Studio's debugger flow:
 *  - PExProjectNode::startComServer / analyzeParameters (src/file/pexgroupnode.cpp): start the
 *    gamscom::Server, pass DebugPort=<port> after the Studio default parameters;
 *  - signalMapDone handler: adjustBreakpoints, addBreakpoints(bpContinuousLines), then
 *    sendStepLine (cfStepDebug) or sendRun;
 *  - gotoPaused: map contLN -> file/line, request writeGDX to <workdir>/temp<port>.gdx;
 *  - DebugWidget (src/gamscom/debugwidget.cpp): run / stepLine / pause / stop, "LST line" label;
 *  - PExProjectNode::terminate: kill the process; MainWindow::stopDebugServer removes the temp GDX.
 * GPL-3.0-or-later. Pure node module: no vscode imports (testable without VS Code).
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildGamsArgs, GamsProcess, paramValue, withReference } from '../run/gamsProcess';
import { ErrorEntry, LogSession } from '../run/logSession';
import { attachRun } from '../run/runLifecycle';
import type { HRefContext } from '../run/logParser';
import type { GdxRecord, GdxSymbolInfo } from '../views/gdx/model';
import { normalizeValue, typeAsString, VALUE_COLUMNS } from '../views/gdx/model';
import { formatValue } from '../views/gdx/format';
import { ComServer } from './comServer';
import { ContinuousLineData } from './continuousLineData';
import { ComFeature } from './protocol';
import type { Breakpoint, Event, Request, Response, Scope, StackFrame, Variable } from './dap';

export interface GamsLaunchArguments {
  program: string;
  /** extra GAMS parameters (array of key=value or one command-line string) */
  parameters?: string[] | string;
  cwd?: string;
  /** stop at the first executable line (Studio: "Step Debugger" = cfStepDebug) */
  stopOnEntry?: boolean;
  /** records shown per symbol in the Variables view (default 100) */
  maxRecords?: number;
  noDebug?: boolean;
  /** resolved by the configuration provider */
  sysdir?: string;
  defaultParameters?: string[];
}

export interface GdxAccess {
  symbols(gdx: string): Promise<GdxSymbolInfo[]>;
  records(gdx: string, symbolIndex: number, offset: number, limit: number): Promise<{ total: number; records: GdxRecord[] }>;
  /** close cached handles so GAMS can rewrite the file / fresh data is read */
  release?(gdx: string): Promise<void>;
}

export interface SessionHooks {
  gdx?: GdxAccess;
  /** an error found in the log (Problems entry, same as a normal run) */
  onError?(e: ErrorEntry): void;
  /** GAMS wrote a reference file (same as a normal run) */
  refWritten?(gms: string, refPath: string, startedAt?: number): void;
  /** raw GAMScom traffic */
  traffic?(dir: 'in' | 'out', data: string): void;
  /** clock for timeouts (tests) */
  gdxTimeoutMs?: number;
}

const THREAD_ID = 1;
const FRAME_ID = 1;
const SCOPE_REF = 1;
const SYMBOL_REF_BASE = 1000;

/** split a command-line string into parameters, keeping quoted parts together */
export function splitParameters(s: string): string[] {
  const res: string[] = [];
  const re = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) res.push(m[0]);
  return res;
}

/** file key: absolute, forward slashes, real path, case folded where the file system usually is */
export function fileKey(p: string): string {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r);
  } catch {
    // keep resolved path
  }
  r = r.replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
}

interface BpEntry {
  id: number;
  requested: number;
  line: number;
  verified: boolean;
  /** set when the breakpoint could not be sent to GAMS */
  failure?: string;
}

export class GamsDebugSession {
  private seq = 1;
  private server?: ComServer;
  private proc?: GamsProcess;
  private readonly cld = new ContinuousLineData(fileKey);
  /** key -> original path as reported by GAMS / VS Code */
  private readonly displayPath = new Map<string, string>();
  /** requested breakpoints per file key */
  private readonly bps = new Map<string, BpEntry[]>();
  /** files GAMS reported as parent / child of an include statement (part of the run even without executable lines) */
  private readonly includedFiles = new Set<string>();
  private nextBpId = 1;
  private mapDone = false;
  private configured = false;
  private terminated = false;
  private stopOnEntry = false;
  private pauseRequested = false;
  private entryPending = false;
  private contLine = -1;
  private pauseGen = 0;
  private gdxFile?: string;
  private gdxPromise?: Promise<string | undefined>;
  /** the current pause's snapshot promise gave up (timeout) before gdxReady arrived */
  private gdxTimedOut = false;
  private supportsInvalidated = false;
  private gdxResolve?: (f: string | undefined) => void;
  private symbolsCache?: GdxSymbolInfo[];
  private maxRecords = 100;
  private workDir = '';
  private program = '';

  constructor(
    private readonly sendMessage: (m: Response | Event) => void,
    private readonly hooks: SessionHooks = {},
  ) {}

  // ---- DAP plumbing ----------------------------------------------------------------------

  private respond(req: Request, body?: unknown, error?: string): void {
    const r: Response = { seq: this.seq++, type: 'response', request_seq: req.seq, command: req.command, success: !error };
    if (error) r.message = error;
    if (body !== undefined) r.body = body;
    this.sendMessage(r);
  }

  private event(event: string, body?: unknown): void {
    const e: Event = { seq: this.seq++, type: 'event', event };
    if (body !== undefined) e.body = body;
    this.sendMessage(e);
  }

  private logBuf: string[] = [];
  private logTimer?: NodeJS.Timeout;

  /** Log lines go out in batches (one DAP output event per 100 ms, not one per line). */
  private logLine(text: string): void {
    this.logBuf.push(text);
    if (this.logBuf.length >= 2000) this.flushLog();
    else if (!this.logTimer) this.logTimer = setTimeout(() => this.flushLog(), 100);
  }

  private flushLog(): void {
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = undefined;
    if (!this.logBuf.length) return;
    const text = this.logBuf.join('\n') + '\n';
    this.logBuf = [];
    this.output(text);
  }

  private output(text: string, category: 'console' | 'stdout' | 'stderr' | 'important' = 'stdout'): void {
    this.event('output', { category, output: text });
  }

  handleMessage(msg: { type: string }): void {
    if (msg.type !== 'request') return;
    const req = msg as Request;
    void this.dispatch(req).catch((e: unknown) => this.respond(req, undefined, e instanceof Error ? e.message : String(e)));
  }

  private async dispatch(req: Request): Promise<void> {
    const a = req.arguments ?? {};
    switch (req.command) {
      case 'initialize':
        this.supportsInvalidated = !!a.supportsInvalidatedEvent;
        this.respond(req, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
          supportsBreakpointLocationsRequest: true,
          supportsEvaluateForHovers: true,
          supportsSteppingGranularity: false,
        });
        return;
      case 'launch':
        return this.launch(req, a as GamsLaunchArguments);
      case 'setBreakpoints':
        this.respond(req, { breakpoints: this.setBreakpoints(a.source?.path, (a.breakpoints ?? []).map((b: { line: number }) => b.line)) });
        return;
      case 'breakpointLocations': {
        const p: string | undefined = a.source?.path;
        const end: number = a.endLine ?? a.line;
        const lines = p ? this.cld.validLines(p).filter((l) => l >= a.line && l <= end) : [];
        this.respond(req, { breakpoints: lines.map((line) => ({ line })) });
        return;
      }
      case 'configurationDone':
        this.respond(req);
        this.configurationDone();
        return;
      case 'threads':
        this.respond(req, { threads: [{ id: THREAD_ID, name: `GAMS ${path.basename(this.program)}` }] });
        return;
      case 'stackTrace':
        this.respond(req, this.stackTrace());
        return;
      case 'scopes':
        this.respond(req, { scopes: this.scopes() });
        return;
      case 'variables':
        this.respond(req, { variables: await this.variables(a.variablesReference as number) });
        return;
      case 'evaluate':
        this.respond(req, await this.evaluate(String(a.expression ?? '')));
        return;
      case 'continue':
        this.resume(() => this.server?.sendRun());
        this.respond(req, { allThreadsContinued: true });
        return;
      case 'next':
      case 'stepIn':
      case 'stepOut':
        // Studio has a single "step to the next possible line" (stepLine)
        this.resume(() => this.server?.sendStepLine());
        this.respond(req);
        return;
      case 'pause':
        this.pauseRequested = true;
        this.server?.sendPause();
        this.respond(req);
        return;
      case 'terminate':
      case 'disconnect':
        this.terminate();
        this.respond(req);
        return;
      case 'gamsSnapshot':
        // custom request used by the "Open snapshot in GDX viewer" command
        this.respond(req, { gdx: this.gdxFile && fs.existsSync(this.gdxFile) ? this.gdxFile : undefined, contLine: this.contLine });
        return;
      default:
        this.respond(req, undefined, `Unsupported request '${req.command}'`);
    }
  }

  // ---- launch ------------------------------------------------------------------------------

  private async launch(req: Request, a: GamsLaunchArguments): Promise<void> {
    if (!a.program) return this.respond(req, undefined, 'No GAMS program given ("program").');
    const program = path.resolve(a.cwd ?? process.cwd(), a.program);
    if (!fs.existsSync(program)) return this.respond(req, undefined, `GAMS program not found: ${program}`);
    if (!a.sysdir) return this.respond(req, undefined, 'GAMS system directory not found. Set "gams.sysdir".');
    this.program = program;
    this.workDir = a.cwd ? path.resolve(a.cwd) : path.dirname(program);
    this.stopOnEntry = !!a.stopOnEntry;
    this.maxRecords = Math.max(1, a.maxRecords ?? 100);
    const user = [
      ...(a.defaultParameters ?? []),
      ...(typeof a.parameters === 'string' ? splitParameters(a.parameters) : a.parameters ?? []),
    ];

    const extra: string[] = [];
    if (!a.noDebug) {
      this.server = new ComServer(this.workDir, this.stopOnEntry ? ComFeature.StepDebug : ComFeature.RunDebug, {
        log: (m) => this.output(m + '\n', 'console'),
        traffic: this.hooks.traffic,
        linesMap: (f, l, c) => {
          const k = fileKey(f);
          if (!this.displayPath.has(k)) this.displayPath.set(k, f);
          this.cld.addLinesMap(f, l, c);
        },
        linesMapDone: (includes) => {
          for (const inc of includes) {
            for (const f of [inc.parentFile, inc.childFile]) if (f) this.includedFiles.add(fileKey(f));
          }
          this.onMapDone();
        },
        paused: (c) => this.onPaused(c),
        gdxReady: (f) => this.onGdxReady(f),
        disconnected: () => undefined,
      });
      const started = await this.server.start();
      if (this.terminated) {
        // disconnect arrived while the server was starting: never spawn GAMS
        this.server.stop();
        return this.respond(req, undefined, 'Debug session was terminated.');
      }
      if (!started) return this.respond(req, undefined, 'Could not start the GAMScom server (no free port in 3563..4563).');
      // pexgroupnode.cpp analyzeParameters: DebugPort is the last Studio default parameter
      extra.push(`DebugPort=${this.server.port}`);
    }
    const { args, refPath, paths } = withReference(buildGamsArgs(program, [...extra, ...user], false), program, this.workDir);
    this.startProcess(a.sysdir, args, refPath, paths.lst ?? '');
    this.respond(req);
    if (a.noDebug) {
      this.mapDone = true;
      this.event('initialized');
    }
  }

  private startProcess(sysdir: string, args: string[], refPath: string, lst: string): void {
    const ctx: HRefContext = {
      workDir: this.workDir,
      lst,
      sysDir: sysdir,
      inputDirs: (paramValue(args, 'inputdir', 'idir') ?? '').split(path.delimiter).filter(Boolean),
    };
    const log = new LogSession(ctx, (p) => fs.existsSync(p), { onLine: (l) => this.logLine(l.text), onError: (e) => this.hooks.onError?.(e) }, false);
    const proc = new GamsProcess(sysdir, args, this.workDir);
    this.proc = proc;
    const startedAt = Date.now();
    this.output(`Running: ${proc.commandLine}\n`, 'console');
    proc.on('stdout', (d) => log.push(d));
    proc.on('stderr', (d) => log.push(d));
    let exitCode: number | undefined;
    proc.on('exit', (code) => {
      exitCode = code ?? undefined;
    });
    attachRun(proc, log, {
      isCurrentRun: () => true,
      isCurrentProc: () => true,
      appendLine: (text) => {
        this.flushLog();
        this.output(text + '\n', 'console');
      },
      onProcFinished: () => undefined,
      onFinalized: () => {
        try {
          if (fs.statSync(refPath).mtimeMs >= startedAt - 1000) this.hooks.refWritten?.(this.program, refPath, startedAt);
        } catch {
          // no reference file
        }
        this.finish(exitCode);
      },
    });
    proc.start();
  }

  // ---- GAMScom events ---------------------------------------------------------------------

  private onMapDone(): void {
    if (this.mapDone) {
      // sub-run reconnect (Server::newConnection with mSubRuns): resend breakpoints and continue
      this.sendBreakpoints(this.cld.bpContinuousLines());
      this.server?.sendRun();
      return;
    }
    this.mapDone = true;
    for (const k of this.bps.keys()) this.refreshFile(k, true);
    // breakpoints arrive after "initialized"; GAMS waits for run/stepLine until configurationDone
    this.event('initialized');
  }

  private configurationDone(): void {
    this.configured = true;
    if (!this.server) return;
    this.sendBreakpoints(this.cld.bpContinuousLines());
    if (this.stopOnEntry) {
      this.entryPending = true;
      this.server.sendStepLine();
    } else {
      this.server.sendRun();
    }
  }

  private onPaused(contLine: number): void {
    this.contLine = contLine;
    this.symbolsCache = undefined;
    let reason = 'step';
    const hit: number[] = [];
    if (this.entryPending) reason = 'entry';
    else if (this.pauseRequested) reason = 'pause';
    else {
      const f = this.cld.filename(contLine);
      const line = this.cld.fileLine(contLine);
      for (const b of this.bps.get(fileKey(f || '.')) ?? []) {
        if (b.verified && b.line === line) hit.push(b.id);
      }
      if (hit.length) reason = 'breakpoint';
    }
    this.entryPending = false;
    this.pauseRequested = false;
    // PExProjectNode::gotoPaused: request a GDX snapshot of the current state
    if (contLine > 0 && this.server) {
      const gdx = this.server.gdxTempFile();
      this.gdxTimedOut = false;
      this.gdxPromise = new Promise<string | undefined>((resolve) => {
        this.gdxResolve = resolve;
        setTimeout(() => {
          if (this.gdxResolve === resolve) this.gdxTimedOut = true;
          resolve(undefined);
        }, this.hooks.gdxTimeoutMs ?? 10000).unref?.();
      });
      const gen = ++this.pauseGen;
      // skip the request when the user resumed meanwhile (GAMS is running again)
      void this.release(gdx).then(() => {
        if (gen === this.pauseGen && this.contLine === contLine) this.server?.sendWriteGdx(gdx);
        else this.gdxResolve?.(undefined);
      });
    } else {
      this.gdxPromise = Promise.resolve(undefined);
    }
    this.event('stopped', { reason, threadId: THREAD_ID, allThreadsStopped: true, ...(hit.length ? { hitBreakpointIds: hit } : {}) });
  }

  private onGdxReady(file: string): void {
    this.gdxFile = file;
    this.symbolsCache = undefined;
    const r = this.gdxResolve;
    this.gdxResolve = undefined;
    if (this.gdxTimedOut && !this.terminated && this.gdxPromise) {
      // late snapshot of the same pause: replace the (undefined) promise and let the client re-fetch variables
      this.gdxTimedOut = false;
      const pause = this.pauseGen;
      const p = this.release(file).then(() => file);
      this.gdxPromise = p;
      void p.then(() => {
        if (pause === this.pauseGen && this.contLine >= 0 && this.supportsInvalidated) this.event('invalidated', { areas: ['variables'], threadId: THREAD_ID });
      });
      return;
    }
    void this.release(file).then(() => r?.(file));
  }

  /** release cached GDX handles in the language server; never rejects, at most 1 s */
  private release(gdx: string): Promise<void> {
    const r = this.hooks.gdx?.release?.(gdx);
    if (!r) return Promise.resolve();
    return Promise.race([r.catch(() => undefined), new Promise<void>((res) => setTimeout(res, 1000))]);
  }

  private resume(send: () => void): void {
    ++this.pauseGen;
    this.contLine = -1;
    this.symbolsCache = undefined;
    this.gdxPromise = undefined;
    send();
  }

  // ---- breakpoints -------------------------------------------------------------------------

  private setBreakpoints(file: string | undefined, lines: number[]): Breakpoint[] {
    if (!file) return lines.map((line) => ({ verified: false, line, message: 'No source path' }));
    const k = fileKey(file);
    if (!this.displayPath.has(k)) this.displayPath.set(k, file);
    const before = new Set(this.cld.bpContinuousLines());
    for (const b of this.bps.get(k) ?? []) this.cld.delBreakpoint(file, b.line);
    const old = this.bps.get(k) ?? [];
    const entries: BpEntry[] = lines.map((line) => ({ id: old.find((o) => o.requested === line)?.id ?? this.nextBpId++, requested: line, line, verified: false }));
    this.bps.set(k, entries);
    this.refreshFile(k, false);
    if (this.configured && this.server) {
      const after = new Set(this.cld.bpContinuousLines());
      for (const c of before) if (!after.has(c)) this.server.delBreakpoint(c);
      const add = [...after].filter((c) => !before.has(c));
      if (add.length) this.sendBreakpoints(add);
    }
    return entries.map((e) => this.toDap(k, e));
  }

  /** Send addBP; when it cannot be sent the affected breakpoints are reported as unverified. */
  private sendBreakpoints(contLines: readonly number[]): void {
    if (!this.server || contLines.length === 0) return;
    if (this.server.addBreakpoints(contLines)) return;
    for (const [k, entries] of this.bps) {
      for (const e of entries) {
        if (!e.verified) continue;
        e.verified = false;
        e.failure = 'Could not send the breakpoint to GAMS (not connected or call line too long).';
        this.event('breakpoint', { reason: 'changed', breakpoint: this.toDap(k, e) });
      }
    }
  }

  /** (re)validate the breakpoints of one file against the lines map (ContinuousLineData::addBreakpoint, isRunning) */
  private refreshFile(k: string, sendEvents: boolean): void {
    const entries = this.bps.get(k) ?? [];
    for (const e of entries) {
      if (!this.mapDone) {
        e.verified = false;
        e.line = e.requested;
        continue;
      }
      if (this.cld.validLines(k).length === 0) {
        e.verified = false;
        e.line = e.requested;
      } else {
        e.line = this.cld.addBreakpoint(k, e.requested, true);
        e.verified = true;
        e.failure = undefined;
      }
      if (sendEvents) this.event('breakpoint', { reason: 'changed', breakpoint: this.toDap(k, e) });
    }
  }

  private toDap(k: string, e: BpEntry): Breakpoint {
    const bp: Breakpoint = { id: e.id, verified: e.verified, line: e.line, source: { path: this.displayPath.get(k) ?? k } };
    if (!e.verified && e.failure) {
      bp.reason = 'failed';
      bp.message = e.failure;
    } else if (!e.verified) {
      bp.reason = this.mapDone ? 'failed' : 'pending';
      bp.message = !this.mapDone
        ? 'Waiting for GAMS to send the lines map.'
        : this.includedFiles.has(k)
          ? 'This file is part of the run but has no executable statement (for example a data-only include): there is nothing to stop at.'
          : 'GAMS reported no executable statement for this file: it is not part of the run, or it is only included in a skipped part.';
    }
    return bp;
  }

  // ---- inspection --------------------------------------------------------------------------

  private stackTrace(): { stackFrames: StackFrame[]; totalFrames: number } {
    if (this.contLine < 0) return { stackFrames: [], totalFrames: 0 };
    const f = this.cld.filename(this.contLine);
    const line = this.cld.fileLine(this.contLine);
    // DebugWidget::setContLine: "LST line: <contLN>"
    const frame: StackFrame = { id: FRAME_ID, name: `main  (LST line: ${this.contLine})`, line: Math.max(1, line), column: 1 };
    if (f) {
      const p = this.displayPath.get(fileKey(f)) ?? f;
      frame.source = { name: path.basename(p), path: p };
    } else frame.presentationHint = 'subtle';
    return { stackFrames: [frame], totalFrames: 1 };
  }

  private scopes(): Scope[] {
    if (this.contLine < 0) return [];
    return [{ name: 'GDX snapshot', presentationHint: 'locals', variablesReference: SCOPE_REF, expensive: false }];
  }

  private async snapshot(): Promise<string | undefined> {
    return this.gdxPromise ? this.gdxPromise : undefined;
  }

  private async symbols(): Promise<{ gdx?: string; symbols: GdxSymbolInfo[]; error?: string }> {
    const gdx = await this.snapshot();
    if (!gdx) return { symbols: [], error: 'No GDX snapshot available.' };
    if (!this.hooks.gdx) return { gdx, symbols: [], error: 'The GAMS language server is not running.' };
    if (!this.symbolsCache) this.symbolsCache = await this.hooks.gdx.symbols(gdx);
    return { gdx, symbols: this.symbolsCache };
  }

  private async variables(ref: number): Promise<Variable[]> {
    if (this.contLine < 0) return [];
    try {
      const { gdx, symbols, error } = await this.symbols();
      if (error) return [{ name: 'info', value: error, variablesReference: 0 }];
      if (ref === SCOPE_REF) return symbols.map((s) => symbolVariable(s));
      if (ref >= SYMBOL_REF_BASE && gdx) {
        const sym = symbols.find((s) => s.index === ref - SYMBOL_REF_BASE);
        if (!sym) return [];
        return this.recordVariables(gdx, sym);
      }
    } catch (e) {
      return [{ name: 'error', value: e instanceof Error ? e.message : String(e), variablesReference: 0 }];
    }
    return [];
  }

  private async recordVariables(gdx: string, sym: GdxSymbolInfo): Promise<Variable[]> {
    const r = await this.hooks.gdx!.records(gdx, sym.index, 0, this.maxRecords);
    const res = r.records.map((rec, i) => recordVariable(sym, rec, i));
    if (r.total > r.records.length) {
      res.push({ name: '…', value: `${r.total - r.records.length} more records (open the snapshot in the GDX viewer)`, variablesReference: 0 });
    }
    return res;
  }

  private async evaluate(expr: string): Promise<{ result: string; variablesReference: number }> {
    const name = expr.trim().replace(/\(.*$/, '');
    const { symbols, error } = await this.symbols();
    if (error) throw new Error(error);
    const sym = symbols.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!sym) throw new Error(`Symbol '${name}' is not in the GDX snapshot.`);
    const v = symbolVariable(sym);
    return { result: v.value, variablesReference: v.variablesReference };
  }

  // ---- termination -------------------------------------------------------------------------

  /**
   * Studio stop: PExProjectNode::terminate (hard kill), MainWindow::stopDebugServer. No graceful interrupt: a job
   * paused at a breakpoint ignores SIGINT, so the graceful stop used for normal runs would only delay the end.
   */
  terminate(): void {
    if (this.proc?.running) this.proc.kill();
    else this.finish(undefined);
  }

  private finish(exitCode: number | undefined): void {
    if (this.terminated) return;
    this.terminated = true;
    this.flushLog();
    this.server?.stop();
    const gdx = this.server?.gdxTempFile();
    if (gdx) {
      void this.release(gdx).then(() => {
        setTimeout(() => fs.rm(gdx, { force: true }, () => undefined), 200);
      });
    }
    this.gdxResolve?.(undefined);
    if (exitCode !== undefined) this.event('exited', { exitCode });
    this.event('terminated');
  }

  dispose(): void {
    this.terminate();
  }
}

function symbolVariable(s: GdxSymbolInfo): Variable {
  const dim = s.dim > 0 ? `(${s.domain.length ? s.domain.join(',') : Array(s.dim).fill('*').join(',')})` : '';
  const value = `${typeAsString(s)}${dim}  [${s.records} record${s.records === 1 ? '' : 's'}]${s.text ? '  ' + s.text : ''}`;
  return {
    name: s.name,
    value,
    type: s.kind,
    variablesReference: s.records > 0 ? SYMBOL_REF_BASE + s.index : 0,
    namedVariables: s.records > 0 ? s.records : undefined,
  };
}

function recordVariable(sym: GdxSymbolInfo, rec: GdxRecord, i: number): Variable {
  const name = rec.keys.length ? rec.keys.join('.') : sym.dim === 0 ? sym.name : `#${i + 1}`;
  let value: string;
  const vals = rec.values.map((v) => normalizeValue(v, sym.kind));
  if (sym.kind === 'Variable' || sym.kind === 'Equation') {
    const short = ['L', 'M', 'LO', 'UP', 'SCALE'];
    value = vals.map((v, j) => `${short[j] ?? VALUE_COLUMNS[j]}=${formatValue(v)}`).join('  ');
  } else if (sym.kind === 'Set' || sym.kind === 'Alias') {
    const t = vals[0];
    value = typeof t === 'string' && t !== '' ? t : 'yes';
  } else {
    value = vals.length ? formatValue(vals[0]) : '';
  }
  return { name, value, variablesReference: 0 };
}
