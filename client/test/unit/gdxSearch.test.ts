// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import {
  combineExcludes, dimsText, filterSymbols, globToRegExp, IndexedSymbol, nextSort, parseElementQuery, parseSymbolQuery,
  sortSymbols, splitDir, symbolDescription,
} from '../../src/views/gdxSearch/query';

const s = (name: string, type: string, dim: number, rel: string, mtime: number, text = '', records = 3): IndexedSymbol => ({
  name, type, dim, records, text, domain: [], file: '/w/' + rel, rel, mtime,
});
// SYNTHETIC index shaped like the `gams/gdxIndex` response
const all = [
  s('x', 'Variable', 2, 'a/mini.gdx', 100, 'shipment quantities'),
  s('Demand', 'Parameter', 1, 'a/mini.gdx', 100, 'demand at market'),
  s('i', 'Set', 1, 'b/data.gdx', 300, 'plants'),
  s('d', 'Parameter', 2, 'b/data.gdx', 300, 'distance'),
  s('eq', 'Equation', 0, 'top.gdx', 200),
];
const names = (l: IndexedSymbol[]): string[] => l.map((x) => x.name);

describe('gdx search query', () => {
  it('parses type, dim, file and words', () => {
    const q = parseSymbolQuery('type:par,var dim:1,2 file:b/*.gdx dem');
    assert.deepStrictEqual(q.types, ['Parameter', 'Variable']);
    assert.deepStrictEqual(q.dims, [1, 2]);
    assert.deepStrictEqual(q.words, ['dem']);
    assert.strictEqual(q.fileGlobs.length, 1);
    assert.strictEqual(q.error, undefined);
  });
  it('reports bad type, dim and regex', () => {
    assert.match(parseSymbolQuery('type:foo').error ?? '', /Unknown type/);
    assert.match(parseSymbolQuery('dim:x').error ?? '', /dimension/);
    assert.match(parseSymbolQuery('/(/').error ?? '', /regular expression/);
    assert.strictEqual(parseSymbolQuery('type:').error, undefined); // still typing
  });
  it('filters by name or text, case-insensitively', () => {
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('dem'))), ['Demand']);
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('plants'))), ['i']); // matches the text
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery(''))), names(all));
  });
  it('filters by type and dim', () => {
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('t:parameter'))), ['Demand', 'd']);
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('t:par dim:2'))), ['d']);
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('type:e'))), ['eq']);
  });
  it('filters by file glob (path, base name, substring)', () => {
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('file:b/*.gdx'))), ['i', 'd']);
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('file:top.gdx'))), ['eq']);
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('file:min*'))), ['x', 'Demand']);
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('file:MINI'))), ['x', 'Demand']);
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('file:**/*.gdx'))), names(all));
  });
  it('filters by regex on the name', () => {
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('/^d/'))), ['Demand', 'd']);
    assert.deepStrictEqual(names(filterSymbols(all, parseSymbolQuery('/^d/s'))), ['d']);
  });
  it('sorts by name, file and mtime', () => {
    assert.deepStrictEqual(names(sortSymbols(all, 'name')), ['d', 'Demand', 'eq', 'i', 'x']);
    assert.deepStrictEqual(names(sortSymbols(all, 'file')), ['Demand', 'x', 'd', 'i', 'eq']);
    assert.deepStrictEqual(names(sortSymbols(all, 'mtime')), ['d', 'i', 'eq', 'Demand', 'x']);
    assert.strictEqual(all[0].name, 'x'); // input untouched
    assert.strictEqual(nextSort('mtime'), 'name');
  });
  it('globs', () => {
    assert.ok(globToRegExp('*.gdx').test('a.gdx'));
    assert.ok(!globToRegExp('*.gdx').test('d/a.gdx'));
    assert.ok(globToRegExp('**/a.gdx').test('a.gdx'));
    assert.ok(globToRegExp('**/a.gdx').test('x/y/a.gdx'));
    assert.ok(globToRegExp('d/**').test('d/x/y.gdx'));
    assert.ok(globToRegExp('a?.gdx').test('ab.gdx'));
  });
  it('formats descriptions', () => {
    assert.strictEqual(symbolDescription({ type: 'Parameter', dim: 2, records: 1234 }), 'Parameter · 2D · 1,234 rec');
    assert.strictEqual(dimsText([0]), 'dim 1');
    assert.strictEqual(dimsText([0, 2]), 'dims 1, 3');
    assert.deepStrictEqual(splitDir('a/b/c.gdx'), { dir: 'a/b', base: 'c.gdx' });
    assert.deepStrictEqual(splitDir('c.gdx'), { dir: '', base: 'c.gdx' });
  });
  it('parses element queries', () => {
    assert.deepStrictEqual(parseElementQuery(' seattle '), { label: 'seattle', regex: false, caseSensitive: false, error: undefined });
    assert.deepStrictEqual(parseElementQuery('case:/^s.*/'), { label: '^s.*', regex: true, caseSensitive: true });
    assert.strictEqual(parseElementQuery('').error, 'Enter a label');
    assert.match(parseElementQuery('/(/').error ?? '', /regular expression/);
    assert.strictEqual(parseElementQuery('/').regex, false); // a lone slash is a literal label
  });
  it('combines exclude maps', () => {
    assert.strictEqual(combineExcludes([undefined, {}], []), undefined);
    assert.strictEqual(combineExcludes([{ '**/a': true, '**/b': false }], []), '**/a');
    assert.strictEqual(combineExcludes([{ '**/a': true }, { '**/a': true, '**/c': true }], [' **/d ', '']), '{**/a,**/c,**/d}');
  });
});
