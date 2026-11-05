// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { DEFAULT_SUBSTITUTIONS, ConnectSymbol, attributeSuffix, domains, generateConnectYaml, sheetNameFor, yamlScalar } from '../../src/views/gdx/connect';
import { buildConnectYaml, defaultExportFiles, exportSlots, isUniverseAlias, skippedNote, splitExportSymbols, validateExport, xlsxSpecs } from '../../src/views/gdx/exportExcel';
import { cellValue, exportGdxXlsx, pivotHeaderRows, round16, setText, XlsxSymbolSpec } from '../../src/views/gdx/exportXlsx';
import type { ExcelExportRequest, ExcelExportSymbol } from '../../src/views/gdx/protocol';
import { DEFAULT_VALUE_FILTER } from '../../src/views/gdx/query';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const root = path.resolve(__dirname, '../../..');
const yaml = require('js-yaml');
const Ajv = require('ajv');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'connect', 'connect.schema.json'), 'utf8'));
const validate = new Ajv({ strict: false }).compile(schema);

function check(text: string): any[] {
  const doc = yaml.load(text);
  const ok = validate(doc);
  assert.ok(ok, `Connect schema: ${JSON.stringify(validate.errors)}\n${text}`);
  return doc as any[];
}

const sym = (o: Partial<ConnectSymbol> & { name: string }): ConnectSymbol => ({ dim: 2, kind: 'Parameter', attrs: [true, true, true, true, true], ...o });

describe('Connect file of the Excel export (port of Studio ExportDriver)', () => {
  const base = { gdxFile: '/data/my model.gdx', excelFile: '/data/out.xlsx', applyFilters: true, hiddenAttributes: false, substitutions: DEFAULT_SUBSTITUTIONS };

  it('quotes special-value substitutions so they round-trip through YAML', () => {
    const vals = ['it\'s', 'a"b', 'c\\d', 'e: f', 'g # h', "'", '"', '{x}, [y]', 'tab\there', '-'];
    for (const v of vals) {
      const y = generateConnectYaml({ ...base, symbols: [sym({ name: 'd' })], substitutions: { ...DEFAULT_SUBSTITUTIONS, eps: v, na: v + 'z' } });
      const doc = yaml.load(y) as any[];
      const w = doc.find((e) => e.ExcelWriter).ExcelWriter;
      assert.strictEqual(w.valueSubstitutions.EPS, v, v);
      assert.strictEqual(w.valueSubstitutions.NA, v + 'z', v);
    }
  });

  it('writes GDXReader and ExcelWriter for plain sets and parameters', () => {
    const y = generateConnectYaml({ ...base, symbols: [sym({ name: 'i', kind: 'Set', dim: 1 }), sym({ name: 'd' }), sym({ name: 'scal', dim: 0 })] });
    const doc = check(y);
    assert.deepStrictEqual(doc.map((a) => Object.keys(a)[0]), ['GDXReader', 'ExcelWriter']);
    assert.strictEqual(doc[0].GDXReader.file, '/data/my model.gdx');
    assert.deepStrictEqual(doc[0].GDXReader.symbols.map((s: any) => s.name), ['i', 'd', 'scal']);
    const w = doc[1].ExcelWriter;
    assert.deepStrictEqual(w.valueSubstitutions, { EPS: 'EPS', INF: 'INF', '-INF': '-INF', UNDEF: 'UNDEF', NA: 'NA' });
    assert.deepStrictEqual(w.symbols, [
      { name: 'i', range: 'i!A1', columnDimension: 0 }, { name: 'd', range: 'd!A1', columnDimension: 0 }, { name: 'scal', range: 'scal!A1', columnDimension: 0 },
    ]);
    // Studio's text layout is kept
    assert.match(y, /^- GDXReader:\n {4}file: /);
    assert.match(y, /valueSubstitutions: \{\n {6}EPS: EPS,\n/);
  });

  it('projects variables and equations to their visible attributes (column dimension +1)', () => {
    const y = generateConnectYaml({
      ...base,
      symbols: [sym({ name: 'x', kind: 'Variable', attrs: [true, true, false, false, false] }), sym({ name: 'e', kind: 'Equation', dim: 1 })],
    });
    const doc = check(y);
    assert.deepStrictEqual(doc[1], { Projection: { name: 'x.[l, m](0,1)', newName: 'x_proj_(0,1)' } });
    assert.deepStrictEqual(doc[2], { Projection: { name: 'e.all(0)', newName: 'e_proj_(0)' } });
    assert.deepStrictEqual(doc[3].ExcelWriter.symbols, [
      { name: 'x_proj_', range: 'x!A1', columnDimension: 1 }, { name: 'e_proj_', range: 'e!A1', columnDimension: 1 },
    ]);
    // hidden attributes included -> .all
    const h = check(generateConnectYaml({ ...base, hiddenAttributes: true, symbols: [sym({ name: 'x', kind: 'Variable', attrs: [true, false, false, false, false] })] }));
    assert.strictEqual(h[1].Projection.name, 'x.all(0,1)');
    assert.strictEqual(attributeSuffix([false, false, true, true, false], false), '.[lo, up]');
  });

  it('projects aliases and uses the table view column dimensions', () => {
    const y = generateConnectYaml({
      ...base,
      symbols: [sym({ name: 'ii', kind: 'Alias', aliasOf: 'i', dim: 1 }), sym({ name: 'c', tableColDims: 2, dim: 3 }), sym({ name: 'v', kind: 'Variable', tableColDims: 1 })],
    });
    const doc = check(y);
    assert.deepStrictEqual(doc[0].GDXReader.symbols.map((s: any) => s.name), ['i', 'c', 'v']);
    assert.deepStrictEqual(doc[1], { Projection: { name: 'i(0)', newName: 'ii(0)' } });
    const cols = doc.at(-1).ExcelWriter.symbols.map((s: any) => s.columnDimension);
    assert.deepStrictEqual(cols, [0, 2, 2]); // variable: table col dim 1 + attribute dimension
  });

  it('writes label and value filters (Filter agent) and uses the filtered symbols', () => {
    const y = generateConnectYaml({
      ...base,
      symbols: [
        sym({
          name: 'd',
          labelFilters: { 0: { mode: 'include', labels: ['seattle', "o'brien"] }, 1: { mode: 'exclude', labels: ['ny'] } },
          valueFilters: { 0: { ...DEFAULT_VALUE_FILTER, min: 1, max: 5, showEps: false, showNA: false } },
        }),
        sym({ name: 'x', kind: 'Variable', valueFilters: { 1: { ...DEFAULT_VALUE_FILTER, min: 0, exclude: true, showUndef: false } }, attrs: [true, true, false, false, false] }),
      ],
    });
    const doc = check(y);
    const f = doc[1].Filter;
    assert.strictEqual(f.name, 'd');
    assert.strictEqual(f.newName, 'd_filter_');
    assert.deepStrictEqual(f.labelFilters, [{ dimension: 1, keep: ['seattle', "o'brien"] }, { dimension: 2, reject: ['ny'] }]);
    assert.deepStrictEqual(f.valueFilters, [{ attribute: 'value', rule: '(x>=1) & (x<=5)', rejectSpecialValues: ['EPS', 'NA'] }]);
    const fx = doc[2].Filter;
    assert.deepStrictEqual(fx.valueFilters, [{ attribute: 'marginal', rule: '(x<0)', rejectSpecialValues: ['UNDEF'] }]);
    assert.strictEqual(doc[3].Projection.name, 'x_filter_.[l, m](0,1)');
    const w = doc[4].ExcelWriter.symbols;
    assert.deepStrictEqual(w.map((s: any) => s.name), ['d_filter_', 'x_proj_']);
    // filters are ignored without "apply filters"
    const n = check(generateConnectYaml({ ...base, applyFilters: false, symbols: [sym({ name: 'd', labelFilters: { 0: { mode: 'include', labels: ['a'] } } })] }));
    assert.strictEqual(n.length, 2);
  });

  it('substitutes special values (numbers raw, text quoted) and truncates long sheet names', () => {
    const long = 'a_very_long_symbol_name_that_exceeds_31_characters';
    const y = generateConnectYaml({
      ...base,
      substitutions: { eps: '0', posInf: "it's", negInf: '-1e10', undef: 'n/a', na: 'NA' },
      symbols: [sym({ name: long }), sym({ name: long + '2' })],
    });
    const doc = check(y);
    assert.deepStrictEqual(doc[1].ExcelWriter.valueSubstitutions, { EPS: 0, INF: "it's", '-INF': -1e10, UNDEF: 'n/a', NA: 'NA' });
    const ranges = doc[1].ExcelWriter.symbols.map((s: any) => s.range);
    assert.deepStrictEqual(ranges, [`${long.slice(0, 29)}~1!A1`, `${long.slice(0, 29)}~2!A1`]);
    assert.strictEqual(sheetNameFor('short', []), 'short');
    assert.strictEqual(domains(0), '');
    assert.strictEqual(domains(3), '(0,1,2)');
  });

  it('quotes unsafe paths and names', () => {
    assert.strictEqual(yamlScalar('C:\\data\\a b.gdx'), "'C:\\data\\a b.gdx'"); // contains ':'
    assert.strictEqual(yamlScalar('/data/it\'s.gdx'), "'/data/it''s.gdx'");
    assert.strictEqual(yamlScalar('/data/a b.gdx'), '/data/a b.gdx');
    const doc = check(generateConnectYaml({ ...base, gdxFile: 'C:\\my data\\a: b.gdx', excelFile: 'D:\\o.xlsx', symbols: [sym({ name: 'p' })] }));
    assert.strictEqual(doc[0].GDXReader.file, 'C:\\my data\\a: b.gdx');
  });
});

const exSym = (o: Partial<ExcelExportSymbol> & { name: string }): ExcelExportSymbol => ({
  index: 1, dim: 2, kind: 'Parameter', domain: ['i', 'j'], view: 'list', attrs: [true, true, true, true, true], labelFilters: {}, valueFilters: {}, ...o,
});
const req = (o: Partial<ExcelExportRequest>): ExcelExportRequest => ({
  symbols: [exSym({ name: 'd' })], applyFilters: true, hiddenAttributes: false, excelFile: 'o.xlsx', connectFile: 'o.yaml',
  substitutions: { eps: 'EPS', posInf: 'INF', negInf: '-INF', undef: 'UNDEF', na: 'NA' }, connectOnly: false, ...o,
});

describe('Excel export request handling', () => {
  it('validates like Studio (empty file, extension, no symbols) and resolves relative paths', () => {
    const g = '/data/m.gdx';
    assert.match(validateExport(req({ excelFile: ' ' }), g).error, /Excel file can not be empty/);
    assert.match(validateExport(req({ excelFile: 'o.csv' }), g).error, /needs to be 'xlsx' but is 'csv'/);
    assert.match(validateExport(req({ symbols: [] }), g).error, /At least one symbol/);
    const ok = validateExport(req({ excelFile: 'out', connectFile: 'x.yaml' }), g);
    assert.strictEqual(ok.error, '');
    assert.strictEqual(ok.excelFile, path.join('/data', 'out.xlsx'));
    assert.strictEqual(ok.connectFile, path.join('/data', 'x.yaml'));
    assert.deepStrictEqual(defaultExportFiles(path.join('/d', 'm.gdx')), { excelFile: path.join('/d', 'm_export.xlsx'), connectFile: path.join('/d', 'm_export.yaml') });
  });

  it('leaves aliases of the universe out of the workbook and the Connect file (GDXReader: UniverseAlias not supported)', () => {
    const u = exSym({ name: 'u', kind: 'Alias', dim: 1, domain: ['*'] }); // no aliasOf: alias of the universe
    const a = exSym({ name: 'a', kind: 'Alias', dim: 1, domain: ['*'], aliasOf: 'i' });
    const r = req({ symbols: [exSym({ name: 'i', kind: 'Set', dim: 1 }), a, u] });
    assert.ok(isUniverseAlias(u) && !isUniverseAlias(a));
    assert.deepStrictEqual(splitExportSymbols(r), { symbols: [r.symbols[0], r.symbols[1]], skipped: ['u'] });
    assert.deepStrictEqual(xlsxSpecs(r).map((s) => s.name), ['i', 'a']);
    const doc = check(buildConnectYaml(r, '/data/m.gdx', '/data/o.xlsx'));
    assert.deepStrictEqual(doc[0].GDXReader.symbols.map((s: any) => s.name), ['i', 'i']);
    assert.ok(!JSON.stringify(doc).includes('"u"') && !JSON.stringify(doc).includes('name":"u'));
    assert.match(skippedNote(['u']), /universe.*: u\./);
    assert.strictEqual(skippedNote([]), '');
    assert.match(validateExport(req({ symbols: [u] }), '/data/m.gdx').error, /Aliases of the universe cannot be exported.*: u/);
  });

  it('derives sheet specs: attribute slots, filters only when requested, table view', () => {
    const filt = { 0: { mode: 'include' as const, labels: ['a'] } };
    const r = req({
      symbols: [
        exSym({ name: 'x', kind: 'Variable', attrs: [false, true, false, false, false], labelFilters: filt }),
        exSym({ name: 'p', view: 'table', pivot: { rowDims: [0], colDims: [1], valueField: 0 } }),
      ],
    });
    const s = xlsxSpecs(r);
    assert.deepStrictEqual(s[0].slots, [1]);
    assert.deepStrictEqual(s[0].query.filters, { 0: { mode: 'include', labels: ['a'] } });
    assert.strictEqual(s[1].view, 'table');
    assert.deepStrictEqual(xlsxSpecs(req({ applyFilters: false, symbols: [r.symbols[0]] }))[0].query, {});
    assert.deepStrictEqual(xlsxSpecs(req({ hiddenAttributes: true, symbols: [r.symbols[0]] }))[0].slots, [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(exportSlots([false, false, false, false, false], false), []); // asSet projection: labels only
    const y = buildConnectYaml(r, '/data/m.gdx', '/data/o.xlsx');
    check(y);
    assert.match(y, /columnDimension: 1/);
  });
});

describe('native Excel writer of the viewer export', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gams-xl-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sub = DEFAULT_SUBSTITUTIONS;

  it('maps values: numbers stay numbers, specials become text or the substitution', () => {
    assert.strictEqual(cellValue(1.5, sub), 1.5);
    assert.strictEqual(cellValue('+INF', sub), 'INF');
    assert.strictEqual(cellValue('UNDF', sub), 'UNDEF');
    assert.strictEqual(cellValue('EPS', { ...sub, eps: '0' }), 0);
    assert.strictEqual(cellValue('NA', { ...sub, na: 'n/a' }), 'n/a');
    assert.strictEqual(cellValue(null, sub), null);
    // the viewer protocol returns the placeholder `Y` for elements without text (hasText false); a real `Y` stays
    assert.strictEqual(setText('Y', false), '');
    assert.strictEqual(setText('Y', true), 'Y');
    assert.strictEqual(setText('plant', true), 'plant');
    // Connect's writer (openpyxl) writes numbers with %.16g
    assert.strictEqual(cellValue(0.036000000000000004, sub), 0.036);
    assert.strictEqual(round16(0.009000000000000008), 0.009000000000000008);
    assert.strictEqual(round16(1234567), 1234567);
    assert.strictEqual(round16(1.1240007277776077e21), 1.124000727777608e21);
    assert.strictEqual(cellValue('aaa', sub), 'UNDEF'); // acronym: Connect writes UNDEF
    // header rows: blank above the row labels, no row dimension names
    assert.deepStrictEqual(pivotHeaderRows(1, 1, [['a'], ['b']]), [[null, 'a', 'b']]);
    assert.deepStrictEqual(pivotHeaderRows(1, 2, [['a', 'l'], ['a', 'm']]), [[null, 'a', 'a'], [null, 'l', 'm']]);
  });

  function server(): { request: <T>(m: string, p: unknown) => Promise<T>; calls: any[] } {
    const calls: any[] = [];
    const request = async <T,>(method: string, p: unknown): Promise<T> => {
      const q = p as any;
      calls.push({ method, ...q });
      if (method === 'gams/gdxRecords') {
        const recs: Record<number, any[]> = {
          1: [{ keys: ['s', 'n'], values: [2.5] }, { keys: ['s', 'c'], values: ['EPS'] }, { keys: ['t', 'n'], values: [-3] }],
          2: [{ keys: ['a'], values: ['Y'], hasText: false }, { keys: ['b'], values: ['plant b'], hasText: true }, { keys: ['c'], values: ['Y'], hasText: true }],
          3: [{ keys: ['a'], values: [1, 2, 'NA', '+INF', 1] }],
        };
        const r = recs[q.symbolIndex];
        return { total: r.length, records: r.slice(q.offset, q.offset + q.limit) } as T;
      }
      // gdxTable: 2 rows (s, t) x 2 columns (n, c); value = row*10+col+valueField/100
      const rows = ['s', 't'];
      const cols = ['n', 'c'];
      const r0 = q.rowOffset, r1 = Math.min(rows.length, q.rowOffset + q.rowLimit);
      return {
        rowCount: 2, colCount: 2, rowOffset: r0, colOffset: 0, rowDims: q.rowDims, colDims: q.colDims,
        rowHeaders: rows.slice(r0, r1).map((r) => [r]), colHeaders: cols.map((c) => [c]),
        cells: rows.slice(r0, r1).map((_, ri) => cols.map((_c, ci) => (ri + r0) * 10 + ci + q.valueField / 100)),
      } as T;
    };
    return { request, calls };
  }

  const spec = (o: Partial<XlsxSymbolSpec> & { name: string; index: number }): XlsxSymbolSpec => ({
    dim: 2, kind: 'Parameter', domain: ['i', 'j'], view: 'list', slots: [0], query: {}, ...o,
  });

  it('deletes the partial file and releases the handle when a data request fails', async () => {
    const file = path.join(dir, 'fail.xlsx');
    let n = 0;
    const request = (async () => {
      if (++n > 1) throw new Error('boom');
      return { records: [{ keys: ['a', 'b'], values: [1] }], total: 5, offset: 0 };
    }) as any;
    await assert.rejects(exportGdxXlsx(file, '/g.gdx', [spec({ name: 'd', index: 1 })], sub, request), /boom/);
    assert.ok(!fs.existsSync(file), 'partial file removed');
  });

  it('writes list sheets (no header; attribute header for variables) and table sheets like the Connect ExcelWriter', async () => {
    const srv = server();
    const file = path.join(dir, 'v.xlsx');
    const specs = [
      spec({ name: 'd', index: 1 }),
      spec({ name: 'i', index: 2, dim: 1, kind: 'Set', domain: ['*'] }),
      spec({ name: 'x', index: 3, dim: 1, kind: 'Variable', domain: ['i'], slots: [0, 1, 2, 3] }),
      spec({ name: 't', index: 1, view: 'table', pivot: { rowDims: [0], colDims: [1], valueField: 0 } }),
      spec({ name: 'tx', index: 1, kind: 'Variable', view: 'table', pivot: { rowDims: [0], colDims: [1], valueField: 0 }, slots: [0, 1] }),
    ];
    const res = await exportGdxXlsx(file, '/data/m.gdx', specs, sub, srv.request);
    assert.deepStrictEqual(res.truncated, []);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['d', 'i', 'x', 't', 'tx']);
    const vals = (name: string): unknown[][] => {
      const rows: unknown[][] = [];
      wb.getWorksheet(name)!.eachRow({ includeEmpty: false }, (r) => rows.push(Array.from((r.values as unknown[]).slice(1), (v) => v ?? '')));
      return rows;
    };
    // like the Connect ExcelWriter: no header for sets / parameters (columnDimension 0), no domain names
    assert.deepStrictEqual(vals('d'), [['s', 'n', 2.5], ['s', 'c', 'EPS'], ['t', 'n', -3]]);
    // element without text: no text cell; a genuine text `Y` is kept
    assert.deepStrictEqual(vals('i'), [['a'], ['b', 'plant b'], ['c', 'Y']]);
    // variables: one header row, blank above the labels
    assert.deepStrictEqual(vals('x'), [['', 'level', 'marginal', 'lower', 'upper'], ['a', 1, 2, 'NA', 'INF']]);
    assert.deepStrictEqual(vals('t'), [['', 'n', 'c'], ['s', 0, 1], ['t', 10, 11]]);
    // variable table: attribute is the last column dimension -> two header rows, attributes side by side per column
    assert.deepStrictEqual(vals('tx'), [['', 'n', 'n', 'c', 'c'], ['', 'level', 'marginal', 'level', 'marginal'], ['s', 0, 0.01, 1, 1.01], ['t', 10, 10.01, 11, 11.01]]);
    // filters are forwarded, sort never
    assert.ok(srv.calls.every((c) => c.sort === undefined && c.path === '/data/m.gdx'));
  });

  it('header row option: domain names, value / text / attribute names, frozen with autofilter (off = no view settings)', async () => {
    const srv = server();
    const file = path.join(dir, 'h.xlsx');
    const on = (o: Partial<XlsxSymbolSpec> & { name: string; index: number }): XlsxSymbolSpec => spec({ headerRow: true, ...o });
    const specs = [
      on({ name: 'd', index: 1 }),
      on({ name: 'dr', index: 1, domain: ['*', 'i'] }),
      on({ name: 'dup', index: 1, domain: ['i', 'i'] }),
      on({ name: 'i', index: 2, dim: 1, kind: 'Set', domain: ['*'] }),
      on({ name: 'x', index: 3, dim: 1, kind: 'Variable', domain: ['i'], slots: [0, 2] }),
      on({ name: 't', index: 1, view: 'table', pivot: { rowDims: [0], colDims: [1], valueField: 0 } }),
      on({ name: 'tx', index: 1, kind: 'Variable', view: 'table', pivot: { rowDims: [0], colDims: [1], valueField: 0 }, slots: [0, 1] }),
      spec({ name: 'off', index: 1 }),
    ];
    await exportGdxXlsx(file, '/data/m.gdx', specs, sub, srv.request);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const vals = (name: string): unknown[][] => {
      const rows: unknown[][] = [];
      wb.getWorksheet(name)!.eachRow({ includeEmpty: false }, (r) => rows.push(Array.from((r.values as unknown[]).slice(1), (v) => v ?? '')));
      return rows;
    };
    assert.deepStrictEqual(vals('d')[0], ['i', 'j', 'value']);
    assert.deepStrictEqual(vals('d')[1], ['s', 'n', 2.5]);
    assert.deepStrictEqual(vals('dr')[0], ['uni_1', 'i', 'value']); // relaxed domain `*` -> uni_N (GAMS Transfer)
    assert.deepStrictEqual(vals('dup')[0], ['i_1', 'i_2', 'value']);
    assert.deepStrictEqual(vals('i'), [['uni_1', 'text'], ['a'], ['b', 'plant b'], ['c', 'Y']]);
    assert.deepStrictEqual(vals('x'), [['i', 'level', 'lower'], ['a', 1, 'NA']]);
    assert.deepStrictEqual(vals('t'), [['i', 'n', 'c'], ['s', 0, 1], ['t', 10, 11]]);
    assert.deepStrictEqual(vals('tx')[0], ['', 'n', 'n', 'c', 'c']);
    assert.deepStrictEqual(vals('tx')[1], ['i', 'level', 'marginal', 'level', 'marginal']);
    const view = (n: string): any => wb.getWorksheet(n)!.views?.[0];
    assert.strictEqual(view('d').state, 'frozen');
    assert.strictEqual(view('d').ySplit, 1);
    assert.strictEqual(view('tx').ySplit, 2);
    assert.strictEqual(view('tx').xSplit, 1);
    assert.strictEqual(view('t').ySplit, 1);
    assert.strictEqual(wb.getWorksheet('d')!.autoFilter, 'A1:C1');
    assert.strictEqual(wb.getWorksheet('tx')!.autoFilter, 'A2:E2');
    assert.strictEqual(wb.getWorksheet('x')!.autoFilter, 'A1:C1');
    // off: Studio's layout, no freeze, no filter
    assert.deepStrictEqual(vals('off')[0], ['s', 'n', 2.5]);
    assert.ok(!view('off') || view('off').state !== 'frozen');
    assert.ok(!wb.getWorksheet('off')!.autoFilter);
  });

  it('header row option reaches the sheet specs and the Connect file (comment only; the YAML stays Studio-identical)', () => {
    assert.strictEqual(xlsxSpecs(req({})).every((x) => !x.headerRow), true);
    assert.strictEqual(xlsxSpecs(req({ headerRow: true }))[0].headerRow, true);
    const off = buildConnectYaml(req({}), '/g.gdx', '/o.xlsx');
    const onY = buildConnectYaml(req({ headerRow: true }), '/g.gdx', '/o.xlsx');
    assert.ok(!off.includes('#'));
    assert.match(onY, /^# Note: .*Header row with domain names/);
    assert.strictEqual(onY.replace(/^(#.*\n)+/, ''), off);
    check(onY);
  });

  it('writes the cells of a set table as element texts (placeholder Y kept, text NA is no special value)', async () => {
    const request = (async (m: string, q: any) => ({
      rowCount: 1, colCount: 2, rowOffset: 0, colOffset: 0, rowDims: q.rowDims, colDims: q.colDims,
      rowHeaders: [['s']], colHeaders: [['n'], ['c']], cells: [['NA', null]],
    })) as any;
    const file = path.join(dir, 'st.xlsx');
    await exportGdxXlsx(file, '/g.gdx', [spec({ name: 'st', index: 1, kind: 'Set', view: 'table', pivot: { rowDims: [0], colDims: [1], valueField: 0 } })], sub, request);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const rows: unknown[][] = [];
    wb.getWorksheet('st')!.eachRow({ includeEmpty: false }, (r) => rows.push(Array.from((r.values as unknown[]).slice(1), (v) => v ?? '')));
    assert.deepStrictEqual(rows, [['', 'n', 'c'], ['s', 'NA']]);
  });

  it('forwards filters and applies substitutions; cuts sheets at the row limit', async () => {
    const srv = server();
    const file = path.join(dir, 'f.xlsx');
    const res = await exportGdxXlsx(
      file, '/g.gdx', [spec({ name: 'd', index: 1, query: { filters: { 0: { mode: 'include', labels: ['s'] } } } })],
      { ...sub, eps: '0' }, srv.request, undefined, { maxRows: 2 },
    );
    assert.deepStrictEqual(res.truncated, [{ name: 'd', reason: 'rows cut at the Excel limit of 2' }]);
    assert.deepStrictEqual(srv.calls[0].filters, { 0: { mode: 'include', labels: ['s'] } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.getWorksheet('d')!;
    assert.strictEqual(ws.rowCount, 2);
    assert.strictEqual(ws.getRow(2).getCell(3).value, 0); // EPS replaced by the number 0
  });

  it('cuts table sheets at the column limit and handles an empty selection', async () => {
    const srv = server();
    const file = path.join(dir, 'c.xlsx');
    const res = await exportGdxXlsx(file, '/g.gdx', [spec({ name: 't', index: 1, view: 'table', pivot: { rowDims: [0], colDims: [1], valueField: 0 } })], sub, srv.request, undefined, { maxCols: 2 });
    assert.deepStrictEqual(res.truncated.map((t) => t.reason), ['columns cut at the Excel limit of 2']);
    await exportGdxXlsx(path.join(dir, 'e.xlsx'), '/g.gdx', [], sub, srv.request);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(dir, 'e.xlsx'));
    assert.strictEqual(wb.worksheets.length, 1);
  });
});
