// SPDX-License-Identifier: GPL-3.0-or-later
// QA fixes in run/log/debug/project/sysdir code: long logs, \r in log lines, execution error locations,
// output paths (analyzeParameters), parameter tokenizing, sysdir validation, dynamic main file, debugger stop.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GamsDebugSession } from '../../src/debug/debugSession';
import { analyzePaths, buildGamsArgs, expandParameters, GamsProcess, withReference } from '../../src/run/gamsProcess';
import { LogSession, normalizeLine } from '../../src/run/logSession';
import { LogStore } from '../../src/run/logStore';
import { checkSysdir } from '../../src/sysdir';
import { parseGsp } from '../../src/project/gsp';
import { isGmsKind, resolveMainFile } from '../../src/project/mainFile';

const posix = process.platform !== 'win32';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe('normalizeLine / LogSession: \\r and line separators', () => {
  it('keeps the text after the last carriage return (Studio: overwrite the last line)', () => {
    assert.strictEqual(normalizeLine('--- progress 10%\r--- progress 50%\r--- progress 100%'), '--- progress 100%');
    assert.strictEqual(normalizeLine('abc\r'), 'abc');
    assert.strictEqual(normalizeLine('a\u2028b\u2029c\u0085d'), 'a b c d');
    assert.strictEqual(normalizeLine('plain'), 'plain');
  });

  it('a lone \\r inside a log line does not shift later lines or links', () => {
    const exists = () => true;
    const s = new LogSession({ workDir: '/w', lst: '/w/m.lst' }, exists);
    s.push('first\n--- progress 10%\r--- progress 50%\r--- progress 100%\n');
    s.push('--- m.gms(7) 2 Mb[FIL:"/w/m.gms",7,0]\r\n');
    s.push('x\u2028y\n--- m.gms(9) 2 Mb[FIL:"/w/m.gms",9,0]\n');
    const text = s.lines.map((l) => l.text).join('\n');
    // the joined text must have exactly as many lines as the session emitted (VS Code splits at \r)
    assert.strictEqual(text.split(/\r\n|\r|\n/).length, s.lines.length);
    assert.deepStrictEqual(s.lines.map((l) => l.text).slice(0, 2), ['first', '--- progress 100%']);
    const linked = s.lines.map((l, i) => [i, l.links.length > 0]).filter((x) => x[1]).map((x) => x[0]);
    assert.deepStrictEqual(linked, [2, 4]);
  });

  it('can run without retaining lines', () => {
    const got: string[] = [];
    const s = new LogSession({ workDir: '/w', lst: '/w/m.lst' }, () => false, { onLine: (l) => got.push(l.text) }, false);
    s.push('a\nb\n');
    s.end();
    assert.deepStrictEqual(got, ['a', 'b']);
    assert.strictEqual(s.lines.length, 0);
  });
});

describe('execution errors get a location (extension addition)', () => {
  const log = [
    '--- Starting execution: elapsed 0:00:00.004[LST:19]',
    '--- execerr.gms(5) 3 Mb[FIL:"/w/execerr.gms",5,0]',
    '*** Error at line 5: division by zero (0)[LST:23]',
    '--- execerr.gms(7) 3 Mb 1 Error[FIL:"/w/execerr.gms",7,0]',
    '*** Error at line 7: Execution halted: abort$1 \'custom abort message\'[LST:28]',
    '',
  ].join('\n');

  it('uses the preceding --- file(N) line', () => {
    const s = new LogSession({ workDir: '/w', lst: '/w/execerr.lst' }, () => true);
    s.push(log);
    s.end();
    assert.strictEqual(s.errors.length, 2);
    assert.deepStrictEqual(s.errors[0].source, { file: '/w/execerr.gms', line: 5, col: 0 });
    assert.strictEqual(s.errors[0].errNr, -1);
    assert.strictEqual(s.errors[0].inferred, true);
    assert.match(s.errors[0].message, /division by zero/);
    assert.strictEqual(s.errors[1].source?.line, 7);
  });

  it('compile errors keep their own location and are not marked inferred', () => {
    const s = new LogSession({ workDir: '/w', lst: '/w/m.lst' }, () => true);
    s.push('--- m.gms(2) 2 Mb[FIL:"/w/m.gms",2,0]\n*** Error 140 in /w/m.gms[ERR:"/w/m.gms",3,1][LST:12]\n   Unknown symbol\n');
    s.end();
    assert.strictEqual(s.errors[0].source?.line, 3);
    assert.ok(!s.errors[0].inferred);
  });

  it('no Problems entry when no file line precedes', () => {
    const s = new LogSession({ workDir: '/w', lst: '/w/m.lst' }, () => true);
    s.push('*** Error at line 5: division by zero (0)[LST:23]\n');
    s.end();
    assert.strictEqual(s.errors[0].source, undefined);
  });
});

describe('LogStore', () => {
  it('keeps everything below the limit', () => {
    const st = new LogStore(1000);
    for (let i = 0; i < 100; i++) st.append({ text: 'l' + i, links: [] });
    assert.strictEqual(st.lineCount, 100);
    assert.strictEqual(st.text().split('\n').length, 101);
    assert.strictEqual(st.headerLines, 0);
  });

  it('caps the in-memory log, writes the complete log to the spill file and says so', async () => {
    const dir = tmp('logstore-');
    try {
      const file = path.join(dir, 'm.log');
      const st = new LogStore(200);
      st.reset(file, 200);
      for (let i = 0; i < 1000; i++) {
        st.append({ text: 'line ' + i, links: i % 100 === 0 ? [{ start: 0, end: 4, target: { file: '/w/m.gms', line: i, col: 0 } }] : [] });
      }
      assert.ok(st.lineCount <= 200 + 20 + 1, `retained ${st.lineCount}`);
      assert.ok(st.droppedLines > 0);
      const text = st.text();
      const first = text.split('\n')[0];
      assert.match(first, /^\*\*\* Log truncated: the first \d+ of 1000 lines are not shown\. Full log: .*m\.log$/);
      assert.ok(text.endsWith('line 999\n'));
      assert.strictEqual(text.split('\n').length - 1, st.lineCount);
      // the links of dropped lines are gone, the others are still addressed per chunk
      const links = st.chunkList.flatMap((c) => c.links);
      assert.ok(links.length > 0 && links.length < 10);
      st.closeSpill();
      await new Promise((r) => setTimeout(r, 100));
      const disk = fs.readFileSync(file, 'utf8').split('\n');
      assert.strictEqual(disk.length, 1001);
      assert.strictEqual(disk[0], 'line 0');
      assert.strictEqual(disk[999], 'line 999');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('max 0 means no limit', () => {
    const st = new LogStore(0);
    for (let i = 0; i < 5000; i++) st.append({ text: 'x', links: [] });
    assert.strictEqual(st.droppedLines, 0);
    assert.strictEqual(st.lineCount, 5000);
  });

  it('survives an unwritable spill file (note says so)', async () => {
    const st = new LogStore(100);
    st.reset('/nonexistent-dir-xyz/m.log', 100);
    for (let i = 0; i < 500; i++) st.append({ text: 'x' + i, links: [] });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(st.text().split('\n')[0], /could not be written/);
  });
});

/** Fake gams printing N lines, with a link tag on every 50th (POSIX only, needs awk). */
function fakeLongGams(): string {
  const dir = tmp('gams-long-');
  const exe = path.join(dir, 'gams');
  fs.writeFileSync(exe, `#!/bin/sh
n=\${1#long}; n=\${n%.gms}
awk -v n=$n 'BEGIN{for(i=1;i<=n;i++){ if(i%50==0) print "--- m.gms(" i ") 3 Mb[FIL:\\"/w/m.gms\\"," i ",0]"; else print "--- line " i " of a long log with a little more text to be realistic"}}'
`);
  fs.chmodSync(exe, 0o755);
  return dir;
}

(posix ? describe : describe.skip)('long logs scale linearly (fake gams)', function () {
  this.timeout(120000);
  let sys: string;
  before(() => { sys = fakeLongGams(); });
  after(() => fs.rmSync(sys, { recursive: true, force: true }));

  for (const n of [100, 400]) {
    it(`${n}k lines: no event loop block over 100 ms, memory bounded`, async () => {
      const store = new LogStore(50000);
      store.reset(path.join(sys, `spill${n}.log`), 50000);
      let lines = 0;
      const session = new LogSession({ workDir: '/w', lst: '/w/m.lst' }, () => true, { onLine: (l) => { store.append(l); lines++; } }, false);
      const p = new GamsProcess(sys, [`long${n * 1000}.gms`], os.tmpdir());
      p.on('stdout', (d) => session.push(d));
      // document refresh as LogDocument does: adaptive interval, whole text each time
      let refreshes = 0;
      let timer: NodeJS.Timeout | undefined;
      const refresh = (): void => {
        timer = undefined;
        store.syncSpill();
        Buffer.byteLength(store.text()); // forces the flatten the RPC serialization needs
        refreshes++;
      };
      const tick = setInterval(() => { if (!timer) timer = setTimeout(refresh, Math.min(1500, 100 + Math.floor(store.lineCount / 100))); }, 20);
      let max = 0;
      let last = Date.now();
      const lag = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last - 5); last = now; }, 5);
      const done = new Promise<void>((resolve) => p.once('close', () => resolve()));
      p.start();
      await done;
      session.end();
      clearInterval(tick);
      if (timer) clearTimeout(timer);
      refresh(); // final refresh (the run is over)
      store.closeSpill();
      clearInterval(lag);
      assert.strictEqual(lines, n * 1000);
      assert.ok(store.lineCount <= 50000 + 2500 + 1, `retained ${store.lineCount}`);
      assert.ok(refreshes > 0);
      console.log(`      ${n}k lines: max event loop delay ${max} ms, ${refreshes} refresh(es)`);
      assert.ok(max < 100, `event loop blocked for ${max} ms`);
    });
  }
});

describe('analyzePaths (Studio analyzeParameters path logic)', () => {
  const W = path.resolve('/w');
  const gms = path.join(W, 'm.gms');
  const p = (...a: string[]) => path.resolve(W, ...a);

  it('defaults to <workdir>/<stem>.*', () => {
    const r = analyzePaths(buildGamsArgs(gms, [], false), gms, W);
    assert.strictEqual(r.lst, p('m.lst'));
    assert.strictEqual(r.log, p('m.log'));
    assert.strictEqual(r.dir, W);
  });

  it('filestem replaces the gms base name for lst / log', () => {
    const r = analyzePaths(buildGamsArgs(gms, ['filestem=abc'], false), gms, W);
    assert.strictEqual(r.lst, p('abc.lst'));
    assert.strictEqual(r.log, p('abc.log'));
    assert.strictEqual(r.stem, 'abc');
  });

  it('curdir, workdir (wdir replaces cdir, relative wdir is appended) and synonyms', () => {
    assert.strictEqual(analyzePaths(['cdir=out'], gms, W).lst, p('out', 'm.lst'));
    assert.strictEqual(analyzePaths(['curdir=out', 'wdir=sub'], gms, W).lst, p('out', 'sub', 'm.lst'));
    assert.strictEqual(analyzePaths(['curdir=out', 'workdir=' + p('abs')], gms, W).lst, p('abs', 'm.lst'));
    assert.strictEqual(analyzePaths(['workdir=wd', 'FileStem=q'], gms, W).lst, p('wd', 'q.lst'));
  });

  it('output, gdx, reference and logfile are resolved against that directory; nul removes the lst', () => {
    const r = analyzePaths(['wdir=out', 'o=my.lst', 'gdx=default', 'rf="r"', 'lf=run'], gms, W);
    assert.strictEqual(r.lst, p('out', 'my.lst'));
    assert.strictEqual(r.gdx, p('out', 'm.gdx'));
    assert.strictEqual(r.ref, p('out', 'r'));
    assert.strictEqual(r.log, p('out', 'run.log'));
    assert.strictEqual(analyzePaths(['o=nul'], gms, W).lst, undefined);
    assert.strictEqual(analyzePaths(['o=/dev/null'], gms, W).lst, undefined);
    assert.strictEqual(analyzePaths(['output=' + p('x', 'abs.lst')], gms, W).lst, p('x', 'abs.lst'));
  });

  it('withReference puts the reference file in the output directory', () => {
    const r = withReference(buildGamsArgs(gms, ['curdir=out', 'filestem=f'], false), gms, W);
    assert.strictEqual(r.refPath, p('out', 'f.ref'));
    assert.strictEqual(r.args[r.args.length - 1], 'rf="f.ref"');
    assert.strictEqual(r.paths.lst, p('out', 'f.lst'));
  });
});

describe('parameter tokenizing and display', () => {
  it('splits an entry with several parameters (Studio tokenizer) and writes key=value', () => {
    assert.deepStrictEqual(expandParameters(['lo=3 reslim=10', '--x="a b"', 'solprint=on']), ['lo=3', 'reslim=10', '--x="a b"', 'solprint=on']);
    assert.deepStrictEqual(expandParameters(['-lo 3 /reslim=5', '  ', '']), ['lo=3', 'reslim=5']);
  });

  it('an empty value is written as key= like Studio, not as a bare key', () => {
    assert.deepStrictEqual(expandParameters(['lo', '--flag']), ['lo=', '--flag=']);
  });

  it('buildGamsArgs handles multi-parameter defaultParameters', () => {
    const a = buildGamsArgs('/w/m.gms', ['lo=3 reslim=10'], false);
    assert.deepStrictEqual(a.slice(-2), ['lo=3', 'reslim=10']);
    assert.ok(buildGamsArgs('m.gms', ['a=r x=1'], true).every((x) => x !== 'ACTION=C'));
  });

  it('the Running: line shows the arguments as GAMS receives them', () => {
    const p = new GamsProcess('/sys', ['/w/m.gms', '--x="a b"', 'o="C:\\x y\\a.lst"', 'rf="m.ref"', 'plain'], '/w');
    assert.strictEqual(p.commandLine, `${path.join('/sys', process.platform === 'win32' ? 'gams.exe' : 'gams')} /w/m.gms --x="a b" o="C:\\x y\\a.lst" rf="m.ref" plain`);
  });
});

describe('checkSysdir', () => {
  let root: string;
  before(() => {
    root = tmp('sysdir-');
    const exe = process.platform === 'win32' ? 'gams.exe' : 'gams';
    for (const d of ['good', 'old/46', 'old/47', 'win64/24.9', 'win64/50']) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
    for (const d of ['good', 'old/46', 'old/47', 'win64/24.9', 'win64/50']) fs.writeFileSync(path.join(root, d, exe), '');
    // macOS framework layout: Versions/<major>/Resources/gams, plus the Current symlink-like dir
    for (const d of ['fw/51/Resources', 'fw/52/Resources', 'fw/Current/Resources']) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
      fs.writeFileSync(path.join(root, d, exe), '');
    }
    fs.mkdirSync(path.join(root, 'empty'));
    fs.writeFileSync(path.join(root, 'some.txt'), '');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exeName = process.platform === 'win32' ? 'gams.exe' : 'gams';

  it('accepts a directory with the executable, with surrounding blanks and quotes', () => {
    assert.deepStrictEqual(checkSysdir(` "${path.join(root, 'good')}" `, ''), { dir: path.join(root, 'good'), source: 'setting' });
  });

  it('a setting that points at the executable yields its directory', () => {
    assert.strictEqual(checkSysdir(path.join(root, 'good', exeName), '').dir, path.join(root, 'good'));
  });

  it('explains missing directories, folders without gams and other files', () => {
    assert.match(checkSysdir(path.join(root, 'nope'), '').problem ?? '', /does not exist/);
    assert.match(checkSysdir(path.join(root, 'empty'), '').problem ?? '', new RegExp(`does not contain ${exeName}`));
    assert.match(checkSysdir(path.join(root, 'some.txt'), '').problem ?? '', /is a file/);
    assert.strictEqual(checkSysdir(path.join(root, 'nope'), '').dir, undefined);
  });

  it('auto-detects the newest install, also in the C:\\GAMS\\win64\\NN layout', () => {
    assert.strictEqual(checkSysdir('', '', [[path.join(root, 'old')]]).dir, path.join(root, 'old', '47'));
    assert.strictEqual(checkSysdir('', '', [[path.join(root, 'nothing')], [path.join(root, 'win64')]]).dir, path.join(root, 'win64', '50'));
    // both layouts under one root: the newest version wins
    assert.strictEqual(checkSysdir('', '', [[path.join(root, 'old'), path.join(root, 'win64')]]).dir, path.join(root, 'win64', '50'));
  });

  it('auto-detects the newest macOS framework install (Versions/<major>/Resources)', () => {
    assert.strictEqual(checkSysdir('', '', [[path.join(root, 'fw')]]).dir, path.join(root, 'fw', '52', 'Resources'));
  });

  it('reports a problem when nothing is found', () => {
    const r = checkSysdir('', '', [[path.join(root, 'nothing')]]);
    assert.strictEqual(r.dir, undefined);
    assert.match(r.problem ?? '', /gams\.sysdir/);
  });
});

describe('dynamic main file (Studio processMainFileDynamics)', () => {
  const gsp = (dyn: boolean) => parseGsp(JSON.stringify({
    name: 'p', path: '.', workDir: '.', file: 'main.gms', dynamicMainFile: dyn,
    nodes: [{ file: 'main.gms' }, { file: 'other.gms' }, { file: 'sub.inc' }, { file: 'notes.txt' }],
  }), path.resolve('/w/p.gsp'))!;

  it('the active gams source file becomes the main file of a dynamic project', () => {
    const p = gsp(true);
    const r = resolveMainFile({ active: path.resolve('/w/other.gms'), projects: [p], includers: [] });
    assert.deepStrictEqual(r, { kind: 'project', project: p, main: path.resolve('/w/other.gms') });
    const inc = resolveMainFile({ active: path.resolve('/w/sub.inc'), projects: [p], includers: [] });
    assert.strictEqual(inc.kind === 'project' && inc.main, path.resolve('/w/sub.inc'));
  });

  it('other files of a dynamic project and all files of a static one run the project main file', () => {
    const dyn = gsp(true);
    const r = resolveMainFile({ active: path.resolve('/w/notes.txt'), projects: [dyn], includers: [] });
    assert.strictEqual(r.kind === 'project' && r.main, path.resolve('/w/main.gms'));
    const st = gsp(false);
    const r2 = resolveMainFile({ active: path.resolve('/w/other.gms'), projects: [st], includers: [] });
    assert.strictEqual(r2.kind === 'project' && r2.main, path.resolve('/w/main.gms'));
    assert.ok(isGmsKind('a.GMS') && isGmsKind('a.inc') && isGmsKind('a.dmp') && !isGmsKind('a.txt'));
  });
});

// A fake gams that connects to the debug port, pauses on the first step and then ignores SIGINT.
const PAUSING_GAMS = String.raw`#!/usr/bin/env node
const net = require('net');
process.on('SIGINT', () => {});
const port = Number(process.argv.find((a) => /^DebugPort=/i.test(a)).split('=')[1]);
const W = process.cwd();
const s = net.connect(port, '127.0.0.1', () => {
  s.write(('features\n1\n\0' + 'linesMap\n/work/main.gms|!4=4\n/work/data.inc|0=4\n/work/main.gms|?4=5|5=6|6=7\n\0linesMapDone\n\0').split('/work').join(W));
});
let buf = '';
s.setEncoding('utf8');
s.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\t')) >= 0) {
    const call = buf.slice(0, i); buf = buf.slice(i + 1);
    const [kw, arg] = call.split('\n');
    if (kw === 'run' || kw === 'stepLine') s.write('paused\n6\n\0');
    if (kw === 'writeGDX') { require('fs').writeFileSync(arg, 'gdx'); s.write('gdxReady\n' + arg + '\n\0'); }
  }
});
setInterval(() => {}, 1000);
`;

(posix ? describe : describe.skip)('debugger', function () {
  this.timeout(20000);
  let dir: string;
  let sysdir: string;
  before(() => {
    dir = tmp('gamsdbg2-');
    sysdir = path.join(dir, 'sys');
    fs.mkdirSync(sysdir);
    fs.writeFileSync(path.join(sysdir, 'gams'), PAUSING_GAMS, { mode: 0o755 });
    for (const f of ['main.gms', 'data.inc']) fs.writeFileSync(path.join(dir, f), '* test\n');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  type Msg = { type: string; event?: string; request_seq?: number; body?: any; success?: boolean };
  function harness() {
    const msgs: Msg[] = [];
    const waiters: [(m: Msg) => boolean, (m: Msg) => void][] = [];
    const session = new GamsDebugSession((m) => {
      msgs.push(m as Msg);
      for (let i = 0; i < waiters.length; i++) if (waiters[i][0](m as Msg)) waiters.splice(i--, 1)[0][1](m as Msg);
    });
    const wait = (pred: (m: Msg) => boolean): Promise<Msg> => new Promise((r) => waiters.push([pred, r]));
    let seq = 1;
    const req = (command: string, args?: unknown): Promise<Msg> => {
      const s = seq++;
      const p = wait((m) => m.type === 'response' && m.request_seq === s);
      session.handleMessage({ seq: s, type: 'request', command, arguments: args } as { type: string });
      return p;
    };
    return { session, msgs, req, ev: (e: string) => wait((m) => m.type === 'event' && m.event === e) };
  }

  it('Stop while paused kills GAMS at once (SIGINT is ignored while paused)', async () => {
    const saved = GamsProcess.defaultGraceMs;
    GamsProcess.defaultGraceMs = 10000;
    try {
      const h = harness();
      await h.req('initialize', {});
      const init = h.ev('initialized');
      const l = await h.req('launch', { program: path.join(dir, 'main.gms'), sysdir, stopOnEntry: true });
      assert.ok(l.success, JSON.stringify(l));
      await init;
      const stopped = h.ev('stopped');
      await h.req('configurationDone');
      await stopped;
      const t0 = Date.now();
      const terminated = h.ev('terminated');
      await h.req('terminate');
      await terminated;
      assert.ok(Date.now() - t0 < 3000, `terminate took ${Date.now() - t0} ms`);
    } finally {
      GamsProcess.defaultGraceMs = saved;
    }
  });

  it('a breakpoint in a data-only include says so instead of "not part of the run"', async () => {
    const h = harness();
    await h.req('initialize', {});
    const init = h.ev('initialized');
    await h.req('launch', { program: path.join(dir, 'main.gms'), sysdir, stopOnEntry: true });
    await init;
    const inc = await h.req('setBreakpoints', { source: { path: path.join(dir, 'data.inc') }, breakpoints: [{ line: 1 }] });
    assert.strictEqual(inc.body.breakpoints[0].verified, false);
    assert.match(inc.body.breakpoints[0].message, /part of the run but has no executable statement/);
    const other = await h.req('setBreakpoints', { source: { path: path.join(dir, 'other.gms') }, breakpoints: [{ line: 1 }] });
    assert.match(other.body.breakpoints[0].message, /not part of the run/);
    const terminated = h.ev('terminated');
    await h.req('terminate');
    await terminated;
  });
});
