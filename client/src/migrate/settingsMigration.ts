// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { createTaskFromRunScript } from '../tasks/tasksJson';
import { describePlans, LEGACY_KEYS, LegacyKey, LegacyValues, MigrationPlan, NewValues, planMigration } from './mapping';

const DONE_KEY = 'gams.settingsMigration.v1';
const NEW_KEYS = ['gams.sysdir', 'gams.defaultParameters', 'gams.studio.path', 'gams.studio.arguments'];

interface ScopeDef {
  target: vscode.ConfigurationTarget;
  pick: <T>(i: { globalValue?: T; workspaceValue?: T } | undefined) => T | undefined;
}
const SCOPES: ScopeDef[] = [
  { target: vscode.ConfigurationTarget.Global, pick: (i) => i?.globalValue },
  { target: vscode.ConfigurationTarget.Workspace, pick: (i) => i?.workspaceValue },
];

/** One-time migration of the 0.1.x `GAMS.*` settings; never deletes the old keys on its own. */
export async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
  const old = vscode.workspace.getConfiguration('GAMS');
  const cfg = vscode.workspace.getConfiguration();
  const plans: MigrationPlan[] = [];
  const legacyPresent = new Set<string>();
  let runScript: { command: string; cwd?: string } | undefined;
  for (const scope of SCOPES) {
    const isGlobal = scope.target === vscode.ConfigurationTarget.Global;
    const store = isGlobal ? context.globalState : context.workspaceState;
    if (store.get<boolean>(DONE_KEY)) continue;
    if (!isGlobal && !vscode.workspace.workspaceFolders?.length) continue;
    const values: LegacyValues = {};
    for (const k of LEGACY_KEYS) {
      const v = scope.pick(old.inspect(k));
      if (v !== undefined) values[k as LegacyKey] = v;
    }
    const current: NewValues = {};
    for (const k of NEW_KEYS) current[k] = scope.pick(cfg.inspect(k));
    const plan = planMigration(values, current);
    for (const k of plan.present) legacyPresent.add(k);
    if (plan.kept.includes('runBatchPath') && typeof values.runBatchPath === 'string') {
      runScript = { command: values.runBatchPath, cwd: typeof values.terminalCwd === 'string' ? values.terminalCwd : undefined };
    }
    try {
      for (const [k, v] of Object.entries(plan.writes)) await cfg.update(k, v, scope.target);
    } catch (e) {
      void vscode.window.showWarningMessage(`GAMS: could not migrate settings: ${(e as Error).message}`);
      continue;
    }
    plans.push(plan);
    await store.update(DONE_KEY, true);
  }
  const text = describePlans(plans);
  if (!text) return;
  const remove = 'Remove old settings';
  const create = 'Create task from run script';
  const buttons = runScript ? [create, remove] : [remove];
  const choice = await vscode.window.showInformationMessage(text, ...buttons);
  if (choice === create && runScript) await createTaskFromRunScript(runScript.command, runScript.cwd);
  else if (choice === remove) await removeLegacySettings([...legacyPresent]);
}

async function removeLegacySettings(keys: string[]): Promise<void> {
  const old = vscode.workspace.getConfiguration('GAMS');
  for (const k of keys) {
    for (const scope of SCOPES) {
      if (scope.pick(old.inspect(k)) === undefined) continue;
      try {
        await old.update(k, undefined, scope.target);
      } catch (e) {
        void vscode.window.showWarningMessage(`GAMS: could not remove GAMS.${k}: ${(e as Error).message}`);
      }
    }
  }
}
