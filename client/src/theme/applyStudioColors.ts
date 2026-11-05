// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { MergeResult, mergeSemantic, mergeTextMate, resolveTheme, SEMANTIC_KEY, TEXTMATE_KEY } from './studioColors';

async function update(key: string, merge: (existing: unknown) => MergeResult<object>): Promise<void> {
  const [section, name] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
  const cfg = vscode.workspace.getConfiguration(section);
  const existing = cfg.inspect<unknown>(name)?.globalValue;
  const res = merge(existing);
  if (!res.changed) return;
  await cfg.update(name, res.value, vscode.ConfigurationTarget.Global);
}

let queue: Promise<void> = Promise.resolve();

/** Apply the `gams.studioColors` setting to the user's editor colour customizations (serialized; no-op when unchanged). */
export function applyStudioColors(): Promise<void> {
  queue = queue.then(async () => {
    try {
      const value = vscode.workspace.getConfiguration('gams').get<string>('studioColors', 'off');
      const kind = vscode.window.activeColorTheme.kind;
      const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
      const theme = resolveTheme(value, light);
      await update(SEMANTIC_KEY, (e) => mergeSemantic(e, theme));
      await update(TEXTMATE_KEY, (e) => mergeTextMate(e, theme));
    } catch (err) {
      void vscode.window.showWarningMessage(`GAMS: could not apply Studio colors: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return queue;
}

export function registerStudioColors(): vscode.Disposable {
  void applyStudioColors();
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gams.studioColors')) void applyStudioColors();
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      if (vscode.workspace.getConfiguration('gams').get<string>('studioColors') === 'auto') void applyStudioColors();
    }),
  );
}
