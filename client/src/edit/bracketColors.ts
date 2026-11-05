// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { batchVisibleLines, BracketDepth, covered, groupByType, LineSpan, RangeJson, THEME_COLOR_IDS } from './bracketColorsCore';
import { VersionedDebounce } from './parenthesesCore';
import { isGamsSource } from '../languages';

const DELAY_MS = 80;
const MARGIN_LINES = 60;
const RETRY_MS = 500;
const MAX_RETRIES = 40;

function enabled(): boolean {
  return vscode.workspace.getConfiguration('gams').get<boolean>('editor.bracketNestingColors', true);
}

const toRange = (r: RangeJson): vscode.Range => new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
const toJson = (rs: vscode.Range[]): number[][] => rs.map((r) => [r.start.line, r.start.character, r.end.line, r.end.character]);

/**
 * Bracket nesting colors computed from the GAMS Studio highlighter (`gams/bracketDepths`), replacing VS Code's
 * bracket pair colorization for GAMS (switched off for `[gams]` through `configurationDefaults`): brackets in comments,
 * strings, descriptions, end-of-line comments (also with a custom `$eolCom`) and `$onText` blocks are not colored.
 * The colors are VS Code's own `editorBracketHighlight.*` theme colors, cycling by nesting depth.
 */
export function registerBracketColors(getClient: () => LanguageClient | undefined): vscode.Disposable {
  const types = THEME_COLOR_IDS.map((id) => vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor(id) }));
  const debounces = new Map<vscode.TextEditor, VersionedDebounce>();
  // per editor: last decorated state (for the test command and to skip scrolls inside the loaded margin)
  const state = new Map<vscode.TextEditor, { version: number; spans: LineSpan[]; ranges: vscode.Range[][] }>();
  let retries = 0;

  const debounceOf = (editor: vscode.TextEditor): VersionedDebounce => {
    let d = debounces.get(editor);
    if (!d) debounces.set(editor, (d = new VersionedDebounce(DELAY_MS)));
    return d;
  };

  const clear = (editor: vscode.TextEditor): void => {
    debounces.get(editor)?.cancel();
    state.delete(editor);
    for (const t of types) editor.setDecorations(t, []);
  };

  const request = async (editor: vscode.TextEditor, spans: LineSpan[]): Promise<BracketDepth[] | undefined> => {
    const client = getClient();
    if (!client) return undefined;
    const doc = editor.document;
    try {
      const parts = await Promise.all(
        spans.map((s) =>
          client.sendRequest<BracketDepth[]>('gams/bracketDepths', {
            textDocument: { uri: doc.uri.toString() },
            range: { start: { line: s.start, character: 0 }, end: { line: s.end + 1, character: 0 } },
          }),
        ),
      );
      return parts.flat();
    } catch {
      return undefined;
    }
  };

  const update = (editor: vscode.TextEditor | undefined, force = false): void => {
    if (!editor || !isGamsSource(editor.document)) return;
    if (!enabled()) {
      clear(editor);
      return;
    }
    debounceOf(editor).schedule((isCurrent) => {
      const doc = editor.document;
      const version = doc.version;
      const visible = editor.visibleRanges.map((r) => ({ start: r.start.line, end: r.end.line }));
      const spans = batchVisibleLines(visible, doc.lineCount, MARGIN_LINES);
      const prev = state.get(editor);
      // a scroll inside the already decorated margin needs nothing new
      if (!force && prev && prev.version === version && covered(batchVisibleLines(visible, doc.lineCount, 0), prev.spans)) return;
      void request(editor, spans).then((res) => {
        if (!isCurrent() || doc.version !== version || editor.document !== doc) return;
        if (!res) {
          if (retries++ < MAX_RETRIES) setTimeout(() => update(editor, true), RETRY_MS);
          return;
        }
        retries = 0;
        const groups = groupByType(res).map((g) => g.map(toRange));
        types.forEach((t, i) => editor.setDecorations(t, groups[i]));
        state.set(editor, { version, spans, ranges: groups });
      });
    });
  };

  const updateVisible = (force = false): void => vscode.window.visibleTextEditors.forEach((e) => update(e, force));
  updateVisible();
  return vscode.Disposable.from(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => update(e.textEditor)),
    vscode.window.onDidChangeVisibleTextEditors(() => updateVisible()),
    vscode.window.onDidChangeActiveTextEditor((e) => update(e)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      for (const ed of vscode.window.visibleTextEditors) if (ed.document === e.document) update(ed, true);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      for (const ed of [...debounces.keys()]) {
        if (ed.document !== d) continue;
        debounces.get(ed)?.cancel();
        debounces.delete(ed);
        state.delete(ed);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gams.editor.bracketNestingColors')) updateVisible(true);
    }),
    // hidden: used by the integration tests; ranges as [startLine, startChar, endLine, endChar] per decoration type
    ...(process.env.GAMS_EXT_TEST === '1' ? [
    vscode.commands.registerCommand('gams._test.bracketDecorations', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return undefined;
      update(ed, true);
      await new Promise((r) => setTimeout(r, DELAY_MS * 3));
      const s = state.get(ed);
      if (!s || s.version !== ed.document.version) return undefined;
      return { version: s.version, types: s.ranges.map(toJson) };
    }),
    ] : []),
    { dispose: () => { debounces.forEach((d) => d.cancel()); types.forEach((t) => t.dispose()); } },
  );
}
