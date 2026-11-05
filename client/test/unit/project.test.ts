// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as path from 'path';
import { parseGsp, projectOwnsFile, projectParams, writeGsp } from '../../src/project/gsp';
import { findIncluders, resolveMainFile } from '../../src/project/mainFile';

// SYNTHETIC sample built from the format documented in docs/dev/porting-notes/project-and-misc.md
// (Studio projectrepo.cpp); no real .gsp exists in the GAMS sysdir.
const gsp = '/w/proj/model.gsp';
const sample = JSON.stringify({
  file: 'main.gms', pf: 'run.pf', projectType: 1, path: '.', workDir: 'work', name: 'Demo',
  options: ['lo=2', 'reslim=10 solver=cplex'], dynamicMainFile: false, ownBaseDir: true, custom: 42,
  nodes: [
    { file: 'main.gms', name: 'main.gms', type: 'gms', encoding: 'UTF-8', options: ['a=1'] },
    { file: 'inc/data.inc', name: 'data.inc', type: 'gms' },
  ],
});

describe('gsp', () => {
  it('parses', () => {
    const p = parseGsp(sample, gsp)!;
    assert.strictEqual(p.name, 'Demo');
    assert.strictEqual(p.mainFile, path.normalize('/w/proj/main.gms'));
    assert.strictEqual(p.workDir, path.normalize('/w/proj/work'));
    assert.strictEqual(p.pf, path.normalize('/w/proj/run.pf'));
    assert.deepStrictEqual(projectParams(p), ['reslim=10', 'solver=cplex']);
    assert.ok(projectOwnsFile(p, '/w/proj/inc/data.inc'));
    assert.ok(!projectOwnsFile(p, '/w/proj/other.gms'));
  });
  it('legacy wrapper, main file added, falls back to main file options', () => {
    const p = parseGsp(JSON.stringify({ projects: [{ file: 'm.gms', nodes: [{ file: 'm.gms', options: ['x=1'] }] }] }), gsp)!;
    assert.strictEqual(p.name, 'model');
    assert.deepStrictEqual(projectParams(p), ['x=1']);
    const q = parseGsp(JSON.stringify({ file: 'z.gms' }), gsp)!;
    assert.deepStrictEqual(q.files, [path.normalize('/w/proj/z.gms')]);
    assert.strictEqual(parseGsp('not json', gsp), undefined);
  });
  it('writes new and updates keeping unknown keys', () => {
    const fresh = JSON.parse(writeGsp(undefined, gsp, { mainFile: '/w/proj/a.gms', options: 'lo=3' }));
    assert.strictEqual(fresh.file, 'a.gms');
    assert.deepStrictEqual(fresh.options, ['lo=3']);
    assert.strictEqual(fresh.nodes[0].file, 'a.gms');
    const upd = JSON.parse(writeGsp(sample, gsp, { mainFile: '/w/proj/inc/b.gms', options: 'lo=3', pf: null }));
    assert.strictEqual(upd.custom, 42);
    assert.strictEqual(upd.file, 'inc/b.gms');
    assert.strictEqual(upd.pf, undefined);
    assert.deepStrictEqual(upd.options, ['lo=2', 'reslim=10 solver=cplex', 'lo=3']);
    assert.strictEqual(upd.nodes.length, 3);
    const wrapped = JSON.parse(writeGsp(JSON.stringify({ projects: [{ file: 'm.gms' }], x: 1 }), gsp, { options: 'a=1' }));
    assert.strictEqual(wrapped.x, 1);
    assert.deepStrictEqual(wrapped.projects[0].options, ['a=1']);
  });
});

describe('main file resolution', () => {
  const p = parseGsp(sample, gsp)!;
  it('project file runs project main', () => {
    const r = resolveMainFile({ active: '/w/proj/inc/data.inc', projects: [p], includers: [] });
    assert.deepStrictEqual(r.kind, 'project');
  });
  it('plain gms runs itself', () => {
    assert.deepStrictEqual(resolveMainFile({ active: '/w/x.gms', projects: [], includers: [] }), { kind: 'self' });
  });
  it('include file asks, then uses remembered', () => {
    assert.deepStrictEqual(resolveMainFile({ active: '/w/x.inc', projects: [], includers: ['/w/m.gms'] }), { kind: 'ask', candidates: ['/w/m.gms'] });
    assert.deepStrictEqual(resolveMainFile({ active: '/w/x.inc', projects: [], includers: ['/w/m.gms'], remembered: '/w/m.gms' }), { kind: 'main', main: '/w/m.gms' });
    assert.strictEqual(resolveMainFile({ active: '/w/x.inc', projects: [], includers: ['/w/n.gms'], remembered: '/w/m.gms' }).kind, 'ask');
    assert.deepStrictEqual(resolveMainFile({ active: '/w/m.gms', projects: [], includers: ['/w/q.gms'], remembered: '/w/m.gms' }), { kind: 'self' });
  });
  it('finds includers', () => {
    const files = [
      { path: '/w/m.gms', text: 'set i;\n$include "inc/Data.inc"\n' },
      { path: '/w/n.gms', text: '* $include data.inc\n$batinclude other.inc' },
    ];
    assert.deepStrictEqual(findIncluders('/w/inc/data.inc', files), ['/w/m.gms']);
  });
});
