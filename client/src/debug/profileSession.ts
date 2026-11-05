// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * A profiling run as in GAMS Studio's "Run with selected" + "Profiling" flag:
 * GamsParameterWidget::on_runAction prepends "Profile=300" (src/option/gamsparameterwidget.cpp),
 * MainWindow::execute starts the gamscom::Server with cfProfiler and analyzeParameters adds
 * ComPort=<port> (src/file/pexgroupnode.cpp). The map-done handler only sends "run"; every
 * "profileData" reply is fed into gamscom::Profiler.
 * GPL-3.0-or-later. Pure node module: no vscode imports.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildGamsArgs, GamsProcess, paramValue, withReference } from '../run/gamsProcess';
import { ErrorEntry, LogSession } from '../run/logSession';
import { attachRun } from '../run/runLifecycle';
import type { HRefContext } from '../run/logParser';
import { ComServer } from './comServer';
import { ContinuousLineData } from './continuousLineData';
import { fileKey } from './debugSession';
import { Profiler } from './profiler';
import { ComFeature } from './protocol';

export interface ProfileLine {
  file: string;
  line: number;
  timeSec: number;
  memory: number;
  rows: number;
  steps: number;
  /** the line is an include statement: its values are the include totals ("File SUM") */
  isInclude: boolean;
}

export interface ProfileRunEvents {
  log?(text: string): void;
  /** profile data arrived (throttle in the UI) */
  data?(): void;
  /** process ended; exitCode undefined when killed / failed */
  finished?(exitCode: number | undefined): void;
  traffic?(dir: 'in' | 'out', data: string): void;
  refWritten?(gms: string, refPath: string, startedAt?: number): void;
  /** an error found in the log (Problems entry, same as a normal run) */
  onError?(e: ErrorEntry): void;
}

export class ProfileRun {
  readonly cld = new ContinuousLineData(fileKey);
  readonly profiler = new Profiler(fileKey);
  /** key -> original file name */
  readonly files = new Map<string, string>();
  private server?: ComServer;
  private proc?: GamsProcess;
  private profilerActive = false;

  constructor(
    readonly program: string,
    readonly sysdir: string,
    readonly userParams: string[],
    private readonly ev: ProfileRunEvents,
    readonly workDir = path.dirname(program),
  ) {
    this.profiler.setContinuousLineData(this.cld);
    this.profiler.setMainFile(program);
  }

  get running(): boolean {
    return !!this.proc?.running;
  }

  /** "features" reply bit 2 (PExProjectNode::switchProfiler) */
  get active(): boolean {
    return this.profilerActive;
  }

  async start(): Promise<boolean> {
    this.server = new ComServer(this.workDir, ComFeature.Profiler, {
      log: (m) => this.ev.log?.(m),
      traffic: this.ev.traffic,
      features: (f) => {
        this.profilerActive = (f & 2) !== 0;
        this.profiler.setMainFile(this.program);
      },
      linesMap: (f, l, c) => {
        const k = fileKey(f);
        if (!this.files.has(k)) this.files.set(k, f);
        this.cld.addLinesMap(f, l, c);
      },
      linesMapDone: (includes) => {
        for (const inc of includes) {
          for (const f of [inc.parentFile, inc.childFile]) if (f && !this.files.has(fileKey(f))) this.files.set(fileKey(f), f);
        }
        this.profiler.addIncludes(includes);
        this.server?.sendRun();
      },
      profileData: (e) => {
        this.profiler.add(e.contLine, e.statement, e.timeSec, e.memory, e.rows);
        this.ev.data?.();
      },
    });
    if (!(await this.server.start())) {
      this.ev.log?.('Could not start the GAMScom server (no free port in 3563..4563).');
      return false;
    }
    const hasProfile = paramValue(this.userParams, 'profile') !== undefined;
    const params = [`ComPort=${this.server.port}`, ...(hasProfile ? [] : ['Profile=300']), ...this.userParams];
    const { args, refPath, paths } = withReference(buildGamsArgs(this.program, params, false), this.program, this.workDir);
    const ctx: HRefContext = {
      workDir: this.workDir,
      lst: paths.lst ?? '',
      sysDir: this.sysdir,
      inputDirs: (paramValue(args, 'inputdir', 'idir') ?? '').split(path.delimiter).filter(Boolean),
    };
    const log = new LogSession(ctx, (p) => fs.existsSync(p), { onLine: (l) => this.ev.log?.(l.text), onError: (e) => this.ev.onError?.(e) }, false);
    const proc = new GamsProcess(this.sysdir, args, this.workDir);
    this.proc = proc;
    this.ev.log?.(`Running: ${proc.commandLine}`);
    proc.on('stdout', (d) => log.push(d));
    proc.on('stderr', (d) => log.push(d));
    let exitCode: number | undefined;
    const startedAt = Date.now();
    proc.on('exit', (c) => {
      exitCode = c ?? undefined;
    });
    attachRun(proc, log, {
      isCurrentRun: () => true,
      isCurrentProc: () => true,
      appendLine: (t) => this.ev.log?.(t),
      onProcFinished: () => undefined,
      onFinalized: () => {
        this.server?.stop();
        try {
          if (fs.statSync(refPath).mtimeMs >= startedAt - 1000) this.ev.refWritten?.(this.program, refPath, startedAt);
        } catch {
          // no reference file
        }
        this.ev.finished?.(exitCode);
      },
    });
    proc.start();
    return true;
  }

  stop(): void {
    this.proc?.stop();
  }

  /** all files known from the lines map and include statements (original names) */
  knownFiles(): string[] {
    return [...this.files.values()];
  }

  /** per-line values of one file as painted by CodeEdit::profilerPaintEvent (lines with steps > 0) */
  fileLines(file: string): ProfileLine[] {
    const lines = new Set<number>([...this.cld.validLines(file), ...this.profiler.includeLines(file)]);
    if (fileKey(file) === fileKey(this.program)) lines.add(1);
    const incs = new Set(this.profiler.includeLines(file));
    const res: ProfileLine[] = [];
    for (const line of [...lines].sort((a, b) => a - b)) {
      const p = this.profiler.lineProfile(file, line);
      if (p.steps > 0) res.push({ file: this.files.get(fileKey(file)) ?? file, line, ...p, isInclude: incs.has(line) && this.cld.continuousLine(file, line).length === 0 });
    }
    return res;
  }

  /** every profiled line, slowest first */
  summary(): ProfileLine[] {
    const all = this.knownFiles().flatMap((f) => this.fileLines(f));
    return all.sort((a, b) => b.timeSec - a.timeSec || b.steps - a.steps);
  }

  /** contLNs behind a file line (for the hover table, Profiler::getProfileText) */
  contLines(file: string, line: number): number[] {
    return this.profiler.continuousLine(file, line);
  }
}
