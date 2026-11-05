// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GamsProcess } from '../../src/run/gamsProcess';

// Fake `gams` executables (shell scripts) in a temporary sysdir; POSIX only.
function fakeSysdir(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gams-stop-'));
  const exe = path.join(dir, 'gams');
  fs.writeFileSync(exe, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(exe, 0o755);
  return dir;
}

function exited(p: GamsProcess): Promise<{ code: number | null; sig: string | null; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => p.once('exit', (code, sig) => resolve({ code, sig, ms: Date.now() - t0 })));
}

(process.platform === 'win32' ? describe.skip : describe)('GamsProcess graceful stop', function () {
  this.timeout(10000);

  it('ends via interrupt when GAMS honours it (no kill)', async () => {
    const p = new GamsProcess(fakeSysdir("trap 'exit 3' INT\nwhile :; do sleep 0.05; done"), [], os.tmpdir());
    p.start();
    await new Promise((r) => setTimeout(r, 200));
    const done = exited(p);
    p.stop(3000);
    const r = await done;
    assert.strictEqual(r.code, 3);
    assert.strictEqual(r.sig, null);
    assert.ok(r.ms < 2000, `took ${r.ms}ms`);
  });

  it('kills after the grace period when the interrupt is ignored', async () => {
    const p = new GamsProcess(fakeSysdir("trap '' INT\nwhile :; do sleep 0.05; done"), [], os.tmpdir());
    p.start();
    await new Promise((r) => setTimeout(r, 200));
    const done = exited(p);
    p.stop(500);
    const r = await done;
    assert.strictEqual(r.sig, 'SIGKILL');
    assert.ok(r.ms >= 450, `killed too early: ${r.ms}ms`);
  });

  it('a second stop kills immediately; grace 0 is Studio hard kill', async () => {
    const p = new GamsProcess(fakeSysdir("trap '' INT\nwhile :; do sleep 0.05; done"), [], os.tmpdir());
    p.start();
    await new Promise((r) => setTimeout(r, 200));
    const done = exited(p);
    p.stop(5000);
    p.stop(5000);
    const r = await done;
    assert.strictEqual(r.sig, 'SIGKILL');
    assert.ok(r.ms < 2000);
    const q = new GamsProcess(fakeSysdir("trap '' INT\nwhile :; do sleep 0.05; done"), [], os.tmpdir());
    q.start();
    await new Promise((r2) => setTimeout(r2, 200));
    const d2 = exited(q);
    q.stop(0);
    assert.strictEqual((await d2).sig, 'SIGKILL');
  });
});
