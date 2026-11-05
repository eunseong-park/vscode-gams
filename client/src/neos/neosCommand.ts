// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * VS Code side of the NEOS run: settings, the Studio start dialog (NeosStartDialog) as a confirmation
 * with the NEOS terms of use, and the result notifications. Studio: mainwindow.cpp
 * (showNeosStartDialog / prepareNeosProcess / sslValidation), neosstartdialog.cpp/.ui.
 * Nothing is sent before the user confirmed; the email address is only ever taken from `gams.neos.email`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Runner } from '../run/runner';
import { requireSysdir } from '../sysdirUi';
import { DEFAULT_NEOS_URL } from './neosClient';
import { NeosJob, NeosResult } from './neosJob';
import { NEOS_TERMS_URL, NeosPriority, maySkipConfirmation, userSetting, validateEmail } from './neosParams';

const KEY_TERMS = 'gams.neos.termsAccepted';
/** The server URL for which "don't ask again" was chosen (the older boolean key is ignored: it was not bound to a server). */
const KEY_DONT_ASK = 'gams.neos.dontAskServer';

/** Studio's priority labels (neosstartdialog.ui). */
const PRIORITY_LABEL: Record<NeosPriority, string> = {
  short: 'Short priority (limited to 5 minutes)',
  long: 'Long priority',
};

/** A plain http server is only accepted on the local machine (model and email would travel unencrypted). */
export function checkServerUrl(url: string): string | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return `Invalid "gams.neos.server" URL: ${url}`; }
  if (u.protocol === 'https:') return undefined;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return undefined;
  return `"gams.neos.server" must be an https URL (http is only allowed for localhost): ${url}`;
}

async function confirmSubmission(state: vscode.Memento, info: { file: string; email: string; server: string; priority: NeosPriority; gdx: boolean }): Promise<boolean> {
  for (;;) {
    const accepted = state.get<boolean>(KEY_TERMS, false);
    if (maySkipConfirmation(accepted, state.get<unknown>(KEY_DONT_ASK), info.server)) return true;
    const message = 'You are about to submit your data to the NEOS Server. This service is offered with no expectation or guarantee of confidentiality for the data or the model. '
      + `Please ensure you have read the terms of use at ${NEOS_TERMS_URL}`;
    const detail = [
      `Model: ${info.file}`,
      `Server: ${info.server}`,
      `Email: ${info.email}`,
      PRIORITY_LABEL[info.priority],
      info.gdx ? 'A GDX file is requested.' : '',
    ].filter(Boolean).join('\n');
    const terms = 'Open Terms of Use';
    const buttons = accepted
      ? ['Submit', "Submit, don't ask again", terms]
      : ['I agree to the Terms of Use and submit', terms];
    const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons);
    if (choice === terms) {
      await vscode.env.openExternal(vscode.Uri.parse(NEOS_TERMS_URL));
      continue;
    }
    if (!choice) return false;
    // stored only after the explicit choice
    await state.update(KEY_TERMS, true);
    if (choice.startsWith("Submit, don't")) await state.update(KEY_DONT_ASK, info.server);
    return true;
  }
}

export function registerNeos(context: vscode.ExtensionContext, runner: Runner): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('gams.runNeos', () => runNeos(context, runner)),
    vscode.commands.registerCommand('gams.neosResetConsent', async () => {
      await context.globalState.update(KEY_TERMS, undefined);
      await context.globalState.update(KEY_DONT_ASK, undefined);
      void vscode.window.showInformationMessage('NEOS terms confirmation reset. You will be asked again before the next submission.');
    }),
  );
}

export async function runNeos(context: vscode.ExtensionContext, runner: Runner): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'gams' || editor.document.uri.scheme !== 'file') {
    void vscode.window.showErrorMessage('Open a saved GAMS file (.gms) to run on NEOS.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('gams');
  const email = userSetting<string>(cfg, 'neos.email', '').trim();
  const emailProblem = validateEmail(email);
  if (emailProblem) {
    const pick = await vscode.window.showErrorMessage(`NEOS: ${emailProblem}`, 'Open Settings');
    if (pick) await vscode.commands.executeCommand('workbench.action.openSettings', 'gams.neos.email');
    return;
  }
  const server = userSetting<string>(cfg, 'neos.server', DEFAULT_NEOS_URL).trim() || DEFAULT_NEOS_URL;
  const urlProblem = checkServerUrl(server);
  if (urlProblem) {
    void vscode.window.showErrorMessage(urlProblem);
    return;
  }
  const sysdir = requireSysdir('NEOS');
  if (!sysdir) return;
  const priority: NeosPriority = cfg.get<string>('neos.priority', 'short') === 'long' ? 'long' : 'short';
  const forceGdx = cfg.get<boolean>('neos.forceGdx', true);
  if (editor.document.isDirty && !(await editor.document.save())) return;
  const target = await runner.resolveTarget?.(editor.document.uri.fsPath);
  if (target === null) return;
  const gmsFile = target?.main ?? editor.document.uri.fsPath;
  const workDir = target?.workDir ?? path.dirname(gmsFile);
  const userParams = [...cfg.get<string[]>('defaultParameters', []), ...(target?.params ?? [])];

  if (!(await confirmSubmission(context.globalState, { file: gmsFile, email, server, priority, gdx: forceGdx }))) return;

  const outPath = path.join(workDir, path.basename(gmsFile, path.extname(gmsFile)));
  let job: NeosJob | undefined;
  const ext = runner.beginExternalRun(path.basename(gmsFile), { workDir, lst: path.join(outPath, 'solve.lst'), sysDir: sysdir }, () => job?.stop());
  if (!ext) return;
  if (cfg.get<boolean>('showLogOnRun', true)) await runner.showLog();
  let result: NeosResult | undefined;
  try {
    job = new NeosJob({
      sysdir, gmsFile, workDir, userParams, email, priority, forceGdx,
      serverUrl: server,
      log: (t) => ext.push(t),
      onTlsError: async (msg) =>
        (await vscode.window.showErrorMessage(`NEOS: SSL error: ${msg}`, { modal: true }, 'Ignore')) === 'Ignore',
    });
    result = await job.start();
  } catch (e) {
    ext.push(`\n*** ${(e as Error).message}\n`);
  } finally {
    ext.finish();
  }
  if (!result) return;
  if (result.ok) await offerResults(result);
  else if (!result.cancelled) void vscode.window.showWarningMessage(`NEOS run failed: ${result.message ?? 'see the GAMS log'}`);
}

async function offerResults(result: NeosResult): Promise<void> {
  const lst = path.join(result.outPath, 'solve.lst');
  const gdx = result.files.find((f) => f.toLowerCase().endsWith('.gdx'));
  const buttons: string[] = [];
  if (fs.existsSync(lst)) buttons.push('Open solve.lst');
  if (gdx) buttons.push('Open GDX');
  const pick = await vscode.window.showInformationMessage(`NEOS run finished. Results are in ${result.outPath}`, ...buttons);
  if (pick === 'Open solve.lst') {
    await vscode.window.showTextDocument(vscode.Uri.file(lst), { preview: true });
  } else if (pick === 'Open GDX' && gdx) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(result.outPath, gdx)));
  }
}
