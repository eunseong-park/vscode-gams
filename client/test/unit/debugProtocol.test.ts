// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the GAMScom protocol parser, ContinuousLineData and Profiler, using raw transcripts
// recorded from GAMS 54.6.1 (DebugPort=/ComPort=), paths redacted to /work.
import * as assert from 'assert';
import { ContinuousLineData } from '../../src/debug/continuousLineData';
import { formatMemory, formatTime, Profiler } from '../../src/debug/profiler';
import { ComFeature, encodeCall, GamsComParser, IncludeLine, INT_MAX, ProfileEntry } from '../../src/debug/protocol';

/** mini.gms, DebugPort: socket chunks as received */
const TRNSPORT_DEBUG = [
  'features\n1\n\u0000linesMap\n/work/mini.gms|43=43|56=56|58=58|60=60|64=64|66=66\n\u0000linesMapDone\n\u0000',
  'paused\n43\n\u0000',
  'gdxReady\n/work/temp3563.gdx\n\u0000',
  'paused\n64\n\u0000',
  'gdxReady\n/work/temp3563.gdx\n\u0000',
  'paused\n56\n\u0000',
  'gdxReady\n/work/temp3563.gdx\n\u0000',
];

/** main.gms with $include data1.inc (which includes data2.inc) and $batinclude bat.inc, DebugPort */
const INCLUDE_MAP = [
  'features\n1\n\u0000',
  'linesMap\n/work/main.gms|!4=4\n/work/data1.inc|0=4|2=6\n\u0000',
  '|!3=7\n/work/data2.inc|0=7|3=10\n/work/data1.inc|?3=10\n\u0000',
  '|4=11\n/work/main.gms|?4=11|5=12|!7=14\n\u0000',
  '/work/bat.inc|0=14|2=16\n/work/main.gms|?7=16|9=18\n\u0000|10=19|12=21|13=22\n\u0000linesMapDone\n\u0000',
];

/** same model, ComPort + Profile=300 */
const INCLUDE_PROFILE = [
  'features\n2\n\u0000linesMap\n/work/main.gms|!4=4\n/work/data1.inc|0=4|2=6\n\u0000|!3=7\n/work/data2.inc|0=7|3=10\n/work/data1.inc|?3=10\n\u0000|4=11\n/work/main.gms|?4=11|5=12|!7=14\n\u0000/work/bat.inc|0=14|2=16\n/work/main.gms|?7=16|9=18\n\u0000|10=19|12=21|13=22\n\u0000linesMapDone\n\u0000',
  'profileData\n6|Assignment p|0|4.139648|5\n\u0000',
  'profileData\n10|Assignment p|0|4.139648|5\n\u0000profileData\n11|Assignment p|0|4.139648|5\n\u0000profileData\n12|Assignment p|0|4.139648|5\n\u0000profileData\n16|Assignment q|0|4.139648|5\n\u0000profileData\n19|Assignment k|0|4.139648|1\n\u0000profileData\n19|Assignment k|0|4.139648|1\n\u0000profileData\n19|Assignment k|0|4.139648|1\n\u0000profileData\n19|Assignment k|0|4.139648|1\n\u0000profileData\n19|Assignment k|0|4.139648|1\n\u0000profileData\n18|Loop |0|4.139648\n\u0000profileData\n21|Display |0|4.139648\n\u0000profileData\n22|Assignment p|0|4.139648|5\n\u0000profileData\n22|GAMS Fini  |0|4.138592\n\u0000',
];

/** mini.gms, ComPort + Profile=300 */
const TRNSPORT_PROFILE = [
  'features\n2\n\u0000linesMap\n/work/mini.gms|43=43|56=56|58=58|60=60|64=64|66=66\n\u0000linesMapDone\n\u0000',
  'profileData\n43|Assignment c|0|4.140616|6\n\u0000',
  'profileData\n64|Solve Init transport|0|4.140968\n\u0000profileData\n56|Equation cost|0.001|4.140968|1\n\u0000profileData\n58|Equation supply|0|4.140968|2\n\u0000profileData\n60|Equation demand|0|4.140968|3\n\u0000profileData\n64|Solve Fini transport|0.002|4.140616|19\n\u0000',
  'profileData\n64|Solver transport|0.0559994950890541|4.140616\n\u0000',
  'profileData\n64|Solve Read transport|0|4.140616\n\u0000',
  'profileData\n66|Display |0|4.140616\n\u0000profileData\n66|GAMS Fini  |0|4.13956\n\u0000',
];

interface Collected {
  features: number[];
  maps: [string, number[], number[]][];
  done: IncludeLine[][];
  paused: number[];
  gdx: string[];
  prof: ProfileEntry[];
  logs: string[];
  replies: string[];
}

function parse(chunks: string[], features = ComFeature.RunDebug): Collected {
  const c: Collected = { features: [], maps: [], done: [], paused: [], gdx: [], prof: [], logs: [], replies: [] };
  const p = new GamsComParser({
    features: (f) => c.features.push(f),
    linesMap: (f, l, n) => c.maps.push([f, l, n]),
    linesMapDone: (inc) => c.done.push(inc.map((i) => ({ ...i }))),
    paused: (l) => c.paused.push(l),
    gdxReady: (f) => c.gdx.push(f),
    profileData: (e) => c.prof.push(e),
    log: (m) => c.logs.push(m),
    reply: (r) => c.replies.push(...r),
  }, features);
  for (const ch of chunks) p.push(ch);
  return c;
}

/** consecutive linesMap signals of the same file merged (Studio emits the last pair of a line late) */
function merged(maps: [string, number[], number[]][]): [string, number[], number[]][] {
  const res: [string, number[], number[]][] = [];
  for (const [f, l, n] of maps) {
    const last = res[res.length - 1];
    if (last && last[0] === f) {
      last[1].push(...l);
      last[2].push(...n);
    } else res.push([f, [...l], [...n]]);
  }
  return res;
}

function buildCld(c: Collected): ContinuousLineData {
  const cld = new ContinuousLineData();
  for (const [f, l, n] of c.maps) cld.addLinesMap(f, l, n);
  return cld;
}

describe('GAMScom protocol parser (real transcripts)', () => {
  it('parses the mini debug session', () => {
    const c = parse(TRNSPORT_DEBUG);
    assert.deepStrictEqual(c.features, [1]);
    assert.deepStrictEqual(merged(c.maps), [['/work/mini.gms', [43, 56, 58, 60, 64, 66], [43, 56, 58, 60, 64, 66]]]);
    assert.strictEqual(c.done.length, 1);
    assert.deepStrictEqual(c.paused, [43, 64, 56]);
    assert.deepStrictEqual(c.gdx, ['/work/temp3563.gdx', '/work/temp3563.gdx', '/work/temp3563.gdx']);
    assert.deepStrictEqual(c.logs, []);
    assert.deepStrictEqual(c.replies, []);
  });

  it('joins linesMap continuation packets ("|..." and file-first packets)', () => {
    const c = parse(INCLUDE_MAP);
    // Server::parseLinesMap keeps the last pair of every line in mRemainData until the next file starts
    assert.deepStrictEqual(merged(c.maps), [
      ['/work/data1.inc', [2], [6]],
      ['/work/data2.inc', [3], [10]],
      ['/work/data1.inc', [4], [11]],
      ['/work/main.gms', [5], [12]],
      ['/work/bat.inc', [2], [16]],
      ['/work/main.gms', [9, 10, 12, 13], [18, 19, 21, 22]],
    ]);
    assert.deepStrictEqual(c.logs, []);
  });

  it('collects include markers (! include, 0= start, ? return)', () => {
    const c = parse(INCLUDE_MAP);
    const inc = c.done[0];
    assert.deepStrictEqual(inc.map((i) => [i.parentFile, i.line, i.contLine, i.outerContLine, i.childFile]), [
      ['/work/main.gms', 4, 4, 11, '/work/data1.inc'],
      ['/work/data1.inc', 3, 7, 10, '/work/data2.inc'],
      ['/work/main.gms', 7, 14, 16, '/work/bat.inc'],
    ]);
  });

  it('profiler mode prepends the main-file pseudo include on linesMapDone', () => {
    const c = parse(INCLUDE_PROFILE, ComFeature.Profiler);
    assert.deepStrictEqual(c.features, [2]);
    const inc = c.done[0];
    assert.deepStrictEqual([inc[0].parentFile, inc[0].line, inc[0].contLine, inc[0].outerContLine], ['/work/main.gms', 1, 1, 1]);
    assert.strictEqual(inc.length, 4);
    // without includes: a single pseudo include for the main file
    const t = parse(TRNSPORT_PROFILE, ComFeature.Profiler);
    assert.deepStrictEqual(t.done[0].map((i) => [i.parentFile, i.outerContLine]), [['/work/mini.gms', 1]]);
  });

  it('parses profileData (rows optional, memory MB -> bytes)', () => {
    const c = parse(TRNSPORT_PROFILE, ComFeature.Profiler);
    assert.strictEqual(c.prof.length, 10);
    assert.deepStrictEqual(c.prof[0], { contLine: 43, statement: 'Assignment c', timeSec: 0, memory: 4140616, rows: 6 });
    assert.deepStrictEqual(c.prof[1], { contLine: 64, statement: 'Solve Init transport', timeSec: 0, memory: 4140968, rows: 0 });
    assert.strictEqual(c.prof[6].timeSec, 0.0559994950890541);
    assert.strictEqual(c.prof[9].statement, 'GAMS Fini  ');
  });

  it('handles a packet split in the middle of a token and an incomplete packet', () => {
    const whole = 'linesMap\n/work/a.gms|3=3|17=17\n\u0000linesMapDone\n\u0000';
    for (let cut = 1; cut < whole.length; cut++) {
      const c = parse([whole.slice(0, cut), whole.slice(cut)]);
      assert.deepStrictEqual(c.maps.flatMap((m) => m[1]), [3, 17], `cut at ${cut}`);
      assert.strictEqual(c.done.length, 1);
    }
  });

  it('answers unparsable replies with invalidReply', () => {
    const c = parse(['paused\nabc\n\u0000', 'bogus\n\u0000']);
    assert.deepStrictEqual(c.replies, ['invalidReply\npaused\nabc\n\t', 'invalidReply\nbogus\n\t']);
    assert.strictEqual(c.paused.length, 0);
  });

  it('encodes calls like Server::callProcedure (TAB terminated, split below 255 chars)', () => {
    assert.deepStrictEqual(encodeCall('run'), ['run\t']);
    assert.deepStrictEqual(encodeCall('addBP', ['43|64']), ['addBP\n43|64\t']);
    assert.deepStrictEqual(encodeCall('delBP'), ['delBP\t']);
    assert.deepStrictEqual(encodeCall('writeGDX', ['/work/temp3563.gdx']), ['writeGDX\n/work/temp3563.gdx\t']);
    const many = Array.from({ length: 60 }, (_, i) => String(1000 + i));
    const packets = encodeCall('addBP', many);
    assert.ok(packets.length > 1);
    for (const p of packets) {
      assert.ok(p.length - 1 < 255, `packet length ${p.length}`);
      assert.ok(p.startsWith('addBP\n') && p.endsWith('\t'));
    }
    assert.deepStrictEqual(packets.flatMap((p) => p.slice(0, -1).split('\n').slice(1)), many);
    const logs: string[] = [];
    assert.deepStrictEqual(encodeCall('addBP', ['x'.repeat(300)], (m) => logs.push(m)), []); // Studio would send a bare addBP
    assert.strictEqual(logs.length, 1);
  });

  it('INT_MAX marks an include without return marker', () => {
    const c = parse(['linesMap\n/work/m.gms|!2=2\n/work/i.inc|0=2|1=3\n\u0000linesMapDone\n\u0000']);
    assert.strictEqual(c.done[0][0].outerContLine, INT_MAX);
    assert.strictEqual(c.done[0][0].childFile, '/work/i.inc');
  });
});

describe('ContinuousLineData (real include transcript)', () => {
  const cld = buildCld(parse(INCLUDE_MAP));

  it('maps contLN -> file/line through nested includes', () => {
    const expect: [number, string, number][] = [
      [6, '/work/data1.inc', 2],
      [10, '/work/data2.inc', 3],
      [11, '/work/data1.inc', 4],
      [12, '/work/main.gms', 5],
      [16, '/work/bat.inc', 2],
      [18, '/work/main.gms', 9],
      [19, '/work/main.gms', 10],
      [22, '/work/main.gms', 13],
    ];
    for (const [cl, f, l] of expect) {
      assert.strictEqual(cld.filename(cl), f, `file of ${cl}`);
      assert.strictEqual(cld.fileLine(cl), l, `line of ${cl}`);
    }
    assert.strictEqual(cld.fileLine(4), -1);
    assert.strictEqual(cld.filename(-1), '');
  });

  it('maps file/line -> contLN', () => {
    assert.deepStrictEqual(cld.continuousLine('/work/main.gms', 10), [19]);
    assert.deepStrictEqual(cld.continuousLine('/work/data2.inc', 3), [10]);
    assert.deepStrictEqual(cld.continuousLine('/work/main.gms', 4), []);
    assert.deepStrictEqual(cld.validLines('/work/main.gms'), [5, 9, 10, 12, 13]);
  });

  it('adjusts breakpoints to the next valid line (or the last one)', () => {
    assert.strictEqual(cld.adjustBreakpoint('/work/main.gms', 6), 9);
    assert.strictEqual(cld.adjustBreakpoint('/work/main.gms', 1), 5);
    assert.strictEqual(cld.adjustBreakpoint('/work/main.gms', 99), 13);
    assert.strictEqual(cld.adjustBreakpoint('/work/data2.inc', 1), 3);
    assert.strictEqual(cld.adjustBreakpoint('/work/other.gms', 1), -1);
  });

  it('keeps active/aimed breakpoints like Studio', () => {
    const c = buildCld(parse(INCLUDE_MAP));
    assert.strictEqual(c.addBreakpoint('/work/main.gms', 6), 6); // not running: unchanged
    c.adjustBreakpoints();
    assert.deepStrictEqual([...c.bpFileLines('/work/main.gms')], [[9, 9]]);
    assert.deepStrictEqual([...c.bpAimedFileLines('/work/main.gms')], [[6, 9]]);
    assert.strictEqual(c.addBreakpoint('/work/bat.inc', 1, true), 2);
    assert.deepStrictEqual(c.bpContinuousLines().sort((a, b) => a - b), [16, 18]);
    c.delBreakpoint('/work/main.gms', 9);
    assert.deepStrictEqual(c.bpContinuousLines(), [16]);
    assert.deepStrictEqual(c.bpFiles(), ['/work/bat.inc']);
    c.clearBreakpoints();
    assert.deepStrictEqual(c.bpContinuousLines(), []);
  });
});

describe('Profiler (real profile transcripts)', () => {
  function profile(chunks: string[]): { prof: Profiler; cld: ContinuousLineData } {
    const c = parse(chunks, ComFeature.Profiler);
    const cld = buildCld(c);
    const prof = new Profiler();
    prof.setContinuousLineData(cld);
    prof.setMainFile(c.maps.length ? '/work/main.gms' : '');
    prof.addIncludes(c.done[0]);
    for (const e of c.prof) prof.add(e.contLine, e.statement, e.timeSec, e.memory, e.rows);
    return { prof, cld };
  }

  it('aggregates mini per line (solve line collects all solve phases)', () => {
    const { prof } = profile(TRNSPORT_PROFILE);
    const l64 = prof.lineProfile('/work/mini.gms', 64);
    assert.strictEqual(l64.steps, 4);
    assert.ok(Math.abs(l64.timeSec - (0.002 + 0.0559994950890541)) < 1e-12);
    assert.strictEqual(l64.rows, 19);
    assert.strictEqual(prof.lineProfile('/work/mini.gms', 56).timeSec, 0.001);
    const sums = prof.getSums();
    assert.strictEqual(sums.steps, 10);
    assert.strictEqual(sums.rows, 31);
    assert.strictEqual(prof.maxTime()[0][0], 64);
    const text = prof.getProfileText([64]);
    assert.deepStrictEqual(text.map((r) => r.label), ['Solve Fini transport', 'Solve Init transport', 'Solve Read transport', 'Solver transport', 'SUM']);
    assert.strictEqual(text[3].time, '0.056 s');
    assert.strictEqual(text[0].rows, '[19]');
  });

  it('adds include totals ("File SUM") at the include statements', () => {
    const { prof } = profile(INCLUDE_PROFILE);
    // $include data1.inc at main:4 spans contLN 5..11: data1 2, data2 3, data1 4 => 3 statements
    assert.strictEqual(prof.lineProfile('/work/main.gms', 4).steps, 3);
    assert.strictEqual(prof.lineProfile('/work/data1.inc', 3).steps, 1); // nested $include data2.inc
    assert.strictEqual(prof.lineProfile('/work/main.gms', 7).steps, 1); // $batinclude
    assert.strictEqual(prof.lineProfile('/work/main.gms', 10).steps, 5); // loop body
    assert.strictEqual(prof.lineProfile('/work/main.gms', 9).steps, 1); // the loop itself
    assert.deepStrictEqual(prof.getProfileText(prof.continuousLine('/work/main.gms', 4)).map((r) => r.label), ['File SUM']);
    // aggregate statements (loop) are excluded from the sums
    assert.strictEqual(prof.getSums().steps, 13);
  });

  it('formats time and memory like EditorHelper', () => {
    assert.strictEqual(formatTime(0.0559994950890541), '0.056 s');
    assert.strictEqual(formatTime(12.345), '12.345 s');
    assert.strictEqual(formatTime(12.5, true), '12.50 s');
    assert.strictEqual(formatTime(75, true), '1:15 m');
    assert.strictEqual(formatTime(75.5), '1:15.500 m');
    assert.strictEqual(formatMemory(4140616), '  4.141 MB');
    assert.strictEqual(formatMemory(4140616, true), ' 4.14 MB');
    assert.strictEqual(formatMemory(512), '  512 B ');
  });
});
