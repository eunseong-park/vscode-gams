import * as path from 'path';
// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import {
  copyField, copyText, csvField, csvLine, listHeader, listRow, rawText, tableHeaderRows,
} from '../../src/views/gdx/csv';
import {
  DIFF_FIELDS, defaultDiffOptions, gdxDiffArgs, normalizeDiffOptions, parseDiffOutput, prepopulateDiff, resolveDiffFile,
  validateDiffInputs,
} from '../../src/views/gdx/diffArgs';
import { blocksFor, defaultPivot, isValidPivot, LruMap, moveDim, transpose } from '../../src/views/gdx/pivot';
import {
  buildQueryParams, DEFAULT_VALUE_FILTER, emptyFilters, filterFromSelection, hasFilters, isDefaultValueFilter,
  labelSelection, matchLabels, parseBound, queryKey,
} from '../../src/views/gdx/query';

describe('gdx query helpers', () => {
  it('builds request members with unified column numbers', () => {
    const f = emptyFilters();
    assert.deepStrictEqual(buildQueryParams(2, undefined, f), {});
    f.labels[1] = { mode: 'include', labels: ['a'] };
    f.values[1] = { ...DEFAULT_VALUE_FILTER, min: 0, exclude: true };
    f.values[0] = { ...DEFAULT_VALUE_FILTER }; // default filter is dropped
    const q = buildQueryParams(2, { column: 3, ascending: false }, f);
    assert.deepStrictEqual(q.sort, { column: 3, ascending: false });
    assert.deepStrictEqual(Object.keys(q.filters ?? {}), ['1']);
    assert.strictEqual(q.valueFilter?.length, 1);
    assert.strictEqual(q.valueFilter?.[0].column, 3); // dim + slot
    assert.ok(hasFilters(f));
    assert.notStrictEqual(queryKey(q), queryKey({}));
    assert.ok(isDefaultValueFilter(DEFAULT_VALUE_FILTER));
    assert.strictEqual(buildQueryParams(1, undefined, f, true).valueFilter, undefined); // sets have no value filter
  });

  it('label selection round trip chooses the smaller set', () => {
    const all = ['a', 'b', 'c', 'd'];
    assert.strictEqual(filterFromSelection(all, new Set(all)), undefined);
    assert.deepStrictEqual(filterFromSelection(all, new Set(['a'])), { mode: 'include', labels: ['a'] });
    assert.deepStrictEqual(filterFromSelection(all, new Set(['a', 'b', 'c'])), { mode: 'exclude', labels: ['d'] });
    assert.deepStrictEqual([...labelSelection(all, { mode: 'exclude', labels: ['d'] })], ['a', 'b', 'c']);
    assert.deepStrictEqual([...labelSelection(all, { mode: 'include', labels: ['b', 'zz'] })], ['b']);
    assert.strictEqual(labelSelection(all, undefined).size, 4);
  });

  it('matchLabels: substring, regex, case, exact', () => {
    const l = ['Seattle', 'san-diego', 'Topeka'];
    assert.deepStrictEqual(matchLabels(l, 'SEA', { regex: false, caseSensitive: false, exact: false }), ['Seattle']);
    assert.deepStrictEqual(matchLabels(l, 'SEA', { regex: false, caseSensitive: true, exact: false }), []);
    assert.deepStrictEqual(matchLabels(l, '^s', { regex: true, caseSensitive: false, exact: false }), ['Seattle', 'san-diego']);
    assert.deepStrictEqual(matchLabels(l, 'topeka', { regex: false, caseSensitive: false, exact: true }), ['Topeka']);
    assert.deepStrictEqual(matchLabels(l, 'a.', { regex: false, caseSensitive: false, exact: false }), []); // '.' literal
    assert.deepStrictEqual(matchLabels(l, '(', { regex: true, caseSensitive: false, exact: false }), []);
    assert.strictEqual(matchLabels(l, '', { regex: false, caseSensitive: false, exact: false }).length, 3);
  });

  it('parseBound', () => {
    assert.strictEqual(parseBound(''), undefined);
    assert.strictEqual(parseBound(' 1,5 '), 1.5);
    assert.strictEqual(parseBound('abc'), null);
  });
});

describe('gdx pivot helpers', () => {
  it('default split and moves', () => {
    const p = defaultPivot(3);
    assert.deepStrictEqual([p.rowDims, p.colDims], [[0, 1], [2]]);
    assert.ok(isValidPivot(p, 3));
    const m = moveDim(p, 0, 'col', 0);
    assert.deepStrictEqual([m.rowDims, m.colDims], [[1], [0, 2]]);
    assert.ok(isValidPivot(m, 3));
    const t = transpose(m);
    assert.deepStrictEqual([t.rowDims, t.colDims], [[0, 2], [1]]);
    assert.deepStrictEqual(moveDim(p, 2, 'row').rowDims, [0, 1, 2]);
    assert.ok(!isValidPivot({ ...p, rowDims: [0, 0] }, 3));
    assert.deepStrictEqual(defaultPivot(0), { rowDims: [], colDims: [], valueField: 0 });
  });
  it('blocks and LRU', () => {
    assert.deepStrictEqual(blocksFor(0, 250, 100, 1000), [0, 1, 2]);
    assert.deepStrictEqual(blocksFor(95, 105, 100, 1000), [0, 1]);
    assert.deepStrictEqual(blocksFor(990, 1100, 100, 1000), [9]);
    assert.deepStrictEqual(blocksFor(5, 5, 100, 1000), []);
    const c = new LruMap<number>(2);
    c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
    assert.ok(c.has('a') && c.has('c') && !c.has('b'));
  });
});

describe('gdx csv / clipboard text', () => {
  it('RFC 4180 quoting for files', () => {
    assert.strictEqual(csvField('a,b'), '"a,b"');
    assert.strictEqual(csvField('say "x"'), '"say ""x"""');
    assert.strictEqual(csvLine(['a', 'b c', '1']), 'a,b c,1\n');
  });
  it('Studio clipboard quoting', () => {
    assert.strictEqual(copyField('a,b', ','), "'a,b'");
    assert.strictEqual(copyField("it's,x", ','), '"it\'s,x"');
    assert.strictEqual(copyField('a,b', '\t'), 'a,b');
    assert.strictEqual(copyText([['a', '1'], ['b,c', '2']], ','), "a,1\n'b,c',2");
  });
  it('special values and numbers', () => {
    assert.strictEqual(rawText(1.25, true), '1.25');
    assert.strictEqual(rawText('UNDF', true), 'UNDEF');
    assert.strictEqual(rawText('+INF', true), 'INF');
    assert.strictEqual(rawText('UNDF', false), 'UNDF');
    assert.strictEqual(rawText(null, true), '');
    assert.strictEqual(rawText('acr_name', true), 'acr_name');
  });
  it('list and table rows', () => {
    const spec = { domain: ['i', 'j'], isSet: false, isParameter: false, valueNames: ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'], valueCols: [0, 1] };
    assert.deepStrictEqual(listHeader(spec), ['i', 'j', 'Level', 'Marginal']);
    assert.deepStrictEqual(listRow(spec, ['a', 'b'], [1, 'EPS', 3, 4, 5]), ['a', 'b', '1', 'EPS']);
    assert.deepStrictEqual(listHeader({ ...spec, isParameter: true }), ['i', 'j', 'Value']);
    assert.deepStrictEqual(listHeader({ ...spec, isSet: true }), ['i', 'j', 'Text']);
    // set element text like gdxdump: empty for an element without text (the protocol shows the placeholder Y), a real Y stays
    const set = { ...spec, isSet: true };
    assert.deepStrictEqual(listRow(set, ['a', 'b'], ['Y'], false), ['a', 'b', '']);
    assert.deepStrictEqual(listRow(set, ['a', 'b'], ['Y'], true), ['a', 'b', 'Y']);
    assert.deepStrictEqual(listRow(set, ['a', 'b'], ['plant'], true), ['a', 'b', 'plant']);
    assert.deepStrictEqual(listRow(set, ['a', 'b'], ['UNDF'], true), ['a', 'b', 'UNDF']); // a text, not the special value
    assert.deepStrictEqual(tableHeaderRows(['i', 'j'], 2, [['x', '1'], ['y', '2']]), [['', '', 'x', 'y'], ['i', 'j', '1', '2']]);
    assert.deepStrictEqual(tableHeaderRows(['i'], 0, [[]]), [['i', 'Value']]);
  });
});

describe('gdx diff arguments (GdxDiffDialog::gdxDiffParamters)', () => {
  it('default options mirror Studio', () => {
    const o = { ...defaultDiffOptions(), input1: '/w/a.gdx', input2: '/w/b.gdx' };
    assert.deepStrictEqual(gdxDiffArgs(o, '/w'), ['/w/a.gdx', '/w/b.gdx', path.join('/w', 'diff.gdx'), 'Field=All']);
  });
  it('all options in Studio order', () => {
    const o = {
      ...defaultDiffOptions(), input1: 'a.gdx', input2: '/x/b.gdx', diffFile: 'out', field: 'L' as const, eps: ' 0.1 ', relEps: '0.01',
      fieldOnly: true, ignoreSetText: true, cmpDefaults: true, cmpDomains: true, ignoreOrder: true,
    };
    assert.deepStrictEqual(gdxDiffArgs(o, '/w'), [
      path.join('/w', 'a.gdx'), '/x/b.gdx', path.join('/w', 'out.gdx'), 'Field=L', 'Eps=0.1', 'RelEps=0.01', 'FldOnly', 'SetDesc=0', 'CmpDefaults', 'CmpDomains', 'IgnoreOrder',
    ]);
    assert.ok(gdxDiffArgs({ ...o, fieldOnly: false, diffOnly: true }, '/w').includes('DiffOnly'));
  });
  it('option interplay', () => {
    const o = { ...defaultDiffOptions(), fieldOnly: true };
    const n = normalizeDiffOptions(o, 'fieldOnly');
    assert.strictEqual(n.field, 'L'); // All is not allowed with Field Only
    assert.strictEqual(normalizeDiffOptions({ ...n, diffOnly: true }, 'diffOnly').fieldOnly, false);
    assert.strictEqual(normalizeDiffOptions({ ...n, field: 'All' }, 'field').fieldOnly, false);
    assert.deepStrictEqual([...DIFF_FIELDS], ['All', 'L', 'M', 'Lo', 'Up', 'Prior', 'Scale']);
  });
  it('diff file handling', () => {
    assert.strictEqual(resolveDiffFile('', '/w'), path.join('/w', 'diff.gdx'));
    assert.strictEqual(resolveDiffFile('d', '/w'), path.join('/w', 'd.gdx'));
    assert.strictEqual(resolveDiffFile('/o/d.gdx', '/w'), '/o/d.gdx');
    assert.strictEqual(prepopulateDiff('/p/a.gdx', '/w'), path.join('/p', 'diff.gdx'));
    assert.strictEqual(prepopulateDiff('', '/w'), path.join('/w', 'diff.gdx'));
    assert.strictEqual(parseDiffOutput('File1 : x\nOutput: diff.gdx\nGDXDiff finished\n', '/w'), path.join('/w', 'diff.gdx'));
    assert.strictEqual(parseDiffOutput('Output: /o/d.gdx\r\n', '/w'), path.normalize('/o/d.gdx'));
    assert.strictEqual(parseDiffOutput('error', '/w'), undefined);
    assert.notStrictEqual(validateDiffInputs({ input1: '', input2: 'b' }), '');
    assert.strictEqual(validateDiffInputs({ input1: 'a', input2: 'b' }), '');
  });
});
