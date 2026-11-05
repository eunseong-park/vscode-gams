// SPDX-License-Identifier: GPL-3.0-or-later
// GamsDebugSession end to end against a fake `gams` that replays the recorded GAMScom
// transcript of the include model (real GAMS 54.6.1 traffic, paths replaced by the test dir).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GamsDebugSession, splitParameters } from '../../src/debug/debugSession';

const FAKE_GAMS = String.raw`#!/usr/bin/env node
const net = require('net'); const fs = require('fs');
const port = Number(process.argv.find((a) => /^DebugPort=/i.test(a)).split('=')[1]);
const W = process.cwd();
const calls = [];
const s = net.connect(port, '127.0.0.1', () => {
  const chunks = [
    'features\n1\n\0',
    'linesMap\n/work/main.gms|!4=4\n/work/data1.inc|0=4|2=6\n\0',
    '|!3=7\n/work/data2.inc|0=7|3=10\n/work/data1.inc|?3=10\n\0',
    '|4=11\n/work/main.gms|?4=11|5=12|!7=14\n\0',
    '/work/bat.inc|0=14|2=16\n/work/main.gms|?7=16|9=18\n\0|10=19|12=21|13=22\n\0linesMapDone\n\0',
  ];
  for (const c of chunks) s.write(c.split('/work').join(W));
});
let bps = []; let buf = ''; let runs = 0;
s.setEncoding('utf8');
s.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\t')) >= 0) {
    const call = buf.slice(0, i); buf = buf.slice(i + 1);
    calls.push(call);
    const [kw, arg] = call.split('\n');
    if (kw === 'addBP') bps.push(...arg.split('|').map(Number));
    if (kw === 'run' && runs++ === 0) s.write('paused\n' + Math.min(...bps) + '\n\0');
    else if (kw === 'run') { fs.writeFileSync(W + '/calls.json', JSON.stringify(calls)); s.end(); setTimeout(() => process.exit(0), 50); }
    if (kw === 'stepLine') s.write('paused\n19\n\0');
    if (kw === 'writeGDX') { fs.writeFileSync(arg, 'gdx'); s.write('gdxReady\n' + arg + '\n\0'); }
  }
});
`;

type Msg = { type: string; event?: string; command?: string; request_seq?: number; body?: any; success?: boolean };

describe('GamsDebugSession with a replaying fake GAMS', function () {
  if (process.platform === 'win32') return;
  this.timeout(10000);
  let dir: string;
  let sysdir: string;

  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gamsdbg-')));
    sysdir = path.join(dir, 'sys');
    fs.mkdirSync(sysdir);
    fs.writeFileSync(path.join(sysdir, 'gams'), FAKE_GAMS, { mode: 0o755 });
    for (const f of ['main.gms', 'data1.inc', 'data2.inc', 'bat.inc']) fs.writeFileSync(path.join(dir, f), '* test\n');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('maps breakpoints, stops, shows the frame and GDX symbols, and runs to the end', async () => {
    const msgs: Msg[] = [];
    const waiters: [(m: Msg) => boolean, (m: Msg) => void][] = [];
    const released: string[] = [];
    const session = new GamsDebugSession((m) => {
      msgs.push(m as Msg);
      for (let i = 0; i < waiters.length; i++) if (waiters[i][0](m as Msg)) waiters.splice(i--, 1)[0][1](m as Msg);
    }, {
      gdx: {
        symbols: async () => [{ index: 1, name: 'p', dim: 1, kind: 'Parameter', records: 2, text: 'param', domain: ['i'] }],
        records: async () => ({ total: 3, records: [{ keys: ['i1'], values: [1.5] }, { keys: ['i2'], values: [2e300] }] }),
        release: async (p) => { released.push(p); },
      },
    });
    const wait = (pred: (m: Msg) => boolean): Promise<Msg> => new Promise((r) => waiters.push([pred, r]));
    let seq = 1;
    const req = (command: string, args?: unknown): Promise<Msg> => {
      const s = seq++;
      const p = wait((m) => m.type === 'response' && m.request_seq === s);
      session.handleMessage({ seq: s, type: 'request', command, arguments: args } as { type: string });
      return p;
    };
    const ev = (e: string) => wait((m) => m.type === 'event' && m.event === e);

    await req('initialize', { adapterID: 'gams' });
    const initialized = ev('initialized');
    const launch = await req('launch', { program: path.join(dir, 'main.gms'), sysdir, parameters: '--a=1' });
    assert.ok(launch.success, JSON.stringify(launch));
    await initialized;

    const bp = await req('setBreakpoints', { source: { path: path.join(dir, 'main.gms') }, breakpoints: [{ line: 6 }] });
    assert.deepStrictEqual(bp.body.breakpoints.map((b: any) => [b.verified, b.line]), [[true, 9]]);
    const other = await req('setBreakpoints', { source: { path: path.join(dir, 'other.gms') }, breakpoints: [{ line: 1 }] });
    assert.strictEqual(other.body.breakpoints[0].verified, false);
    const locs = await req('breakpointLocations', { source: { path: path.join(dir, 'main.gms') }, line: 1, endLine: 10 });
    assert.deepStrictEqual(locs.body.breakpoints, [{ line: 5 }, { line: 9 }, { line: 10 }]);

    const stopped = ev('stopped');
    await req('configurationDone');
    const st = await stopped;
    assert.strictEqual(st.body.reason, 'breakpoint');
    const trace = await req('stackTrace', { threadId: 1 });
    const frame = trace.body.stackFrames[0];
    assert.strictEqual(frame.name, 'main  (LST line: 18)');
    assert.strictEqual(frame.line, 9);
    assert.strictEqual(frame.source.path, path.join(dir, 'main.gms'));

    const scopes = await req('scopes', { frameId: 1 });
    const vars = await req('variables', { variablesReference: scopes.body.scopes[0].variablesReference });
    assert.strictEqual(vars.body.variables[0].name, 'p');
    assert.match(vars.body.variables[0].value, /^Parameter\(i\)\s+\[2 records\]\s+param$/);
    const recs = await req('variables', { variablesReference: vars.body.variables[0].variablesReference });
    assert.deepStrictEqual(recs.body.variables.map((v: any) => [v.name, v.value]).slice(0, 2), [['i1', '1.5'], ['i2', 'NA']]);
    assert.strictEqual(recs.body.variables.length, 3); // "… 1 more record"
    const snap = await req('gamsSnapshot');
    assert.strictEqual(snap.body.gdx, path.join(dir, 'temp' + /temp(\d+)/.exec(snap.body.gdx)![1] + '.gdx'));
    assert.ok(released.includes(snap.body.gdx));

    // a breakpoint change while paused is sent immediately (delBP/addBP)
    await req('setBreakpoints', { source: { path: path.join(dir, 'main.gms') }, breakpoints: [{ line: 10 }] });
    const stepped = ev('stopped');
    await req('next', { threadId: 1 });
    const s2 = await stepped;
    assert.strictEqual(s2.body.reason, 'breakpoint'); // stepLine landed on contLN 19 = main:10
    await req('stackTrace', { threadId: 1 });
    await req('variables', { variablesReference: 1 }); // waits for gdxReady
    const terminated = ev('terminated');
    await req('continue', { threadId: 1 });
    await terminated;
    assert.ok(msgs.some((m) => m.event === 'exited' && m.body.exitCode === 0), msgs.filter((m) => m.event === 'output').map((m) => m.body.output).join(''));

    const calls: string[] = JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf8'));
    assert.deepStrictEqual(calls.map((c) => c.replace(dir, '/work')), [
      'addBP\n18', 'run', 'writeGDX\n/work/' + path.basename(snap.body.gdx), 'delBP\n18', 'addBP\n19', 'stepLine',
      'writeGDX\n/work/' + path.basename(snap.body.gdx), 'run',
    ]);
    const out = msgs.filter((m) => m.event === 'output').map((m) => m.body.output).join('');
    assert.match(out, /DebugPort=\d+ --a=1 rf="main\.ref"/);
    // the temp GDX is removed after the session (MainWindow::stopDebugServer)
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!fs.existsSync(snap.body.gdx));
  });

  it('splits a parameter string', () => {
    assert.deepStrictEqual(splitParameters('a=1  --x="b c" o=\'my file.lst\''), ['a=1', '--x="b c"', "o='my file.lst'"]);
  });
});
