// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { testSysdir } from './testSysdir';
import {
  buildJobXml, compileArgs, parseSolverCapabilities, RefConverter, maySkipConfirmation, userSetting, remoteArgs, solverToCategories, unzipLogLine, validateEmail,
} from '../../src/neos/neosParams';
import { parseCall } from '../../src/neos/xmlrpc';
import { STUDIO_DEFAULT_PARAMETERS } from '../../src/run/gamsProcess';

describe('NEOS parameters', () => {
  it('compileArgs: action=c, xsave and previousWork enforced (neosprocess.cpp compileParameters)', () => {
    const a = compileArgs('/w/m.gms', ['a=r', 'xs=old', 'solver=cbc'], 'm');
    assert.strictEqual(a[0], '/w/m.gms');
    assert.ok(a.includes('action=c') && !a.includes('a=r'));
    assert.ok(a.includes('xsave="m"') && !a.includes('xs=old'));
    assert.ok(a.includes('previousWork=1'));
    assert.ok(a.includes('solver=cbc'));
    const b = compileArgs('/w/m.gms', ['previousWork=0'], 'm');
    assert.ok(b.includes('previousWork=0') && !b.includes('previousWork=1'));
    assert.deepStrictEqual(b.slice(1, 1 + STUDIO_DEFAULT_PARAMETERS.length), [...STUDIO_DEFAULT_PARAMETERS]);
  });

  it('remoteArgs: strips file, action, reference, xsave, previousWork, gdx (remoteParameters)', () => {
    const r = remoteArgs('/w/m.gms', ['a=r', 'rf=x', 'xsave=s', 'previousWork=1', 'gdx=mine', 'lp=cbc'], true);
    assert.deepStrictEqual(r.params, [...STUDIO_DEFAULT_PARAMETERS, 'lp=cbc']);
    assert.strictEqual(r.hasGdx, true);
    const f = remoteArgs('/w/m.gms', [], true);
    assert.ok(f.params.includes('gdx=default') && f.hasGdx);
    const n = remoteArgs('/w/m.gms', [], false);
    assert.ok(!n.params.some((p) => p.startsWith('gdx')) && !n.hasGdx);
  });

  it('solverToCategories replaces solver= by model type categories', () => {
    const caps = parseSolverCapabilities([
      '* header', '', 'CBC 2011 5 0001 1 0 2 LP MIP RMIP', 'gmsgenus.run', 'gmsgenux.out',
      '', 'CONOPT 1 0 CO 1 0 1 LP NLP', 'gmsco_us.run', 'DEFAULTS', 'LP CBC',
    ].join('\n'));
    assert.deepStrictEqual([...caps.keys()], ['cbc', 'conopt']);
    assert.deepStrictEqual(solverToCategories(['x=1', 'solver=CBC', 'y=2'], caps), ['x=1', 'LP=CBC', 'MIP=CBC', 'RMIP=CBC', 'y=2']);
    // categories already set by the user are kept as the user wrote them
    assert.deepStrictEqual(solverToCategories(['mip=conopt', 'solver=cbc'], caps), ['mip=conopt', 'LP=cbc', 'RMIP=cbc']);
    // unknown solver: parameter removed (Studio)
    assert.deepStrictEqual(solverToCategories(['solver=nope', 'a=1'], caps), ['a=1']);
  });

  it('parses the real gmscmpun.txt when GAMS is installed', function () {
    const dir = testSysdir('neosParams real gmscmpun.txt', 'gmscmpun.txt');
    if (!dir) return this.skip();
    const f = path.join(dir, 'gmscmpun.txt');
    const caps = parseSolverCapabilities(fs.readFileSync(f, 'utf8'));
    assert.deepStrictEqual(caps.get('cbc'), ['LP', 'MIP', 'RMIP']);
    assert.ok(caps.size > 10);
  });

  it('buildJobXml carries the restart file, parameters and flags (mRawJob)', () => {
    const x = buildJobXml(Buffer.from('G00'), 'a=1 b="]]>"', 'long', true, 'me@example.org');
    assert.ok(x.includes('<priority>long</priority>'));
    assert.ok(x.includes('<email>me@example.org</email>'));
    assert.ok(x.includes('<restart><base64>RzAw</base64></restart>'));
    assert.ok(x.includes('<wantgdx><![CDATA[yes]]></wantgdx>'));
    assert.ok(x.includes('<inputType>GAMS</inputType>'));
    assert.ok(buildJobXml(Buffer.alloc(0), '', 'short', false, 'a@b.c').includes('<wantgdx><![CDATA[]]></wantgdx>'));
    assert.ok(x.includes(']]]]><![CDATA[>'));
  });

  it('validateEmail follows NeosStartDialog::validateEmail', () => {
    assert.notStrictEqual(validateEmail(''), '');
    for (const bad of ['a b@c.de', 'abc', '@x.de', 'a@b', 'a@b.', 'a@.de']) assert.notStrictEqual(validateEmail(bad), '', bad);
    assert.strictEqual(validateEmail(' me@example.org '), '');
  });
});

describe('NEOS log conversion', () => {
  const out = path.join('/w', 'm');

  it('rewrites remote paths and [LST: tags', () => {
    const c = new RefConverter(out);
    const r = c.push('*** Error at line 3 in /var/lib/condor/execute/dir_12345/gamsexec/MODEL.gms[LST:44]\nx /var/lib/condor/execute/dir_9/gamsexec/foo.inc\n');
    assert.strictEqual(r, `*** Error at line 3 in ${out}.gms[LS2:44]\nx ${out}${path.sep}foo.inc\n`);
  });

  it('finds patterns split across chunks and flushes the tail', () => {
    const c = new RefConverter(out);
    assert.strictEqual(c.push('a /var/lib/condor/exe'), '');
    assert.strictEqual(c.push('cute/dir_1/gamsexec/MODEL.gms\nlast'), `a ${out}.gms\n`);
    assert.strictEqual(c.end(), 'last');
  });

  it('drops everything from the log clone marker on', () => {
    const c = new RefConverter(out);
    assert.strictEqual(c.push('keep\n%% GAMS LOGFILE %%%%\nclone\n'), 'keep\n');
    assert.strictEqual(c.push('more\n'), '');
    assert.strictEqual(c.end(), '');
  });

  it('unzipLogLine: FIL links for extracted files, lxi skipped', () => {
    const s = path.sep;
    assert.strictEqual(unzipLogLine(' extracting: solve.lst', out), `--- extracting: .${s}m${s}solve.lst[FIL:"${out}${s}solve.lst",0,0]`);
    assert.strictEqual(unzipLogLine('  inflating: a.lxi', out), `--- skipping: .${s}m${s}a.lxi`);
    assert.strictEqual(unzipLogLine('Archive: x', out), 'Archive: x');
  });

  it('job document parses as XML-RPC call parameter', () => {
    const call = parseCall(`<methodCall><methodName>submitJob</methodName><params><param><value><string>${buildJobXml(Buffer.from('x'), 'p', 'short', false, 'a@b.c').replace(/</g, '&lt;')}</string></value></param></params></methodCall>`);
    assert.strictEqual(call.method, 'submitJob');
    assert.ok(String(call.params[0]).includes('<document>'));
  });
});

describe('RefConverter neutralizes remote link tags', () => {
  const out = '/work/m';
  it('keeps Studio rewrites, defuses everything else', () => {
    const c = new RefConverter(out);
    const r = c.push('a [LST:12] b [FIL:"/etc/passwd",1,1] [DIR:"/"] [LS2:"/x"] [REF:"/y"]\n'
      + '[FIL:"/var/lib/condor/execute/dir_5/gamsexec/MODEL.gdx",0,0]\n');
    const [l1, l2] = r.split('\n');
    assert.ok(l1.includes('[LS2:12]'));
    for (const t of ['FIL', 'DIR', 'LS2:"', 'REF']) assert.ok(!l1.includes('[' + t + (t.includes(':') ? '' : ':')), t);
    assert.ok(l1.includes('[​FIL:"/etc/passwd"'));
    assert.ok(l2.startsWith('[FIL:"/work/m.gdx"'));
  });
});

describe('NEOS consent bound to server', () => {
  it('skips only for the consented server', () => {
    assert.strictEqual(maySkipConfirmation(true, 'https://a', 'https://a'), true);
    assert.strictEqual(maySkipConfirmation(true, 'https://a', 'https://evil'), false);
    assert.strictEqual(maySkipConfirmation(true, true, 'https://a'), false);
    assert.strictEqual(maySkipConfirmation(false, 'https://a', 'https://a'), false);
  });
  it('ignores workspace values', () => {
    const cfg = { inspect: () => ({ globalValue: 'g', workspaceValue: 'w', workspaceFolderValue: 'f', defaultValue: 'd' }) } as any;
    assert.strictEqual(userSetting(cfg, 'x', 'z'), 'g');
    assert.strictEqual(userSetting({ inspect: () => ({ workspaceValue: 'w', defaultValue: 'd' }) } as any, 'x', 'z'), 'd');
  });
});
