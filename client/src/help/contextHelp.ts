// SPDX-License-Identifier: GPL-3.0-or-later
/** `gams.contextHelp`: F1 context help (port of GAMS Studio `MainWindow::on_actionGamsHelp_triggered`). */
import * as vscode from 'vscode';
import { detectSysdir } from '../sysdir';
import { kindOfTokenType, guessKind, solverOfOptionFile, requestForCursor, wordAt, WordKind } from './context';
import {
  docsDirOf, docsEnv, HelpRequest, HelpTarget, onlineUrl, resolveHelp, versionFromSysdir, keywordIndex, anchorExists, solverOptionNames, STUDIO_SECTION, ResolveEnv,
} from './helpData';
import { HelpPanel } from './helpPanel';

export interface HelpResult {
  target: HelpTarget;
  /** `panel` (offline docs in the webview) or `external` (browser, online docs). */
  shown: 'panel' | 'external';
  url: string;
}

/** Position argument of the command (used by hover links). */
export interface HelpArg {
  uri: string;
  line: number;
  character: number;
}

function sysdir(): string | undefined {
  return detectSysdir(vscode.workspace.getConfiguration('gams').get<string>('sysdir', ''));
}

interface LineTokens { data: Uint32Array | number[]; legend: vscode.SemanticTokensLegend }
const lineCache = new Map<string, LineTokens | undefined>();
const LINE_CACHE_MAX = 64;

/** Semantic tokens of one line (range request, cached per document version). */
async function lineTokens(doc: vscode.TextDocument, line: number): Promise<LineTokens | undefined> {
  const key = `${doc.uri.toString()}@${doc.version}:${line}`;
  if (lineCache.has(key)) return lineCache.get(key);
  const range = new vscode.Range(line, 0, line, doc.lineAt(line).text.length);
  const [tokens, legend] = await Promise.all([
    vscode.commands.executeCommand<vscode.SemanticTokens | undefined>('vscode.provideDocumentRangeSemanticTokens', doc.uri, range),
    vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>('vscode.provideDocumentRangeSemanticTokensLegend', doc.uri, range),
  ]);
  const res = tokens && legend ? { data: tokens.data, legend } : undefined;
  if (lineCache.size >= LINE_CACHE_MAX) lineCache.delete(lineCache.keys().next().value as string);
  lineCache.set(key, res);
  return res;
}

/** Studio syntax kind at `pos` from the server's semantic tokens (range request for the line); `undefined` if none are available. */
export async function kindAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<WordKind | undefined> {
  try {
    const t = await lineTokens(doc, pos.line);
    if (!t) return undefined;
    const d = t.data;
    let line = 0;
    let ch = 0;
    for (let i = 0; i + 4 < d.length; i += 5) {
      line += d[i];
      ch = d[i] === 0 ? ch + d[i + 1] : d[i + 1];
      if (line > pos.line) break;
      if (line === pos.line && ch <= pos.character && pos.character < ch + d[i + 2]) return kindOfTokenType(t.legend.tokenTypes[d[i + 3]]);
    }
    return 'other';
  } catch {
    return undefined;
  }
}

/** Help request for a position in a document. */
export async function requestAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<HelpRequest> {
  const lineText = doc.lineAt(pos.line).text;
  const w = wordAt(lineText, pos.character);
  let kind: WordKind = 'other';
  if (w && doc.languageId === 'gams') kind = (await kindAt(doc, new vscode.Position(pos.line, w.start))) ?? guessKind(lineText, w.start);
  let optionNames: Set<string> | undefined;
  const sd = doc.languageId === 'gams-opt' && !/\.pf$/i.test(doc.fileName) ? sysdir() : undefined;
  if (sd) optionNames = solverOptionNames(sd, solverOfOptionFile(doc.fileName));
  return requestForCursor({ languageId: doc.languageId, fileName: doc.fileName, lineText, character: pos.character, kind, optionNames });
}

function tabRequest(): HelpRequest | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === 'gams.gdxViewer') {
    return { type: 'StudioMain', submodule: STUDIO_SECTION.GDXViewer };
  }
  return undefined;
}

export interface Resolved {
  target: HelpTarget;
  docsDir: string | undefined;
  version: string | undefined;
}

export function resolveForSysdir(req: HelpRequest, sd: string | undefined): Resolved {
  const docsDir = docsDirOf(sd);
  const env: ResolveEnv = sd && docsDir ? docsEnv(sd) : {};
  return { target: resolveHelp(req, env), docsDir, version: sd ? versionFromSysdir(sd) : undefined };
}

/** Open `req` honoring `gams.help.source`; falls back to the online docs when the offline docs are missing. */
export async function openHelp(req: HelpRequest): Promise<HelpResult> {
  const sd = sysdir();
  const { target, docsDir, version } = resolveForSysdir(req, sd);
  const online = onlineUrl(target, version);
  const source = vscode.workspace.getConfiguration('gams').get<string>('help.source', 'offline');
  if (source === 'offline' && docsDir) {
    const p = await HelpPanel.show(docsDir, target, () => online);
    return { target, shown: 'panel', url: p.lastUrl };
  }
  if (source === 'offline') {
    void vscode.window.showInformationMessage('GAMS documentation not found in the system directory; opening the online documentation.');
  }
  await vscode.env.openExternal(vscode.Uri.parse(online));
  return { target, shown: 'external', url: online };
}

/** Whether a documentation target for the keyword at `pos` exists in the offline docs (used for hover links). */
export async function hasDocTarget(doc: vscode.TextDocument, pos: vscode.Position): Promise<boolean> {
  const sd = sysdir();
  const docsDir = docsDirOf(sd);
  if (!docsDir) return false;
  const req = await requestAt(doc, pos);
  if (req.type === 'DollarControl') {
    const t = resolveHelp(req);
    return !!t.fragment && anchorExists(docsDir, t.page, t.fragment);
  }
  if (req.type === 'Index') return keywordIndex(docsDir).has((req.keyword ?? '').toLowerCase());
  return false;
}

export function registerContextHelp(globalState?: vscode.Memento): vscode.Disposable {
  if (globalState) HelpPanel.setZoomStore(globalState);
  return vscode.Disposable.from(
    // test hook: what the docs frame reported (rendered title / heading) and which pages the docs server delivered
    ...(process.env.GAMS_EXT_TEST === '1'
      ? [vscode.commands.registerCommand('gams._test.helpClick', (sel: string) => HelpPanel.testClick(sel)), vscode.commands.registerCommand('gams.internal.helpState', () => ({ loaded: HelpPanel.lastLoaded, served: HelpPanel.servedPages, external: HelpPanel.lastExternal }))]
      : []),
    registerContextHelpCommand(),
  );
}

function registerContextHelpCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('gams.contextHelp', async (arg?: HelpArg): Promise<HelpResult> => {
    let req: HelpRequest = { type: 'Main' };
    if (arg && typeof arg.uri === 'string') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri));
      req = await requestAt(doc, new vscode.Position(arg.line, arg.character));
    } else {
      const ed = vscode.window.activeTextEditor;
      if (ed) req = await requestAt(ed.document, ed.selection.active);
      else req = tabRequest() ?? req;
    }
    return openHelp(req);
  });
}
