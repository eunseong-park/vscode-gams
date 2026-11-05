// SPDX-License-Identifier: GPL-3.0-or-later
/** Adds an "Open documentation" command link to keyword hovers (language client middleware). */
import * as vscode from 'vscode';
import type { HoverMiddleware } from 'vscode-languageclient';
import { hasDocTarget } from './contextHelp';
import { isGamsSource } from '../languages';

export const helpHoverMiddleware: HoverMiddleware['provideHover'] = async (document, position, token, next) => {
  const hover = await next(document, position, token);
  if (!hover || !isGamsSource(document)) return hover;
  try {
    if (!(await hasDocTarget(document, position))) return hover;
    const args = encodeURIComponent(JSON.stringify([{ uri: document.uri.toString(), line: position.line, character: position.character }]));
    const link = new vscode.MarkdownString(`[Open documentation](command:gams.contextHelp?${args})`);
    link.isTrusted = { enabledCommands: ['gams.contextHelp'] };
    const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
    return new vscode.Hover([...contents, link], hover.range);
  } catch {
    return hover;
  }
};
