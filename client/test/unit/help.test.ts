// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { testSysdir } from './testSysdir';
import {
  dollarControlOptionAnchor, gamsCallOptionAnchor, solverOptionAnchor, studioSectionAnchor, searchQuery, resolveHelp, onlineUrl, onlineBase,
  versionFromSysdir, solverOptionNames, docsEnv, pageIds, keywordIndex, anchorExists, relativeUrl, docsDirOf, solverAliasFromSysdir,
} from '../../src/help/helpData';
import { classifyLink, docFileOfUrl, isOpenableUrl, LINK_INTERCEPT_SOURCE } from '../../src/help/links';
import { requestForCursor, wordAt, kindOfTokenType, requestForKind, optionNameOfLine } from '../../src/help/context';

const SYSDIR = testSysdir('help (real docs)') ?? '';
const docs = SYSDIR ? docsDirOf(SYSDIR) : undefined;
const real = docs ? describe : describe.skip;

describe('help anchors (port of Studio helpdata.h)', () => {
  it('GAMSAO anchors are GAMSAO + lower case', () => {
    assert.strictEqual(gamsCallOptionAnchor('Action'), 'GAMSAOaction');
    assert.strictEqual(gamsCallOptionAnchor(''), '');
  });
  it('dollar control on/off pairing', () => {
    assert.strictEqual(dollarControlOptionAnchor('onText'), 'DOLLARonofftext');
    assert.strictEqual(dollarControlOptionAnchor('offText'), 'DOLLARonofftext');
    assert.strictEqual(dollarControlOptionAnchor('OFFLISTING'), 'DOLLARonofflisting');
    assert.strictEqual(dollarControlOptionAnchor('title'), 'DOLLARtitle');
    assert.strictEqual(dollarControlOptionAnchor('echo'), 'DOLLARecho');
    assert.strictEqual(dollarControlOptionAnchor(''), '');
  });
  it('solver option anchors', () => {
    assert.strictEqual(solverOptionAnchor('cplex', 'lpmethod'), 'CPLEXlpmethod');
    assert.strictEqual(solverOptionAnchor('gurobi', 'lazy.x/y z'), 'GUROBIlazyDOTx_y_z');
    assert.strictEqual(solverOptionAnchor('conopt4', 'threads', 'conopt'), 'CONOPTthreads');
  });
  it('studio section / search anchors', () => {
    assert.strictEqual(studioSectionAnchor('Solver Option Editor'), 'STUDIO_SOLVER_OPTION_EDITOR');
    assert.strictEqual(studioSectionAnchor('GDX Viewer'), 'STUDIO_GDX_VIEWER');
    assert.strictEqual(searchQuery('  a   b&c '), 'q=a%20b%26c');
    assert.strictEqual(searchQuery(''), '');
  });
  it('resolveHelp pages, queries and fragments', () => {
    assert.deepStrictEqual(resolveHelp({ type: 'DollarControl', keyword: 'offText' }), { page: 'UG_DollarControlOptions.html', fragment: 'DOLLARonofftext' });
    assert.deepStrictEqual(resolveHelp({ type: 'GamsCall', keyword: 'Action' }), { page: 'UG_GamsCall.html', fragment: 'GAMSAOaction' });
    assert.deepStrictEqual(resolveHelp({ type: 'Index', keyword: 'Solve' }), { page: 'keyword.html', query: 'q=solve' });
    assert.deepStrictEqual(resolveHelp({ type: 'Search', keyword: 'foo bar' }), { page: 'search.html', query: 'q=foo%20bar' });
    assert.deepStrictEqual(resolveHelp({ type: 'Main' }), { page: 'index.html' });
    assert.deepStrictEqual(resolveHelp({ type: 'Solvers', keyword: 'lpmethod', submodule: 'cplex' }), { page: 'S_CPLEX.html', fragment: 'CPLEXlpmethod' });
    assert.deepStrictEqual(resolveHelp({ type: 'Solvers', keyword: 'x', submodule: 'nosuch' }, { pageExists: () => false }), { page: 'S_MAIN.html', fragment: 'NOSUCHx' });
    assert.deepStrictEqual(resolveHelp({ type: 'StudioMain', submodule: 'GDX Viewer' }), { page: 'T_STUDIO.html', fragment: 'STUDIO_GDX_VIEWER' });
    assert.strictEqual(relativeUrl({ page: 'a.html', query: 'q=x', fragment: 'f' }), 'a.html?q=x#f');
  });
  it('online URLs follow the sysdir version like Studio', () => {
    assert.strictEqual(versionFromSysdir('/opt/gams/gams54.6_x64'), '54.6');
    assert.strictEqual(onlineBase('54.6'), 'https://www.gams.com/54/');
    assert.strictEqual(onlineBase('24.9'), 'https://www.gams.com/24.9/');
    assert.strictEqual(onlineBase(undefined), 'https://www.gams.com/latest/');
    assert.strictEqual(onlineUrl({ page: 'UG_GamsCall.html', fragment: 'GAMSAOaction' }, '54.6'), 'https://www.gams.com/54/docs/UG_GamsCall.html#GAMSAOaction');
  });
});

describe('help context (port of MainWindow::on_actionGamsHelp_triggered)', () => {
  const base = { fileName: '/w/m.gms', languageId: 'gams', character: 3 };
  it('word detection like CodeEdit::wordInfo', () => {
    assert.deepStrictEqual(wordAt('$onText', 3), { word: 'onText', start: 1 });
    assert.deepStrictEqual(wordAt('solve m', 5), { word: 'solve', start: 0 });
    assert.strictEqual(wordAt('a  b', 2), undefined);
  });
  it('kinds', () => {
    assert.deepStrictEqual(requestForKind('onText', 'dco'), { type: 'DollarControl', keyword: 'onText' });
    assert.deepStrictEqual(requestForKind('Hello', 'title'), { type: 'DollarControl', keyword: 'title' });
    assert.deepStrictEqual(requestForKind('Set', 'keyword'), { type: 'Index', keyword: 'Set' });
    assert.deepStrictEqual(requestForKind('xyz', 'other'), { type: 'Search', keyword: 'xyz' });
    assert.deepStrictEqual(requestForKind('', 'other'), { type: 'Main' });
    assert.strictEqual(kindOfTokenType('gamsDeclaration'), 'keyword');
    assert.strictEqual(kindOfTokenType('gamsIdentifier'), 'other');
  });
  it('option files', () => {
    const o = { ...base, languageId: 'gams-opt', kind: 'other' as const };
    assert.deepStrictEqual(requestForCursor({ ...o, fileName: '/w/cplex.opt', lineText: 'lpmethod 4', character: 2 }), { type: 'Solvers', keyword: 'lpmethod', submodule: 'cplex' });
    assert.deepStrictEqual(requestForCursor({ ...o, fileName: '/w/cplex.op2', lineText: 'lpmethod=4', character: 2 }), { type: 'Solvers', keyword: 'lpmethod', submodule: 'cplex' });
    assert.deepStrictEqual(requestForCursor({ ...o, fileName: '/w/cplex.opt', lineText: '* comment', character: 2 }), { type: 'StudioMain', submodule: 'Solver Option Editor' });
    assert.deepStrictEqual(requestForCursor({ ...o, fileName: '/w/a.pf', lineText: '--action=c', character: 4 }), { type: 'GamsCall', keyword: 'action' });
    assert.strictEqual(optionNameOfLine('$onecho', false), '');
  });
  it('multi-word option names use the longest known name', () => {
    const known = new Set(['major iterations limit', 'major print level', 'major', 'print frequency']);
    assert.strictEqual(optionNameOfLine('major iterations limit 5', false, known), 'major iterations limit');
    assert.strictEqual(optionNameOfLine('Major_Iterations_Limit 5', false, known), 'Major_Iterations_Limit');
    assert.strictEqual(optionNameOfLine('major iterations limit = 5', false, known), 'major iterations limit');
    assert.strictEqual(optionNameOfLine('major 5', false, known), 'major');
    assert.strictEqual(optionNameOfLine('unknown thing 5', false, known), 'unknown');
    assert.strictEqual(optionNameOfLine('major iterations limit 5', false), 'major');
    const o = { ...base, languageId: 'gams-opt', kind: 'other' as const, optionNames: known };
    assert.deepStrictEqual(requestForCursor({ ...o, fileName: '/w/snopt.opt', lineText: 'major iterations limit 5', character: 2 }),
      { type: 'Solvers', keyword: 'major iterations limit', submodule: 'snopt' });
    assert.strictEqual(solverOptionAnchor('snopt', 'major iterations limit'), 'SNOPTmajor_iterations_limit');
  });
  it('listing', () => {
    assert.deepStrictEqual(requestForCursor({ ...base, languageId: 'gams-lst', lineText: 'x', kind: 'other' }), { type: 'StudioMain', submodule: 'Listing Viewer' });
  });
});

real('help against the real docs of the sysdir', () => {
  const d = docs as string;
  const env = docsEnv(SYSDIR);
  it('every dollar control option page anchor resolves, including on/off pairs', () => {
    for (const w of ['onText', 'offText', 'title', 'include', 'set', 'onEmpty', 'offListing', 'echo', 'gdxIn']) {
      const t = resolveHelp({ type: 'DollarControl', keyword: w }, env);
      assert.ok(fs.existsSync(path.join(d, t.page)));
      assert.ok(pageIds(path.join(d, t.page)).has((t.fragment as string).toLowerCase()), `${w} -> ${t.fragment}`);
    }
  });
  it('GAMSAO anchors exist', () => {
    for (const w of ['action', 'Appendout', 'gdx', 'reference']) {
      const t = resolveHelp({ type: 'GamsCall', keyword: w }, env);
      assert.ok(pageIds(path.join(d, t.page)).has((t.fragment as string).toLowerCase()), w);
    }
  });
  it('solver option anchors exist (case resolved against the page, aliases, DOT)', () => {
    const cases: Array<[string, string]> = [['cplex', 'LPMethod'], ['cplex', 'feasopt'], ['gurobi', 'lazyconstraints'], ['conopt4', 'threads'], ['gurobi', '.lazy']];
    for (const [s, o] of cases) {
      const t = resolveHelp({ type: 'Solvers', keyword: o, submodule: s }, env);
      assert.ok(t.fragment && pageIds(path.join(d, t.page)).has(t.fragment.toLowerCase()), `${s}.${o} -> ${t.page}#${t.fragment}`);
    }
    assert.strictEqual(resolveHelp({ type: 'Solvers', keyword: 'lpmethod', submodule: 'cplex' }, env).fragment, 'CPLEXlpmethod');
    assert.strictEqual(solverAliasFromSysdir(SYSDIR)('conopt4'), 'conopt');
    assert.strictEqual(solverAliasFromSysdir(SYSDIR)('cplex'), undefined);
  });
  it('studio sections exist', () => {
    for (const s of ['Listing Viewer', 'GDX Viewer', 'Solver Option Editor', 'Parameter File', 'Reference File Viewer']) {
      const t = resolveHelp({ type: 'StudioMain', submodule: s }, env);
      assert.ok(pageIds(path.join(d, t.page)).has((t.fragment as string).toLowerCase()), s);
    }
  });
  it('unknown words go to the keyword index / search; index lists real keywords', () => {
    const idx = keywordIndex(d);
    assert.ok(idx.size > 1000);
    for (const w of ['solve', 'minimizing', 'positive', 'model']) assert.ok(idx.has(w), w);
    assert.ok(!idx.has('zzzznotakeyword'));
    assert.deepStrictEqual(resolveHelp({ type: 'Index', keyword: 'zzzz' }, env), { page: 'keyword.html', query: 'q=zzzz' });
    assert.ok(fs.existsSync(path.join(d, 'keyword.html')) && fs.existsSync(path.join(d, 'search.html')) && fs.existsSync(path.join(d, 'index.html')));
  });
});

real('multi-word option names against the real opt*.def', () => {
  it('snopt, minos and conopt anchors', () => {
    const env = docsEnv(SYSDIR);
    const d = docs as string;
    const anchor = (solver: string, line: string): string | undefined => {
      const name = optionNameOfLine(line, false, solverOptionNames(SYSDIR, solver));
      const t = resolveHelp({ type: 'Solvers', keyword: name, submodule: solver }, env);
      return t.fragment && anchorExists(d, t.page, t.fragment) ? t.fragment : undefined;
    };
    assert.strictEqual(anchor('snopt', 'major iterations limit 5'), 'SNOPTmajor_iterations_limit');
    assert.strictEqual(anchor('snopt', 'major_iterations_limit 5'), 'SNOPTmajor_iterations_limit');
    assert.ok(anchor('minos', 'major iterations 5')?.startsWith('MINOS'), String(anchor('minos', 'major iterations 5')));
    assert.ok(anchor('conopt', 'Lim_Err_2DDir 5')?.startsWith('CONOPT'));
    assert.ok(anchor('conopt4', 'threads 2')?.startsWith('CONOPT'));
  });
});

describe('help panel link rules', () => {
  const O = 'http://127.0.0.1:5000';
  it('classifies clicks', () => {
    assert.strictEqual(classifyLink('https://www.gams.com/', O, '_blank', false), 'external');
    assert.strictEqual(classifyLink('https://en.wikipedia.org/wiki/YAML', O, '', false), 'external');
    assert.strictEqual(classifyLink('mailto:a@b.c', O, '', false), 'external');
    assert.strictEqual(classifyLink(O + '/t/docs/UG_X.html#a', O, '', false), 'default');
    assert.strictEqual(classifyLink(O + '/t/docs/UG_X.html', O, '_blank', false), 'self');
    assert.strictEqual(classifyLink(O + '/t/docs/a.xlsx', O, '', false), 'external');
    assert.strictEqual(classifyLink(O + '/t/docs/a.PDF', O, '_blank', false), 'external');
    assert.strictEqual(classifyLink(O + '/t/docs/m.gms', O, '', false), 'external');
    assert.strictEqual(classifyLink(O + '/t/docs/x.html', O, '', true), 'external');
    assert.strictEqual(classifyLink('file:///etc/passwd', O, '', false), 'block');
    assert.strictEqual(classifyLink('javascript:void(0)', O, '', false), 'default');
  });
  it('the injected script embeds the rule function and is syntactically valid', () => {
    const js = LINK_INTERCEPT_SOURCE.replace(/^<script>/, '').replace(/<\/script>$/, '');
    assert.doesNotThrow(() => new Function(js));
    assert.ok(js.includes('gamsOpenExternal'));
  });
  it('validates urls and maps served urls to files', () => {
    assert.ok(isOpenableUrl('https://www.gams.com/'));
    assert.ok(isOpenableUrl('mailto:a@b.c'));
    assert.ok(!isOpenableUrl('file:///etc/passwd'));
    assert.ok(!isOpenableUrl('javascript:alert(1)'));
    assert.ok(!isOpenableUrl({ a: 1 }));
    const bases = ['http://127.0.0.1:5000/tok/'];
    assert.strictEqual(docFileOfUrl(bases, 'http://127.0.0.1:5000/tok/docs/a/b.xlsx', '/sys/docs'), path.resolve('/sys/docs/a/b.xlsx'));
    assert.strictEqual(docFileOfUrl(bases, 'http://127.0.0.1:5000/tok/gamslib_ml/libhtml/x.gms', '/sys/docs'), path.resolve('/sys/gamslib_ml/libhtml/x.gms'));
    assert.strictEqual(docFileOfUrl(bases, 'http://127.0.0.1:5000/tok/docs/%2E%2E/gamslice.txt', '/sys/docs'), undefined);
    assert.strictEqual(docFileOfUrl(bases, 'http://127.0.0.1:5000/tok/other/x', '/sys/docs'), undefined);
    assert.strictEqual(docFileOfUrl(bases, 'http://evil/tok/docs/x', '/sys/docs'), undefined);
  });
});
