// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { availableTargets, listInstallations, overridingScopes, readGamsVersion, shortVersion } from '../../src/installations';
import { gamsExecutableName } from '../../src/sysdir';

function mkInstall(root: string, name: string, stamp?: string): string {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, gamsExecutableName()), '');
  if (stamp !== undefined) fs.writeFileSync(path.join(d, 'gamsstmp.txt'), stamp);
  return d;
}

describe('readGamsVersion', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gamsver-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads the first x.y.z of gamsstmp.txt', () => {
    const a = mkInstall(tmp, 'a', 'leg 54.6.1 (Jun 15, 2026): something\nsecond 1.2.3\n');
    const b = mkInstall(tmp, 'b', 'wei 49.6.0 (Feb 15, 2025): something\r\n');
    assert.strictEqual(readGamsVersion(a), '54.6.1');
    assert.strictEqual(readGamsVersion(b), '49.6.0');
  });
  it('falls back to the folder name when the file is missing', () => {
    assert.strictEqual(readGamsVersion(mkInstall(tmp, 'gams54.6_platform')), '54.6');
    assert.strictEqual(readGamsVersion(mkInstall(tmp, '49')), '49');
    assert.strictEqual(readGamsVersion(mkInstall(tmp, 'gams-latest')), 'unknown');
  });
  it('falls back when the file has no version', () => {
    assert.strictEqual(readGamsVersion(mkInstall(tmp, '51', 'garbage\n')), '51');
  });
  it('shortVersion keeps major.minor', () => {
    assert.strictEqual(shortVersion('54.6.1'), '54.6');
    assert.strictEqual(shortVersion('49'), '49');
    assert.strictEqual(shortVersion('unknown'), 'unknown');
  });
});

describe('listInstallations', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gamslist-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('lists newest first and ignores folders without gams', () => {
    mkInstall(tmp, 'gams49.6_x', 'wei 49.6.0 (x)\n');
    mkInstall(tmp, 'gams54.6_x', 'leg 54.6.1 (x)\n');
    mkInstall(tmp, 'gams51.3_x', 'leg 51.3.0 (x)\n');
    fs.mkdirSync(path.join(tmp, 'empty'));
    const l = listInstallations('', [[tmp]]);
    assert.deepStrictEqual(l.map((i) => i.version), ['54.6.1', '51.3.0', '49.6.0']);
    assert.ok(l.every((i) => i.source === 'install'));
  });
  it('dedupes a PATH hit against the same folder (PATH wins) and symlinks', function () {
    const a = mkInstall(tmp, 'gams54.6_x', 'leg 54.6.1 (x)\n');
    mkInstall(tmp, 'gams49.6_x', 'wei 49.6.0 (x)\n');
    try { fs.symlinkSync(a, path.join(tmp, 'current')); } catch { this.skip(); }
    const l = listInstallations(a, [[tmp]]);
    assert.strictEqual(l.length, 2);
    assert.strictEqual(l[0].source, 'path');
    assert.strictEqual(l[0].version, '54.6.1');
  });
  it('includes a PATH-only installation and sorts it among the others', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gamspath-'));
    try {
      const p = mkInstall(outside, 'g', 'leg 60.0.0 (x)\n');
      mkInstall(tmp, 'gams54.6_x', 'leg 54.6.1 (x)\n');
      const l = listInstallations(p, [[tmp]]);
      assert.deepStrictEqual(l.map((i) => [i.version, i.source]), [['60.0.0', 'path'], ['54.6.1', 'install']]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('returns an empty list when nothing is found', () => {
    assert.deepStrictEqual(listInstallations('', [[path.join(tmp, 'nope')]]), []);
  });
});

describe('target selection', () => {
  it('offers the workspace only when a folder is open', () => {
    assert.deepStrictEqual(availableTargets(true), ['workspace', 'global']);
    assert.deepStrictEqual(availableTargets(false), ['global']);
  });
  it('finds more specific scopes that override the choice', () => {
    assert.deepStrictEqual(overridingScopes('global', { workspaceValue: 'x', workspaceFolderValue: 'y' }), ['workspaceFolder', 'workspace']);
    assert.deepStrictEqual(overridingScopes('workspace', { globalValue: 'g', workspaceValue: 'x', workspaceFolderValue: 'y' }), ['workspaceFolder']);
    assert.deepStrictEqual(overridingScopes('workspace', { globalValue: 'g', workspaceValue: 'x' }), []);
    assert.deepStrictEqual(overridingScopes('global', { workspaceValue: '' }), []);
  });
});
