// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { jumpTarget, MatchResponse, pickParenColors, VersionedDebounce } from '../../src/edit/parenthesesCore';

const r = (l: number, c: number) => ({ start: { line: l, character: c }, end: { line: l, character: c + 1 } });

describe('parentheses core', () => {
  it('picks Studio Light/Dark colors', () => {
    assert.strictEqual(pickParenColors(undefined, true).validBg, '#b2ffb2');
    assert.strictEqual(pickParenColors(undefined, false).validBg, '#28461e');
    assert.strictEqual(pickParenColors(true, true).invalidBg, '#960000'); // explicit dark Studio theme wins
    assert.strictEqual(pickParenColors(false, false).invalidBg, '#ff7f7f');
  });

  it('jump target is after the partner', () => {
    const open: MatchResponse = { open: r(0, 4), close: r(2, 1), valid: true, origin: 'open' };
    assert.deepStrictEqual(jumpTarget(open), { line: 2, character: 2 });
    assert.deepStrictEqual(jumpTarget({ ...open, origin: 'close' }), { line: 0, character: 5 });
    assert.deepStrictEqual(jumpTarget({ open: r(1, 1), valid: false, origin: 'open' }), { line: 1, character: 2 });
  });

  it('debounces and drops stale versions', async () => {
    const d = new VersionedDebounce(10);
    const calls: boolean[] = [];
    let first: (() => boolean) | undefined;
    d.schedule(() => assert.fail('superseded call ran'));
    d.schedule((cur) => { first = cur; calls.push(cur()); });
    await new Promise((res) => setTimeout(res, 40));
    assert.deepStrictEqual(calls, [true]);
    d.schedule(() => undefined);
    assert.strictEqual(first!(), false);
    d.cancel();
  });
});
