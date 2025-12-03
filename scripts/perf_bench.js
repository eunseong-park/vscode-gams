const path = require('path');

// Local lightweight parser implementation copied for benchmarking (avoids importing 'vscode')
function normalizeWhitespaceAndDashes(s) {
  if (!s) return s;
  const DASH_CODES = [0x2010,0x2011,0x2012,0x2013,0x2014,0x2212];
  let out = '';
  for (let i=0;i<s.length;i++){
    const code = s.charCodeAt(i);
    if (DASH_CODES.includes(code)) out += '-';
    else if (code === 0x200B || code === 0xFEFF) continue;
    else out += s[i];
  }
  return out;
}

function parseLines(lines) {
  const tokens = [];
  for (let i=0;i<lines.length;i++){
    const raw = lines[i];
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('$ontext')) { tokens.push({type:'blockCommentStart', line:i, raw}); continue; }
    if (lower.startsWith('$offtext')) { tokens.push({type:'blockCommentEnd', line:i, raw}); continue; }
    let processed = trimmed;
    if (!processed.startsWith('*')){
      const idx = processed.indexOf('*');
      if (idx !== -1) processed = processed.substring(0, idx).trim();
    }
    const processedNormalized = normalizeWhitespaceAndDashes(processed);
    if (processed.length === 0) { tokens.push({type:'normal', line:i, raw, processed, processedNormalized}); continue; }
    // simple section detection: lines starting with '*' followed by text and '---'
    const m = processedNormalized.match(/^\s*(\*+)\s*(.*?)\s+[-]{2,}/);
    if (m) { tokens.push({type:'section', line:i, raw, processed, processedNormalized, level:m[1].length, title:m[2]}); continue; }
    // declaration simple match
    const dm = processedNormalized.match(/^\s*(acronym|alias|equation|file|function|model|parameter|scalar|set|table|variable)\b/i);
    if (dm) { tokens.push({type:'declaration', line:i, raw, processed, processedNormalized, full:dm[0], baseKeyword:dm[1], keywordIndex: processed.toLowerCase().indexOf(dm[0].toLowerCase()), keywordLength: dm[0].trim().length}); continue; }
    tokens.push({type:'normal', line:i, raw, processed, processedNormalized});
  }
  return tokens;
}

function makeLine(i) {
  // create a variety of line types
  if (i % 50 === 0) return `* Section ${Math.floor(i/50)} --------------------------------------------`;
  if (i % 5 === 0) return `variables x${i}, y${i};`;
  if (i % 7 === 0) return `equations e${i};`;
  return `display a${i};`;
}

function generateLines(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = makeLine(i);
  return out;
}

function benchParseLines(n, iterations=3) {
  console.log(`\nBenchmark parseLines with ${n.toLocaleString()} lines (${iterations} runs)`);
  const lines = generateLines(n);
  for (let k = 0; k < iterations; k++) {
    const t0 = Date.now();
    const tokens = parseLines(lines);
    const dt = Date.now() - t0;
    console.log(`run ${k+1}: ${dt} ms — tokens: ${tokens.length}`);
  }
}

function benchSingleLineReparse(n, edits=10000) {
  console.log(`\nBenchmark single-line reparses (${edits} edits on 1-line patch) — parseLines on single-line`);
  const line = 'variables x,y;';
  const t0 = Date.now();
  for (let i = 0; i < edits; i++) {
    parseLines([line]);
  }
  const dt = Date.now() - t0;
  console.log(`${edits} single-line parses: ${dt} ms`);
}

(function main(){
  console.log('perf bench start');
  benchParseLines(20000, 3);
  benchSingleLineReparse(20000);
  console.log('perf bench done');
})();
