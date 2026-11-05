// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';

export const WS = process.env.GAMS_TEST_WORKSPACE as string;
export const SERVER = process.env.GAMS_TEST_SERVER as string;
export const RUN_GAMS = process.env.GAMS_RUN_TESTS === '1';
export const EXT_ID = 'eunseong-park.vscode-gams';

export const file = (...p: string[]): vscode.Uri => vscode.Uri.file(path.join(WS, ...p));

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` until it returns a truthy value (or throw after `timeout` ms). */
export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false | null> | T | undefined | false | null, timeout = 30000): Promise<T> {
  const end = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ''}`);
}

export async function activate(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  if (!ext) throw new Error('extension not found');
  await ext.activate();
}

export async function open(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  return doc;
}

export async function exec<T>(cmd: string, ...args: unknown[]): Promise<T> {
  return vscode.commands.executeCommand<T>(cmd, ...args);
}

/** Wait until the server answers document symbols for `uri` (server ready + doc analysed). */
export async function waitForServer(uri: vscode.Uri): Promise<void> {
  await open(uri);
  await waitFor('language server', async () => {
    const s = await exec<unknown[]>('vscode.executeDocumentSymbolProvider', uri);
    return s && s.length > 0;
  }, 60000);
}

export function posOf(doc: vscode.TextDocument, needle: string, nth = 0): vscode.Position {
  const text = doc.getText();
  let i = -1;
  for (let k = 0; k <= nth; k++) {
    i = text.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`'${needle}' #${nth} not found`);
  }
  return doc.positionAt(i);
}

/** A second, test-owned client for the custom `gams/*` requests (the extension exports no API). */
export async function startRawClient(): Promise<LanguageClient> {
  const c = new LanguageClient('gams-test', 'gams-test', { command: SERVER, args: [], transport: TransportKind.stdio }, {
    documentSelector: [],
    initializationOptions: { sysdir: process.env.GAMS_TEST_SYSDIR ?? null },
  });
  await c.start();
  return c;
}
