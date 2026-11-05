// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { complete, normalize, OptionDefinitions, OptionIndex, tokenize, validate, valueError } from '../../src/options/commandLine';

const defs: OptionDefinitions = {
  file: 'optgams.def',
  groups: [],
  synonyms: [
    { synonym: 'lo', option: 'logoption', deprecated: false },
    { synonym: 'oldlo', option: 'logoption', deprecated: true },
  ],
  options: [
    { nr: 1, name: 'logoption', description: 'log', group: 1, type: 5, typeName: 'enumint', deprecated: false, hidden: false, synonyms: ['lo'], default: '1', lower: null, upper: null,
      enums: [0, 1, 2, 3, 4].map((n) => ({ value: String(n), description: `d${n}`, hidden: false })) },
    { nr: 2, name: 'reslim', description: 'time', group: 1, type: 1, typeName: 'double', deprecated: false, hidden: false, synonyms: [], default: '1000', lower: '0', upper: 'maxdouble', enums: [] },
    { nr: 3, name: 'iterlim', description: 'iters', group: 1, type: 0, typeName: 'integer', deprecated: false, hidden: false, synonyms: [], default: '2000000000', lower: '0', upper: 'maxint', enums: [] },
    { nr: 4, name: 'solver', description: 's', group: 1, type: 2, typeName: 'string', deprecated: false, hidden: false, synonyms: [], default: '', lower: null, upper: null, enums: [{ value: 'CPLEX', description: '', hidden: false }] },
    { nr: 5, name: 'old', description: 'x', group: 1, type: 0, typeName: 'integer', deprecated: true, hidden: false, synonyms: [], default: '0', lower: '0', upper: '5', enums: [] },
    { nr: 6, name: 'secret', description: 'x', group: 1, type: 0, typeName: 'integer', deprecated: false, hidden: true, synonyms: [], default: '0', lower: '0', upper: '5', enums: [] },
    { nr: 7, name: 'solprint', description: 'x', group: 1, type: 3, typeName: 'boolean', deprecated: false, hidden: false, synonyms: [], default: '0', lower: null, upper: null, enums: [] },
    { nr: 8, name: 'mode', description: 'x', group: 1, type: 4, typeName: 'enumstr', deprecated: false, hidden: false, synonyms: [], default: 'a', lower: null, upper: null,
      enums: [{ value: 'a', description: '', hidden: false }, { value: 'B', description: '', hidden: false }, { value: 'h', description: '', hidden: true }] },
  ],
};
const idx = new OptionIndex(defs);

describe('tokenize (Studio OptionTokenizer::tokenize)', () => {
  it('splits key=value, key value and key = value', () => {
    const t = tokenize('lo=3  reslim 10 iterlim = 5');
    assert.deepStrictEqual(t.map((i) => [i.key, i.value]), [['lo', '3'], ['reslim', '10'], ['iterlim', '5']]);
    assert.deepStrictEqual(t.map((i) => [i.keyPosition, i.valuePosition]), [[0, 3], [6, 13], [16, 26]]);
  });
  it('keeps quoted values with blanks together', () => {
    const t = tokenize('--name="a b c" curdir="my dir" x');
    assert.deepStrictEqual(t.map((i) => [i.key, i.value]), [['--name', '"a b c"'], ['curdir', '"my dir"'], ['x', '']]);
  });
  it('keyword only, trailing blank and double equals', () => {
    assert.deepStrictEqual(tokenize('  lo ').map((i) => [i.key, i.value]), [['lo', '']]);
    assert.deepStrictEqual(tokenize('a==b').map((i) => [i.key, i.value]), [['a', '=b']]);
    assert.deepStrictEqual(tokenize(''), []);
    assert.deepStrictEqual(tokenize('=5').map((i) => [i.key, i.value]), [['', '5']]);
  });
  it('normalizes to key=value, leading dash stripped, --vars kept', () => {
    assert.deepStrictEqual(normalize(tokenize('-lo 3 /reslim=5 --my_var=1 //b=2 solprint')), ['lo=3', 'reslim=5', '--my_var=1', '//b=2', 'solprint']);
  });
});

describe('validate (Studio OptionTokenizer::format)', () => {
  const msgs = (s: string) => validate(tokenize(s), idx).map((i) => `${i.severity}:${i.message}`);
  it('accepts valid parameters, synonyms and double-dash variables', () => {
    assert.deepStrictEqual(msgs('lo=3 reslim=10.5 iterlim=1e3 solver=cplex solprint=1 --abc_1=x mode=b'), []);
    assert.deepStrictEqual(msgs('iterlim=maxint reslim=eps'), []);
  });
  it('flags unknown and hidden options', () => {
    assert.deepStrictEqual(msgs('foo=1'), ['error:foo (Unknown option)']);
    assert.deepStrictEqual(msgs('secret=1'), ['error:secret (Unknown option)']);
  });
  it('flags bad values', () => {
    assert.ok(msgs('reslim=abc')[0].includes('Double expected'));
    assert.ok(msgs('iterlim=1.5')[0].includes('Integer expected'));
    assert.ok(msgs('iterlim=-1')[0].includes('not in range [0,maxint]'));
    assert.ok(msgs('lo=9')[0].includes('Possible values are 0 1 2 3 4'));
    assert.ok(msgs('mode=zzz')[0].includes('Possible values are a B '));
    assert.ok(msgs('solprint=2')[0].includes('0 or 1 expected'));
    assert.ok(msgs('lo')[0].includes('missing defined value'));
    assert.ok(msgs('lo="3 x')[0].includes('bad double quoted'));
  });
  it('flags deprecated, recurrent, bad double-dash names and a value without key', () => {
    assert.deepStrictEqual(msgs('old=1'), ['warning:old (Deprecated option, will be ignored)']);
    assert.deepStrictEqual(msgs('oldlo=1'), ['warning:oldlo (Deprecated option, will be ignored)']);
    assert.ok(msgs('old=9')[0].includes('Invalid value for deprecated'));
    assert.strictEqual(msgs('lo=1 logoption=2').filter((m) => m.includes('Recurrent')).length, 2);
    assert.ok(msgs('--1abc=2')[0].includes('Either start with other character'));
    assert.ok(msgs('=5')[0].includes('Option keyword expected'));
  });
  it('reports ranges', () => {
    const [i] = validate(tokenize('reslim=abc'), idx);
    assert.deepStrictEqual([i.start, i.length], [7, 3]);
  });
});

describe('valueError', () => {
  it('integer accepts floats within 0.01 of an integer', () => {
    const o = defs.options[2];
    assert.strictEqual(valueError(o, '3.004'), 'none');
    assert.strictEqual(valueError(o, '3.5'), 'type');
    assert.strictEqual(valueError(o, ''), 'missing');
  });
});

describe('complete', () => {
  const labels = (s: string) => complete(s, idx).map((c) => c.label);
  it('offers names and synonyms by prefix, not hidden ones', () => {
    assert.deepStrictEqual(labels('lo'), ['logoption', 'lo']);
    assert.ok(labels('').includes('reslim'));
    assert.ok(!labels('').includes('secret'));
    assert.deepStrictEqual(labels('lo=1 res'), ['reslim']);
  });
  it('offers enum and boolean values', () => {
    assert.deepStrictEqual(labels('lo='), ['0', '1', '2', '3', '4']);
    assert.deepStrictEqual(labels('logoption 3').length, 1);
    assert.deepStrictEqual(labels('solprint='), ['0', '1']);
    assert.deepStrictEqual(labels('mode='), ['a', 'B']);
    assert.deepStrictEqual(labels('solver=c'), ['CPLEX']);
  });
  it('starts a new key after a complete pair', () => {
    assert.ok(labels('lo=3 ').includes('reslim'));
  });
  it('gives replacement ranges', () => {
    const c = complete('lo=1 res', idx)[0];
    assert.deepStrictEqual([c.start, c.end, c.insert], [5, 8, 'reslim=']);
  });
});
