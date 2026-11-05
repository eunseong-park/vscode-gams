// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { fileChildren, GROUPS, KINDS, makeMatcher, RefData, RefSymbol, symbolDescription, symbolsOfGroup } from '../../src/views/symbols/model';

const empty = { declare: [], define: [], assign: [], implicitAssign: [], reference: [], control: [], index: [] };
const sym = (name: string, type: string, extra: Partial<RefSymbol> = {}): RefSymbol => ({
  id: 1, name, type, dim: 0, domain: [], text: '', numElements: 0, unused: false, locations: empty, ...extra,
});
// SYNTHETIC data shaped like the `gams/refSymbols` response
const data: RefData = {
  refPath: '/w/m.ref',
  symbols: [
    sym('i', 'Set', { text: 'plants' }),
    sym('c', 'Parameter', { dim: 2, domain: ['i', 'j'], text: 'cost' }),
    sym('u', 'Variable', { unused: true }),
  ],
  files: [
    { id: 1, parentId: 0, type: 'INPUT', globalLine: '1', localLine: '0', uri: 'file:///w/m.gms' },
    { id: 2, parentId: 1, type: 'INCLUDE', globalLine: '5', localLine: '5', uri: 'file:///w/a.inc' },
  ],
};

describe('symbols view model', () => {
  it('has the Studio tabs incl. Unused and File Used', () => {
    const ids = GROUPS.map((g) => g.id);
    assert.deepStrictEqual(ids.slice(0, 2), ['all', 'set']);
    assert.ok(ids.includes('unused') && ids.includes('fileUsed'));
    assert.deepStrictEqual(KINDS.map((k) => k.label)[3], 'Implicitly Assigned');
  });
  it('groups symbols by type, unused and all', () => {
    const g = (id: string) => symbolsOfGroup(data, GROUPS.find((x) => x.id === id)!).map((s) => s.name);
    assert.deepStrictEqual(g('all'), ['i', 'c', 'u']);
    assert.deepStrictEqual(g('parameter'), ['c']);
    assert.deepStrictEqual(g('unused'), ['u']);
  });
  it('describes domain and text', () => {
    assert.strictEqual(symbolDescription(data.symbols[1], false), '(i,j)  cost');
    assert.strictEqual(symbolDescription(data.symbols[0], true), 'Set  plants');
  });
  it('filters by substring or /regex/', () => {
    assert.strictEqual(makeMatcher(''), undefined);
    assert.ok(makeMatcher('SUP')!('supply'));
    assert.ok(!makeMatcher('x')!('supply'));
    assert.ok(makeMatcher('/^s.p/')!('Supply'));
    assert.ok(makeMatcher('/(/')!('a/(/b')); // invalid regex -> substring
  });
  it('builds the include tree', () => {
    assert.deepStrictEqual(fileChildren(data, 0).map((f) => f.id), [1]);
    assert.deepStrictEqual(fileChildren(data, 1).map((f) => f.id), [2]);
  });
});
