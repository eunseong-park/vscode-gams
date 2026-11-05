// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { getTheme } from '../theme/studioColors';
import { jumpTarget, MatchResponse, ParenColors, pickParenColors, VersionedDebounce } from './parenthesesCore';
import { isGamsSource } from '../languages';

const DELAY_MS = 50;

function enabled(): boolean {
  return vscode.workspace.getConfiguration('gams').get<boolean>('editor.studioParentheses', true);
}

function isLightKind(): boolean {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight;
}

function currentColors(): ParenColors {
  const value = vscode.workspace.getConfiguration('gams').get<string>('studioColors', 'off');
  return pickParenColors(getTheme(value)?.dark, isLightKind());
}

function makeTypes(): { valid: vscode.TextEditorDecorationType; invalid: vscode.TextEditorDecorationType } {
  if (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight) {
    const border = (c: string) => ({ border: '1px solid', borderColor: new vscode.ThemeColor(c) });
    return {
      valid: vscode.window.createTextEditorDecorationType(border('contrastActiveBorder')),
      invalid: vscode.window.createTextEditorDecorationType(border('editorError.foreground')),
    };
  }
  const c = currentColors();
  // the nesting colors (bracketColors.ts) own the foreground of brackets; the match highlight then only sets the
  // background (Studio's red/yellow valid foreground is dropped). The invalid pair keeps its black foreground.
  const nesting = vscode.workspace.getConfiguration('gams').get<boolean>('editor.bracketNestingColors', true);
  return {
    valid: vscode.window.createTextEditorDecorationType(nesting ? { backgroundColor: c.validBg } : { color: c.validFg, backgroundColor: c.validBg }),
    invalid: vscode.window.createTextEditorDecorationType({ color: c.invalidFg, backgroundColor: c.invalidBg }),
  };
}

const toRange = (r: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range =>
  new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);

/** Studio-style parenthesis matching (CodeEdit::matchParentheses) via `gams/matchingParenthesis`. */
export function registerParentheses(getClient: () => LanguageClient | undefined): vscode.Disposable {
  let types = makeTypes();
  const debounce = new VersionedDebounce(DELAY_MS);
  const shown = { valid: [] as vscode.Range[], invalid: [] as vscode.Range[] };

  const request = async (editor: vscode.TextEditor): Promise<MatchResponse | null> => {
    const client = getClient();
    if (!client || !isGamsSource(editor.document)) return null;
    try {
      return await client.sendRequest<MatchResponse | null>('gams/matchingParenthesis', {
        textDocument: { uri: editor.document.uri.toString() },
        position: editor.selection.active,
      });
    } catch {
      return null;
    }
  };

  const apply = (editor: vscode.TextEditor, valid: vscode.Range[], invalid: vscode.Range[]): void => {
    if (editor === vscode.window.activeTextEditor) {
      shown.valid = valid;
      shown.invalid = invalid;
    }
    editor.setDecorations(types.valid, valid);
    editor.setDecorations(types.invalid, invalid);
  };

  const update = (editor: vscode.TextEditor | undefined): void => {
    if (!editor) return;
    if (!enabled() || !isGamsSource(editor.document)) {
      apply(editor, [], []);
      return;
    }
    debounce.schedule((isCurrent) => {
      const version = editor.document.version;
      void request(editor).then((r) => {
        if (!isCurrent() || editor.document.version !== version) return;
        if (!r) return apply(editor, [], []);
        const ranges = [toRange(r.open), ...(r.close ? [toRange(r.close)] : [])];
        apply(editor, r.valid ? ranges : [], r.valid ? [] : ranges);
      });
    });
  };

  const rebuild = (): void => {
    types.valid.dispose();
    types.invalid.dispose();
    types = makeTypes();
    update(vscode.window.activeTextEditor);
  };

  update(vscode.window.activeTextEditor);
  return vscode.Disposable.from(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) update(e.textEditor);
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => update(e)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && e.document === ed.document) update(ed);
    }),
    vscode.window.onDidChangeActiveColorTheme(rebuild),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gams.studioColors') || e.affectsConfiguration('gams.editor.bracketNestingColors')) rebuild();
      else if (e.affectsConfiguration('gams.editor.studioParentheses')) update(vscode.window.activeTextEditor);
    }),
    vscode.commands.registerCommand('gams.jumpToMatchingParenthesis', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !enabled()) return;
      const r = await request(editor);
      if (!r) return;
      const t = jumpTarget(r);
      const p = new vscode.Position(t.line, t.character);
      editor.selection = new vscode.Selection(p, p);
      editor.revealRange(new vscode.Range(p, p));
    }),
    // hidden: used by the integration tests
    ...(process.env.GAMS_EXT_TEST === '1' ? [
    vscode.commands.registerCommand('gams._test.parenthesisDecorations', async () => {
      const ed = vscode.window.activeTextEditor;
      if (ed) await request(ed); // no-op, keeps ordering with pending updates
      const f = (rs: vscode.Range[]) => rs.map((r) => [r.start.line, r.start.character, r.end.line, r.end.character]);
      return { valid: f(shown.valid), invalid: f(shown.invalid) };
    }),
    ] : []),
    { dispose: () => { debounce.cancel(); types.valid.dispose(); types.invalid.dispose(); } },
  );
}
