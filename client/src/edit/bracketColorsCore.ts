// SPDX-License-Identifier: GPL-3.0-or-later
// Pure (vscode-free) helpers for the bracket nesting colors (`gams/bracketDepths`).

/** VS Code's `editorBracketHighlight.foreground1` .. `foreground6` (they cycle by depth). */
export const COLOR_COUNT = 6;
/** Index of the decoration type for invalid (unmatched or mismatched) brackets. */
export const INVALID_INDEX = COLOR_COUNT;

export const THEME_COLOR_IDS: readonly string[] = [
  ...Array.from({ length: COLOR_COUNT }, (_, i) => `editorBracketHighlight.foreground${i + 1}`),
  'editorBracketHighlight.unexpectedBracket.foreground',
];

export interface PosJson { line: number; character: number }
export interface RangeJson { start: PosJson; end: PosJson }
export interface BracketDepth { range: RangeJson; depth: number; valid: boolean }

/**
 * Decoration type index of a bracket. Like VS Code with `editor.bracketPairColorization.independentColorPoolPerBracketType`
 * off (the default), one color pool for all bracket types: the color only depends on the nesting level.
 */
export function colorIndex(depth: number, valid: boolean): number {
  if (!valid) return INVALID_INDEX;
  return ((Math.trunc(depth) % COLOR_COUNT) + COLOR_COUNT) % COLOR_COUNT;
}

/** Group the ranges of a `gams/bracketDepths` result by decoration type (index 0..6). */
export function groupByType(brackets: readonly BracketDepth[]): RangeJson[][] {
  const out: RangeJson[][] = THEME_COLOR_IDS.map(() => []);
  for (const b of brackets) out[colorIndex(b.depth, b.valid)].push(b.range);
  return out;
}

export interface LineSpan { start: number; end: number }

/**
 * Line spans to request for the visible ranges: every range widened by `margin` lines (clamped to the document)
 * and overlapping/adjacent spans merged, so scrolling by a few lines needs no new data and folded regions give
 * one request per visible block. `end` is the last line, inclusive.
 */
export function batchVisibleLines(visible: readonly LineSpan[], lineCount: number, margin: number): LineSpan[] {
  if (lineCount <= 0) return [];
  const spans = visible
    .map((v) => ({ start: Math.max(0, v.start - margin), end: Math.min(lineCount - 1, v.end + margin) }))
    .filter((v) => v.start <= v.end)
    .sort((a, b) => a.start - b.start);
  const out: LineSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + 1) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Whether `inner` is covered by one of the `outer` spans (a scroll that stays inside the loaded margin). */
export function covered(inner: readonly LineSpan[], outer: readonly LineSpan[]): boolean {
  return inner.every((i) => outer.some((o) => o.start <= i.start && i.end <= o.end));
}
