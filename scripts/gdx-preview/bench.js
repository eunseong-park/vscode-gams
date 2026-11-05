// Timing / memory probe of the GDX requests against a (large) GDX file:
//   node scripts/gdx-preview/bench.js <file.gdx> [symbolIndex=2]
const { start } = require('./lsp');
const fs = require('fs');
const SYSDIR = process.env.GAMS_SYSDIR;
if (!SYSDIR) { console.error('set GAMS_SYSDIR to the GAMS system directory'); process.exit(2); }
const file = process.argv[2];
const sym = Number(process.argv[3] || 2);
const rss = (pid) => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024); } catch { return -1; } };
(async () => {
  const s = start(SYSDIR);
  await s.ready;
  const t = async (label, method, params) => {
    const t0 = process.hrtime.bigint();
    let r, err;
    try { r = await s.request(method, { path: file, ...params }); } catch (e) { err = e.message; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${label.padEnd(44)} ${ms.toFixed(0).padStart(7)} ms  rss ${String(rss(s.proc.pid)).padStart(5)} MB  ${err ? 'ERROR ' + err : ''}`);
    return r;
  };
  const syms = (await t('gdxSymbols', 'gams/gdxSymbols', {})).symbols;
  console.log(syms.map((x) => `${x.index}:${x.name}(${x.kind},${x.dim},${x.records})`).join(' '));
  await t('records offset 0 limit 200 (no query)', 'gams/gdxRecords', { symbolIndex: sym, offset: 0, limit: 200 });
  await t('records offset 400000 limit 200 (no query)', 'gams/gdxRecords', { symbolIndex: sym, offset: 400000, limit: 200 });
  const n = syms.find((x) => x.index === sym).records;
  await t(`records offset ${n - 200} (last page, no query)`, 'gams/gdxRecords', { symbolIndex: sym, offset: Math.max(0, n - 200), limit: 200 });
  await t('records offset 0 again (cursor restart)', 'gams/gdxRecords', { symbolIndex: sym, offset: 0, limit: 200 });
  await t('records sort col 1 desc, first page', 'gams/gdxRecords', { symbolIndex: sym, offset: 0, limit: 200, sort: { column: 1, ascending: false } });
  await t('records sort again (cached order)', 'gams/gdxRecords', { symbolIndex: sym, offset: 1000, limit: 200, sort: { column: 1, ascending: false } });
  await t('records label filter', 'gams/gdxRecords', { symbolIndex: sym, offset: 0, limit: 200, filters: { 0: { mode: 'include', labels: ['u0001', 'u0002'] } } });
  await t('labels col 0', 'gams/gdxLabels', { symbolIndex: sym, column: 0 });
  await t('gdxDefaults', 'gams/gdxDefaults', { symbolIndex: sym });
  await t('table 100x30 (pivot)', 'gams/gdxTable', { symbolIndex: sym, rowOffset: 0, rowLimit: 100, colOffset: 0, colLimit: 30 });
  await t('table again (cached pivot)', 'gams/gdxTable', { symbolIndex: sym, rowOffset: 100, rowLimit: 100, colOffset: 0, colLimit: 30 });
  s.stop();
})().catch((e) => { console.error(e); process.exit(1); });
