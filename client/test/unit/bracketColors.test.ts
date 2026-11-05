// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { batchVisibleLines, colorIndex, covered, groupByType, INVALID_INDEX, THEME_COLOR_IDS } from '../../src/edit/bracketColorsCore';

const r = (l: number, c: number) => ({ start: { line: l, character: c }, end: { line: l, character: c + 1 } });

describe('bracket colors core', () => {
  it('uses the six VS Code bracket colors plus the unexpected-bracket color', () => {
    assert.deepStrictEqual(THEME_COLOR_IDS, [
      'editorBracketHighlight.foreground1', 'editorBracketHighlight.foreground2', 'editorBracketHighlight.foreground3',
      'editorBracketHighlight.foreground4', 'editorBracketHighlight.foreground5', 'editorBracketHighlight.foreground6',
      'editorBracketHighlight.unexpectedBracket.foreground',
    ]);
  });

  it('cycles by depth over one pool for all bracket types; invalid brackets get the last type', () => {
    assert.deepStrictEqual([0, 1, 5, 6, 7, 13].map((d) => colorIndex(d, true)), [0, 1, 5, 0, 1, 1]);
    assert.strictEqual(colorIndex(0, false), INVALID_INDEX);
    assert.strictEqual(colorIndex(9, false), INVALID_INDEX);
    assert.strictEqual(colorIndex(-1, true), 5); // never negative
  });

  it('groups the ranges by decoration type', () => {
    const g = groupByType([
      { range: r(0, 3), depth: 0, valid: true },
      { range: r(0, 5), depth: 1, valid: true },
      { range: r(0, 6), depth: 1, valid: true },
      { range: r(0, 7), depth: 0, valid: true },
      { range: r(1, 0), depth: 3, valid: false },
      { range: r(2, 0), depth: 6, valid: true },
    ]);
    assert.strictEqual(g.length, 7);
    assert.deepStrictEqual(g[0], [r(0, 3), r(0, 7), r(2, 0)]);
    assert.deepStrictEqual(g[1], [r(0, 5), r(0, 6)]);
    assert.deepStrictEqual(g[6], [r(1, 0)]);
    assert.deepStrictEqual(g[2], []);
  });

  it('widens visible ranges by the margin and merges overlapping or adjacent spans', () => {
    assert.deepStrictEqual(batchVisibleLines([{ start: 100, end: 140 }], 1000, 20), [{ start: 80, end: 160 }]);
    assert.deepStrictEqual(batchVisibleLines([{ start: 2, end: 10 }], 50, 20), [{ start: 0, end: 30 }]);
    assert.deepStrictEqual(batchVisibleLines([{ start: 40, end: 49 }], 50, 20), [{ start: 20, end: 49 }]);
    // folded regions: ranges that do not touch stay separate requests
    assert.deepStrictEqual(batchVisibleLines([{ start: 0, end: 30 }, { start: 45, end: 50 }], 1000, 10), [{ start: 0, end: 60 }]);
    assert.deepStrictEqual(
      batchVisibleLines([{ start: 300, end: 320 }, { start: 0, end: 30 }, { start: 55, end: 60 }], 1000, 10),
      [{ start: 0, end: 40 }, { start: 45, end: 70 }, { start: 290, end: 330 }],
    );
    assert.deepStrictEqual(batchVisibleLines([{ start: 0, end: 5 }, { start: 8, end: 9 }], 100, 0), [{ start: 0, end: 5 }, { start: 8, end: 9 }]);
    assert.deepStrictEqual(batchVisibleLines([{ start: 0, end: 5 }, { start: 6, end: 9 }], 100, 0), [{ start: 0, end: 9 }]); // adjacent
    assert.deepStrictEqual(batchVisibleLines([], 100, 5), []);
    assert.deepStrictEqual(batchVisibleLines([{ start: 0, end: 3 }], 0, 5), []);
  });

  it('knows when a scroll stays inside the loaded margin', () => {
    const loaded = batchVisibleLines([{ start: 100, end: 140 }], 1000, 60);
    assert.ok(covered([{ start: 120, end: 160 }], loaded));
    assert.ok(!covered([{ start: 190, end: 230 }], loaded));
    assert.ok(!covered([{ start: 120, end: 160 }, { start: 500, end: 510 }], loaded));
  });
});
