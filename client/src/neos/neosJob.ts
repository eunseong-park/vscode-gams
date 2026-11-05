// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * One NEOS run: ping, local preparation (gams action=c + xsave), submitJob, status polling with
 * intermediate log streaming, result download and gmsunzip. Port of the state machine of GAMS Studio
 * src/neos/neosprocess.cpp (Proc1Compile -> Proc4Monitor -> Proc5GetResult) driven by the manager calls
 * of src/neos/neosmanager.cpp. Pure module (no vscode imports); the log goes out through `log`.
 * Original: Copyright (c) 2017-2026 GAMS Software GmbH / GAMS Development Corp., GPL-3.0-or-later.
 */
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { GamsProcess } from '../run/gamsProcess';
import { NeosClient, NeosError } from './neosClient';
import {
  buildJobXml, compileArgs, NeosPriority, parseSolverCapabilities, RefConverter, remoteArgs, solverToCategories,
  unzipLogLine,
} from './neosParams';

/** The `gmsunzip` tool of the GAMS system directory (Studio GmsunzipProcess). */
class UnzipProcess extends GamsProcess {
  override get exePath(): string {
    return path.join(this.sysdir, process.platform === 'win32' ? 'gmsunzip.exe' : 'gmsunzip');
  }
}

export interface NeosJobOptions {
  sysdir: string;
  gmsFile: string;
  workDir: string;
  /** Parameters after the Studio defaults (settings, project, run-with options). */
  userParams: string[];
  email: string;
  priority: NeosPriority;
  forceGdx: boolean;
  serverUrl: string;
  /** Raw text for the GAMS log view (LogSession.push). */
  log: (text: string) => void;
  /** Called on a TLS certificate error; resolve true to ignore it (Studio "Ignore"/"Abort" dialog). */
  onTlsError?: (message: string) => Promise<boolean>;
  pollMs?: number;
  /** Idle timeout of one NEOS request. */
  requestTimeoutMs?: number;
  /** gams.stopGracePeriod for the local preparation step, in ms. */
  graceMs?: number;
  /** Consecutive failed status polls tolerated before giving up. */
  maxPollFailures?: number;
}

export interface NeosResult {
  ok: boolean;
  cancelled: boolean;
  outPath: string;
  /** files extracted from solver-output.zip (names) */
  files: string[];
  message?: string;
}

class Cancelled extends Error {}
class Failed extends Error {}

export class NeosJob {
  private cancelled = false;
  private client?: NeosClient;
  private proc?: GamsProcess;
  private jobNumber = 0;
  private password = '';
  private wake?: () => void;
  private readonly stem: string;
  readonly outPath: string;
  private readonly opt: Required<Pick<NeosJobOptions, 'pollMs' | 'requestTimeoutMs' | 'graceMs' | 'maxPollFailures'>>;

  constructor(private readonly o: NeosJobOptions) {
    this.stem = path.basename(o.gmsFile, path.extname(o.gmsFile));
    this.outPath = path.join(o.workDir, this.stem);
    this.refs = new RefConverter(this.outPath);
    this.opt = {
      pollMs: o.pollMs ?? 1000,
      requestTimeoutMs: o.requestTimeoutMs ?? 60000,
      graceMs: o.graceMs ?? GamsProcess.defaultGraceMs,
      maxPollFailures: o.maxPollFailures ?? 3,
    };
  }

  get jobId(): number { return this.jobNumber; }

  /**
   * Cancel (Studio interrupt/terminate): kills the NEOS job if one was submitted (the server may ignore it,
   * Studio comment), otherwise stops the local preparation (gracefully, then hard). Second call: hard kill.
   */
  stop(): void {
    if (this.cancelled) { this.proc?.kill(); return; }
    this.cancelled = true;
    this.client?.abort();
    this.proc?.stop(this.opt.graceMs);
    this.wake?.();
  }

  async start(): Promise<NeosResult> {
    const res: NeosResult = { ok: false, cancelled: false, outPath: this.outPath, files: [] };
    try {
      await this.ping();
      await this.prepare();
      await this.submit();
      await this.monitor();
      await this.fetchResults(res);
      res.ok = true;
    } catch (e) {
      if (e instanceof Cancelled || this.cancelled) {
        res.cancelled = true;
        await this.killRemote();
        this.o.log('\n*** NEOS run cancelled\n');
        res.message = 'cancelled';
      } else {
        res.message = (e as Error).message;
        this.o.log(`\n*** ${res.message}\n`);
      }
    }
    return res;
  }

  // ---- helpers ----

  private mkClient(timeoutMs = this.opt.requestTimeoutMs, ignoreTls = this.client?.ignoreTlsErrors ?? false): NeosClient {
    return new NeosClient(this.o.serverUrl, { timeoutMs, ignoreTlsErrors: ignoreTls });
  }

  private check(): void {
    if (this.cancelled) throw new Cancelled();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done(): void { clearTimeout(t); self.wake = undefined; resolve(); }
      this.wake = done;
    });
  }

  private netError(e: unknown): Failed {
    if (e instanceof NeosError) {
      return new Failed(e.kind === 'fault' || e.kind === 'protocol' || e.kind === 'http' ? `NEOS server error: ${e.message}` : `Network error: ${e.message}`);
    }
    return new Failed(`Network error: ${(e as Error).message}`);
  }

  /** NeosProcess::validate -> NeosManager::ping, with the SSL error dialog. */
  private async ping(): Promise<void> {
    this.client = this.mkClient();
    for (let attempt = 0; ; attempt++) {
      this.check();
      try {
        await this.client.ping();
        return;
      } catch (e) {
        this.check();
        if (e instanceof NeosError && e.kind === 'tls' && attempt === 0 && this.o.onTlsError) {
          this.o.log(`\n*** SSL errors:\n${e.message}\n`);
          if (await this.o.onTlsError(e.message)) {
            this.client = this.mkClient(undefined, true);
            continue;
          }
          throw new Failed('Aborted because of SSL errors');
        }
        throw this.netError(e);
      }
    }
  }

  /** Local step: gams action=c xsave="<stem>" previousWork=1 (NeosProcess::execute/compileParameters). */
  private async prepare(): Promise<void> {
    this.check();
    fs.mkdirSync(this.outPath, { recursive: true });
    const proc = new GamsProcess(this.o.sysdir, compileArgs(this.o.gmsFile, this.o.userParams, this.stem), this.o.workDir);
    this.proc = proc;
    this.o.log(`Running: ${proc.commandLine}\n`);
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.on('stdout', (d) => this.o.log(d));
      proc.on('stderr', (d) => this.o.log(d));
      proc.on('error', (e) => reject(new Failed(`Could not start GAMS: ${e.message}`)));
      // 'close' = stdio drained, so the whole compile log is delivered before we go on
      proc.on('close', (c) => resolve(c));
      proc.start();
    });
    this.proc = undefined;
    this.check();
    if (code !== 0) throw new Failed(`Error on compilation, exit code ${code}`);
  }

  private async submit(): Promise<void> {
    this.check();
    const g00 = this.outPath + '.g00';
    let data: Buffer;
    try { data = fs.readFileSync(g00); } catch { throw new Failed(`Can't open ${g00}`); }
    const { params, hasGdx } = remoteArgs(this.o.gmsFile, this.o.userParams, this.o.forceGdx);
    let caps = new Map<string, string[]>();
    try { caps = parseSolverCapabilities(fs.readFileSync(path.join(this.o.sysdir, 'gmscmpun.txt'), 'utf8')); } catch { /* keep solver=... as is */ }
    const finalParams = (caps.size ? solverToCategories(params, caps) : params).join(' ');
    const xml = buildJobXml(data, finalParams, this.o.priority, hasGdx, this.o.email);
    let r: { jobNumber: number; password: string };
    try {
      r = await this.client!.submitJob(xml);
    } catch (e) {
      this.check();
      throw this.netError(e);
    }
    if (!r.jobNumber) throw new Failed(`NEOS: ${r.password}`);
    this.jobNumber = r.jobNumber;
    this.password = r.password;
    const cred = this.o.priority === 'long' ? `\nJob ${r.jobNumber} dispatched\npassword: ${r.password}` : '';
    this.o.log(`\n--- switch to NEOS .${path.sep}${this.stem}${path.sep}solve.lst[LS2:"${this.outPath}/solve.lst"]${cred}\n`);
  }

  private readonly refs: RefConverter;
  private decoder = new StringDecoder('utf8');
  private logOffset = 0;

  private emitRemote(data: Buffer): void {
    const t = this.refs.push(this.decoder.write(data));
    if (t) this.o.log(t);
  }

  /** NeosProcess::pullStatus loop (Proc4Monitor). */
  private async monitor(): Promise<void> {
    const c = this.client!;
    let failures = 0;
    for (;;) {
      this.check();
      try {
        if (this.o.priority === 'short') {
          const r = await c.getIntermediateResultsNonBlocking(this.jobNumber, this.password, this.logOffset);
          this.logOffset = r.offset;
          this.emitRemote(r.data);
        }
        const status = await c.getJobStatus(this.jobNumber, this.password);
        failures = 0;
        switch (status.toLowerCase()) {
          case 'done':
            await this.drain();
            return;
          case 'running':
          case 'waiting':
            break;
          default:
            throw new Failed(`Neos error-status: ${status}`);
        }
      } catch (e) {
        this.check();
        if (e instanceof Failed) throw e;
        if (++failures > this.opt.maxPollFailures) throw this.netError(e);
        this.o.log(`\n*** NEOS request failed (${(e as Error).message}); retrying (${failures}/${this.opt.maxPollFailures})\n`);
      }
      await this.sleep(this.opt.pollMs);
    }
  }

  /** Log text produced between the last poll and "done" (Studio loses it; it is in the result zip anyway). */
  private async drain(): Promise<void> {
    if (this.o.priority !== 'short') return;
    try {
      const r = await this.client!.getIntermediateResultsNonBlocking(this.jobNumber, this.password, this.logOffset);
      this.logOffset = r.offset;
      this.emitRemote(r.data);
    } catch { /* optional */ }
  }

  /** Proc5GetResult: completion code, final results (long), solver-output.zip, gmsunzip. */
  private async fetchResults(res: NeosResult): Promise<void> {
    const c = this.client!;
    let code: string;
    try { code = await c.getCompletionCode(this.jobNumber, this.password); } catch (e) { this.check(); throw this.netError(e); }
    this.check();
    if (code !== 'Normal') {
      let msg = `Neos error-exit: ${code}`;
      if (!this.o.userParams.some((p) => /^previouswork/i.test(p))) msg += '\n    (you may try adding the parameter "PreviousWork=1")';
      throw new Failed(msg);
    }
    try {
      if (this.o.priority === 'long') this.emitRemote(await c.getFinalResultsNonBlocking(this.jobNumber, this.password));
      const tail = this.refs.end();
      if (tail) this.o.log(tail);
      this.check();
      const zip = await c.getOutputFile(this.jobNumber, this.password, 'solver-output.zip');
      fs.mkdirSync(this.outPath, { recursive: true });
      fs.writeFileSync(path.join(this.outPath, 'solver-output.zip'), zip);
    } catch (e) {
      this.check();
      if (e instanceof Failed) throw e;
      throw this.netError(e);
    }
    this.check();
    await this.unpack(res);
  }

  private async unpack(res: NeosResult): Promise<void> {
    const proc = new UnzipProcess(this.o.sysdir, ['-o', 'solver-output.zip'], this.outPath);
    this.proc = proc;
    this.o.log(`Running: ${proc.commandLine}\n`);
    let buf = '';
    const line = (l: string): void => {
      this.o.log(unzipLogLine(l, this.outPath) + '\n');
      const m = /^\s*(?:extracting|inflating):\s*(.+?)\s*$/.exec(l);
      if (m) res.files.push(m[1]);
    };
    const feed = (d: string): void => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.substring(0, i).replace(/\r$/, '')); buf = buf.substring(i + 1); }
    };
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.on('stdout', feed);
      proc.on('stderr', feed);
      proc.on('error', (e) => reject(new Failed(`Could not start gmsunzip: ${e.message}`)));
      proc.on('close', (c) => resolve(c));
      proc.start();
    });
    if (buf) line(buf);
    this.proc = undefined;
    this.check();
    if (code !== 0) throw new Failed(`gmsunzip failed with exit code ${code}`);
  }

  /** NeosManager::killJob; best effort with a short timeout (the server may ignore it). */
  private async killRemote(): Promise<void> {
    if (!this.jobNumber) return;
    const k = this.mkClient(10000);
    try {
      const text = await k.killJob(this.jobNumber, this.password);
      if (text) this.o.log(`\n${text}\n`);
    } catch (e) {
      this.o.log(`\n*** Could not send killJob to NEOS: ${(e as Error).message}\n`);
    }
  }
}
