// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { gamsEnvironment } from '../../src/sysdir';

describe('gamsEnvironment (port of Studio Application::initEnvironment)', () => {
  it('prepends sysdir and sysdir/gbin to PATH and LD_LIBRARY_PATH on Linux', () => {
    const env = gamsEnvironment('/opt/gams', { PATH: '/usr/bin', HOME: '/h' }, 'linux');
    assert.strictEqual(env.PATH, '/opt/gams:/opt/gams/gbin:/usr/bin');
    assert.strictEqual(env.LD_LIBRARY_PATH, '/opt/gams:/opt/gams/gbin');
    assert.strictEqual(env.HOME, '/h');
    assert.strictEqual(env.DYLD_LIBRARY_PATH, undefined);
  });
  it('uses ; and backslashes on Windows, keeps the Path key spelling, no LD_LIBRARY_PATH', () => {
    const env = gamsEnvironment('C:/GAMS/54', { Path: 'C:\\Windows' }, 'win32');
    assert.strictEqual(env.Path, 'C:\\GAMS\\54;C:\\GAMS\\54\\gbin;C:\\Windows');
    assert.strictEqual(env.PATH, undefined);
    assert.strictEqual(env.LD_LIBRARY_PATH, undefined);
  });
  it('sets DYLD_LIBRARY_PATH on macOS and does not mutate the base env', () => {
    const base = { PATH: '/usr/bin' };
    const env = gamsEnvironment('/Library/GAMS', base, 'darwin');
    assert.strictEqual(env.DYLD_LIBRARY_PATH, '/Library/GAMS:/Library/GAMS/gbin');
    assert.strictEqual(base.PATH, '/usr/bin');
  });
});
