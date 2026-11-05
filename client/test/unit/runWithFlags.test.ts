// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { flagsFromBits, flagsToBits, withRunFlags } from '../../src/options/runFlags';

describe('run flags', () => {
  const all = { gdx: true, ref: true, profile: true };
  it('adds Studio defaults', () => {
    assert.deepStrictEqual(withRunFlags(['lo=3'], all, false), ['GDX=default', 'RF=default', 'Profile=300', 'lo=3']);
  });
  it('does not override user keys', () => {
    assert.deepStrictEqual(withRunFlags(['gdx=a.gdx', 'RF=x', 'profile=1'], all, false), ['gdx=a.gdx', 'RF=x', 'profile=1']);
  });
  it('compile has no profile', () => {
    assert.deepStrictEqual(withRunFlags([], all, true), ['GDX=default', 'RF=default']);
  });
  it('bits', () => {
    assert.strictEqual(flagsToBits(flagsFromBits(5)), 5);
    assert.deepStrictEqual(flagsFromBits(2), { gdx: false, ref: true, profile: false });
  });
});
