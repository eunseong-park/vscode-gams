// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Profiler UI: Studio paints time/memory/rows/steps columns next to the line numbers
 * (CodeEdit::profilerPaintEvent, src/editors/codeedit.cpp) with a per-statement tooltip table
 * (Profiler::getProfileText). Here: end-of-line decorations, a hover with that table and a
 * summary (output channel + QuickPick) sorted by time.
 * GPL-3.0-or-later.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { notifyRefUpdated } from '../lsp';
import { fileKey } from './debugSession';
import { formatMemory, formatTime } from './profiler';
import { ProfileLine, ProfileRun } from './profileSession';
import { beginBusy } from '../run/busy';
import { sharedDiagnostics } from '../run/diagnostics';
import { OutputBatcher } from '../run/outputBatcher';
import { prepareRun } from '../run/prepare';

export class ProfileController implements vscode.Disposable {
  private run?: ProfileRun;
  private profiling = false;
  private readonly out = vscode.window.createOutputChannel('GAMS Profiler');
  private readonly batch = new OutputBatcher(this.out);
  private readonly deco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em', fontStyle: 'normal' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly getSysdir: () => string | undefined) {
    this.disposables.push(
      this.out,
      this.deco,
      vscode.commands.registerCommand('gams.profile', () => this.profile()),
      vscode.commands.registerCommand('gams.profile.summary', () => this.showSummary()),
      vscode.commands.registerCommand('gams.profile.clear', () => this.clear()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
      vscode.languages.registerHoverProvider({ language: 'gams' }, { provideHover: (d, p) => this.hover(d, p) }),
    );
  }

  dispose(): void {
    this.run?.stop();
    if (this.timer) clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  private async profile(): Promise<void> {
    if (this.run?.running || this.profiling) {
      void vscode.window.showWarningMessage('A GAMS profiling run is already active.');
      return;
    }
    // busy from before the save (it fires onDidSaveTextDocument) until the run ends
    this.profiling = true;
    const endBusy = beginBusy();
    try {
      await this.profileInner();
    } finally {
      this.profiling = false;
      endBusy();
    }
  }

  private async profileInner(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'gams' || ed.document.uri.scheme !== 'file') {
      void vscode.window.showErrorMessage('Open a saved GAMS file (.gms) to profile.');
      return;
    }
    // same steps as F9: save all modified files, sysdir check, project / main file, project parameters
    const prep = await prepareRun(ed.document.uri.fsPath, 'GAMS profile');
    if (!prep) return;
    this.clear();
    this.batch.reset();
    this.out.show(true);
    sharedDiagnostics().clear();
    const run = new ProfileRun(prep.main, prep.sysdir, prep.params, {
      log: (t) => this.batch.add(t),
      data: () => this.scheduleDecorate(),
      refWritten: (gms, ref, t) => notifyRefUpdated(vscode.Uri.file(gms), ref, t),
      onError: (e) => sharedDiagnostics().add(e),
      finished: (code) => {
        this.batch.flush();
        this.decorateAll();
        this.writeSummary();
        void vscode.window
          .showInformationMessage(`GAMS profiling finished${code !== undefined ? ` (exit code ${code})` : ''}.`, 'Show Summary', 'Clear')
          .then((c) => (c === 'Show Summary' ? this.showSummary() : c === 'Clear' ? this.clear() : undefined));
      },
    }, prep.workDir);
    this.run = run;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `GAMS profiling ${path.basename(run.program)}` },
      async () => {
        if (!(await run.start())) return;
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (!run.running) {
              clearInterval(check);
              resolve();
            }
          }, 500);
        });
      },
    );
  }

  private clear(): void {
    if (this.run?.running) return;
    this.run = undefined;
    for (const e of vscode.window.visibleTextEditors) e.setDecorations(this.deco, []);
  }

  /** PExProjectNode mUpdateEditsTimer: refresh the editors at most once a second */
  private scheduleDecorate(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.decorateAll();
    }, 1000);
  }

  private decorateAll(): void {
    const run = this.run;
    for (const e of vscode.window.visibleTextEditors) {
      if (!run || e.document.uri.scheme !== 'file') {
        e.setDecorations(this.deco, []);
        continue;
      }
      const lines = run.fileLines(e.document.uri.fsPath);
      e.setDecorations(
        this.deco,
        lines
          .filter((l) => l.line - 1 < e.document.lineCount)
          .map((l) => {
            const end = e.document.lineAt(l.line - 1).range.end;
            return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: lineText(l) } } };
          }),
      );
    }
  }

  private hover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const run = this.run;
    if (!run || doc.uri.scheme !== 'file') return undefined;
    const rows = run.profiler.getProfileText(run.contLines(doc.uri.fsPath, pos.line + 1));
    if (!rows.length) return undefined;
    const end = doc.lineAt(pos.line).range.end;
    if (pos.character < end.character) return undefined; // only on the decoration / line end
    const md = new vscode.MarkdownString();
    md.appendMarkdown('| statement | time | % | memory | rows | steps | % |\n|---|--:|--:|--:|--:|--:|--:|\n');
    for (const r of rows) {
      md.appendMarkdown(`| ${esc(r.label)} | ${r.time} | ${r.timePct} | ${r.memory} | ${r.rows} | ${r.steps} ↻ | ${r.stepsPct} |\n`);
    }
    return new vscode.Hover(md, new vscode.Range(end, end));
  }

  private writeSummary(): void {
    const run = this.run;
    if (!run) return;
    const sums = run.profiler.getSums();
    this.out.appendLine('');
    this.out.appendLine(`=== GAMS profile: ${sums.steps} statements, ${formatTime(sums.timeSec)} total ===`);
    this.out.appendLine('      time      memory      rows    steps  location');
    for (const l of run.summary().slice(0, 50)) {
      this.out.appendLine(
        `${formatTime(l.timeSec).padStart(10)} ${formatMemory(l.memory).padStart(11)} ${String(l.rows || '').padStart(9)} ${String(l.steps).padStart(8)}  ` +
          `${path.basename(l.file)}:${l.line}${l.isInclude ? '  (include total)' : ''}`,
      );
    }
  }

  private async showSummary(): Promise<void> {
    const run = this.run;
    if (!run || run.profiler.isEmpty()) {
      void vscode.window.showInformationMessage('No GAMS profile data. Run "GAMS: Run with Profiler" first.');
      return;
    }
    const sums = run.profiler.getSums();
    const items = run.summary().map((l) => ({
      label: `${formatTime(l.timeSec)}  ${path.basename(l.file)}:${l.line}`,
      description: `${formatMemory(l.memory).trim()} · ${l.steps} step${l.steps === 1 ? '' : 's'}${l.rows ? ` · ${l.rows} rows` : ''}${l.isInclude ? ' · include total' : ''}`,
      detail: lineSource(l),
      l,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: `GAMS profile (${formatTime(sums.timeSec)} in ${sums.steps} statements), sorted by time`,
      matchOnDescription: true,
    });
    if (!pick) return;
    const doc = await vscode.workspace.openTextDocument(pick.l.file);
    const p = new vscode.Position(pick.l.line - 1, 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(p, p) });
  }
}

function lineText(l: ProfileLine): string {
  const parts = [formatTime(l.timeSec), formatMemory(l.memory).trim()];
  if (l.rows) parts.push(`${l.rows} rows`);
  parts.push(`${l.steps}↻`);
  return `${l.isInclude ? 'Σ ' : ''}${parts.join(' · ')}`;
}

function lineSource(l: ProfileLine): string {
  const d = vscode.workspace.textDocuments.find((t) => t.uri.scheme === 'file' && fileKey(t.uri.fsPath) === fileKey(l.file));
  return d && l.line <= d.lineCount ? d.lineAt(l.line - 1).text.trim() : '';
}

function esc(s: string): string {
  return s.replace(/[|\\`*_[\]<>]/g, (c) => '\\' + c);
}
