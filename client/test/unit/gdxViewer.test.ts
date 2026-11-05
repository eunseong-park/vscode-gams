// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { formatValue, formatDouble, x2efmt, x2fixed, x2gfmt, SV_EPS, SV_MINF, SV_NA, SV_PINF, SV_UNDEF } from '../../src/views/gdx/format';
import { GdxRecord, keyHeader, makeTextFilter, normalizeValue, sortIndices, specVal2SortVal, typeAsString } from '../../src/views/gdx/model';

describe('gdx number formatting (doubleFormat.c port)', () => {
  it('g-format default (6 sig digits, squeezed)', () => {
    assert.strictEqual(x2gfmt(1.5, 6, true), '1.5');
    assert.strictEqual(x2gfmt(0, 6, true), '0');
    assert.strictEqual(x2gfmt(123456789, 6, true), '1.23457e+08');
    assert.strictEqual(x2gfmt(0.000123456789, 6, true), '0.000123457');
    assert.strictEqual(x2gfmt(0.00001234, 6, true), '1.234e-05');
    assert.strictEqual(x2gfmt(-3.14159265, 6, true), '-3.14159');
    assert.strictEqual(x2gfmt(100, 6, true), '100');
    assert.strictEqual(x2gfmt(1e100, 6, true), '1e+100');
  });
  it('g-format without squeeze pads zeros', () => {
    assert.strictEqual(x2gfmt(1.5, 6, false), '1.50000');
    assert.strictEqual(x2gfmt(2, 4, false), '2.000');
  });
  it('g-format full precision is shortest round trip', () => {
    assert.strictEqual(x2gfmt(0.1, 0, true), '0.1');
    assert.strictEqual(x2gfmt(3100, 0, true), '3100');
    assert.strictEqual(x2gfmt(1 / 3, 0, true), '0.3333333333333333');
  });
  it('f-format', () => {
    assert.strictEqual(x2fixed(1.5, 3, true), '1.5');
    assert.strictEqual(x2fixed(1.5, 3, false), '1.500');
    assert.strictEqual(x2fixed(0.00012, 3, true), '0');
    assert.strictEqual(x2fixed(1234.5678, 2, true), '1234.57');
    assert.strictEqual(x2fixed(1e22, 2, true), '1e+22');
  });
  it('e-format', () => {
    assert.strictEqual(x2efmt(12345.678, 4, true), '1.235e+04');
    assert.strictEqual(x2efmt(1, 4, false), '1.000e+00');
    assert.strictEqual(x2efmt(1, 4, true), '1e+00');
    assert.strictEqual(x2efmt(0, 3, true), '0e+00');
  });
  it('exact binary ties round half-even like dtoa (JS toFixed / toExponential round them up)', () => {
    // expected strings from the compiled Studio doubleFormat.c (with dtoa)
    assert.strictEqual(x2gfmt(1234565, 6, true), '1.23456e+06');
    assert.strictEqual(x2gfmt(1234575, 6, true), '1.23458e+06');
    assert.strictEqual(x2gfmt(52.25, 3, true), '52.2');
    assert.strictEqual(x2gfmt(3265, 3, true), '3.26e+03');
    assert.strictEqual(x2efmt(52.25, 3, true), '5.22e+01');
    assert.strictEqual(x2fixed(2.5, 0, true), '2');
    assert.strictEqual(x2fixed(3.5, 0, true), '4');
    assert.strictEqual(x2fixed(0.5, 0, true), '0');
    assert.strictEqual(x2fixed(1.5, 0, true), '2');
    assert.strictEqual(x2fixed(0.125, 2, true), '0.12');
    assert.strictEqual(x2fixed(0.375, 2, true), '0.38');
    assert.strictEqual(x2fixed(-0.0625, 3, false), '-0.062');
    assert.strictEqual(x2fixed(36.79361343383789, 17, true), '36.79361343383789062');
    assert.strictEqual(x2fixed(1e21, 0, true), '1000000000000000000000');
    // a decimal that merely looks like a tie is not one: 0.15 is below 0.15 in binary
    assert.strictEqual(x2fixed(0.15, 1, true), '0.1');
    assert.strictEqual(x2fixed(0.25, 1, true), '0.2');
    assert.strictEqual(x2fixed(0.35, 1, true), '0.3');
    assert.strictEqual(x2fixed(9.5, 0, true), '10');
    assert.strictEqual(x2gfmt(0.5, 0, true), '0.5');
  });
  it('non-finite yields FORMAT_ERROR', () => {
    assert.strictEqual(formatDouble(Infinity), 'FORMAT_ERROR');
  });
});

describe('gdx special values', () => {
  it('displays UNDF/NA/+INF/-INF/EPS', () => {
    assert.strictEqual(formatValue(SV_UNDEF), 'UNDF');
    assert.strictEqual(formatValue(SV_NA), 'NA');
    assert.strictEqual(formatValue(SV_PINF), '+INF');
    assert.strictEqual(formatValue(SV_MINF), '-INF');
    assert.strictEqual(formatValue(SV_EPS), 'EPS');
    assert.strictEqual(formatValue(2.5), '2.5');
    assert.strictEqual(formatValue('some text'), 'some text');
  });
  it('normalizes textual special values for non-sets', () => {
    assert.strictEqual(normalizeValue('NA', 'Parameter'), SV_NA);
    assert.strictEqual(normalizeValue('NA', 'Set'), 'NA');
  });
  it('sort order of specials', () => {
    assert.ok(specVal2SortVal(SV_MINF) < -1e308);
    assert.ok(specVal2SortVal(SV_EPS) > 0 && specVal2SortVal(SV_EPS) < 1e-300);
    assert.ok(specVal2SortVal(SV_PINF) < specVal2SortVal(SV_NA));
    assert.ok(specVal2SortVal(SV_NA) < specVal2SortVal(SV_UNDEF));
  });
});

describe('gdx sorting and labels', () => {
  const recs: GdxRecord[] = [
    { keys: ['b'], values: [3] },
    { keys: ['A'], values: [SV_EPS] },
    { keys: ['c'], values: [SV_MINF] },
    { keys: ['a'], values: [0] },
  ];
  const all = [0, 1, 2, 3];
  it('sorts keys case-insensitively and stably', () => {
    assert.deepStrictEqual(sortIndices(recs, all, { type: 'key', dim: 0 }, true, 'Parameter'), [1, 3, 0, 2]);
    assert.deepStrictEqual(sortIndices(recs, all, { type: 'key', dim: 0 }, false, 'Parameter'), [2, 0, 1, 3]);
  });
  it('sorts values with special-value order', () => {
    assert.deepStrictEqual(sortIndices(recs, all, { type: 'value', idx: 0 }, true, 'Parameter'), [2, 3, 1, 0]);
  });
  it('sorts set text case-sensitively', () => {
    const s: GdxRecord[] = [{ keys: ['x'], values: ['b'] }, { keys: ['y'], values: ['B'] }];
    assert.deepStrictEqual(sortIndices(s, [0, 1], { type: 'value', idx: 0 }, true, 'Set'), [1, 0]);
  });
  it('type strings', () => {
    assert.strictEqual(typeAsString({ kind: 'Variable', subType: 3 }), 'Variable (Positive)');
    assert.strictEqual(typeAsString({ kind: 'Equation', subType: 1 }), 'Equation (=g=)');
    assert.strictEqual(typeAsString({ kind: 'Set', subType: 1 }), 'Set (Singleton)');
    assert.strictEqual(typeAsString({ kind: 'Parameter' }), 'Parameter');
  });
  it('headers and filters', () => {
    assert.strictEqual(keyHeader(['i', 'j'], 1), 'j²');
    assert.strictEqual(makeTextFilter('')?.('x'), undefined);
    assert.ok(makeTextFilter('^s')!('Seattle'));
    assert.ok(makeTextFilter('(')!('a(b'));
  });
});
