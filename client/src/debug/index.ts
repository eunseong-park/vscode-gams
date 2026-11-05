// SPDX-License-Identifier: GPL-3.0-or-later
/* GAMS debugger and profiler registration (port of GAMS Studio src/gamscom). GPL-3.0-or-later. */
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { ProfileController } from './profileView';
import { registerDebug } from './vscodeDebug';

export function registerDebugFeatures(getClient: () => LanguageClient | undefined, getSysdir: () => string | undefined): vscode.Disposable {
  return vscode.Disposable.from(registerDebug({ getClient, getSysdir }), new ProfileController(getSysdir));
}
