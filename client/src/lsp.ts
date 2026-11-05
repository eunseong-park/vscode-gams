// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { helpHoverMiddleware } from './help/hover';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { gamsSelector } from './languages';

let client: LanguageClient | undefined;
const refUpdated = new vscode.EventEmitter<vscode.Uri>();
/** Fires (with the main .gms) after the server was told about a new reference file. */
export const onRefUpdated = refUpdated.event;

/** Tell the server that GAMS wrote a new reference file for `gms` (custom notification `gams/refUpdated`). */
export function notifyRefUpdated(gms: vscode.Uri, refPath: string, startedAt?: number): void {
  if (!client) return;
  void client
    .sendNotification('gams/refUpdated', { gmsUri: gms.toString(), refPath, startedAt })
    .then(() => refUpdated.fire(gms), () => undefined);
}

/**
 * Tell the server which main .gms an include file belongs to (`gams/setMainFile`), so definition/hover in the
 * include use the main file's reference file. `main` undefined clears the assignment. Best effort.
 */
export function notifyMainFile(file: vscode.Uri, main: vscode.Uri | undefined): boolean {
  if (!client) return false;
  void client
    .sendNotification('gams/setMainFile', { uri: file.toString(), mainUri: main ? main.toString() : null })
    .then(undefined, () => undefined);
  return true;
}

const clientStarted = new vscode.EventEmitter<void>();
/** Fires when the language client (re)started: state told to the server earlier must be sent again. */
export const onClientStarted = clientStarted.event;

/** Ask the server to close cached GDX handles (`gams/gdxRelease`); `path` omitted releases all. Never throws. */
export async function releaseGdx(gdxPath?: string, timeoutMs = 1000): Promise<void> {
  const c = client;
  if (!c) return;
  try {
    await Promise.race([
      c.sendRequest('gams/gdxRelease', gdxPath ? { path: gdxPath } : {}),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
  } catch {
    // server not running / request failed
  }
}

export function getLanguageClient(): LanguageClient | undefined {
  return client;
}

function exe(name: string): string {
  return process.platform === 'win32' ? name + '.exe' : name;
}

/** serverPath setting -> bundled server/bin/gams-lsp -> dev server/target/debug/gams-lsp */
export function findServerBinary(extensionPath: string, setting: string): string | undefined {
  const candidates = [
    setting.trim(),
    path.join(extensionPath, 'server', 'bin', exe('gams-lsp')),
    path.join(extensionPath, 'server', 'target', 'debug', exe('gams-lsp')),
  ].filter((c) => c.length > 0);
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

export async function startLanguageClient(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  sysdir: string | undefined,
): Promise<void> {
  const setting = vscode.workspace.getConfiguration('gams').get<string>('serverPath', '');
  const bin = findServerBinary(context.extensionPath, setting);
  if (!bin) {
    out.appendLine('[gams] Language server binary not found (gams.serverPath, server/bin, server/target/debug); continuing without LSP.');
    return;
  }
  const serverOptions: ServerOptions = { command: bin, args: [], transport: TransportKind.stdio };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      ...gamsSelector('file'),
      ...gamsSelector('untitled'),
      { scheme: 'file', language: 'gams-lst' },
      { scheme: 'file', language: 'gams-opt' },
      { scheme: 'untitled', language: 'gams-opt' },
    ],
    initializationOptions: { sysdir: sysdir ?? null },
    outputChannelName: 'GAMS Language Server',
    middleware: { provideHover: helpHoverMiddleware },
  };
  client = new LanguageClient('gams', 'GAMS Language Server', serverOptions, clientOptions);
  try {
    await client.start();
    clientStarted.fire();
  } catch (e) {
    out.appendLine(`[gams] Language server failed to start: ${String(e)}`);
    client = undefined;
  }
}

export async function stopLanguageClient(): Promise<void> {
  const c = client;
  client = undefined;
  if (c) await c.stop();
}

export async function restartLanguageClient(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  sysdir: string | undefined,
): Promise<void> {
  await stopLanguageClient();
  await startLanguageClient(context, out, sysdir);
}
