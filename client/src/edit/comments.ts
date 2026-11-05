// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * GAMS comment editing helpers (pure text transforms, no vscode imports).
 * A GAMS `*` comment must start in column 1, so VS Code's built-in toggle (which inserts at the
 * indentation) produces code instead of a comment.
 */

export interface CommentOptions {
  insertSpace: boolean;
  ignoreEmptyLines: boolean;
}

/** Edit of one line: delete `remove` characters at column 0, then insert `insert` there. */
export interface LineEdit {
  index: number;
  remove: number;
  insert: string;
}

const blank = (s: string): boolean => s.trim() === '';

/** Edits that comment (or, when every non-blank line is a column-1 comment, uncomment; `force` fixes the direction) the given lines. */
export function toggleLineComment(lines: string[], opts: CommentOptions, force?: 'comment' | 'uncomment'): LineEdit[] {
  const nonBlank = lines.filter((l) => !blank(l));
  const uncomment = force ? force === 'uncomment' : nonBlank.length > 0 && nonBlank.every((l) => l.startsWith('*'));
  const edits: LineEdit[] = [];
  lines.forEach((text, index) => {
    if (blank(text) && opts.ignoreEmptyLines) return;
    if (uncomment) {
      if (text.startsWith('*')) edits.push({ index, remove: text.startsWith('* ') ? 2 : 1, insert: '' });
    } else {
      edits.push({ index, remove: 0, insert: opts.insertSpace ? '* ' : '*' });
    }
  });
  return edits;
}

/** Range edit (line/column pairs) for the block comment commands. */
export interface RangeEdit {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  text: string;
}

const ON = /^\$ontext\b/i;
const OFF = /^\$offtext\b/i;

/**
 * Wrap lines [first, last] in `$onText` / `$offText` lines at column 0, or remove such a pair when the
 * lines directly before and after are exactly that.
 */
export function toggleBlockComment(doc: string[], first: number, last: number): RangeEdit[] {
  const isOn = (l: string | undefined): boolean => l !== undefined && l.startsWith('$') && ON.test(l.trim());
  const isOff = (l: string | undefined): boolean => l !== undefined && l.startsWith('$') && OFF.test(l.trim());
  // remove one whole line (with its line break; the preceding break when it is the last line without trailing newline)
  const dropLine = (i: number): RangeEdit => (i + 1 < doc.length
    ? { startLine: i, startCol: 0, endLine: i + 1, endCol: 0, text: '' }
    : { startLine: i - 1, startCol: doc[i - 1].length, endLine: i, endCol: doc[i].length, text: '' });
  // the marker lines are inside the selection: remove them (wrapping again would nest and leave a stray $offText)
  if (last > first && isOn(doc[first]) && isOff(doc[last])) return [dropLine(last), dropLine(first)];
  // the marker lines directly around the selection
  if (first > 0 && isOn(doc[first - 1]) && isOff(doc[last + 1])) return [dropLine(last + 1), dropLine(first - 1)];
  const edits: RangeEdit[] = [];
  if (last + 1 < doc.length) {
    edits.push({ startLine: last + 1, startCol: 0, endLine: last + 1, endCol: 0, text: '$offText\n' });
  } else {
    edits.push({ startLine: last, startCol: doc[last].length, endLine: last, endCol: doc[last].length, text: '\n$offText' });
  }
  edits.push({ startLine: first, startCol: 0, endLine: first, endCol: 0, text: '$onText\n' });
  return edits;
}

/** Total width of a section header line (as in version 0.1.x of this extension). */
export const SECTION_WIDTH = 74;

/** Split the user's input into level (leading `*` count, at least 1) and name. */
export function parseSectionInput(input: string): { level: number; name: string } {
  const m = /^\s*(\*+)\s*(.*)$/.exec(input);
  if (!m) return { level: 1, name: input.trim() };
  return { level: m[1].length, name: m[2].trim() };
}

/** `* <name> ----...` padded to SECTION_WIDTH characters (at least three dashes). */
export function sectionHeader(name: string, level = 1): string {
  const head = `${'*'.repeat(Math.max(1, level))} ${name} `;
  return head + '-'.repeat(Math.max(3, SECTION_WIDTH - head.length));
}
