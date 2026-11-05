// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applySubstitutions, buildConnectArgs, ConnectProcess, connectExecutableName, findGdxOutputs, writtenSince } from '../../src/connect/connectRun';
import { addAssociation, globFor, isAssociated, migrateKeys } from '../../src/connect/yamlAssoc';

describe('Connect runner arguments', () => {
  it('builds <file> [key=value...] and drops malformed substitutions', () => {
    assert.deepStrictEqual(buildConnectArgs('/w/a.connect.yaml', ['x=1', ' y=2 ', 'bad', '=v']), ['/w/a.connect.yaml', 'x=1', 'y=2']);
    assert.strictEqual(connectExecutableName('linux'), 'gamsconnect');
  });

  it('applies %key% substitutions case-insensitively', () => {
    assert.strictEqual(applySubstitutions('file: %MyFile%\nn: %n%', ['myfile=a.csv', 'n=3']), 'file: a.csv\nn: 3');
  });

  it('finds GDXWriter outputs relative to the working directory', () => {
    const y = '- CSVReader:\n    file: in.csv\n    name: a\n- GDXWriter:\n    file: out/%n%.gdx\n- GDXWriter:\n    file: /abs/x.gdx\n';
    assert.deepStrictEqual(findGdxOutputs(y, '/w', ['n=7']), [path.resolve('/w/out/7.gdx'), path.resolve('/abs/x.gdx')]);
    assert.deepStrictEqual(findGdxOutputs('not: [valid', '/w'), []);
  });

  it('writtenSince filters by existence and mtime', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-'));
    const f = path.join(d, 'a.gdx');
    fs.writeFileSync(f, 'x');
    assert.deepStrictEqual(writtenSince([f, path.join(d, 'none.gdx')], Date.now() - 5000), [f]);
    assert.deepStrictEqual(writtenSince([f], Date.now() + 60000), []);
  });
});

describe('yaml.schemas association', () => {
  const key = 'file:///home/u/.vscode/extensions/eunseong-park.vscode-gams-0.0.2/schemas/connect/connect.schema.json';
  it('adds without duplicating and keeps other schemas', () => {
    const a = addAssociation({ other: '*.x.yaml' }, key, 'a.yaml');
    assert.deepStrictEqual(addAssociation(a, key, 'a.yaml'), { other: '*.x.yaml', [key]: ['a.yaml'] });
  });
  it('detects associated files and migrates stale extension folders', () => {
    const s = { 'file:///home/u/.vscode/extensions/eunseong-park.vscode-gams-0.0.1-linux-x64/schemas/connect/connect.schema.json': ['sub/a.yaml'] };
    assert.ok(isAssociated(s, path.resolve('/ws/sub/a.yaml'), [path.resolve('/ws')]));
    assert.ok(!isAssociated(s, path.resolve('/ws/b.yaml'), [path.resolve('/ws')]));
    assert.deepStrictEqual(migrateKeys(s, key), { [key]: ['sub/a.yaml'] });
    assert.strictEqual(migrateKeys({ [key]: ['a'] }, key), undefined);
    // foreign keys that merely end in the same path are left alone
    for (const k of ['file:///ext/v1/schemas/connect/connect.schema.json', '/work/mine/schemas/connect/connect.schema.json',
      'file:///home/u/.vscode/extensions/other.pub-ext-1.0.0/schemas/connect/connect.schema.json',
      'file:///home/u/eunseong-park.vscode-gams-evil/schemas/connect/connect.schema.json']) {
      assert.strictEqual(migrateKeys({ [k]: ['x.yaml'] }, key), undefined, k);
    }
    assert.strictEqual(globFor(path.resolve('/ws/sub/a.yaml'), path.resolve('/ws')), 'sub/a.yaml');
  });
});

(process.platform === 'win32' ? describe.skip : describe)('ConnectProcess with a fake sysdir', function () {
  this.timeout(10000);
  function fakeSysdir(script: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamsconnect-'));
    const exe = path.join(dir, 'gamsconnect');
    fs.writeFileSync(exe, `#!/bin/sh\n${script}\n`);
    fs.chmodSync(exe, 0o755);
    return dir;
  }
  function collect(p: ConnectProcess): Promise<{ out: string; code: number | null }> {
    return new Promise((resolve) => {
      let out = '';
      p.on('stdout', (s) => (out += s));
      p.on('stderr', (s) => (out += s));
      p.on('close', (code) => resolve({ out, code }));
      p.start();
    });
  }

  it('runs <sysdir>/gamsconnect with the YAML file and substitutions, cwd = file dir, sysdir env', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'connwork-'));
    const sys = fakeSysdir('echo "args:$*"; echo "cwd:$(pwd)"; echo "path:$PATH"; exit 4');
    const p = new ConnectProcess(sys, buildConnectArgs('m.connect.yaml', ['k=v']), work);
    const r = await collect(p);
    assert.strictEqual(r.code, 4);
    assert.ok(r.out.includes('args:m.connect.yaml k=v'), r.out);
    assert.ok(r.out.includes('cwd:' + fs.realpathSync(work)), r.out);
    assert.ok(r.out.includes('path:' + sys), r.out);
    assert.strictEqual(p.exePath, path.join(sys, 'gamsconnect'));
  });

  it('graceful stop sends SIGINT to the process group and the job ends without kill', async () => {
    const p = new ConnectProcess(fakeSysdir("trap 'exit 3' INT\nwhile :; do sleep 0.05; done"), ['x.yaml'], os.tmpdir());
    p.start();
    await new Promise((r) => setTimeout(r, 200));
    const done = new Promise<number | null>((r) => p.once('exit', (c) => r(c)));
    p.stop(3000);
    assert.strictEqual(await done, 3);
  });
});
