// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * GAMS Connect integration: "GAMS: Run Connect File", "GAMS: Treat as Connect File" and the YAML schema
 * association (JSON Schema generated from the official agent schemas, see scripts/gen-connect-schema.js).
 * Schema validation/completion itself is done by the Red Hat YAML extension (redhat.vscode-yaml), which is
 * recommended but not a hard dependency.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { requireSysdir } from '../sysdirUi';
import { beginBusy } from '../run/busy';
import { buildConnectArgs, ConnectProcess, findGdxOutputs, writtenSince } from './connectRun';
import { addAssociation, globFor, isAssociated, isConnectFileName, migrateKeys, SCHEMA_REL, YamlSchemas } from './yamlAssoc';

const YAML_EXT = 'redhat.vscode-yaml';
const PROMPTED_KEY = 'gams.connect.yamlExtensionPrompted';
const GDX_VIEW_TYPE = 'gams.gdxViewer';

export function registerConnect(context: vscode.ExtensionContext): vscode.Disposable {
  const out = vscode.window.createOutputChannel('GAMS Connect');
  const schemaKey = vscode.Uri.file(context.asAbsolutePath(SCHEMA_REL)).toString();
  let running: ConnectProcess | undefined;

  const yamlSchemas = (target: vscode.ConfigurationTarget): YamlSchemas | undefined => {
    const i = vscode.workspace.getConfiguration('yaml').inspect<YamlSchemas>('schemas');
    return target === vscode.ConfigurationTarget.Workspace ? i?.workspaceValue : i?.globalValue;
  };

  const isConnect = (doc: vscode.TextDocument | undefined): boolean => {
    if (!doc || doc.uri.scheme !== 'file' || !/^(yaml|yml)$/.test(doc.languageId) && !/\.ya?ml$/i.test(doc.fileName)) return false;
    if (isConnectFileName(doc.fileName)) return true;
    const i = vscode.workspace.getConfiguration('yaml').inspect<YamlSchemas>('schemas');
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    return [i?.workspaceValue, i?.globalValue].some((s) => isAssociated(s, doc.fileName, roots));
  };

  const updateContext = (): void => {
    void vscode.commands.executeCommand('setContext', 'gams.connectFile', isConnect(vscode.window.activeTextEditor?.document));
  };

  const hasYamlExtension = (): boolean => !!vscode.extensions.getExtension(YAML_EXT);

  async function promptYamlExtension(always = false): Promise<void> {
    if (hasYamlExtension() || (!always && context.globalState.get<boolean>(PROMPTED_KEY))) return;
    await context.globalState.update(PROMPTED_KEY, true);
    const install = 'Install';
    const pick = await vscode.window.showInformationMessage(
      'GAMS Connect files get validation, completion and hover help from the "YAML" extension by Red Hat (redhat.vscode-yaml).',
      install,
      'Not now',
    );
    if (pick === install) await vscode.commands.executeCommand('workbench.extensions.installExtension', YAML_EXT);
  }

  async function treatAsConnect(uri?: vscode.Uri): Promise<void> {
    const file = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!file || file.scheme !== 'file') {
      void vscode.window.showErrorMessage('Open a saved YAML file first.');
      return;
    }
    if (!hasYamlExtension()) {
      // without the Red Hat extension "yaml.schemas" is not a registered setting: writing it throws
      await promptYamlExtension(true);
      if (!hasYamlExtension()) return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(file)?.uri.fsPath;
    const target = folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const next = addAssociation(yamlSchemas(target), schemaKey, globFor(file.fsPath, folder));
    await vscode.workspace.getConfiguration('yaml').update('schemas', next, target);
    updateContext();
    void vscode.window.showInformationMessage(
      `${path.basename(file.fsPath)} is now validated as a GAMS Connect file (yaml.schemas in ${folder ? 'workspace' : 'user'} settings).`,
    );
  }

  async function runConnect(uri?: vscode.Uri): Promise<void> {
    const doc = uri
      ? await vscode.workspace.openTextDocument(uri)
      : vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file') {
      void vscode.window.showErrorMessage('Open a saved Connect YAML file to run.');
      return;
    }
    if (running?.running) {
      void vscode.window.showWarningMessage('A GAMS Connect run is already in progress.');
      return;
    }
    if (doc.isDirty && !(await doc.save())) return;
    const sysdir = requireSysdir('GAMS Connect');
    if (!sysdir) return;
    const subs = vscode.workspace.getConfiguration('gams').get<string[]>('connect.arguments', []);
    const workDir = path.dirname(doc.fileName);
    const args = buildConnectArgs(doc.fileName, subs);
    const proc = new ConnectProcess(sysdir, args, workDir);
    running = proc;
    const endBusy = beginBusy();
    const started = Date.now();
    out.clear();
    out.show(true);
    out.appendLine(`Running: ${proc.commandLine}`);
    out.appendLine(`Working directory: ${workDir}`);

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GAMS Connect: ${path.basename(doc.fileName)}`, cancellable: true },
      (_p, token) =>
        new Promise<{ code: number | null; sig: string | null; err?: Error }>((resolve) => {
          token.onCancellationRequested(() => proc.stop());
          proc.on('stdout', (s) => out.append(s));
          proc.on('stderr', (s) => out.append(s));
          let done = false;
          const finish = (r: { code: number | null; sig: string | null; err?: Error }): void => {
            if (done) return;
            done = true;
            resolve(r);
          };
          proc.on('error', (e) => finish({ code: null, sig: null, err: e }));
          proc.on('exit', (code, sig) => finish({ code, sig }));
          proc.start();
        }),
    );
    endBusy();
    running = undefined;

    if (result.err) {
      out.appendLine(`*** Could not start gamsconnect: ${result.err.message}`);
      void vscode.window.showErrorMessage(`Could not start gamsconnect: ${result.err.message}`);
      return;
    }
    out.appendLine(result.sig ? `*** Process ended by signal ${result.sig}` : `*** Process ended with exit code ${result.code}`);
    if (result.code !== 0) {
      const show = 'Show Output';
      const msg = result.sig ? `GAMS Connect was stopped (${result.sig}).` : `GAMS Connect failed (exit code ${result.code}).`;
      if ((await vscode.window.showErrorMessage(msg, show)) === show) out.show();
      return;
    }
    const gdx = writtenSince(findGdxOutputs(doc.getText(), workDir, subs), started - 1000);
    if (gdx.length) {
      const open = 'Open in GDX Viewer';
      const pick = await vscode.window.showInformationMessage(
        `GAMS Connect finished. Written: ${gdx.map((g) => path.basename(g)).join(', ')}`,
        open,
      );
      if (pick === open) for (const g of gdx) await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(g), GDX_VIEW_TYPE);
    } else {
      void vscode.window.showInformationMessage('GAMS Connect finished.');
    }
  }

  // the extension install folder changes on update: repoint stale associations
  const migrate = async (): Promise<void> => {
    if (!hasYamlExtension()) return;
    for (const t of [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]) {
      const fixed = migrateKeys(yamlSchemas(t), schemaKey);
      if (fixed) await vscode.workspace.getConfiguration('yaml').update('schemas', fixed, t);
    }
  };
  void migrate().catch(() => undefined);
  updateContext();

  return vscode.Disposable.from(
    out,
    { dispose: () => running?.kill() },
    vscode.commands.registerCommand('gams.runConnect', (u?: vscode.Uri) => runConnect(u instanceof vscode.Uri ? u : undefined)),
    vscode.commands.registerCommand('gams.treatAsConnect', (u?: vscode.Uri) => treatAsConnect(u instanceof vscode.Uri ? u : undefined)),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('yaml.schemas') && updateContext()),
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (isConnectFileName(d.fileName) && d.uri.scheme === 'file') void promptYamlExtension();
    }),
  );
}
