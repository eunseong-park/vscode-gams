// Dump real GDX server responses for the preview harness:
//   node scripts/gdx-preview/dump.js <file.gdx> <name> [maxRecordsPerSymbol=3000] [fullSymbols=sym1,sym2]
// Talks to server/target/debug/gams-lsp (build it first: cd server && cargo build -p gams-lsp) and writes
// scripts/gdx-preview/out/data-<name>.js (a plain script so the preview works from file://).
const { start } = require('./lsp');
const fs = require('fs');
const path = require('path');

const SYSDIR = process.env.GAMS_SYSDIR;
if (!SYSDIR) { console.error('set GAMS_SYSDIR to the GAMS system directory'); process.exit(2); }
const [file, name, maxArg, fullArg] = process.argv.slice(2);
if (!file || !name) { console.error('usage: dump.js <file.gdx> <name> [maxRecords] [fullSymbols]'); process.exit(2); }
const MAX = Number(maxArg || 3000);
const FULL = new Set((fullArg || '').split(',').filter(Boolean));

(async () => {
  const s = start(SYSDIR);
  await s.ready;
  const req = (m, p) => s.request(m, { path: path.resolve(file), ...p });
  const symbols = (await req('gams/gdxSymbols', {})).symbols;
  const out = { fileName: path.basename(file), symbols, records: {}, labels: {}, defaults: {} };
  for (const sym of symbols) {
    const limit = FULL.has(sym.name) ? Math.min(sym.records, 200000) : Math.min(sym.records, MAX);
    if (sym.records > 0) out.records[sym.index] = (await req('gams/gdxRecords', { symbolIndex: sym.index, offset: 0, limit })).records;
    if (sym.kind === 'Variable' || sym.kind === 'Equation') out.defaults[sym.index] = (await req('gams/gdxDefaults', { symbolIndex: sym.index })).allDefault;
  }
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const dest = path.join(__dirname, 'out', `data-${name}.js`);
  fs.writeFileSync(dest, `window.GDX_PREVIEW_DATA = window.GDX_PREVIEW_DATA || {};\nwindow.GDX_PREVIEW_DATA[${JSON.stringify(name)}] = ${JSON.stringify(out)};\n`);
  console.log(`${dest}: ${symbols.length} symbols, ${fs.statSync(dest).size} bytes`);
  s.stop();
})().catch((e) => { console.error(e); process.exit(1); });
