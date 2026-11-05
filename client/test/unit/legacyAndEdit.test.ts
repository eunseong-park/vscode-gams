// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { describePlans, planMigration, sysdirFromExecutable } from '../../src/migrate/mapping';
import { parseSectionInput, sectionHeader, toggleBlockComment, toggleLineComment, SECTION_WIDTH } from '../../src/edit/comments';
import { launchSpec, resolveStudioPath, splitArgs, studioCandidates } from '../../src/studio/studioPath';

describe('settings migration mapping', () => {
  it('executablePath -> sysdir only for gams[.exe] with a directory', () => {
    assert.strictEqual(sysdirFromExecutable('/opt/gams/gams54/gams'), '/opt/gams/gams54');
    assert.strictEqual(sysdirFromExecutable('C:\\GAMS\\43\\gams.exe'), 'C:\\GAMS\\43');
    assert.strictEqual(sysdirFromExecutable('gams'), undefined);
    assert.strictEqual(sysdirFromExecutable('/x/mygams.sh'), undefined);
  });
  it('maps parameters, studio settings and explains project keys', () => {
    const p = planMigration({
      executablePath: '/opt/g/gams', commandLineParameters: '-keep 1 --MPSGEMT 1 lo=3', runProject: true, runBatchPath: 'a.bat',
      idePath: '/opt/g/studio/studio.AppImage', ideArguments: '-platform xcb', terminalCwd: '/t', projectLst: '',
    }, {});
    assert.deepStrictEqual(p.writes, {
      'gams.sysdir': '/opt/g',
      'gams.defaultParameters': ['keep=1', '--MPSGEMT=1', 'lo=3'],
      'gams.studio.path': '/opt/g/studio/studio.AppImage',
      'gams.studio.arguments': '-platform xcb',
    });
    assert.deepStrictEqual(p.kept, ['terminalCwd', 'runProject', 'runBatchPath']);
    assert.deepStrictEqual(p.dropped, []);
    const text = describePlans([p])!;
    assert.ok(/Migrated/.test(text) && /still supported \(deprecated\)/.test(text) && /GAMS\.terminalCwd/.test(text) && /disables the legacy/.test(text));
  });
  it('never overwrites a new value; defaults and unset values are ignored', () => {
    const p = planMigration({ executablePath: '/o/gams', commandLineParameters: 'a=1', idePath: 'gamside', runProject: false }, { 'gams.sysdir': '/mine', 'gams.defaultParameters': [] });
    assert.deepStrictEqual(p.writes, { 'gams.defaultParameters': ['a=1'] });
    assert.deepStrictEqual(p.dropped.sort(), ['executablePath', 'idePath']);
    assert.strictEqual(describePlans([planMigration({}, {})]), undefined);
  });
});

describe('column-1 comments', () => {
  const o = { insertSpace: true, ignoreEmptyLines: true };
  const apply = (lines: string[], opts = o): string[] => {
    const out = [...lines];
    for (const e of toggleLineComment(lines, opts)) out[e.index] = e.insert + out[e.index].substring(e.remove);
    return out;
  };
  it('comments at column 0 even when indented', () => {
    assert.deepStrictEqual(apply(['  x = 1;', '', 'y;']), ['*   x = 1;', '', '* y;']);
    assert.deepStrictEqual(apply(['a'], { ...o, insertSpace: false }), ['*a']);
    assert.deepStrictEqual(apply(['', 'a'], { insertSpace: true, ignoreEmptyLines: false }), ['* ', '* a']);
  });
  it('uncomments only column-1 stars; indented star counts as code', () => {
    assert.deepStrictEqual(apply(['* a', '*b', '', '** c']), ['a', 'b', '', '* c']);
    assert.deepStrictEqual(apply(['* a', '  * b']), ['* * a', '*   * b']);
  });
  it('wraps and unwraps $onText/$offText', () => {
    const doc = ['a', 'b', 'c'];
    const edits = toggleBlockComment(doc, 1, 1);
    assert.deepStrictEqual(edits.map((e) => [e.startLine, e.startCol, e.text]), [[2, 0, '$offText\n'], [1, 0, '$onText\n']]);
    assert.deepStrictEqual(toggleBlockComment(doc, 2, 2).map((e) => [e.startLine, e.startCol, e.text]), [[2, 1, '\n$offText'], [2, 0, '$onText\n']]);
    const w = ['$onText', 'b', '$offText', 'c'];
    assert.deepStrictEqual(toggleBlockComment(w, 1, 1).map((e) => [e.startLine, e.endLine, e.text]), [[2, 3, ''], [0, 1, '']]);
    // offText is the last line, no trailing newline
    const w2 = ['$onText', 'b', '$offText'];
    assert.deepStrictEqual(toggleBlockComment(w2, 1, 1)[0], { startLine: 1, startCol: 1, endLine: 2, endCol: 8, text: '' });
    // the selection includes the marker lines: unwrap instead of nesting
    const sel = ['x', '$onText', 'b', 'c', '$offText', 'y'];
    assert.deepStrictEqual(toggleBlockComment(sel, 1, 4).map((e) => [e.startLine, e.endLine, e.text]), [[4, 5, ''], [1, 2, '']]);
    const selEnd = ['$onText', 'b', '$offText'];
    assert.deepStrictEqual(toggleBlockComment(selEnd, 0, 2).map((e) => [e.startLine, e.startCol, e.endLine, e.endCol]), [[1, 1, 2, 8], [0, 0, 1, 0]]);
    // a marker-less multi-line selection still wraps
    assert.strictEqual(toggleBlockComment(sel, 2, 3).length, 2);
  });
});

describe('section header', () => {
  it('pads to the width and parses level prefix', () => {
    assert.strictEqual(sectionHeader('Data').length, SECTION_WIDTH);
    assert.ok(sectionHeader('Data').startsWith('* Data ---'));
    assert.ok(sectionHeader('Sub', 3).startsWith('*** Sub ---'));
    assert.ok(sectionHeader('x'.repeat(80)).endsWith(' ---'));
    assert.deepStrictEqual(parseSectionInput('** Sub'), { level: 2, name: 'Sub' });
    assert.deepStrictEqual(parseSectionInput('2 Data'), { level: 1, name: '2 Data' });
  });
});

describe('Studio launch', () => {
  it('resolves default locations', () => {
    assert.deepStrictEqual(studioCandidates('/g', 'linux'), ['/g/studio/studio.AppImage', '/g/studio/studio']);
    assert.deepStrictEqual(studioCandidates('C:\\G', 'win32'), ['C:\\G\\studio\\studio.exe']);
    assert.ok(studioCandidates(undefined, 'darwin').includes('/Applications/GAMS Studio.app'));
    assert.strictEqual(resolveStudioPath(' /my/studio ', '/g', () => false), '/my/studio');
    assert.strictEqual(resolveStudioPath('', '/g', (p) => p.endsWith('AppImage'), 'linux'), '/g/studio/studio.AppImage');
    assert.strictEqual(resolveStudioPath('', undefined, () => true, 'linux'), undefined);
  });
  it('splits arguments and builds the command', () => {
    assert.deepStrictEqual(splitArgs('-platform "windows:darkmode=2" \'a b\' ""'), ['-platform', 'windows:darkmode=2', 'a b', '']);
    assert.deepStrictEqual(launchSpec('/s', ['-x'], '/f.gms', 'linux'), { command: '/s', args: ['-x', '/f.gms'] });
    assert.deepStrictEqual(launchSpec('/Applications/GAMS Studio.app', ['-x'], '/f.gms', 'darwin'),
      { command: 'open', args: ['-a', '/Applications/GAMS Studio.app', '/f.gms', '--args', '-x'] });
  });
});
