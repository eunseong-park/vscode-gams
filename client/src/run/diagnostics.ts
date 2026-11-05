/*
 * Problems entries for GAMS errors found in the log (Studio: error text marks, PExProjectNode::setErrorText).
 * One collection ("gams") shared by run, compile, debug and profile so each of them clears and fills the same list.
 */
import * as vscode from 'vscode';
import type { ErrorEntry } from './logSession';

export class RunDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('gams');
  private byFile = new Map<string, vscode.Diagnostic[]>();

  clear(): void {
    this.collection.clear();
    this.byFile = new Map();
  }

  dispose(): void {
    this.collection.dispose();
  }

  add(e: ErrorEntry): void {
    if (!e.source) return;
    const line = Math.max(0, e.source.line - 1);
    const col = Math.max(0, e.source.col - 1);
    const range = new vscode.Range(line, col, line, 1000);
    const msg = (e.errNr > 0 ? `${e.errNr}: ` : '') + (e.message || e.logLine);
    const d = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error);
    d.source = 'GAMS';
    d.code = e.errNr > 0 ? e.errNr : undefined;
    if (e.lst) {
      d.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(vscode.Uri.file(e.lst.file), new vscode.Position(Math.max(0, e.lst.line - 1), 0)),
          'Listing file',
        ),
      ];
    }
    const arr = this.byFile.get(e.source.file) ?? [];
    arr.push(d);
    this.byFile.set(e.source.file, arr);
    this.collection.set(vscode.Uri.file(e.source.file), arr);
  }
}

let shared: RunDiagnostics | undefined;

export function sharedDiagnostics(): RunDiagnostics {
  return (shared ??= new RunDiagnostics());
}

export function disposeSharedDiagnostics(): void {
  shared?.dispose();
  shared = undefined;
}
