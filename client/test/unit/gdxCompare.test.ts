// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import {
  CompareRecord, CompareRecordsResult, DEFAULT_COMPARE_OPTIONS, optionsChanged, optionParams, CompareSymbol, detectGdxDiff, excelColor, cssColor, fieldsFromFlags, filterSymbols,
  keyFlag, parseTolerance, defaultSymbolFilter, mergeSymbols, pendingNames, isCancelled, isTimeout, SYMBOL_STATUS_LABEL, statusCounts, symbolSummary, toggleAttribute, valueColumns, valueFlag, SymbolStatus,
} from '../../src/views/gdxCompare/model';
import { exportColumns, exportRow, keyNames, sheetNames, summaryRow, DEFAULT_EXPORT_OPTIONS, EXCEL_MAX_ROWS } from '../../src/views/gdxCompare/exportModel';
import { csvCell, csvFileName, csvHeader, csvRecordLine, csvSummary, exportCompareCsv, SymbolRequest } from '../../src/views/gdxCompare/exportCsv';
import { exportCompareXlsx } from '../../src/views/gdxCompare/exportXlsx';

const sym = (o: Partial<CompareSymbol> & { name: string }): CompareSymbol => ({
  kind: 'Parameter', dim: 2, domain: ['i', 'j'], text: '', status: 'different', rows: 4, differences: 3, changed: 1, added: 1, removed: 1, equal: 1, ...o,
});

const rec = (o: Partial<CompareRecord>): CompareRecord => ({ keys: ['a', 'b'], status: 'equal', a: [1], b: [1], abs: [0], rel: [0], diff: [false], ...o });

describe('compare status colors', () => {
  it('flags added / removed rows as a whole and only the changed slots of changed rows', () => {
    assert.strictEqual(valueFlag(rec({ status: 'equal' }), 0), undefined);
    assert.strictEqual(valueFlag(rec({ status: 'added' }), 0), 'added');
    assert.strictEqual(valueFlag(rec({ status: 'removed' }), 3), 'removed');
    const ch = rec({ status: 'changed', diff: [false, true] });
    assert.strictEqual(valueFlag(ch, 0), undefined);
    assert.strictEqual(valueFlag(ch, 1), 'changed');
    assert.strictEqual(keyFlag(ch), undefined);
    assert.strictEqual(keyFlag(rec({ status: 'added' })), 'added');
  });

  it('derives the Excel fills from the webview colors (blended onto white)', () => {
    assert.match(cssColor('added'), /^rgba\(46,160,67,0\.28\)$/);
    for (const k of ['added', 'removed', 'changed'] as const) assert.match(excelColor(k), /^[0-9A-F]{6}$/);
    // 28% of 46 over white: 255 * 0.72 + 46 * 0.28 = 196.48 -> C4
    assert.strictEqual(excelColor('added').slice(0, 2), 'C4');
  });
});

describe('compare symbol list', () => {
  const syms = [
    sym({ name: 'd', status: 'different' }), sym({ name: 'same', status: 'equal' }), sym({ name: 'onlya', status: 'onlyA' }),
    sym({ name: 'onlyb', status: 'onlyB' }),
  ];
  it('filters by status and name (regex, falling back to substring)', () => {
    const f = defaultSymbolFilter();
    assert.strictEqual(filterSymbols(syms, f).length, 4);
    f.statuses = new Set<SymbolStatus>(['different', 'onlyA']);
    assert.deepStrictEqual(filterSymbols(syms, f).map((s) => s.name), ['d', 'onlya']);
    f.statuses = new Set(['different', 'onlyA', 'onlyB', 'equal']);
    f.text = '^only';
    assert.deepStrictEqual(filterSymbols(syms, f).map((s) => s.name), ['onlya', 'onlyb']);
    f.text = '(';
    assert.deepStrictEqual(filterSymbols(syms, f).length, 0); // invalid regex -> substring "("
    assert.deepStrictEqual(statusCounts(syms), { onlyA: 1, onlyB: 1, equal: 1, different: 1, unknown: 0, pending: 0 });
  });

  it('summarises a symbol and selects attributes / tolerance input', () => {
    assert.strictEqual(symbolSummary(sym({ name: 'x', changed: 2, added: 1, removed: 0 })), '2 changed, 1 added');
    assert.strictEqual(symbolSummary(sym({ name: 'x', changed: 0, added: 0, removed: 0, status: 'equal' })), 'no differences');
    assert.strictEqual(symbolSummary(sym({ name: 'x', status: 'onlyA', removed: 5 })), 'only in A (5 records)');
    assert.match(symbolSummary(sym({ name: 'x', mismatch: 'Parameter in A, Set in B' })), /mismatch: Parameter in A/);
    assert.strictEqual(symbolSummary(sym({ name: 'x', note: '[limit] too big', status: 'unknown' })), 'too big');
    assert.deepStrictEqual(toggleAttribute([true, false, false, false, false], 0), [true, false, false, false, false]); // last one stays
    assert.deepStrictEqual(toggleAttribute([true, false, false, false, false], 1), [true, true, false, false, false]);
    assert.deepStrictEqual(fieldsFromFlags([false, true, false, true, false]), [1, 3]);
    assert.deepStrictEqual(fieldsFromFlags([false, false, false, false, false]), [0, 1, 2, 3, 4]);
    assert.strictEqual(parseTolerance(''), 0);
    assert.strictEqual(parseTolerance('1,5e-3'), 0.0015);
    assert.strictEqual(parseTolerance('-1'), null);
    assert.strictEqual(parseTolerance('x'), null);
    assert.deepStrictEqual(valueColumns({ kind: 'Variable', slots: 5 }, [true, false, false, true, false]).map((c) => c.label), ['Level', 'Upper']);
    assert.deepStrictEqual(valueColumns({ kind: 'Set', slots: 1 }, [true]).map((c) => c.label), ['Text']);
  });
});

describe('gdxdiff output detection', () => {
  // symbol list of client/test/fixtures/gdxdiff/diff.gdx as returned by gams/gdxSymbols (real gdxdiff 54.6 output)
  const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../client/test/fixtures/gdxdiff/diff.symbols.json'), 'utf8'));
  it('recognises the real gdxdiff result', () => {
    const d = detectGdxDiff(fixture.symbols);
    assert.strictEqual(d.isDiffFile, true);
    assert.deepStrictEqual(d.diffSymbols, ['d', 'i', 'x']);
  });
  it('rejects ordinary GDX files and accepts the output of a comparison without differences', () => {
    assert.strictEqual(detectGdxDiff([{ name: 'i', kind: 'Set', dim: 1, records: 3, text: '' }]).isDiffFile, false);
    assert.strictEqual(detectGdxDiff([{ name: 'FilesCompared', kind: 'Set', dim: 1, records: 2, text: '' }]).isDiffFile, true);
    // a user symbol called FilesCompared next to ordinary data is not a gdxdiff file
    assert.strictEqual(detectGdxDiff([
      { name: 'FilesCompared', kind: 'Set', dim: 1, records: 2, text: '' }, { name: 'p', kind: 'Parameter', dim: 1, records: 4, text: 'data' },
    ]).isDiffFile, false);
    assert.strictEqual(detectGdxDiff([
      { name: 'FilesCompared', kind: 'Set', dim: 1, records: 5, text: '' }, { name: 'p', kind: 'Parameter', dim: 2, records: 4, text: 'Differences' },
    ]).isDiffFile, false);
  });
});

describe('compare export rows', () => {
  const p = sym({ name: 'd' });
  it('names key columns uniquely', () => {
    assert.deepStrictEqual(keyNames(['i', 'j'], 2), ['i', 'j']);
    assert.deepStrictEqual(keyNames(['*', '*'], 2), ['uni_1', 'uni_2']);
    assert.deepStrictEqual(keyNames(['i', 'i'], 2), ['i_1', 'i_2']);
    assert.deepStrictEqual(keyNames([], 1), ['uni_1']);
  });

  it('builds parameter columns and rows with status, keys, A, B, abs and rel difference', () => {
    const cols = exportColumns(p, DEFAULT_EXPORT_OPTIONS);
    assert.deepStrictEqual(cols.map((c) => c.header), ['Status', 'i', 'j', 'A', 'B', 'AbsDiff', 'RelDiff']);
    const line = csvRecordLine(cols, rec({ keys: ['s', 'n'], status: 'changed', a: [1.5], b: [2], abs: [0.5], rel: [0.3333333333333333], diff: [true] }));
    assert.strictEqual(line, 'changed,s,n,1.5,2,0.5,0.3333333333333333\n');
    assert.strictEqual(csvHeader(cols), 'Status,i,j,A,B,AbsDiff,RelDiff\n');
  });

  it('writes specials as text, missing sides empty and guards formula labels', () => {
    const cols = exportColumns(p, DEFAULT_EXPORT_OPTIONS);
    assert.strictEqual(
      csvRecordLine(cols, rec({ keys: ['=SUM(A1)', '-x'], status: 'changed', a: ['NA'], b: [3], abs: [null], rel: [null], diff: [true] })),
      "changed,'=SUM(A1),'-x,NA,3,,\n",
    );
    assert.strictEqual(csvRecordLine(cols, rec({ keys: ['n', 'm'], status: 'added', a: null, b: ['-INF'], abs: null, rel: null, diff: [false] })), 'added,n,m,,-INF,,\n');
    assert.strictEqual(csvCell({ value: '+INF', text: false }), 'INF');
    assert.strictEqual(csvCell({ value: 'UNDF', text: false }), 'UNDEF');
    assert.strictEqual(csvCell({ value: -5, text: false }), '-5'); // negative numbers are never prefixed
  });

  it('exports the selected attributes of variables and optional difference columns', () => {
    const v = sym({ name: 'x', kind: 'Variable', dim: 1, domain: ['i'], slots: 5 });
    const cols = exportColumns(v, { ...DEFAULT_EXPORT_OPTIONS, attrs: [true, true, false, false, false], diffColumns: false });
    assert.deepStrictEqual(cols.map((c) => c.header), ['Status', 'i', 'A Level', 'B Level', 'A Marginal', 'B Marginal']);
    const row = exportRow(cols, rec({ keys: ['a'], status: 'changed', a: [1, 2, 0, 0, 1], b: [1, 3, 0, 0, 1], diff: [false, true, false, false, false] }));
    assert.deepStrictEqual(row.map((c) => c.value), ['changed', 'a', 1, 1, 2, 3]);
    assert.deepStrictEqual(row.map((c) => c.flag), ['changed', undefined, undefined, undefined, 'changed', 'changed']);
    const s = sym({ name: 's', kind: 'Set', dim: 1, domain: ['i'] });
    const scols = exportColumns(s, DEFAULT_EXPORT_OPTIONS);
    assert.deepStrictEqual(scols.map((c) => c.header), ['Status', 'i', 'A', 'B']);
    assert.strictEqual(csvRecordLine(scols, rec({ keys: ['a'], status: 'changed', a: ['x'], b: ['y'], diff: [true] })), 'changed,a,x,y\n');
  });

  it('writes sets element texts; an element without text is empty, a real text Y stays', () => {
    const s = sym({ name: 's', kind: 'Set', dim: 1, domain: ['i'] });
    const scols = exportColumns(s, DEFAULT_EXPORT_OPTIONS);
    assert.strictEqual(csvRecordLine(scols, rec({ keys: ['a'], status: 'changed', a: ['Y'], b: ['Y'], aNoText: true, bNoText: false, diff: [true] })), 'changed,a,,Y\n');
    assert.strictEqual(csvRecordLine(scols, rec({ keys: ['a'], status: 'removed', a: ['Y'], b: null, aNoText: true, bNoText: false, diff: [false] })), 'removed,a,,\n');
  });

  it('sends the gdxdiff options CmpDefaults / CmpDomains and flags non-default options', () => {
    assert.deepStrictEqual(optionParams(DEFAULT_COMPARE_OPTIONS), { eps: 0, relEps: 0, ignoreSetText: false, fields: [0, 1, 2, 3, 4], cmpDefaults: false, cmpDomains: false });
    assert.strictEqual(optionParams({ ...DEFAULT_COMPARE_OPTIONS, cmpDefaults: true }).cmpDefaults, true);
    assert.strictEqual(optionsChanged(DEFAULT_COMPARE_OPTIONS), false);
    assert.strictEqual(optionsChanged({ ...DEFAULT_COMPARE_OPTIONS, cmpDomains: true }), true);
    assert.strictEqual(optionsChanged({ ...DEFAULT_COMPARE_OPTIONS, cmpDefaults: true }), true);
    assert.strictEqual(optionsChanged({ ...DEFAULT_COMPARE_OPTIONS, fields: [0] }), true);
  });

  it('writes summary.csv rows', () => {
    const t = csvSummary([sym({ name: 'd' }), sym({ name: 'q', status: 'onlyA', changed: 0, added: 0, removed: 3, equal: 0 })], (s) => `${s.name}.csv`);
    const lines = t.trim().split('\n');
    assert.strictEqual(lines[0], 'Symbol,Type,Dimension,Status,Changed,Added,Removed,Equal,Records A,Records B,Sheet / File,Note');
    assert.strictEqual(lines[1], 'd,Parameter,2,different,1,1,1,1,,,d.csv,');
    assert.strictEqual(lines[2], 'q,Parameter,2,only in A,0,0,3,0,,,q.csv,');
    assert.strictEqual(csvFileName('a/b c'), 'a_b_c.csv');
  });

  it('makes Excel sheet names unique and limited to 31 characters (Studio generateSheetName)', () => {
    const long = 'a'.repeat(40);
    assert.deepStrictEqual(sheetNames([long, long + 'b', 'Summary', 'x'], ['Summary']), ['a'.repeat(31), 'a'.repeat(29) + '~1', 'Summary~1', 'x']);
    assert.deepStrictEqual(sheetNames(['A', 'a']), ['A', 'a~1']);
    assert.strictEqual(sheetNames(['a:b']).join(), 'a_b');
  });
});

// ---- end to end with a fake server ----

function fakeServer(data: Record<string, CompareRecord[]>) {
  const calls: Array<Record<string, unknown>> = [];
  const request = async <T,>(method: string, params: unknown): Promise<T> => {
    const p = params as { name: string; offset: number; limit: number; onlyDiff?: boolean };
    calls.push(p as unknown as Record<string, unknown>);
    assert.strictEqual(method, 'gams/gdxCompareRecords');
    const all = data[p.name].filter((r) => !p.onlyDiff || r.status !== 'equal');
    const out: CompareRecordsResult = {
      total: all.length, rows: data[p.name].length, differences: data[p.name].filter((r) => r.status !== 'equal').length,
      offset: p.offset, records: all.slice(p.offset, p.offset + p.limit),
    };
    return out as T;
  };
  return { request, calls };
}

describe('compare export files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gams-cmp-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = sym({ name: 'd' });
  const x = sym({ name: 'x', kind: 'Variable', dim: 1, domain: ['i'], slots: 5, rows: 2, differences: 1, changed: 1, added: 0, removed: 0, equal: 1 });
  const same = sym({ name: 'same', status: 'equal', rows: 1, differences: 0, changed: 0, added: 0, removed: 0, equal: 1 });
  const all = [d, x, same];
  const data = {
    d: [
      rec({ keys: ['s', 'n'], status: 'equal', a: [2.5], b: [2.5], abs: [0], rel: [0] }),
      rec({ keys: ['s', 'c'], status: 'changed', a: [1.7], b: [1.8], abs: [0.1], rel: [0.0588], diff: [true] }),
      rec({ keys: ['b', 'n'], status: 'added', a: null, b: [9], abs: null, rel: null, diff: [false] }),
      rec({ keys: ['t', 'n'], status: 'removed', a: ['EPS'], b: null, abs: null, rel: null, diff: [false] }),
    ],
    x: [
      rec({ keys: ['a'], status: 'changed', a: [1, 2, 0, '+INF', 1], b: [1, 3, 0, '+INF', 1], diff: [false, true, false, false, false] }),
      rec({ keys: ['b'], status: 'equal', a: [1, 0, 0, '+INF', 1], b: [1, 0, 0, '+INF', 1], diff: [false, false, false, false, false] }),
    ],
    same: [rec({ keys: ['k'], status: 'equal', a: [1], b: [1] })],
  } as Record<string, CompareRecord[]>;
  const reqOf = (onlyDiff: boolean, attrs = [true, true, false, false, false]): SymbolRequest => ({
    base: { pathA: 'a', pathB: 'b' }, method: 'gams/gdxCompareRecords', options: { ...DEFAULT_COMPARE_OPTIONS },
    export: { ...DEFAULT_EXPORT_OPTIONS, onlyDiff, attrs },
  });

  it('exports one symbol to a CSV file and several to a folder with summary.csv', async () => {
    const srv = fakeServer(data);
    const one = path.join(dir, 'd.csv');
    await exportCompareCsv(one, [d], all, reqOf(false), srv.request);
    assert.strictEqual(
      fs.readFileSync(one, 'utf8'),
      'Status,i,j,A,B,AbsDiff,RelDiff\nequal,s,n,2.5,2.5,0,0\nchanged,s,c,1.7,1.8,0.1,0.0588\nadded,b,n,,9,,\nremoved,t,n,EPS,,,\n',
    );
    const folder = path.join(dir, 'out');
    const files = await exportCompareCsv(folder, [d, x], all, reqOf(true), srv.request);
    assert.deepStrictEqual(files.map((f) => path.basename(f)), ['d.csv', 'x.csv', 'summary.csv']);
    assert.strictEqual(fs.readFileSync(path.join(folder, 'd.csv'), 'utf8').trim().split('\n').length, 4); // header + 3 differences
    assert.strictEqual(fs.readFileSync(path.join(folder, 'summary.csv'), 'utf8').trim().split('\n').length, 4); // all three symbols
    assert.ok(srv.calls.every((c) => typeof c.limit === 'number'));
  });

  it('does not let summary.csv overwrite a symbol named summary', async () => {
    const sm = sym({ name: 'summary', status: 'different', rows: 1, differences: 1, changed: 1, added: 0, removed: 0, equal: 0 });
    const srv = fakeServer({ ...data, summary: [rec({ keys: ['k'], status: 'changed', a: [1], b: [2], abs: [1], rel: [1], diff: [true] })] });
    const folder = path.join(dir, 'out2');
    const files = await exportCompareCsv(folder, [sm, d], [sm, d], reqOf(false), srv.request);
    assert.deepStrictEqual(files.map((f) => path.basename(f)), ['summary_1.csv', 'd.csv', 'summary.csv']);
    assert.ok(fs.readFileSync(path.join(folder, 'summary.csv'), 'utf8').startsWith('Symbol'));
    assert.ok(fs.readFileSync(path.join(folder, 'summary_1.csv'), 'utf8').includes('changed,k'));
    assert.ok(fs.readFileSync(path.join(folder, 'summary.csv'), 'utf8').includes('summary_1.csv'));
  });

  it('compare xlsx: a failing data source leaves no partial file', async () => {
    const file = path.join(dir, 'failing.xlsx');
    const request = (async () => { throw new Error('boom'); }) as unknown as typeof fakeServer extends (...a: any) => infer R ? R extends { request: infer Q } ? Q : never : never;
    await assert.rejects(exportCompareXlsx(file, [d], all, reqOf(false), { fileA: '/a', fileB: '/b', eps: 0, relEps: 0 }, request), /boom/);
    assert.ok(!fs.existsSync(file));
  });

  it('writes an xlsx with summary, symbol sheets, frozen header, autofilter, colors and numeric cells', async () => {
    const srv = fakeServer(data);
    const file = path.join(dir, 'cmp.xlsx');
    const res = await exportCompareXlsx(file, [d, x], all, reqOf(false), { fileA: '/a.gdx', fileB: '/b.gdx', eps: 0, relEps: 0 }, srv.request);
    assert.deepStrictEqual(res.sheets.map((s) => s.sheet), ['d', 'x']);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['Summary', 'd', 'x']);
    const sum = wb.getWorksheet('Summary')!;
    assert.strictEqual(sum.getRow(1).getCell(1).value, 'Symbol');
    assert.strictEqual(sum.getRow(2).getCell(1).value, 'd');
    assert.strictEqual(sum.getRow(2).getCell(4).value, 'different');
    assert.strictEqual(sum.getRow(2).getCell(5).value, 1); // changed count is a number
    assert.strictEqual(sum.getRow(2).getCell(11).value, 'd');
    assert.strictEqual((sum.getRow(2).getCell(4).fill as ExcelJS.FillPattern).fgColor?.argb, 'FF' + excelColor('changed'));
    assert.ok(sum.getRow(4).getCell(11).value === '' || sum.getRow(4).getCell(11).value === null); // equal symbol: not exported
    const ws = wb.getWorksheet('d')!;
    assert.deepStrictEqual((ws.getRow(1).values as unknown[]).slice(1), ['Status', 'i', 'j', 'A', 'B', 'AbsDiff', 'RelDiff']);
    assert.strictEqual(ws.views[0].state, 'frozen');
    assert.strictEqual((ws.views[0] as { ySplit?: number }).ySplit, 1);
    assert.ok(ws.autoFilter, 'autofilter');
    const n = (r: number, c: number): ExcelJS.CellValue => ws.getRow(r).getCell(c).value;
    assert.strictEqual(typeof n(2, 4), 'number');
    assert.strictEqual(n(3, 4), 1.7);
    assert.strictEqual(n(3, 6), 0.1);
    assert.strictEqual(n(5, 4), 'EPS'); // special value as text
    assert.strictEqual(n(4, 4), null);
    const fillOf = (r: number, c: number): string | undefined => (ws.getRow(r).getCell(c).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
    assert.strictEqual(fillOf(2, 4), undefined); // equal row: no color
    assert.strictEqual(fillOf(3, 5), 'FF' + excelColor('changed'));
    assert.strictEqual(fillOf(3, 2), undefined);
    assert.strictEqual(fillOf(4, 2), 'FF' + excelColor('added')); // whole added row
    assert.strictEqual(fillOf(4, 5), 'FF' + excelColor('added'));
    assert.strictEqual(fillOf(5, 3), 'FF' + excelColor('removed'));
    const wx = wb.getWorksheet('x')!;
    assert.deepStrictEqual((wx.getRow(1).values as unknown[]).slice(1), ['Status', 'i', 'A Level', 'B Level', 'AbsDiff Level', 'RelDiff Level', 'A Marginal', 'B Marginal', 'AbsDiff Marginal', 'RelDiff Marginal']);
  });

  it('handles the sheet row limit with a note in the summary', async () => {
    const big: CompareRecord[] = Array.from({ length: 50 }, (_, i) => rec({ keys: [`k${i}`, 'z'], status: 'changed', a: [i], b: [i + 1], abs: [1], rel: [0.1], diff: [true] }));
    const bigSym = sym({ name: 'big', rows: 50, differences: 50, changed: 50, added: 0, removed: 0, equal: 0 });
    const srv = fakeServer({ big });
    const file = path.join(dir, 'limit.xlsx');
    const res = await exportCompareXlsx(file, [bigSym], [bigSym], reqOf(false), { fileA: 'a', fileB: 'b', eps: 0, relEps: 0, maxRows: 11 }, srv.request);
    assert.deepStrictEqual(res.truncated, [{ name: 'big', written: 10, total: 50 }]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    assert.strictEqual(wb.getWorksheet('big')!.rowCount, 11);
    assert.match(String(wb.getWorksheet('Summary')!.getRow(2).getCell(12).value), /truncated at the Excel limit of 11 rows: 10 of 50/);
    assert.strictEqual(EXCEL_MAX_ROWS, 1048576);
  });

  it('summary rows carry the status color', () => {
    assert.strictEqual(summaryRow(sym({ name: 'q', status: 'onlyA' }), '').flag, 'removed');
    assert.strictEqual(summaryRow(sym({ name: 'q', status: 'onlyB' }), '').flag, 'added');
    assert.strictEqual(summaryRow(sym({ name: 'q', status: 'equal' }), '').flag, undefined);
  });
});

describe('pending statuses (lazy summary)', () => {
  const mk = (name: string, status: any, changed: number | null = null) => sym({ name, status, changed });
  it('mergeSymbols keeps resolved statuses when a later partial result lists them as pending', () => {
    const cur = [mk('a', 'pending'), mk('b', 'pending'), mk('c', 'onlyA')];
    const r1 = mergeSymbols(cur, [mk('a', 'different', 2), mk('b', 'pending'), mk('c', 'onlyA')]);
    assert.deepStrictEqual(r1.map((s) => s.status), ['different', 'pending', 'onlyA']);
    const r2 = mergeSymbols(r1, [mk('a', 'pending'), mk('b', 'equal', 0)]);
    assert.deepStrictEqual(r2.map((s) => s.status), ['different', 'equal', 'onlyA']);
    assert.strictEqual(r2[0].changed, 2);
  });
  it('pendingNames picks visible pending rows in order, skipping tried ones', () => {
    const rows = [mk('a', 'equal'), mk('b', 'pending'), mk('c', 'pending'), mk('d', 'pending')];
    assert.deepStrictEqual(pendingNames(rows, 2), ['b', 'c']);
    assert.deepStrictEqual(pendingNames(rows, 5, new Set(['b'])), ['c', 'd']);
  });
  it('pending is counted, labelled and survives the "only differences" status filter as its own status', () => {
    const l = [mk('a', 'pending'), mk('b', 'different')];
    assert.strictEqual(statusCounts(l).pending, 1);
    assert.strictEqual(SYMBOL_STATUS_LABEL.pending, 'Pending');
    assert.strictEqual(symbolSummary(l[0]), 'not compared yet');
    assert.deepStrictEqual(filterSymbols(l, defaultSymbolFilter()).map((s) => s.name), ['a', 'b']);
    assert.ok(isCancelled('[cancelled] x') && isTimeout('[timeout] x'));
  });
  it('summary.csv lists pending symbols as pending', () => {
    assert.ok(csvSummary([mk('p', 'pending')], () => '').includes('pending'));
  });
});
