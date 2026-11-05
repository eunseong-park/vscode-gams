// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as path from 'path';
import { buildGamsArgs, resolveDefaultFileParams, windowsCommandLine, withReference } from '../../src/run/gamsProcess';

describe('withReference', () => {
  const gms = path.join('/w', 'mini.gms');
  it('appends rf="<stem>.ref" when the user set nothing', () => {
    const base = buildGamsArgs(gms, [], false);
    const r = withReference(base, gms, '/w');
    assert.strictEqual(r.args[r.args.length - 1], 'rf="mini.ref"');
    assert.strictEqual(r.refPath, path.resolve('/w', 'mini.ref'));
  });
  it('keeps a user supplied reference / rf parameter', () => {
    for (const p of ['rf=my.ref', 'Reference=my.ref', 'rf="my"']) {
      const base = buildGamsArgs(gms, [p], false);
      const r = withReference(base, gms, '/w');
      assert.deepStrictEqual(r.args, base);
      assert.strictEqual(r.refPath, path.resolve('/w', path.extname(p) ? 'my.ref' : 'my.ref'));
    }
  });
  it('treats default as <stem>.ref', () => {
    const r = withReference(buildGamsArgs(gms, ['rf=default'], false), gms, '/w');
    assert.strictEqual(r.refPath, path.resolve('/w', 'mini.ref'));
  });
});

describe('resolveDefaultFileParams (Studio analyzeParameters "default" handling)', () => {
  it('replaces default for GDX/RF/PF with <stem>.<ext> and keeps other values', () => {
    const out = resolveDefaultFileParams(['GDX=default', 'RF="default"', 'pf=default', 'gdx2=default', 'lo=3', 'gdx=my.gdx'], 'mini');
    assert.deepStrictEqual(out, ['GDX="mini.gdx"', 'RF="mini.ref"', 'pf="mini.pf"', 'gdx2=default', 'lo=3', 'gdx=my.gdx']);
  });
  it('withReference resolves RF=default and honours filestem', () => {
    const r = withReference(['RF=default', 'filestem=abc', 'GDX=default'], '/w/mini.gms', '/w');
    assert.deepStrictEqual(r.args, ['RF="abc.ref"', 'filestem=abc', 'GDX="abc.gdx"']);
    assert.strictEqual(r.refPath, path.resolve('/w', 'abc.ref'));
  });
});

describe('windowsCommandLine (Studio setNativeArguments on Windows)', () => {
  it('keeps GAMS quoting verbatim instead of C-runtime escaping', () => {
    const cl = windowsCommandLine(['d:\\non-active\\steel-market-model\\gams\\trade.gms', 'logoption=3', 'ide=1', 'rf="trade.ref"']);
    assert.strictEqual(cl, 'd:\\non-active\\steel-market-model\\gams\\trade.gms logoption=3 ide=1 rf="trade.ref"');
  });
  it('quotes paths and values with blanks like Studio', () => {
    const cl = windowsCommandLine(['C:\\My Models\\a b.gms', 'gdx=C:\\out dir\\x.gdx', '--name=two words', 'o="C:\\x y\\a.lst"', '"already quoted"']);
    assert.strictEqual(cl, '"C:\\My Models\\a b.gms" gdx="C:\\out dir\\x.gdx" --name="two words" o="C:\\x y\\a.lst" "already quoted"');
  });
});
