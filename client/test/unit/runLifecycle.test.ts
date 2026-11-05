// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { EventEmitter } from 'events';
import { attachRun } from '../../src/run/runLifecycle';

function setup() {
  const logs: string[] = [];
  let activeRun: object | undefined;
  let proc: object | undefined;
  let idle = 0;
  let finalized = 0;
  const start = () => {
    const p = new EventEmitter();
    const run = {};
    activeRun = run;
    proc = p;
    attachRun(p, { end() {} }, {
      isCurrentRun: () => activeRun === run,
      isCurrentProc: () => proc === p,
      appendLine: (t) => logs.push(t),
      onProcFinished: () => { proc = undefined; idle++; },
      onFinalized: () => { finalized++; },
    }, 10_000);
    return p;
  };
  return { start, logs, idle: () => idle, finalized: () => finalized, running: () => proc !== undefined };
}

describe('attachRun', () => {
  it('exit -> idle, close -> flush and finalize', () => {
    const s = setup();
    const p = s.start();
    p.emit('exit', 0, null);
    assert.strictEqual(s.running(), false);
    assert.strictEqual(s.logs.length, 0);
    p.emit('close', 0, null);
    assert.deepStrictEqual(s.logs, ['*** Process ended with exit code 0']);
    assert.strictEqual(s.finalized(), 1);
  });

  it('late close of an old run does not touch run #2', () => {
    const s = setup();
    const p1 = s.start();
    p1.emit('exit', 0, null);
    const p2 = s.start();
    p1.emit('close', 0, null);
    assert.strictEqual(s.running(), true);
    assert.strictEqual(s.idle(), 1);
    assert.deepStrictEqual(s.logs, []);
    assert.strictEqual(s.finalized(), 0);
    p2.emit('exit', 1, null);
    p2.emit('close', 1, null);
    assert.deepStrictEqual(s.logs, ['*** Process ended with exit code 1']);
  });

  it('spawn error finalizes once', () => {
    const s = setup();
    const p = s.start();
    p.emit('error', new Error('boom'));
    assert.deepStrictEqual(s.logs, ['*** Could not start GAMS: boom']);
    assert.strictEqual(s.running(), false);
  });
});
