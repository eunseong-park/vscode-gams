// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { parseSectionInput, sectionHeader, toggleBlockComment, toggleLineComment } from './comments';

function commentOptions(): { insertSpace: boolean; ignoreEmptyLines: boolean } {
  const c = vscode.workspace.getConfiguration('editor').get<{ insertSpace?: boolean; ignoreEmptyLines?: boolean }>('comments');
  return { insertSpace: c?.insertSpace ?? true, ignoreEmptyLines: c?.ignoreEmptyLines ?? true };
}

/** Lines covered by a selection; a multi-line selection ending in column 0 excludes its last line. */
function selectionLines(s: vscode.Selection): [number, number] {
  const end = s.end.character === 0 && s.end.line > s.start.line ? s.end.line - 1 : s.end.line;
  return [s.start.line, end];
}

async function toggleLine(force?: 'comment' | 'uncomment'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const lineSet = new Set<number>();
  for (const s of editor.selections) {
    const [a, b] = selectionLines(s);
    for (let i = a; i <= b; i++) lineSet.add(i);
  }
  const nums = [...lineSet].sort((x, y) => x - y);
  const edits = toggleLineComment(nums.map((i) => editor.document.lineAt(i).text), commentOptions(), force);
  await editor.edit((b) => {
    for (const e of edits) {
      const line = nums[e.index];
      if (e.remove) b.delete(new vscode.Range(line, 0, line, e.remove));
      if (e.insert) b.insert(new vscode.Position(line, 0), e.insert);
    }
  }, { undoStopBefore: true, undoStopAfter: true });
}

async function toggleBlock(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = Array.from({ length: editor.document.lineCount }, (_, i) => editor.document.lineAt(i).text);
  const edits = editor.selections.flatMap((s) => {
    const [a, b] = selectionLines(s);
    return toggleBlockComment(doc, a, b);
  });
  await editor.edit((b) => {
    for (const e of edits) {
      const r = new vscode.Range(e.startLine, e.startCol, e.endLine, e.endCol);
      if (e.text) b.insert(r.start, e.text); else b.delete(r);
    }
  }, { undoStopBefore: true, undoStopAfter: true });
}

async function insertSection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const input = await vscode.window.showInputBox({
    prompt: 'Name of the new section',
    placeHolder: 'Name; start with ** or *** for a sub-section level',
  });
  if (input === undefined) return;
  const { level, name } = parseSectionInput(input);
  const header = sectionHeader(name, level);
  const line = editor.selection.active.line;
  const text = editor.document.lineAt(line);
  await editor.edit((b) => {
    if (text.isEmptyOrWhitespace) b.replace(text.range, header);
    else b.insert(text.range.end, `\n\n${header}`);
  }, { undoStopBefore: true, undoStopAfter: true });
}

export function registerEditCommands(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('gams.toggleLineComment', () => toggleLine()),
    vscode.commands.registerCommand('gams.addLineComment', () => toggleLine('comment')),
    vscode.commands.registerCommand('gams.removeLineComment', () => toggleLine('uncomment')),
    vscode.commands.registerCommand('gams.toggleBlockComment', toggleBlock),
    vscode.commands.registerCommand('gams.insertNewSection', insertSection),
  );
}
