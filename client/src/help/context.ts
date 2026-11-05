// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which help topic belongs to the cursor. Pure (no vscode imports).
 * Port of `MainWindow::on_actionGamsHelp_triggered` (src/mainwindow.cpp) and `CodeEdit::wordInfo` / `findAlphaNum`.
 */
import * as path from 'path';
import { HelpRequest, STUDIO_SECTION } from './helpData';

/** Syntax kinds Studio distinguishes in F1 (derived from the server's semantic token types). */
export type WordKind = 'title' | 'dco' | 'keyword' | 'other';

const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);

/** `CodeEdit::wordInfo`: word under (or directly before) `character`, with its start column. */
export function wordAt(text: string, character: number): { word: string; start: number } | undefined {
  let i = Math.min(character, text.length);
  if (!isWord(text[i])) {
    if (i === 0 || !isWord(text[i - 1])) return undefined;
    i -= 1;
  }
  let from = i;
  while (from > 0 && isWord(text[from - 1])) from--;
  let to = i;
  while (to < text.length - 1 && isWord(text[to + 1])) to++;
  return { word: text.slice(from, to + 1), start: from };
}

/** Semantic token type (legend name, see `gams-syntax` semantic.rs) -> Studio kind. */
export function kindOfTokenType(type: string | undefined): WordKind {
  switch (type) {
    case 'gamsDco':
      return 'dco';
    case 'gamsTitle':
      return 'title';
    case 'gamsKeyword':
    case 'gamsDeclaration':
      return 'keyword';
    default:
      return 'other';
  }
}

/** The `.gms` branch of the F1 handler: Title/Dco -> $-options, keyword kinds -> keyword index, else full-text search. */
export function requestForKind(word: string, kind: WordKind): HelpRequest {
  if (word === '') return { type: 'Main' };
  if (kind === 'title') return { type: 'DollarControl', keyword: 'title' };
  if (kind === 'dco') return { type: 'DollarControl', keyword: word };
  if (kind === 'keyword') return { type: 'Index', keyword: word };
  return { type: 'Search', keyword: word };
}

/** Solver name from an option file name (`cplex.opt`, `cplex.op2`, `cplex.o12`, `cplex.123` -> `cplex`). */
export function solverOfOptionFile(fileName: string): string {
  return path.basename(fileName).replace(/\.[^.]*$/, '').toLowerCase();
}

/**
 * Option name on an option-file line: `name value`, `name=value`, `name = value`; none on blank,
 * comment (`*`) or dollar-command lines. For parameter files (`.pf`) leading `-`/`--`/`/` are dropped.
 * Multi-word names (`major iterations limit 5`): with `known` (normalized names of the solver's .def file:
 * lower case, `_` as space) the longest matching word sequence is the name; otherwise the first token.
 */
export function optionNameOfLine(line: string, pf: boolean, known?: ReadonlySet<string>): string {
  const t = line.trim();
  if (t === '' || t.startsWith('*') || t.startsWith('$') || t.startsWith('#')) return '';
  if (pf) {
    const m = /^[-/]*([^\s=]+)/.exec(t);
    return m ? m[1] : '';
  }
  const eq = t.indexOf('=');
  const words = (eq >= 0 ? t.slice(0, eq) : t).split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return '';
  if (known && known.size > 0) {
    for (let n = Math.min(words.length, 8); n >= 1; n--) {
      if (known.has(words.slice(0, n).join(' ').toLowerCase().replace(/_/g, ' '))) return words.slice(0, n).join(' ');
    }
  }
  return words[0];
}

export interface CursorContext {
  languageId: string;
  fileName: string;
  lineText: string;
  character: number;
  kind: WordKind;
  /** Normalized option names of the solver (see `optionNameOfLine`), for multi-word option names. */
  optionNames?: ReadonlySet<string>;
}

/** Full F1 decision for a text editor. */
export function requestForCursor(c: CursorContext): HelpRequest {
  if (c.languageId === 'gams-opt') {
    const pf = /\.pf$/i.test(c.fileName);
    const name = optionNameOfLine(c.lineText, pf, c.optionNames);
    if (pf) {
      return name === '' ? { type: 'StudioMain', submodule: STUDIO_SECTION.ParameterFile } : { type: 'GamsCall', keyword: name };
    }
    return name === ''
      ? { type: 'StudioMain', submodule: STUDIO_SECTION.SolverOptionEditor }
      : { type: 'Solvers', keyword: name, submodule: solverOfOptionFile(c.fileName) };
  }
  if (c.languageId === 'gams-lst') return { type: 'StudioMain', submodule: STUDIO_SECTION.ListingViewer };
  const w = wordAt(c.lineText, c.character);
  return requestForKind(w?.word ?? '', c.kind);
}

/**
 * Fallback kind when no semantic tokens are available: a word directly after `$` is a dollar control option,
 * everything else goes to the full-text search (what Studio does for kinds it does not know).
 */
export function guessKind(lineText: string, start: number): WordKind {
  return start > 0 && lineText[start - 1] === '$' ? 'dco' : 'other';
}
