// SPDX-License-Identifier: GPL-3.0-or-later
// All log lines below are SYNTHETIC, crafted from reading Studio's
// src/editors/logparser.cpp / memorymapper.cpp and the GAMS docs; they are not captured GAMS output.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { extractLinks, HRefContext, parseHRef, quickParse, resolveHRef } from '../../src/run/logParser';
import { LogSession } from '../../src/run/logSession';
import { buildGamsArgs, paramValue } from '../../src/run/gamsProcess';
import { compareVersionDesc } from '../../src/sysdir';

describe('extractLinks', () => {
  it('passes through lines without tags', () => {
    const r = extractLinks('--- Starting compilation');
    assert.strictEqual(r.text, '--- Starting compilation');
    assert.strictEqual(r.hasError, false);
  });

  it('strips a trailing [LST:n] and records the line', () => {
    const r = extractLinks('--- Executing GUROBI (Solvelink=2): elapsed 0:00:00.047[LST:85]');
    assert.strictEqual(r.text, '--- Executing GUROBI (Solvelink=2): elapsed 0:00:00.047');
    assert.strictEqual(r.state.marks.hRef, 'LST:85');
    assert.strictEqual(r.state.marks.lstLine, 85);
  });

  it('parses compile error with ERR and LST (SYNTHETIC; real format in fixtures test) tags', () => {
    const r = extractLinks('*** Error   140 in /w/m.gms[ERR:"/w/m.gms",5,12][LST:34]');
    assert.strictEqual(r.hasError, true);
    assert.strictEqual(r.text, '*** Error   140 in /w/m.gms');
    assert.strictEqual(r.state.marks.errRef, 'ERR:"/w/m.gms",5,12');
    assert.strictEqual(r.state.marks.errNr, 140);
    assert.strictEqual(r.state.marks.hRef, 'LST:34');
    assert.strictEqual(r.state.errData.lstLine, 34);
  });

  it('parses "*** Error at line N: text" form', () => {
    const r = extractLinks('*** Error at line 12: Something broke[LST:40]');
    assert.strictEqual(r.text, '*** Error at line 12: Something broke');
    assert.strictEqual(r.state.errData.errNr, -1);
    assert.strictEqual(r.state.errData.text, 'Something broke');
    assert.strictEqual(r.state.marks.errNr, -1);
  });

  it('switches secondary lst with LS2', () => {
    const r = extractLinks('--- Job x[LS2:"sub\\x.lst"]');
    assert.strictEqual(r.state.switchLst, 'sub/x.lst');
    assert.strictEqual(r.text, '--- Job x');
  });

  it('does not leak a ,n suffix of LS2', () => {
    const r = extractLinks('--- Job x[LS2:"x.lst",7]');
    assert.strictEqual(r.text, '--- Job x');
  });

  it('hides TIT lines', () => {
    assert.strictEqual(extractLinks('Title text[TIT:"abc"]').text, null);
  });

  it('restores non-link brackets', () => {
    const r = extractLinks('x[i] = 3 [FOO:bar]');
    assert.strictEqual(r.text, 'x[i] = 3 [FOO:bar]');
    const r2 = extractLinks('value [abc] and more[LST:3]');
    assert.strictEqual(r2.text, 'value [abc] and more');
    assert.strictEqual(r2.state.marks.lstLine, 3);
  });

  it('handles DIR and REF tags', () => {
    const r = extractLinks('--- Dir[DIR:"/tmp/x"]');
    assert.strictEqual(r.state.marks.hRef, 'DIR:"/tmp/x"');
    const r2 = extractLinks('--- Ref[REF:"/tmp/x.ref"]');
    assert.strictEqual(r2.state.marks.hRef, 'REF:"/tmp/x.ref"');
  });

  it('leaves lines starting with [ untouched', () => {
    assert.strictEqual(extractLinks('[LST:3]').text, '[LST:3]');
  });
});

describe('quickParse', () => {
  it('finds ERR+LST pair', () => {
    const r = quickParse('*** Error 1 in a.gms[ERR:"a.gms",1,1][LST:9]');
    assert.strictEqual(r.line, '*** Error 1 in a.gms');
    assert.strictEqual(r.lstLine, 9);
    assert.ok(r.linkStart > 0);
  });
  it('ignores short or untagged lines', () => {
    assert.deepStrictEqual(quickParse('abc'), { line: 'abc', linkStart: -1, lstLine: -1 });
  });
  it('does not cut array brackets', () => {
    const r = quickParse('--- x[i,j]');
    assert.strictEqual(r.line, '--- x[i,j]');
  });
});

describe('hrefs', () => {
  it('parses quoted file with line and col', () => {
    assert.deepStrictEqual(parseHRef('FIL:"C:/a b.gms",12,3'), { tag: 'FIL', name: 'C:/a b.gms', line: 12, col: 3 });
    assert.deepStrictEqual(parseHRef('LST:34'), { tag: 'LST', name: '', line: 34, col: 0 });
  });
  it('resolves against context', () => {
    const ctx = { workDir: '/w', lst: '/w/m.lst', sysDir: '/s' };
    const have = new Set(['/w/m.lst', '/w/inc/a.gms', '/w/b.gms', '/s/inclib/x.gms']);
    const ex = (p: string) => have.has(p);
    assert.deepStrictEqual(resolveHRef('LST:5', ctx, ex), { file: '/w/m.lst', line: 5, col: 0 });
    assert.deepStrictEqual(resolveHRef('FIL:"b.gms",2,1', ctx, ex), { file: '/w/b.gms', line: 2, col: 1 });
    assert.deepStrictEqual(resolveHRef('INC:"b",3', ctx, ex), { file: '/w/b.gms', line: 3, col: 0 });
    assert.deepStrictEqual(resolveHRef('LIB:"x.gms"', ctx, ex), { file: '/s/inclib/x.gms', line: 0, col: 0 });
    assert.strictEqual(resolveHRef('FIL:"nope.gms",1', ctx, ex), undefined);
  });
});

describe('LogSession', () => {
  const ctx = (): HRefContext => ({ workDir: '/w', lst: '/w/m.lst' });
  const ex = () => true;

  it('collects compile errors with indented message lines', () => {
    const s = new LogSession(ctx(), ex);
    s.push(
      '--- Starting compilation\r\n' +
      '*** Error   140 in /w/m.gms[ERR:"/w/m.gms",5,12][LST:34]\r\n' +
      '    Unknown symbol\r\n' +
      '    second line\r\n' +
      '--- m.gms(5) 3 Mb 1 Error\r\n',
    );
    s.end();
    assert.strictEqual(s.errors.length, 1);
    const e = s.errors[0];
    assert.strictEqual(e.errNr, 140);
    assert.deepStrictEqual(e.source, { file: '/w/m.gms', line: 5, col: 12 });
    assert.deepStrictEqual(e.lst, { file: '/w/m.lst', line: 34, col: 0 });
    assert.strictEqual(e.message, 'Unknown symbol\nsecond line');
    // click on the log line follows the LST mark
    assert.deepStrictEqual(s.lines[1].links[0].target, { file: '/w/m.lst', line: 34, col: 0 });
    assert.strictEqual(s.lines[1].text, '*** Error   140 in /w/m.gms');
  });

  it('buffers partial lines across chunks', () => {
    const s = new LogSession(ctx(), ex);
    s.push('--- Exec');
    s.push('uting[LST:8]\n');
    assert.strictEqual(s.lines.length, 1);
    assert.strictEqual(s.lines[0].text, '--- Executing');
    assert.strictEqual(s.lines[0].links[0].target.line, 8);
  });

  it('skips TIT lines and handles LS2 switch', () => {
    const c = ctx();
    const s = new LogSession(c, ex);
    s.push('hidden[TIT:"t"]\n--- sub[LS2:"sub.lst"]\n--- go[LS2:34]\n');
    assert.strictEqual(s.lines.length, 2);
    assert.strictEqual(c.ls2, '/w/sub.lst');
    assert.strictEqual(s.lines[1].links[0].target.file, '/w/sub.lst');
  });
});

describe('gams args', () => {
  it('uses Studio defaults in order, then user params', () => {
    assert.deepStrictEqual(buildGamsArgs('/w/m.gms', ['--x=1'], false), [
      '/w/m.gms', 'logoption=3', 'ide=1', 'errorlog=99', 'errmsg=1', 'pagesize=0', 'lstTitleleftaligned=1', '--x=1',
    ]);
  });
  it('compile adds ACTION=C unless user set action/a', () => {
    assert.ok(buildGamsArgs('m.gms', [], true).includes('ACTION=C'));
    assert.ok(!buildGamsArgs('m.gms', ['a=r'], true).includes('ACTION=C'));
    assert.ok(!buildGamsArgs('m.gms', ['Action=R'], true).includes('ACTION=C'));
  });
  it('paramValue reads last value without quotes', () => {
    assert.strictEqual(paramValue(['o=a.lst', 'O="b c.lst"'], 'o', 'output'), 'b c.lst');
  });
});

describe('sysdir', () => {
  it('orders versions newest first', () => {
    const l = ['gams49.6_x', 'gams54.6_x', 'gams53.1_x'].sort(compareVersionDesc);
    assert.deepStrictEqual(l, ['gams54.6_x', 'gams53.1_x', 'gams49.6_x']);
  });
});

describe('real GAMS 54.6 fixtures (mini_err.log / mini.log / execerr.log)', () => {
  const fix = path.resolve(__dirname, '../../../server/tests/fixtures');
  const ctx = (n: string): HRefContext => ({ workDir: '/work', lst: `/work/${n}.lst`, sysDir: '/gamssys' });
  const have = () => true;
  const load = (n: string) => fs.readFileSync(path.join(fix, n), 'utf8');

  it('mini_err.log yields 5 diagnostics (two in the include) with columns and messages', () => {
    const s = new LogSession(ctx('mini_err'), have);
    s.push(load('mini_err.log'));
    s.end();
    assert.strictEqual(s.errors.length, 5);
    const [a, b, c, d, e] = s.errors;
    assert.strictEqual(a.errNr, 170);
    assert.deepStrictEqual(a.source, { file: '/work/mini_err_inc.inc', line: 2, col: 35 });
    assert.deepStrictEqual(a.lst, { file: '/work/mini_err.lst', line: 16, col: 0 });
    assert.strictEqual(a.message, 'Domain violation for element');
    assert.strictEqual(b.errNr, 140);
    assert.deepStrictEqual(b.source, { file: '/work/mini_err_inc.inc', line: 3, col: 20 });
    assert.deepStrictEqual(b.lst, { file: '/work/mini_err.lst', line: 21, col: 0 });
    assert.strictEqual(b.message, 'Unknown symbol');
    assert.deepStrictEqual([c.errNr, c.source], [140, { file: '/work/mini_err.gms', line: 9, col: 34 }]);
    assert.deepStrictEqual([d.errNr, d.source], [257, { file: '/work/mini_err.gms', line: 11, col: 30 }]);
    assert.strictEqual(d.message, 'Solve statement not checked because of previous errors');
    assert.deepStrictEqual([e.errNr, e.source], [282, { file: '/work/mini_err.gms', line: 12, col: 27 }]);
    assert.match(e.message, /^Unable to open include file/);
  });

  it('cleans tags and links lines', () => {
    const s = new LogSession(ctx('mini_err'), have);
    s.push(load('mini_err.log'));
    s.end();
    for (const l of s.lines) assert.ok(!/\[(LST|LS2|FIL|ERR|REF|DIR|TIT):/.test(l.text), l.text);
    const errLine = s.lines.find((l) => l.text === '*** Error 170 in /work/mini_err_inc.inc')!;
    assert.deepStrictEqual(errLine.links[0].target, { file: '/work/mini_err.lst', line: 16, col: 0 });
    const st = s.lines.find((l) => l.text === '*** Status: Compilation error(s)')!;
    assert.strictEqual(st.links[0].target.line, 69);
    const fil = s.lines.find((l) => l.text === '--- > mini_err_inc.inc(2) 3 Mb 1 Error')!;
    assert.deepStrictEqual(fil.links[0].target, { file: '/work/mini_err_inc.inc', line: 2, col: 0 });
  });

  it('LST line numbers point at the echoed source line in mini_err.lst', () => {
    const lst = load('mini_err.lst').split('\n');
    assert.match(lst[16 - 1], /^\s+7\s+Parameter bad\(d\)/);
    assert.match(lst[21 - 1], /^\s+8\s+scalar q;/);
    assert.match(lst[29 - 1], /^\s+12\s+e\.\. x =e=/);
  });

  it('mini.log, mini_inc.log and mini_bat.log have no errors and no leftover tags', () => {
    for (const n of ['mini', 'mini_inc', 'mini_bat']) {
      const s = new LogSession(ctx(n), have);
      s.push(load(`${n}.log`));
      s.end();
      assert.strictEqual(s.errors.length, 0, n);
      for (const l of s.lines) assert.ok(!/\[(LST|LS2|FIL|ERR|REF|DIR|TIT):/.test(l.text), l.text);
    }
  });

  it('mini_bat.log links the progress lines of the included files', () => {
    const s = new LogSession(ctx('mini_bat'), have);
    s.push(load('mini_bat.log'));
    s.end();
    const files = new Set(s.lines.flatMap((l) => l.links.map((k) => k.target.file)));
    assert.ok(files.has('/work/mini_data.inc') && files.has('/work/mini_rep.inc'), [...files].join(','));
  });

  it('execerr.log reports execution errors', () => {
    const s = new LogSession(ctx('execerr'), have);
    s.push(load('execerr.log'));
    s.end();
    for (const l of s.lines) assert.ok(!/\[(LST|LS2|FIL|ERR|REF|DIR|TIT):/.test(l.text), l.text);
    assert.ok(s.errors.length >= 1);
  });
});
