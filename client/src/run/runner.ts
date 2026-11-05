// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectSysdir } from '../sysdir';
import { notifyRefUpdated, releaseGdx } from '../lsp';
import { buildGamsArgs, GamsProcess, paramValue, withReference } from './gamsProcess';
import { disposeSharedDiagnostics, sharedDiagnostics } from './diagnostics';
import { DEFAULT_MAX_LINES, LogChunk, LogStore } from './logStore';
import { OutputBatcher } from './outputBatcher';
import { prepareRun, ResolvedRunTarget, setTargetResolver } from './prepare';
import { LogLine, LogSession } from './logSession';
import { attachRun } from './runLifecycle';
import { beginBusy } from './busy';
import { HRefContext, ResolvedTarget } from './logParser';
import { editorOptions, openListing, openListingAfterRun } from '../legacy/legacyVscode';

/** A run started from a GAMS task (task provider): fixed file, output mirrored to a pseudoterminal. */
export interface TaskRun {
  file: string;
  onLine(text: string): void;
  /** exit code (1: could not start) */
  done(code: number): void;
}

export const LOG_SCHEME = 'gams-log';
export const LOG_URI = vscode.Uri.from({ scheme: LOG_SCHEME, path: '/GAMS Log' });

function targetUri(t: ResolvedTarget): vscode.Uri {
  const u = vscode.Uri.file(t.file);
  if (t.line > 0) return u.with({ fragment: t.col > 0 ? `L${t.line},${t.col}` : `L${t.line}` });
  return u;
}

interface LinkCache {
  base: number;
  done: number;
  links: vscode.DocumentLink[];
}

/**
 * Virtual document holding the cleaned log, with clickable links (Studio: log widget with marks).
 * Storage is chunked and bounded (LogStore, `gams.log.maxLines`); links are built per chunk once and only for
 * lines added since the last request, so the work per refresh does not grow with the length of the run.
 */
export class LogDocument implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  readonly store = new LogStore();
  private readonly linkCache = new WeakMap<LogChunk, LinkCache>();
  private timer?: NodeJS.Timeout;

  /** Start a new log; `spillPath`: where the complete log is written when it exceeds `gams.log.maxLines`. */
  clear(spillPath?: string): void {
    const max = vscode.workspace.getConfiguration('gams').get<number>('log.maxLines', DEFAULT_MAX_LINES);
    this.store.reset(spillPath, max > 0 ? Math.max(100, Math.floor(max)) : 0);
    this.flush();
  }

  append(l: LogLine): void {
    this.store.append(l);
    // refresh interval grows with the document: every refresh re-sends the whole text
    if (!this.timer) this.timer = setTimeout(() => this.flush(), Math.min(1500, 100 + Math.floor(this.store.lineCount / 100)));
  }

  /** Fire the pending change event now (also called when a run finishes). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.store.syncSpill();
    this.changed.fire(LOG_URI);
  }

  /** The run is over: the complete log is on disk. */
  finish(): void {
    this.flush();
    this.store.closeSpill();
  }

  /** The editor shows a different text than the store has (an update was lost while the document was opening). */
  isStale(doc: vscode.TextDocument): boolean {
    const n = this.store.lineCount;
    if (doc.lineCount - 1 !== n) return true;
    if (n === 0) return false;
    const chunks = this.store.chunkList;
    const last = chunks[chunks.length - 1];
    const lastText = last.text.substring(last.text.lastIndexOf('\n', last.text.length - 2) + 1, last.text.length - 1);
    return doc.lineAt(doc.lineCount - 2).text !== lastText;
  }

  provideTextDocumentContent(): string {
    return this.store.text();
  }

  provideDocumentLinks(): vscode.DocumentLink[] {
    const res: vscode.DocumentLink[] = [];
    const header = this.store.headerLines;
    const spill = this.store.spillFile;
    if (header && spill) {
      const note = this.store.note();
      res.push(new vscode.DocumentLink(new vscode.Range(0, note.length - spill.length, 0, note.length), vscode.Uri.file(spill)));
    }
    for (const chunk of this.store.chunkList) {
      const base = header + chunk.firstLine - this.store.droppedLines;
      let c = this.linkCache.get(chunk);
      if (!c || c.base !== base) {
        c = { base, done: 0, links: [] };
        this.linkCache.set(chunk, c);
      }
      for (; c.done < chunk.links.length; c.done++) {
        const k = chunk.links[c.done];
        const link = new vscode.DocumentLink(new vscode.Range(base + k.line, k.start, base + k.line, k.end), targetUri(k.target));
        link.tooltip = path.basename(k.target.file) + (k.target.line ? `:${k.target.line}` : '');
        c.links.push(link);
      }
      for (const l of c.links) res.push(l);
    }
    return res;
  }
}

export class Runner implements vscode.Disposable {
  private proc?: GamsProcess;
  /** A non-GAMS-process job (NEOS) that owns the log view; Stop/Interrupt are forwarded to it. */
  private external?: { stop(): void };
  private activeRun?: object;
  private endBusy?: () => void;
  private readonly status: vscode.StatusBarItem;
  private readonly diagnostics = sharedDiagnostics();
  private readonly channel = vscode.window.createOutputChannel('GAMS');
  private readonly output = new OutputBatcher(this.channel);
  private readonly logDoc = new LogDocument();
  private readonly disposables: vscode.Disposable[] = [];
  private resolver?: (active: string) => Promise<ResolvedRunTarget | undefined | null>;

  /** Studio project / main file resolution (set by the extension). `null`: run cancelled. Also used by debug and profile. */
  get resolveTarget(): ((active: string) => Promise<ResolvedRunTarget | undefined | null>) | undefined {
    return this.resolver;
  }

  set resolveTarget(fn: ((active: string) => Promise<ResolvedRunTarget | undefined | null>) | undefined) {
    this.resolver = fn;
    setTargetResolver(fn, (p) => this.isProjectFile?.(p) ?? false);
  }

  /** Files that belong to a Studio project (saved with every run); set by the extension. */
  isProjectFile?: (fsPath: string) => boolean;

  constructor() {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.status.command = 'gams.showLog';
    this.status.name = 'GAMS Run Status';
    this.setIdle();
    this.disposables.push(
      this.status,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusVisibility()),
      this.diagnostics,
      this.output,
      vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, this.logDoc),
      vscode.languages.registerDocumentLinkProvider({ scheme: LOG_SCHEME }, this.logDoc),
    );
  }

  dispose(): void {
    // extension shutdown: hard kill so no GAMS job outlives VS Code (Studio behaviour)
    this.proc?.kill();
    this.external?.stop();
    this.disposables.forEach((d) => d.dispose());
    disposeSharedDiagnostics();
  }

  get sysdir(): string | undefined {
    return detectSysdir(vscode.workspace.getConfiguration('gams').get<string>('sysdir', ''));
  }

  async showLog(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(LOG_URI);
    const shown = (await vscode.languages.setTextDocumentLanguage(doc, 'plaintext')) ?? doc;
    await vscode.window.showTextDocument(shown, editorOptions());
    // a change event that fired while the document was being opened (or its language switched) is lost:
    // a fast run could end without its last lines ("Process ended") ever showing
    if (this.logDoc.isStale(shown)) this.logDoc.flush();
  }

  private statusBusy = false;

  /** The idle item only shows for GAMS editors; a running job is always shown. */
  private updateStatusVisibility(): void {
    if (this.statusBusy || vscode.window.activeTextEditor?.document.languageId.startsWith('gams')) this.status.show();
    else this.status.hide();
  }

  private setIdle(): void {
    this.statusBusy = false;
    this.status.text = '$(circle-outline) GAMS';
    this.status.tooltip = 'GAMS: idle. Click to show the log.';
    this.status.accessibilityInformation = { label: 'GAMS: idle. Show the log', role: 'button' };
    this.updateStatusVisibility();
    void vscode.commands.executeCommand('setContext', 'gams.running', false);
  }

  private setRunning(name: string, pid: number | undefined): void {
    this.status.text = `$(sync~spin) GAMS: ${name}`;
    this.status.tooltip = `GAMS running (pid ${pid ?? '?'}). Click to show the log.`;
    this.status.accessibilityInformation = { label: `GAMS running ${name}. Show the log`, role: 'button' };
    this.statusBusy = true;
    this.updateStatusVisibility();
    void vscode.commands.executeCommand('setContext', 'gams.running', true);
  }

  async run(compile: boolean, extraParams: string[] = [], task?: TaskRun): Promise<void> {
    if (this.proc?.running || this.endBusy) {
      void vscode.window.showWarningMessage('GAMS is already running. Stop it first.');
      task?.onLine('GAMS is already running. Stop it first.');
      task?.done(1);
      return;
    }
    // busy from before the save (which fires onDidSaveTextDocument) until the process is finished
    const end = beginBusy();
    this.endBusy = () => { end(); this.endBusy = undefined; };
    const started = { value: false };
    try {
      await this.runInner(compile, extraParams, task, started);
    } catch (e) {
      task?.onLine(`*** ${(e as Error).message}`);
    } finally {
      if (!this.proc?.running) this.endBusy?.();
      if (task && !started.value) task.done(1);
    }
  }

  private async runInner(compile: boolean, extraParams: string[], task?: TaskRun, started?: { value: boolean }): Promise<void> {
    let active = task?.file;
    if (!active) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'gams' || editor.document.uri.scheme !== 'file') {
        void vscode.window.showErrorMessage('Open a saved GAMS file (.gms) to run.');
        return;
      }
      active = editor.document.uri.fsPath;
    }
    const prep = await prepareRun(active, compile ? 'GAMS compile' : 'GAMS run');
    if (!prep) return;
    const { sysdir, main: gmsFile, workDir } = prep;
    // order: Studio defaults, user/project/main-file options, run-with options
    const { args, refPath, paths } = withReference(buildGamsArgs(gmsFile, [...prep.params, ...extraParams], compile), gmsFile, workDir);
    const startedAt = Date.now();

    // lst location (analyzeParameters): <curdir/workdir>/<filestem>.lst, overridden by o=/output=
    const ctx: HRefContext = {
      workDir,
      lst: paths.lst ?? '',
      sysDir: sysdir,
      inputDirs: (paramValue(args, 'inputdir', 'idir') ?? '').split(path.delimiter).filter(Boolean),
    };

    // Studio releases GDX files before a run so GAMS can rewrite them.
    await releaseGdx();

    this.diagnostics.clear();
    this.logDoc.clear(paths.log);
    this.output.reset();

    const run = {};
    this.activeRun = run;
    const isCurrent = (): boolean => this.activeRun === run;
    const session = new LogSession(ctx, (p) => fs.existsSync(p), {
      onLine: (l) => {
        if (!isCurrent()) return;
        this.logDoc.append(l);
        this.output.add(l.text);
        task?.onLine(l.text);
      },
      onError: (e) => {
        if (isCurrent()) this.diagnostics.add(e);
      },
    }, false);

    const proc = new GamsProcess(sysdir, args, workDir);
    this.proc = proc;
    const header: LogLine = { text: `Running: ${proc.commandLine}`, links: [] };
    this.logDoc.append(header);
    this.output.add(header.text);
    task?.onLine(header.text);
    let exitCode = 1;
    proc.on('exit', (code: number | null) => { exitCode = code ?? 1; });
    proc.on('stdout', (d) => session.push(d));
    proc.on('stderr', (d) => session.push(d));
    attachRun(proc, session, {
      isCurrentRun: isCurrent,
      isCurrentProc: () => this.proc === proc,
      appendLine: (text) => {
        this.logDoc.append({ text, links: [] });
        this.output.add(text);
        task?.onLine(text);
      },
      onProcFinished: () => {
        this.proc = undefined;
        this.setIdle();
        this.endBusy?.();
      },
      onFinalized: () => {
        this.logDoc.finish();
        this.output.flush();
        // a fresh reference file lets the language server serve definition/references/symbols
        try {
          if (fs.statSync(refPath).mtimeMs >= startedAt - 1000) notifyRefUpdated(vscode.Uri.file(gmsFile), refPath, startedAt);
        } catch {
          // no reference file written (e.g. fatal error before compilation)
        }
        if (openListingAfterRun()) void openListing(paths.lst);
        task?.done(exitCode);
      },
    });
    if (started) started.value = true;
    proc.start();
    this.setRunning(path.basename(gmsFile), proc.pid);
    if (vscode.workspace.getConfiguration('gams').get<boolean>('showLogOnRun', true)) await this.showLog();
  }

  /**
   * Log view, diagnostics and busy state for a job that is not a single GAMS process (NEOS run).
   * Returns undefined (with a warning) when something else is running.
   */
  beginExternalRun(name: string, ctx: HRefContext, stop: () => void): { push(text: string): void; finish(): void } | undefined {
    if (this.proc?.running || this.endBusy) {
      void vscode.window.showWarningMessage('GAMS is already running. Stop it first.');
      return undefined;
    }
    const end = beginBusy();
    this.endBusy = () => { end(); this.endBusy = undefined; };
    this.diagnostics.clear();
    this.logDoc.clear(path.join(ctx.workDir, path.basename(name, path.extname(name)) + '.log'));
    this.output.reset();
    const run = {};
    this.activeRun = run;
    const session = new LogSession(ctx, (p) => fs.existsSync(p), {
      onLine: (l) => {
        this.logDoc.append(l);
        this.output.add(l.text);
      },
      onError: (e) => this.diagnostics.add(e),
    }, false);
    const ext = { stop };
    this.external = ext;
    this.status.text = `$(sync~spin) NEOS: ${name}`;
    this.status.tooltip = 'NEOS run in progress. Click to show the log.';
    this.status.accessibilityInformation = { label: `NEOS run ${name} in progress. Show the log`, role: 'button' };
    this.statusBusy = true;
    this.updateStatusVisibility();
    void vscode.commands.executeCommand('setContext', 'gams.running', true);
    return {
      push: (t) => session.push(t),
      finish: () => {
        session.end();
        this.logDoc.finish();
        this.output.flush();
        if (this.external === ext) this.external = undefined;
        this.setIdle();
        this.endBusy?.();
      },
    };
  }

  interrupt(): void {
    if (this.external) { this.external.stop(); return; }
    this.proc?.interrupt();
  }

  /** Stop: interrupt first, hard kill after gams.stopGracePeriod; a second Stop kills at once. */
  stop(): void {
    if (this.external) { this.external.stop(); return; }
    this.proc?.stop();
  }
}
