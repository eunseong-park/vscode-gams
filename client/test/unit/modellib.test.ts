// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { findSysdirGlbs, gamslibArgs, modelInputFile, parseGlb, parseGlbFile } from '../../src/modellib/glb';

const SAMPLE = `Version = 5
LibraryName = Lib
Columns = 3
1 = Name
2 = Type
3 = Description
InitialSort = 1
*$*$*$
Files = a.1, a.dat
1 = A
2 = LP
3 = x = y
Long A

*$*$*$
Files = b.gms
1 = a
2 = LP
3 = dup
Long B
*$*$*$
`;

describe('glb parser', () => {
  it('parses sample', () => {
    const l = parseGlb(SAMPLE);
    assert.strictEqual(l.models.length, 2);
    assert.strictEqual(l.models[0].values[2], 'x = y');
    assert.deepStrictEqual(l.models[0].files, ['a.1', 'a.dat']);
    assert.strictEqual(l.models[0].longDescription, 'Long A');
    assert.strictEqual(l.models[1].nameWithSuffix, 'a_1');
    assert.strictEqual(modelInputFile(l.models[0]), 'a.gms');
    assert.strictEqual(modelInputFile(l.models[1]), 'b.gms');
    assert.deepStrictEqual(gamslibArgs('/g.glb', l.models[1], '/d'), ['-lib', '/g.glb', 'a_1', '/d']);
  });
  it('rejects bad input', () => {
    assert.throws(() => parseGlb('Foo = 1'));
    assert.throws(() => parseGlb(SAMPLE.replace('Files = b.gms', 'Files = ')));
  });
  const sysdir = process.env.GAMS_SYSDIR;
  (sysdir ? it : it.skip)('parses all real glb files', () => {
    const files = findSysdirGlbs(sysdir!);
    assert.ok(files.length > 0);
    for (const f of files) assert.ok(parseGlbFile(f).models.length > 0, path.basename(f));
    const g = parseGlbFile(path.join(sysdir!, 'gamslib_ml', 'gamslib.glb'));
    assert.strictEqual(g.models[0].name, 'TRNSPORT');
    assert.ok(fs.existsSync(g.glbFile));
  });
});
