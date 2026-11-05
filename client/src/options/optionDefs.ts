// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { getLanguageClient } from '../lsp';
import { OptionDefinitions, OptionIndex } from './commandLine';

const cache = new Map<string, Promise<OptionIndex | undefined>>();

/** Definitions of `def` (e.g. `optgams.def`) from the language server, cached per def file. */
export function getOptionIndex(def: string): Promise<OptionIndex | undefined> {
  let p = cache.get(def);
  if (!p) {
    const c = getLanguageClient();
    if (!c) return Promise.resolve(undefined);
    p = c
      .sendRequest<OptionDefinitions>('gams/optionDefinitions', { def })
      .then((d) => new OptionIndex(d))
      .catch(() => undefined);
    cache.set(def, p);
    void p.then((v) => {
      if (!v) cache.delete(def);
    });
  }
  return p;
}

/** Forget cached definitions (after the server restarted with another sysdir). */
export function clearOptionCache(): void {
  cache.clear();
}

export function toSeverity(s: 'error' | 'warning'): vscode.DiagnosticSeverity {
  return s === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
}
