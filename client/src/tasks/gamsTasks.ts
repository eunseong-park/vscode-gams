// SPDX-License-Identifier: GPL-3.0-or-later
/* Task provider for `gams` tasks: executed by our runner (log, links, Problems) in a pseudoterminal. */
import * as path from 'path';
import * as vscode from 'vscode';
import { Runner } from '../run/runner';
import { GamsTaskDef, resolveTaskDef } from './taskDef';

class GamsPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private finished = false;

  constructor(private readonly runner: Runner, private readonly def: Partial<GamsTaskDef>, private readonly folder?: vscode.WorkspaceFolder) {}

  open(): void {
    const r = resolveTaskDef(this.def, {
      activeFile: activeGamsFile(),
      workspaceRoot: this.folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
    if ('error' in r) {
      this.line(`*** ${r.error}`);
      this.end(1);
      return;
    }
    void this.runner.run(r.compile, r.parameters, {
      file: r.file,
      onLine: (t) => this.line(t),
      done: (code) => this.end(code),
    });
  }

  handleInput(data: string): void {
    if (data === '\x03') this.runner.interrupt();
  }

  /** The terminal was closed (or the task terminated): stop GAMS gracefully. */
  close(): void {
    if (!this.finished) this.runner.stop();
  }

  private line(t: string): void {
    if (!this.finished) this.writeEmitter.fire(t.replace(/\r?\n/g, '\r\n') + '\r\n');
  }

  private end(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.closeEmitter.fire(code);
  }
}

function activeGamsFile(): string | undefined {
  const d = vscode.window.activeTextEditor?.document;
  return d && d.languageId === 'gams' && d.uri.scheme === 'file' ? d.uri.fsPath : undefined;
}

function makeTask(runner: Runner, def: GamsTaskDef, scope: vscode.WorkspaceFolder | vscode.TaskScope, name: string): vscode.Task {
  const folder = typeof scope === 'object' ? scope : undefined;
  const t = new vscode.Task(def, scope, name, 'GAMS', new vscode.CustomExecution(async () => {
    return new GamsPty(runner, def, folder);
  }));
  t.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: false, panel: vscode.TaskPanelKind.Dedicated, showReuseMessage: false };
  return t;
}

export function registerGamsTasks(runner: Runner): vscode.Disposable {
  return vscode.tasks.registerTaskProvider('gams', {
    provideTasks(): vscode.Task[] {
      const file = activeGamsFile();
      const name = file ? path.basename(file) : '${file}';
      const folder = vscode.workspace.workspaceFolders?.[0];
      const scope = folder ?? vscode.TaskScope.Workspace;
      return [
        makeTask(runner, { type: 'gams' }, scope, `Run ${name}`),
        makeTask(runner, { type: 'gams', compile: true }, scope, `Compile ${name}`),
      ];
    },
    resolveTask(task: vscode.Task): vscode.Task | undefined {
      const def = task.definition as GamsTaskDef;
      if (def.type !== 'gams' || (task.definition as { legacy?: boolean }).legacy) return undefined;
      return makeTask(runner, def, task.scope ?? vscode.TaskScope.Workspace, task.name);
    },
  });
}
