// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { clampWidth, fitWidth, resizedWidth, sanitizeWidths, widthsFor } from '../../src/views/gdx/columns';
import { clipboardText, cellCount, listCopyRows, normalizeRange, tableCopyRows } from '../../src/views/gdx/copy';
import { DEFAULT_LAYOUT, effectiveOrientation, NARROW_PX, ratioAfterDrag, sanitizeLayout, symbolPanelPx } from '../../src/views/gdx/layout';
import { DEFAULT_FORMAT, formatValue, groupThousands, localeSeparators, SV_EPS, SV_NA, SV_UNDEF } from '../../src/views/gdx/format';
import { domainTargets, NavHistory } from '../../src/views/gdx/nav';
import { firstWithPin, maxDisplayRecords, MAX_SPACER_PX, ScrollAxis } from '../../src/views/gdx/scrollmap';
import { makeMatcher, searchStep, startSearch, SearchSpace } from '../../src/views/gdx/search';
import {
  defaultSymView, effectiveFormat, invertAttrs, isDefaultView, sanitizeState, sanitizeSymView, serializeViews, toggleAttr,
  visibleValueColumns,
} from '../../src/views/gdx/symview';
import {
  barLayout, chartPivot, dataFromRecords, pointCap, dataFromTable, extent, MAX_POINTS, MAX_SERIES, niceScale, plotValue, truncationNotice,
} from '../../src/views/gdx/chart';
import type { GdxSymbolInfo } from '../../src/views/gdx/model';

const sym = (o: Partial<GdxSymbolInfo>): GdxSymbolInfo => ({ index: 1, name: 'x', dim: 2, kind: 'Variable', records: 6, text: '', domain: ['i', 'j'], ...o });

describe('gdx column widths', () => {
  const measure = (s: string): number => s.length * 7;
  it('fits header and cells, adds padding, clamps', () => {
    assert.strictEqual(fitWidth('Name', ['a', 'longer-name'], measure, { padding: 10 }), 11 * 7 + 10);
    assert.strictEqual(fitWidth('Header text', ['a'], measure, { padding: 10, headerExtra: 20 }), 11 * 7 + 20 + 10);
    assert.strictEqual(fitWidth('x', [], measure, { padding: 0, min: 60 }), 60);
    assert.strictEqual(fitWidth('x'.repeat(1000), [], measure), 1200);
  });
  it('resize clamps to the minimum', () => {
    assert.strictEqual(resizedWidth(100, 30), 130);
    assert.strictEqual(resizedWidth(100, -500), 40);
    assert.strictEqual(clampWidth(NaN), 40);
  });
  it('merges saved widths over defaults and drops junk', () => {
    assert.deepStrictEqual(widthsFor(['k0', 'v0'], { k0: 200, v0: 'x' as unknown as number }, () => 90), [200, 90]);
    assert.deepStrictEqual(sanitizeWidths({ a: 99, b: 'z', c: 1e9, d: NaN }), { a: 99, c: 1200 });
    assert.deepStrictEqual(sanitizeWidths(5), {});
  });
});

describe('gdx scaled scrolling', () => {
  const H = 22;
  const sizes = [1, 10, 1_500_000, 50_000_000, 100_000_000];
  for (const n of sizes) {
    it(`row <-> offset round trip for ${n.toLocaleString()} rows`, () => {
      const ax = new ScrollAxis(n, H, 600);
      assert.ok(ax.spacerPx <= MAX_SPACER_PX);
      assert.strictEqual(ax.scaled, n * H > MAX_SPACER_PX);
      const tol = ax.scaled ? Math.ceil(n / ax.maxScroll) + 1 : 0; // rows per scroll pixel
      const probes = [0, 1, Math.floor(n / 3), Math.floor(n / 2), n - ax.viewItems, n - 1].filter((r) => r >= 0 && r < n);
      for (const r of probes) {
        const st = ax.scrollFor(r);
        assert.ok(st >= 0 && st <= ax.maxScroll);
        const back = ax.firstAt(st);
        // near the end the first row is clamped so that the last row is still on screen
        const want = Math.min(r, Math.max(0, n - ax.viewItems));
        assert.ok(Math.abs(back - want) <= tol, `n=${n} r=${r} back=${back} tol=${tol}`);
      }
      assert.strictEqual(ax.firstAt(0), 0);
      assert.strictEqual(ax.firstAt(ax.maxScroll), Math.max(0, n - (ax.scaled ? ax.viewItems : ax.viewItems)) === 0 ? 0 : ax.firstAt(ax.maxScroll));
      // the last row is reachable
      const last = ax.firstAt(ax.maxScroll);
      assert.ok(last + ax.viewItems >= n - 1 || !ax.scaled && last + ax.viewItems >= n - 1 || n <= ax.viewItems, `last=${last}`);
    });
  }
  it('positions rows exactly one row height apart near the viewport when scaled', () => {
    const ax = new ScrollAxis(100_000_000, H, 600);
    const st = ax.scrollFor(60_000_000);
    const first = ax.firstAt(st);
    assert.strictEqual(ax.viewPos(first, first, st), 0);
    assert.strictEqual(ax.viewPos(first + 5, first, st), 5 * H);
    assert.strictEqual(ax.contentPos(first + 5, first, st), st + 5 * H);
  });
  it('unscaled positions are plain multiples', () => {
    const ax = new ScrollAxis(1000, H, 600);
    assert.strictEqual(ax.contentPos(10, 0, 0), 220);
    assert.strictEqual(ax.viewPos(10, 5, 110 + 3), 220 - 113);
  });
  it('a pin makes any row exactly reachable and expires when scrolled elsewhere', () => {
    const ax = new ScrollAxis(100_000_000, H, 600);
    const st = ax.scrollFor(77_777_777);
    assert.strictEqual(firstWithPin(ax, st, { scroll: st, first: 77_777_777 }), 77_777_777);
    assert.notStrictEqual(firstWithPin(ax, st + 50, { scroll: st, first: 77_777_777 }), 77_777_777);
  });
  it('reveal keeps, moves up or moves down', () => {
    const ax = new ScrollAxis(1000, H, 220); // 10 rows visible
    assert.strictEqual(ax.reveal(5, 0), 0);
    assert.strictEqual(ax.reveal(12, 0), 3);
    assert.strictEqual(ax.reveal(2, 8), 2);
    assert.strictEqual(ax.reveal(5000, 0), 990);
  });
  it('Studio display limit is (INT_MAX - 2^15) / row height', () => {
    assert.strictEqual(maxDisplayRecords(22), Math.floor((2147483647 - 32768) / 22));
    assert.ok(maxDisplayRecords(22) > 97_000_000);
  });
});

describe('gdx attribute selection and squeeze defaults', () => {
  it('keeps at least one attribute checked', () => {
    let a = [true, false, false, false, false];
    a = toggleAttr(a, 0);
    assert.deepStrictEqual(a, [true, false, false, false, false]);
    a = toggleAttr(a, 2);
    assert.deepStrictEqual(a, [true, false, true, false, false]);
    a = toggleAttr(a, 0);
    assert.deepStrictEqual(a, [false, false, true, false, false]);
    assert.deepStrictEqual(toggleAttr(a, 9), a);
  });
  it('invert never produces an empty selection', () => {
    assert.deepStrictEqual(invertAttrs([true, false, true, false, false]), [false, true, false, true, true]);
    assert.deepStrictEqual(invertAttrs([true, true, true, true, true]), [true, true, true, true, true]);
  });
  it('visible columns honour attributes and squeeze defaults', () => {
    const all = [true, true, true, true, true];
    assert.deepStrictEqual(visibleValueColumns('Parameter', all, undefined, false), [0]);
    assert.deepStrictEqual(visibleValueColumns('Variable', all, undefined, false), [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(visibleValueColumns('Variable', [true, false, true, false, false], undefined, false), [0, 2]);
    const def = [false, true, true, true, true];
    assert.deepStrictEqual(visibleValueColumns('Variable', all, def, true), [0]);
    assert.deepStrictEqual(visibleValueColumns('Variable', all, def, false), [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(visibleValueColumns('Equation', [false, true, true, false, false], def, true), [1]); // all would vanish -> first checked stays
    assert.deepStrictEqual(visibleValueColumns('Variable', all, undefined, true), [0, 1, 2, 3, 4]); // defaults unknown yet
  });
  it('precision Full forces squeezing for g / e (NumericalFormatController)', () => {
    assert.strictEqual(effectiveFormat({ format: 'g', precision: 0, squeeze: false }).squeeze, true);
    assert.strictEqual(effectiveFormat({ format: 'f', precision: 0, squeeze: false }).squeeze, false);
    assert.strictEqual(effectiveFormat({ format: 'f', precision: 99, squeeze: true }).precision, 14);
    assert.strictEqual(effectiveFormat({ format: 'g', precision: 99, squeeze: true }).precision, 17);
  });
});

describe('gdx view state persistence', () => {
  it('round trips a modified view and drops default ones', () => {
    const s = sym({});
    const v = defaultSymView(s);
    assert.ok(isDefaultView(v, s));
    v.mode = 'table';
    v.attrs = [true, false, false, false, true];
    v.sort = { column: 2, ascending: false };
    v.widths = { k0: 150 };
    v.filters.labels[0] = { mode: 'include', labels: ['a'] };
    assert.ok(!isDefaultView(v, s));
    const out = serializeViews(new Map([['x', v], ['y', defaultSymView(s)]]), [s, sym({ name: 'y' })]);
    assert.deepStrictEqual(Object.keys(out), ['x']);
    const back = sanitizeSymView(JSON.parse(JSON.stringify(out.x)), s);
    assert.deepStrictEqual(back, v);
  });
  it('sanitizes garbage and invalid combinations', () => {
    const s = sym({ dim: 1, kind: 'Parameter' });
    const bad = sanitizeSymView({ mode: 'table', attrs: [false, false, false, false, false], sort: { column: 99 }, pivot: { rowDims: [5], colDims: [] }, fmt: { format: 'z', precision: -3 }, widths: { a: 'x' } }, s);
    assert.strictEqual(bad.mode, 'list'); // table needs dim >= 2
    assert.deepStrictEqual(bad.attrs, [true, true, true, true, true]);
    assert.strictEqual(bad.sort, undefined);
    assert.strictEqual(bad.fmt.format, 'g');
    assert.strictEqual(bad.fmt.precision, 0);
    assert.deepStrictEqual(bad.widths, {});
    assert.strictEqual(sanitizeSymView({ mode: 'chart' }, sym({ kind: 'Set', dim: 1 })).mode, 'list'); // no chart of sets
    assert.strictEqual(sanitizeSymView(null, s).mode, 'list');
  });
  it('restores the top-level state, also from the old shape', () => {
    const st = sanitizeState({ selected: 'x', fmt: { format: 'e' }, levelOnly: true, layout: { orientation: 'vertical', ratio: 0.5, collapsed: true } });
    assert.strictEqual(st.selected, 'x');
    assert.strictEqual(st.layout.orientation, 'vertical');
    assert.ok(st.layout.collapsed);
    assert.strictEqual(st.thousands, false);
    assert.deepStrictEqual(sanitizeState(undefined).views, {});
  });
});

describe('gdx layout', () => {
  it('stacks a side-by-side layout when narrow without changing the preference', () => {
    assert.strictEqual(effectiveOrientation({ orientation: 'horizontal' }, NARROW_PX - 1), 'vertical');
    assert.strictEqual(effectiveOrientation({ orientation: 'horizontal' }, NARROW_PX), 'horizontal');
    assert.strictEqual(effectiveOrientation({ orientation: 'vertical' }, 2000), 'vertical');
  });
  it('splitter geometry honours minimum sizes', () => {
    assert.strictEqual(symbolPanelPx(1000, 0.3), 300);
    assert.strictEqual(symbolPanelPx(1000, 0.01), 140);
    assert.strictEqual(symbolPanelPx(1000, 0.99), 1000 - 5 - 200);
    assert.ok(symbolPanelPx(300, 0.5) <= 150); // no room for both minimums: split evenly
    assert.strictEqual(ratioAfterDrag(1000, 500), 0.5);
    assert.strictEqual(ratioAfterDrag(1000, 5), 0.14);
  });
  it('sanitizes the persisted layout', () => {
    assert.deepStrictEqual(sanitizeLayout(undefined), DEFAULT_LAYOUT);
    assert.strictEqual(sanitizeLayout({ ratio: 5 }).ratio, DEFAULT_LAYOUT.ratio);
    assert.deepStrictEqual(sanitizeLayout({ symWidths: { name: 100, bad: 'x' } }).symWidths, { name: 100 });
  });
});

describe('gdx search', () => {
  const data = [['seattle', '1.5', 'x'], ['topeka', '2', 'Seattle Y'], ['san-diego', '3', 'z']];
  const space = (loaded: (r: number) => boolean = () => true): SearchSpace => ({
    rows: 3, cols: 3, texts: (r, c) => (loaded(r) ? [data[r][c]] : undefined),
  });
  const m = makeMatcher({ text: 'seattle', regex: false, caseSensitive: false, exact: false })!;
  it('builds matchers: plain, regex, case, exact, invalid', () => {
    assert.ok(m('SEATTLE'));
    assert.ok(!makeMatcher({ text: 'seattle', regex: false, caseSensitive: true, exact: false })!('SEATTLE'));
    assert.ok(makeMatcher({ text: 'a.b', regex: false, caseSensitive: false, exact: false })!('a.b'));
    assert.ok(!makeMatcher({ text: 'a.b', regex: false, caseSensitive: false, exact: false })!('axb'));
    assert.ok(makeMatcher({ text: '^sa', regex: true, caseSensitive: false, exact: false })!('san-diego'));
    assert.ok(!makeMatcher({ text: 'sea', regex: false, caseSensitive: false, exact: true })!('seattle'));
    assert.ok(makeMatcher({ text: 'Seattle', regex: false, caseSensitive: false, exact: true })!('seattle'));
    assert.strictEqual(makeMatcher({ text: '(', regex: true, caseSensitive: false, exact: false }), undefined);
    assert.strictEqual(makeMatcher({ text: '', regex: false, caseSensitive: false, exact: false }), undefined);
  });
  it('walks forward and backward with wrap-around', () => {
    const sp = space();
    let cur = startSearch(sp, undefined, 1)!;
    let r = searchStep(sp, cur, 1, m);
    assert.deepStrictEqual(r, { kind: 'found', r: 0, c: 0 });
    cur = startSearch(sp, { r: 0, c: 0 }, 1)!;
    r = searchStep(sp, cur, 1, m);
    assert.deepStrictEqual(r, { kind: 'found', r: 1, c: 2 });
    cur = startSearch(sp, { r: 1, c: 2 }, 1)!;
    assert.deepStrictEqual(searchStep(sp, cur, 1, m), { kind: 'found', r: 0, c: 0 }); // wrapped
    cur = startSearch(sp, { r: 0, c: 0 }, -1)!;
    assert.deepStrictEqual(searchStep(sp, cur, -1, m), { kind: 'found', r: 1, c: 2 });
    cur = startSearch(sp, undefined, -1)!;
    assert.deepStrictEqual(searchStep(sp, cur, -1, m), { kind: 'found', r: 1, c: 2 });
  });
  it('reports none, and need for unloaded cells so the caller can load and resume', () => {
    const sp = space();
    const none = makeMatcher({ text: 'qqq', regex: false, caseSensitive: false, exact: false })!;
    assert.deepStrictEqual(searchStep(sp, startSearch(sp, { r: 0, c: 0 }, 1)!, 1, none), { kind: 'none' });
    let loaded = 0;
    const lazy = space((r) => r < loaded);
    let step = searchStep(lazy, startSearch(lazy, { r: 0, c: 0 }, 1)!, 1, m);
    assert.strictEqual(step.kind, 'need');
    if (step.kind !== 'need') return;
    assert.deepStrictEqual([step.r, step.c], [0, 1]);
    loaded = 3;
    step = searchStep(lazy, step.cursor, 1, m);
    assert.deepStrictEqual(step, { kind: 'found', r: 1, c: 2 });
    assert.strictEqual(startSearch({ rows: 0, cols: 3 }, undefined, 1), undefined);
  });
  it('table search can match labels in addition to the cell', () => {
    const sp: SearchSpace = { rows: 1, cols: 2, texts: (_r, c) => ['1', c === 1 ? 'seattle' : 'x'] };
    assert.deepStrictEqual(searchStep(sp, startSearch(sp, undefined, 1)!, 1, m), { kind: 'found', r: 0, c: 1 });
  });
});

describe('gdx copy formatting', () => {
  it('list copy builds the selected block and quotes separators like Studio', () => {
    const rows = listCopyRows(normalizeRange({ r: 2, c: 1 }, { r: 1, c: 0 }), (r, c) => `${r}${c}`);
    assert.deepStrictEqual(rows, [['10', '11'], ['20', '21']]);
    assert.strictEqual(clipboardText([['a,b', "c'd,e"], ['x', 'y']], ','), `'a,b',"c'd,e"\nx,y`);
    assert.strictEqual(clipboardText([['a', 'b']], '\t'), 'a\tb');
    assert.strictEqual(cellCount({ r0: 0, r1: 9, c0: 0, c1: 4 }), 50);
  });
  const src = {
    rowDimCount: 2, colDimCount: 1,
    rowHeader: (r: number) => [`i${r}`, `j${r}`], colHeader: (c: number) => [`t${c}`], cell: (r: number, c: number) => `${r * 10 + c}`,
  };
  it('table copy with and without labels', () => {
    const range = { r0: 0, r1: 1, c0: 1, c1: 2 };
    assert.deepStrictEqual(tableCopyRows(range, src, true), [['', '', 't1', 't2'], ['i0', 'j0', '1', '2'], ['i1', 'j1', '11', '12']]);
    assert.deepStrictEqual(tableCopyRows(range, src, false), [['1', '2'], ['11', '12']]);
  });
});

describe('gdx thousands separator', () => {
  const on = { ...DEFAULT_FORMAT, group: ',' };
  it('groups integer digits, leaves short numbers, decimals and exponents alone', () => {
    assert.strictEqual(groupThousands('1234567', ','), '1,234,567');
    assert.strictEqual(groupThousands('-1234567.891', ','), '-1,234,567.891');
    assert.strictEqual(groupThousands('999', ','), '999');
    assert.strictEqual(groupThousands('1234.5e+10', ' '), '1 234.5e+10');
    assert.strictEqual(groupThousands('FORMAT_ERROR', ','), 'FORMAT_ERROR');
    assert.strictEqual(groupThousands('0.12345', ','), '0.12345');
  });
  it('is off by default and does not change Studio output', () => {
    assert.strictEqual(formatValue(123456, DEFAULT_FORMAT), '123456');
    assert.strictEqual(formatValue(123456, { ...DEFAULT_FORMAT, group: '' }), '123456');
    assert.strictEqual(formatValue(123456, on), '123,456');
  });
  it('applies to g / f / e formats, negatives, squeezed zeros and not to specials or text', () => {
    assert.strictEqual(formatValue(1234567, { ...on, precision: 0 }), '1,234,567');
    assert.strictEqual(formatValue(-1234567, { ...on, precision: 9 }), '-1,234,567');
    assert.strictEqual(formatValue(1234567.5, { ...on, format: 'f', precision: 2, squeeze: true }), '1,234,567.5');
    assert.strictEqual(formatValue(1234567.5, { ...on, format: 'f', precision: 2, squeeze: false }), '1,234,567.50');
    assert.strictEqual(formatValue(1234567, { ...on, format: 'f', precision: 0 }), '1,234,567');
    assert.strictEqual(formatValue(1234567, { ...on, format: 'e', precision: 3 }), '1.23e+06'); // mantissa has one integer digit
    assert.strictEqual(formatValue(123456789, { ...on, format: 'g', precision: 3 }), '1.23e+08');
    assert.strictEqual(formatValue(1500, on), '1,500');
    assert.strictEqual(formatValue(SV_UNDEF, on), 'UNDF');
    assert.strictEqual(formatValue(SV_NA, on), 'NA');
    assert.strictEqual(formatValue(SV_EPS, on), 'EPS');
    assert.strictEqual(formatValue('seattle 1234567', on), 'seattle 1234567');
    assert.strictEqual(formatValue(12345.678, { ...on, decSep: ',', group: '.' }), '12.345,7');
  });
  it('derives separators from the display language', () => {
    assert.strictEqual(localeSeparators('en').group, ',');
    assert.strictEqual(localeSeparators('de').decimal, ',');
    assert.strictEqual(localeSeparators('de').group, '.');
    assert.strictEqual(localeSeparators('not a locale!!').group, ',');
  });
});

describe('gdx navigation history and domain links', () => {
  it('back / forward and truncation of the forward list', () => {
    const h = new NavHistory();
    h.push('a'); h.push('b'); h.push('c');
    assert.ok(h.canBack && !h.canForward);
    assert.strictEqual(h.back(), 'b');
    assert.strictEqual(h.back(), 'a');
    assert.strictEqual(h.back(), undefined);
    assert.strictEqual(h.forward(), 'b');
    h.push('d'); // drops c
    assert.ok(!h.canForward);
    assert.strictEqual(h.back(), 'b');
    h.push('b'); // same as current: no-op
    assert.strictEqual(h.forward(), 'd');
  });
  it('caps and prunes', () => {
    const h = new NavHistory(3);
    ['a', 'b', 'c', 'd'].forEach((n) => h.push(n));
    assert.strictEqual(h.back(), 'c');
    assert.strictEqual(h.back(), 'b');
    assert.strictEqual(h.back(), undefined);
    h.prune((n) => n !== 'c');
    assert.strictEqual(h.current, 'b');
    assert.strictEqual(h.forward(), 'd');
  });
  it('links domain names to sets only', () => {
    const syms = [sym({ index: 1, name: 'i', kind: 'Set', dim: 1, domain: ['*'] }), sym({ index: 2, name: 'J', kind: 'Alias', dim: 1 }), sym({ index: 3, name: 'p', kind: 'Parameter' })];
    const t = domainTargets({ name: 'x', domain: ['i', 'j', 'p', '*', 'zz'] }, syms);
    assert.deepStrictEqual(t.map((s) => s?.name), ['i', 'J', undefined, undefined, undefined]);
  });
});

describe('gdx chart data shaping', () => {
  it('maps special values', () => {
    assert.strictEqual(plotValue(2.5), 2.5);
    assert.strictEqual(plotValue(SV_EPS), 0);
    assert.strictEqual(plotValue(SV_UNDEF), null);
    assert.strictEqual(plotValue(SV_NA), null);
    assert.strictEqual(plotValue('x'), null);
    assert.strictEqual(plotValue(null), null);
  });
  it('1-D records become one series, capped with a notice', () => {
    const recs = Array.from({ length: 10 }, (_, i) => ({ keys: [`k${i}`], values: [i, 0] as (number | string)[] }));
    const d = dataFromRecords(recs, 5000, 0, 'Level', 4);
    assert.deepStrictEqual(d.labels, ['k0', 'k1', 'k2', 'k3']);
    assert.deepStrictEqual(d.series[0].values, [0, 1, 2, 3]);
    assert.ok(d.truncatedPoints && !d.truncatedSeries);
    assert.match(truncationNotice(d), /first 4 of 5,000 points/);
    assert.strictEqual(truncationNotice(dataFromRecords(recs, 10, 0, 'v')), '');
    assert.strictEqual(MAX_POINTS, 2000);
    assert.strictEqual(pointCap(1), 2000);
    assert.strictEqual(pointCap(50), 400); // 50 series x 400 points = 20k marks
    assert.strictEqual(pointCap(10000), 50);
  });
  it('pivot windows become grouped series, capped in both directions', () => {
    const t = {
      rowCount: 3, colCount: 120,
      rowHeaders: [['a'], ['b'], ['c']],
      colHeaders: Array.from({ length: 120 }, (_, i) => [`s${i}`]),
      cells: [0, 1, 2].map((r) => Array.from({ length: 120 }, (_, c) => (c === 1 ? null : r * 1000 + c))) as (number | null)[][],
    };
    const d = dataFromTable(t, 2, MAX_SERIES);
    assert.strictEqual(d.series.length, 50);
    assert.deepStrictEqual(d.labels, ['a', 'b']);
    assert.deepStrictEqual(d.series[1].values, [null, null]);
    assert.strictEqual(d.totalSeries, 120);
    assert.ok(d.truncatedPoints && d.truncatedSeries);
    assert.match(truncationNotice(d), /first 2 of 3 points and first 50 of 120 series/);
    // multi-dimensional row tuples are joined
    assert.deepStrictEqual(dataFromTable({ ...t, rowHeaders: [['a', 'x'], ['b', 'y'], ['c', 'z']] }, 3, 1).labels, ['a.x', 'b.y', 'c.z']);
  });
  it('chart pivot makes the chosen dimension the series', () => {
    assert.deepStrictEqual(chartPivot(2, 1, 0), { rowDims: [0], colDims: [1], valueField: 0 });
    assert.deepStrictEqual(chartPivot(3, 0, 2), { rowDims: [1, 2], colDims: [0], valueField: 2 });
    assert.deepStrictEqual(chartPivot(1, 5, 0), { rowDims: [], colDims: [0], valueField: 0 });
  });
  it('nice scales and extents', () => {
    const s = niceScale(0, 97, 5);
    assert.deepStrictEqual([s.min, s.max, s.step], [0, 100, 20]);
    assert.deepStrictEqual(niceScale(-3, 7, 5).ticks, [-4, -2, 0, 2, 4, 6, 8]);
    assert.strictEqual(niceScale(5, 5, 5, false).ticks.length >= 2, true);
    assert.deepStrictEqual(extent({ labels: [], series: [{ name: 'a', values: [null, 3, -1] }], totalPoints: 0, totalSeries: 1, truncatedPoints: false, truncatedSeries: false }), { min: -1, max: 3 });
    assert.strictEqual(extent({ labels: [], series: [{ name: 'a', values: [null] }], totalPoints: 0, totalSeries: 1, truncatedPoints: false, truncatedSeries: false }), undefined);
    const b = barLayout(10, 2, 1000);
    assert.strictEqual(b.groupW, 100);
    assert.strictEqual(b.barW, 40);
    assert.strictEqual(b.pad, 10);
  });
});

import { GridSelection } from '../../src/views/gdx/selection';
describe('gdx grid selection', () => {
  it('moves, extends with shift and clamps', () => {
    const s = new GridSelection(5, 3);
    assert.strictEqual(s.range(), undefined);
    s.move(1, 0); // first move lands on the origin
    assert.deepStrictEqual(s.active, { r: 0, c: 0 });
    s.move(1, 1);
    s.move(10, 10);
    assert.deepStrictEqual(s.active, { r: 4, c: 2 });
    s.set(1, 1);
    s.move(2, 1, true);
    assert.deepStrictEqual(s.range(), { r0: 1, r1: 3, c0: 1, c1: 2 });
    assert.ok(s.contains(2, 2) && !s.contains(0, 0));
    s.selectAll();
    assert.deepStrictEqual(s.range(), { r0: 0, r1: 4, c0: 0, c1: 2 });
    s.resize(2, 2); // selection past the new bounds is dropped
    assert.strictEqual(s.range(), undefined);
  });
});
