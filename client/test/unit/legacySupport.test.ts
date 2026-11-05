// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as path from 'path';
import { columnFor, COLUMN_ACTIVE, COLUMN_BESIDE, editorOpenOptions, effective, legacyCwd, legacyProjectFile, legacyRunMode, runWorkDir } from '../../src/legacy/legacy';
import { mergeTask, resolveTaskDef, shellTaskFromRunScript } from '../../src/tasks/taskDef';

describe('legacy 0.1.x run mode', () => {
  it('batch only with runProject=true and a non-empty runBatchPath', () => {
    assert.strictEqual(legacyRunMode({ runProject: true, runBatchPath: 'run.sh' }), 'batch');
    assert.strictEqual(legacyRunMode({ runProject: true, runBatchPath: '  ' }), 'normal');
    assert.strictEqual(legacyRunMode({ runProject: true }), 'normal');
    assert.strictEqual(legacyRunMode({ runProject: false, runBatchPath: 'run.sh' }), 'normal');
    assert.strictEqual(legacyRunMode({}), 'normal');
  });
  it('projectLst / projectGDX only with runProject', () => {
    assert.strictEqual(legacyProjectFile({ runProject: true, projectLst: 'a.lst' }, 'lst'), 'a.lst');
    assert.strictEqual(legacyProjectFile({ runProject: true, projectLst: 'a.lst' }, 'gdx'), undefined);
    assert.strictEqual(legacyProjectFile({ runProject: false, projectGDX: 'a.gdx' }, 'gdx'), undefined);
    assert.strictEqual(legacyProjectFile({ runProject: true, projectGDX: '' }, 'gdx'), undefined);
  });
});

describe('legacy cwd', () => {
  const ws = path.resolve('/w/space');
  it('terminalCwd || file dir', () => {
    assert.strictEqual(legacyCwd(undefined, '/f'), '/f');
    assert.strictEqual(legacyCwd('', '/f'), '/f');
    assert.strictEqual(legacyCwd(path.resolve('/t'), '/f', ws), path.resolve('/t'));
    assert.strictEqual(legacyCwd('sub', '/f', ws), path.join(ws, 'sub'));
    assert.strictEqual(legacyCwd('${workspaceFolder}/x', '/f', ws), path.join(ws, 'x'));
  });
  it('a .gsp work directory wins for normal runs', () => {
    assert.strictEqual(runWorkDir('/t', true, '/gsp', '/f'), '/gsp');
    assert.strictEqual(runWorkDir('/t', false, '/main', '/f'), path.normalize('/t'));
    assert.strictEqual(runWorkDir(undefined, false, '/main', '/f'), '/main');
    assert.strictEqual(runWorkDir(undefined, false, undefined, '/f'), '/f');
  });
});

describe('editor open location', () => {
  it('maps new and 0.1.x values', () => {
    assert.strictEqual(columnFor('beside'), COLUMN_BESIDE);
    assert.strictEqual(columnFor('Beside'), COLUMN_BESIDE);
    assert.strictEqual(columnFor('Active'), COLUMN_ACTIVE);
    assert.strictEqual(columnFor('active'), COLUMN_ACTIVE);
    assert.strictEqual(columnFor('3'), 3);
    assert.strictEqual(columnFor('One'), 1);
    assert.strictEqual(columnFor('Nine'), 9);
    assert.strictEqual(columnFor('nine'), 9);
    assert.strictEqual(columnFor('10'), COLUMN_BESIDE);
    assert.strictEqual(columnFor('bogus'), COLUMN_BESIDE);
    assert.strictEqual(columnFor(undefined), COLUMN_BESIDE);
  });
  it('new settings beat legacy, legacy beats defaults', () => {
    assert.strictEqual(effective('a', 'b', 'c'), 'a');
    assert.strictEqual(effective(undefined, 'b', 'c'), 'b');
    assert.strictEqual(effective(undefined, undefined, 'c'), 'c');
    assert.strictEqual(effective(false, true, true), false);
    assert.deepStrictEqual(editorOpenOptions(undefined, undefined, {}), { viewColumn: COLUMN_BESIDE, preserveFocus: true });
    assert.deepStrictEqual(editorOpenOptions(undefined, undefined, { listingFileLocation: 'Two', preserveFocus: false }), { viewColumn: 2, preserveFocus: false });
    assert.deepStrictEqual(editorOpenOptions('active', true, { listingFileLocation: 'Two', preserveFocus: false }), { viewColumn: COLUMN_ACTIVE, preserveFocus: true });
  });
});

describe('gams task definition', () => {
  const ws = path.resolve('/w');
  it('defaults to the active file', () => {
    assert.deepStrictEqual(resolveTaskDef({}, { activeFile: path.join(ws, 'a.gms'), workspaceRoot: ws }), { file: path.join(ws, 'a.gms'), parameters: [], compile: false });
    assert.ok('error' in resolveTaskDef({}, { workspaceRoot: ws }));
  });
  it('resolves relative files, variables, parameters and compile', () => {
    assert.deepStrictEqual(resolveTaskDef({ file: 'm/b.gms', parameters: ['lo=3', 'x=1'], compile: true }, { workspaceRoot: ws }), { file: path.join(ws, 'm', 'b.gms'), parameters: ['lo=3', 'x=1'], compile: true });
    assert.strictEqual((resolveTaskDef({ file: '${workspaceFolder}/c.gms' }, { workspaceRoot: ws }) as { file: string }).file, path.join(ws, 'c.gms'));
    assert.ok('error' in resolveTaskDef({ file: 'rel.gms' }, {}));
    assert.deepStrictEqual((resolveTaskDef({ file: 'a.gms', parameters: 'bad' as unknown as string[] }, { workspaceRoot: ws }) as { parameters: string[] }).parameters, []);
  });
});

describe('tasks.json merge', () => {
  const t = shellTaskFromRunScript('./run.sh', '/proj');
  it('builds the shell task', () => {
    assert.deepStrictEqual(t, { label: 'GAMS project run', type: 'shell', command: './run.sh', options: { cwd: '/proj' }, problemMatcher: [] });
    assert.strictEqual(shellTaskFromRunScript('x').options, undefined);
  });
  it('appends without clobbering; same label is kept', () => {
    const old = [{ label: 'build', type: 'shell', command: 'make' }];
    const m = mergeTask(old, t);
    assert.ok(m.added);
    assert.deepStrictEqual(m.tasks, [old[0], t]);
    assert.strictEqual(old.length, 1);
    const again = mergeTask(m.tasks, t);
    assert.ok(!again.added);
    assert.strictEqual(again.tasks.length, 2);
    assert.deepStrictEqual(mergeTask(undefined, t).tasks, [t]);
  });
});
