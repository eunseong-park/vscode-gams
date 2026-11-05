// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { NeosClient, NeosError } from '../../src/neos/neosClient';
import { NeosJob, NeosJobOptions } from '../../src/neos/neosJob';
import { encodeFault, encodeResponse, parseCall, XmlRpcValue } from '../../src/neos/xmlrpc';
import { LogSession } from '../../src/run/logSession';

// Local mock NEOS XML-RPC server on 127.0.0.1 (no external host is contacted) and a fake GAMS sysdir.

interface Call { method: string; params: XmlRpcValue[] }
type Handler = (c: Call, n: number) => XmlRpcValue | Promise<XmlRpcValue> | { fault: [number, string] } | { hang: true };

interface Mock { url: string; calls: Call[]; close(): Promise<void> }

function startMock(handlers: Record<string, Handler>): Promise<Mock> {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const sockets = new Set<import('net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      void (async () => {
        assert.strictEqual(req.headers['content-type'], 'text/xml');
        assert.strictEqual(req.headers['user-agent'], 'neos/1.0');
        const call = parseCall(Buffer.concat(chunks).toString('utf8'));
        calls.push(call);
        counts[call.method] = (counts[call.method] ?? 0) + 1;
        const h = handlers[call.method];
        if (!h) { res.writeHead(200); res.end(encodeFault(1, `no handler ${call.method}`)); return; }
        const r = await h(call, counts[call.method]);
        if (r && typeof r === 'object' && 'hang' in r) return; // never answer
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        if (r && typeof r === 'object' && 'fault' in r) res.end(encodeFault(...(r as { fault: [number, string] }).fault));
        else res.end(encodeResponse(r as XmlRpcValue));
      })();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    resolve({
      url: `http://127.0.0.1:${port}`,
      calls,
      close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }),
    });
  }));
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fake sysdir with stub gams / gmsunzip / gmscmpun.txt. */
function fakeSysdir(gamsBody?: string): string {
  const dir = tmp('neos-sys-');
  const gams = gamsBody ?? `
for a in "$@"; do case "$a" in xsave=*) v=$(printf %s "\${a#xsave=}" | tr -d '"');; esac; done
printf '%s\\n' "$@" > "$(dirname "$0")/gams-args.txt"
pwd > "$(dirname "$0")/gams-cwd.txt"
echo "--- Job m Start"
echo "G00 data" > "$v.g00"
echo "--- Job m done"
`;
  fs.writeFileSync(path.join(dir, 'gams'), `#!/bin/sh\n${gams}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'gmsunzip'), `#!/bin/sh
printf '%s\\n' "$@" > "$(dirname "$0")/unzip-args.txt"
cp "$2" "$(dirname "$0")/zip-copy.bin"
echo "Archive:  solver-output.zip"
echo "  inflating: solve.lst"
echo "  inflating: gams.gdx"
echo "  inflating: m.lxi"
echo "lst" > solve.lst; echo "gdx" > gams.gdx; echo "lxi" > m.lxi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'gmscmpun.txt'), 'CBC 2011 5 0001 1 0 2 LP MIP RMIP\ngmsgenus.run\ngmsgenux.out\nDEFAULTS\n');
  return dir;
}

const ZIP = Buffer.from('PK-fake-zip-bytes');
const LOG1 = '--- Job m Start\n*** Error 1 in /var/lib/condor/execute/dir_77/gamsexec/MODEL.gms[LST:3]\n';
const LOG2 = 'second chunk\n%% GAMS LOGFILE %%%%\nclone text\n';

function lifecycleHandlers(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const chunks = [Buffer.from(LOG1), Buffer.from(LOG2)];
  const offsets = [0, chunks[0].length, chunks[0].length + chunks[1].length];
  return {
    ping: () => ['NeosServer is alive'],
    submitJob: () => [4711, 'secret'],
    getJobStatus: (_c, n) => (n < 2 ? 'Waiting' : n < 3 ? 'Running' : 'Done'),
    getIntermediateResultsNonBlocking: (c) => {
      const off = c.params[2] as number;
      const i = offsets.indexOf(off);
      if (i < 0 || i >= chunks.length) return [Buffer.alloc(0), off];
      return [chunks[i], offsets[i + 1]];
    },
    getCompletionCode: () => 'Normal',
    getFinalResultsNonBlocking: () => Buffer.from('final results\n'),
    getOutputFile: () => ZIP,
    killJob: () => 'killed',
    ...extra,
  };
}

function baseOpts(sys: string, work: string, url: string, lines: string[], extra: Partial<NeosJobOptions> = {}): NeosJobOptions {
  const gms = path.join(work, 'm.gms');
  fs.writeFileSync(gms, 'display "hi";\n');
  return {
    sysdir: sys, gmsFile: gms, workDir: work, userParams: ['lp=cbc'], email: 'me@example.org', priority: 'short', forceGdx: true,
    serverUrl: url, pollMs: 20, requestTimeoutMs: 2000, graceMs: 300,
    log: (t) => lines.push(t),
    ...extra,
  };
}

(process.platform === 'win32' ? describe.skip : describe)('NEOS job against a mock server', function () {
  this.timeout(15000);
  let mock: Mock | undefined;
  afterEach(async () => { await mock?.close(); mock = undefined; });

  it('runs the full short-priority lifecycle', async () => {
    mock = await startMock(lifecycleHandlers());
    const sys = fakeSysdir();
    const work = tmp('neos-work-');
    const lines: string[] = [];
    const job = new NeosJob(baseOpts(sys, work, mock.url, lines));
    const r = await job.start();
    const log = lines.join('');

    assert.strictEqual(r.ok, true, log);
    // local preparation
    const args = fs.readFileSync(path.join(sys, 'gams-args.txt'), 'utf8').split('\n');
    assert.ok(args.includes('action=c') && args.includes('xsave="m"') && args.includes('previousWork=1') && args.includes('lp=cbc'));
    assert.strictEqual(fs.realpathSync(fs.readFileSync(path.join(sys, 'gams-cwd.txt'), 'utf8').trim()), fs.realpathSync(work));
    // wire protocol
    const methods = mock.calls.map((c) => c.method);
    assert.strictEqual(methods[0], 'ping');
    assert.strictEqual(methods[1], 'submitJob');
    const job1 = String(mock.calls[1].params[0]);
    assert.ok(job1.includes('<priority>short</priority>'));
    assert.ok(job1.includes('<email>me@example.org</email>'));
    assert.ok(job1.includes(`<restart><base64>${Buffer.from('G00 data\n').toString('base64')}</base64></restart>`));
    assert.ok(job1.includes('LP=cbc') === false && job1.includes('lp=cbc'));
    assert.ok(job1.includes('gdx=default') && job1.includes('<wantgdx><![CDATA[yes]]></wantgdx>'));
    assert.ok(!job1.includes('action=') && !job1.includes('xsave'));
    const status = mock.calls.filter((c) => c.method === 'getJobStatus');
    assert.deepStrictEqual(status[0].params, [4711, 'secret']);
    assert.ok(status.length >= 3);
    const inter = mock.calls.filter((c) => c.method === 'getIntermediateResultsNonBlocking');
    assert.deepStrictEqual(inter[0].params, [4711, 'secret', 0]);
    assert.strictEqual(inter[1].params[2], Buffer.byteLength(LOG1));
    assert.ok(!methods.includes('getFinalResultsNonBlocking'));
    assert.deepStrictEqual(mock.calls.find((c) => c.method === 'getOutputFile')?.params, [4711, 'secret', 'solver-output.zip']);
    // log content
    assert.ok(log.includes('Running: '));
    assert.ok(log.includes(`--- switch to NEOS .${path.sep}m${path.sep}solve.lst[LS2:"${path.join(work, 'm')}/solve.lst"]`));
    assert.ok(!log.includes('password:'), 'short priority does not print credentials');
    assert.ok(log.includes(`${path.join(work, 'm')}.gms[LS2:3]`), log);
    assert.ok(log.includes('second chunk') && !log.includes('clone text'));
    assert.ok(log.includes('--- extracting: .') && log.includes('--- skipping: .'));
    // results
    assert.deepStrictEqual(fs.readFileSync(path.join(sys, 'zip-copy.bin')), ZIP);
    assert.deepStrictEqual(r.files, ['solve.lst', 'gams.gdx', 'm.lxi']);
    assert.ok(fs.existsSync(path.join(work, 'm', 'solve.lst')));
    assert.ok(fs.existsSync(path.join(work, 'm', 'gams.gdx')));
  });

  it('feeds the normal log parser: error link into the source and listing', async () => {
    mock = await startMock(lifecycleHandlers());
    const sys = fakeSysdir();
    const work = tmp('neos-work-');
    const lines: string[] = [];
    const session = new LogSession({ workDir: work, lst: path.join(work, 'm', 'solve.lst'), sysDir: sys }, () => true);
    const opts = baseOpts(sys, work, mock.url, [], { log: (t) => session.push(t) });
    const r = await new NeosJob(opts).start();
    session.end();
    assert.ok(r.ok);
    const err = session.lines.find((l) => l.text.includes('*** Error 1'));
    assert.ok(err, 'error line present');
    assert.ok(err.links.length > 0, 'error line is clickable');
    assert.ok(session.lines.some((l) => l.text.startsWith('--- switch to NEOS')));
    assert.ok(session.lines.some((l) => l.text.includes('--- extracting:') && l.links.length > 0));
  });

  it('long priority: credentials in the log, no intermediate polling, final results', async () => {
    mock = await startMock(lifecycleHandlers());
    const sys = fakeSysdir();
    const work = tmp('neos-work-');
    const lines: string[] = [];
    const r = await new NeosJob(baseOpts(sys, work, mock.url, lines, { priority: 'long', forceGdx: false, userParams: ['solver=cbc'] })).start();
    const log = lines.join('');
    assert.ok(r.ok, log);
    assert.ok(log.includes('Job 4711 dispatched\npassword: secret'));
    const methods = mock.calls.map((c) => c.method);
    assert.ok(!methods.includes('getIntermediateResultsNonBlocking'));
    assert.ok(methods.includes('getFinalResultsNonBlocking'));
    assert.ok(log.includes('final results'));
    const xml = String(mock.calls[1].params[0]);
    assert.ok(xml.includes('<priority>long</priority>'));
    assert.ok(xml.includes('LP=cbc MIP=cbc RMIP=cbc'), 'solver= expanded to categories');
    assert.ok(!xml.includes('gdx=default') && xml.includes('<wantgdx><![CDATA[]]></wantgdx>'));
  });

  it('reports a job number 0 refusal from the server', async () => {
    mock = await startMock(lifecycleHandlers({ submitJob: () => [0, 'Bad email address'] }));
    const lines: string[] = [];
    const r = await new NeosJob(baseOpts(fakeSysdir(), tmp('neos-work-'), mock.url, lines)).start();
    assert.strictEqual(r.ok, false);
    assert.ok(lines.join('').includes('NEOS: Bad email address'));
    assert.ok(!mock.calls.some((c) => c.method === 'getJobStatus'));
  });

  it('reports non-normal completion codes with the PreviousWork hint', async () => {
    mock = await startMock(lifecycleHandlers({ getCompletionCode: () => 'Timed out' }));
    const lines: string[] = [];
    const r = await new NeosJob(baseOpts(fakeSysdir(), tmp('neos-work-'), mock.url, lines)).start();
    assert.strictEqual(r.ok, false);
    const log = lines.join('');
    assert.ok(log.includes('Neos error-exit: Timed out') && log.includes('PreviousWork=1'));
    assert.ok(!mock.calls.some((c) => c.method === 'getOutputFile'));
  });

  it('reports bad job status', async () => {
    mock = await startMock(lifecycleHandlers({ getJobStatus: () => 'Bad Password' }));
    const lines: string[] = [];
    const r = await new NeosJob(baseOpts(fakeSysdir(), tmp('neos-work-'), mock.url, lines)).start();
    assert.strictEqual(r.ok, false);
    assert.ok(lines.join('').includes('Neos error-status: Bad Password'));
  });

  it('stops when the local compile fails, without submitting', async () => {
    mock = await startMock(lifecycleHandlers());
    const lines: string[] = [];
    const r = await new NeosJob(baseOpts(fakeSysdir('echo "*** Error"; exit 2'), tmp('neos-work-'), mock.url, lines)).start();
    assert.strictEqual(r.ok, false);
    assert.ok(lines.join('').includes('Error on compilation, exit code 2'));
    assert.ok(!mock.calls.some((c) => c.method === 'submitJob'));
  });

  it('retries transient poll failures, then succeeds', async () => {
    mock = await startMock(lifecycleHandlers({
      getJobStatus: (_c, n) => (n === 1 || n === 2 ? { fault: [9, 'busy'] } : 'Done'),
    }));
    const lines: string[] = [];
    const r = await new NeosJob(baseOpts(fakeSysdir(), tmp('neos-work-'), mock.url, lines)).start();
    assert.ok(r.ok, lines.join(''));
    assert.ok(lines.join('').includes('retrying (2/3)'));
  });

  it('gives up after repeated poll failures with a clear message', async () => {
    mock = await startMock(lifecycleHandlers({ getJobStatus: () => ({ fault: [9, 'busy'] }) }));
    const lines: string[] = [];
    const r = await new NeosJob(baseOpts(fakeSysdir(), tmp('neos-work-'), mock.url, lines, { maxPollFailures: 2 })).start();
    assert.strictEqual(r.ok, false);
    assert.ok(/NEOS server error: .*busy/.test(lines.join('')));
  });

  it('times out on a server that never answers (no hang)', async () => {
    mock = await startMock({ ping: () => ({ hang: true }) });
    const lines: string[] = [];
    const t0 = Date.now();
    const r = await new NeosJob(baseOpts(fakeSysdir(), tmp('neos-work-'), mock.url, lines, { requestTimeoutMs: 300 })).start();
    assert.strictEqual(r.ok, false);
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(/Network error: No response from NEOS server/.test(lines.join('')));
  });

  it('reports a refused connection clearly', async () => {
    const m = await startMock({});
    const url = m.url;
    await m.close();
    const lines: string[] = [];
    const r = await new NeosJob(baseOpts(fakeSysdir(), tmp('neos-work-'), url, lines)).start();
    assert.strictEqual(r.ok, false);
    assert.ok(/Network error: .*(ECONNREFUSED|ECONNRESET)/.test(lines.join('')), lines.join(''));
  });

  it('cancel while polling sends killJob and ends promptly', async () => {
    mock = await startMock(lifecycleHandlers({ getJobStatus: () => 'Running', killJob: () => 'Job 4711 killed' }));
    const lines: string[] = [];
    const job = new NeosJob(baseOpts(fakeSysdir(), tmp('neos-work-'), mock.url, lines));
    const p = job.start();
    while (!mock.calls.some((c) => c.method === 'getJobStatus')) await new Promise((r) => setTimeout(r, 10));
    job.stop();
    const r = await p;
    assert.ok(r.cancelled && !r.ok);
    assert.deepStrictEqual(mock.calls.find((c) => c.method === 'killJob')?.params, [4711, 'secret']);
    assert.ok(lines.join('').includes('Job 4711 killed') && lines.join('').includes('cancelled'));
  });

  it('cancel during the local preparation stops gams gracefully and never contacts submitJob', async () => {
    mock = await startMock(lifecycleHandlers());
    const lines: string[] = [];
    const sys = fakeSysdir("trap 'exit 3' INT\necho started\nwhile :; do sleep 0.05; done");
    const job = new NeosJob(baseOpts(sys, tmp('neos-work-'), mock.url, lines));
    const p = job.start();
    while (!lines.join('').includes('started')) await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    job.stop();
    const r = await p;
    assert.ok(r.cancelled);
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(!mock.calls.some((c) => c.method === 'submitJob' || c.method === 'killJob'));
  });

  it('hard-kills a preparation step that ignores the interrupt after the grace period', async () => {
    mock = await startMock(lifecycleHandlers());
    const lines: string[] = [];
    const sys = fakeSysdir("trap '' INT\necho started\nwhile :; do sleep 0.05; done");
    const job = new NeosJob(baseOpts(sys, tmp('neos-work-'), mock.url, lines, { graceMs: 400 }));
    const p = job.start();
    while (!lines.join('').includes('started')) await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    job.stop();
    const r = await p;
    assert.ok(r.cancelled);
    assert.ok(Date.now() - t0 >= 350 && Date.now() - t0 < 4000);
  });

  it('https against a plain-http local port fails with a classified error, not a hang', async () => {
    mock = await startMock({ ping: () => ['x'] });
    const c = new NeosClient(mock.url.replace('http:', 'https:'), { timeoutMs: 1000 });
    await assert.rejects(c.ping(), (e: unknown) => e instanceof NeosError && (e.kind === 'network' || e.kind === 'tls' || e.kind === 'timeout'));
  });
});

describe('NeosClient response size cap', () => {
  let m: Mock | undefined;
  afterEach(async () => { await m?.close(); m = undefined; });
  it('aborts an oversized ordinary response but allows it for downloads', async () => {
    m = await startMock({
      version: () => 'x'.repeat(5000),
      getFinalResultsNonBlocking: () => Buffer.alloc(3000, 1),
    });
    const c = new NeosClient(m.url, { maxResponseBytes: 2000, maxDownloadBytes: 100000 });
    await assert.rejects(c.version(), (e: unknown) => e instanceof NeosError && /size limit/.test(e.message));
    assert.strictEqual((await c.getFinalResultsNonBlocking(1, 'p')).length, 3000);
    const c2 = new NeosClient(m.url, { maxDownloadBytes: 1000 });
    await assert.rejects(c2.getFinalResultsNonBlocking(1, 'p'), /size limit/);
  });
});

describe('NeosClient basics', () => {
  it('rejects unsupported URLs', () => {
    assert.throws(() => new NeosClient('ftp://x'), /Unsupported/);
    assert.throws(() => new NeosClient('nonsense'), /Invalid/);
  });
});
