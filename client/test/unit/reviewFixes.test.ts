// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, Writable } from 'stream';
import { beginBusy, CoalescedRunner, isBusy } from '../../src/run/busy';
import { buildRefCompileArgs } from '../../src/run/refUpdate';
import { encodeCall, splitBpArgs } from '../../src/debug/protocol';
import { resolveTargetDir } from '../../src/modellib/glb';
import { csvLine, listRow, safeLabel, copyText } from '../../src/views/gdx/csv';

describe('busy registry', () => {
  it('counts nested activities', () => {
    const a = beginBusy();
    const b = beginBusy();
    assert.ok(isBusy());
    a(); a();
    assert.ok(isBusy());
    b();
    assert.ok(!isBusy());
  });
  it('skips while busy, queues exactly one follow-up during a compile', async () => {
    let busy = false;
    let runs = 0;
    let release!: () => void;
    const r = new CoalescedRunner(() => { runs++; return new Promise<void>((res) => { release = res; }); }, () => busy);
    busy = true;
    assert.strictEqual(r.request(), false);
    assert.strictEqual(runs, 0);
    busy = false;
    assert.ok(r.request());
    r.request(); r.request(); r.request();
    assert.strictEqual(runs, 1);
    release();
    await new Promise((res) => setTimeout(res, 5));
    assert.strictEqual(runs, 2);
    release();
    await new Promise((res) => setTimeout(res, 5));
    assert.strictEqual(runs, 2);
  });
});

describe('reference compile args', () => {
  it('redirects o= and rf= to the temp dir, dropping user values', () => {
    const { args, refPath } = buildRefCompileArgs('/w/m.gms', ['o=mine.lst', 'rf=x.ref', 'x=b'], '/tmp/t');
    assert.strictEqual(refPath, path.join('/tmp/t', 'm.ref'));
    assert.ok(!args.includes('o=mine.lst') && !args.includes('rf=x.ref'));
    assert.ok(args.includes('x=b') && args.includes('ACTION=C'));
    assert.ok(args.includes(`rf="${refPath}"`));
    assert.ok(args.includes(`o="${path.join('/tmp/t', 'm.lst')}"`));
  });
});

describe('addBP splitting', () => {
  it('100 breakpoints fit into packets', () => {
    const lines = Array.from({ length: 100 }, (_, i) => 100000 + i * 7);
    const args = splitBpArgs(lines);
    assert.ok(args.length > 1 && args.every((a) => a.length <= 240));
    assert.deepStrictEqual(args.join('|').split('|').map(Number), lines);
    let dropped = false;
    const packets = encodeCall('addBP', args, () => { dropped = true; });
    assert.ok(!dropped);
    assert.ok(packets.every((p) => p.length < 256));
    const got = packets.flatMap((p) => p.replace(/\t$/, '').split('\n').slice(1)).join('|').split('|').map(Number);
    assert.deepStrictEqual(got, lines);
  });
});

describe('target dir resolution', () => {
  it('expands ~, resolves relative, validates', () => {
    assert.deepStrictEqual(resolveTargetDir('~/x', '/ws', '/home/u'), { dir: path.resolve('/home/u/x') });
    assert.deepStrictEqual(resolveTargetDir('~', '/ws', '/home/u'), { dir: path.resolve('/home/u') });
    assert.deepStrictEqual(resolveTargetDir('sub/d', '/ws', '/home/u'), { dir: path.resolve('/ws/sub/d') });
    assert.ok('error' in resolveTargetDir('  ', '/ws', '/h'));
    const f = path.join(os.tmpdir(), `rf-${process.pid}.txt`);
    fs.writeFileSync(f, 'x');
    assert.ok('error' in resolveTargetDir(f, '/ws', '/h'));
    fs.rmSync(f);
  });
});

describe('csv label safety', () => {
  it('prefixes labels but not numbers or clipboard text', () => {
    assert.strictEqual(safeLabel('=1+1'), "'=1+1");
    assert.strictEqual(safeLabel('@x'), "'@x");
    assert.strictEqual(safeLabel('abc'), 'abc');
    const spec = { domain: ['i'], isSet: false, isParameter: true, valueNames: ['Value'], valueCols: [0] };
    assert.deepStrictEqual(listRow(spec, ['-a'], [-5]), ["'-a", '-5']);
    assert.deepStrictEqual(listRow(spec, ['a'], ['-INF']), ['a', '-INF']);
    assert.strictEqual(csvLine(['a', 'b']), 'a,b\n');
    assert.strictEqual(copyText([['=a']], ','), '=a');
  });
});

describe('export LineWriter', () => {
  it('rejects instead of hanging on stream errors', async () => {
    const { LineWriter } = await import('../../src/views/gdx/lineWriter');
    const w = new LineWriter('x', () => {
      const s = new Writable({ highWaterMark: 1, write(_c, _e, cb) { setImmediate(() => cb(new Error('disk full'))); } });
      return s as unknown as fs.WriteStream;
    });
    await assert.rejects(async () => { await w.write('hello world'); await w.write('more'); await w.close(); }, /disk full/);
    const ok = new LineWriter('x', () => new PassThrough() as unknown as fs.WriteStream);
    await ok.write('a');
    await ok.close();
  });
});
