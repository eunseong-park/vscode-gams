// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, waitFor } from './helpers';

const SEM = 'semanticTokenColorCustomizations';

function semRules(): Record<string, unknown> {
  const v = vscode.workspace.getConfiguration('editor').inspect<{ rules?: Record<string, unknown> }>(SEM)?.globalValue;
  return v?.rules ?? {};
}
const gamsKeys = (r: Record<string, unknown>) => Object.keys(r).filter((k) => k.startsWith('gams'));

suite('Studio colors', () => {
  let saved: unknown;
  suiteSetup(async () => {
    await activate();
    saved = vscode.workspace.getConfiguration('editor').inspect(SEM)?.globalValue;
  });
  suiteTeardown(async () => {
    const g = vscode.workspace.getConfiguration('gams');
    await g.update('studioColors', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('editor').update(SEM, saved, vscode.ConfigurationTarget.Global);
  });

  test("'auto' writes gams rules, 'off' removes them", async () => {
    const g = vscode.workspace.getConfiguration('gams');
    await g.update('studioColors', 'auto', vscode.ConfigurationTarget.Global);
    await waitFor('gams rules', () => gamsKeys(semRules()).length > 0);
    assert.ok(gamsKeys(semRules()).includes('gamsDco') || gamsKeys(semRules()).length > 3);
    await g.update('studioColors', 'off', vscode.ConfigurationTarget.Global);
    await waitFor('rules removed', () => gamsKeys(semRules()).length === 0);
  });
});
