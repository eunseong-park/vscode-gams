// Preview harness: a mocked acquireVsCodeApi + mocked extension host answering the viewer's requests
// from dumped real server responses (out/data-*.js). Query semantics (sort / label + value filters / pivot)
// are re-implemented in a few lines here, so they approximate the Rust server; totals come from the real
// file. Symbols that were dumped only partially cycle their dumped records beyond the dump (to exercise
// scrolling). URL parameters: file=<name> theme=dark|light|hc-dark|hc-light latency=<ms> lang=<code>
// synthetic=<records> (adds a huge 2-D parameter "synth") ; width/height are taken from the window.
(function () {
  const q = new URLSearchParams(location.search);
  const name = q.get('file') || Object.keys(window.GDX_PREVIEW_DATA)[0];
  const D = window.GDX_PREVIEW_DATA[name];
  if (!D) { document.body.textContent = 'No preview data "' + name + '"; run dump.js first.'; return; }
  const theme = q.get('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  document.body.classList.add(theme.startsWith('hc') ? 'vscode-high-contrast' : theme === 'light' ? 'vscode-light' : 'vscode-dark');
  const latency = Number(q.get('latency') || 15);
  const symbols = D.symbols.map((s) => ({ ...s }));
  const synthN = Number(q.get('synthetic') || 0);
  const records = Object.assign({}, D.records);
  if (synthN > 0) {
    const idx = symbols.length + 1;
    symbols.push({ index: idx, name: 'synth', dim: 2, kind: 'Parameter', records: synthN, text: 'synthetic ' + synthN.toLocaleString() + ' records', domain: ['*', '*'] });
    records[idx] = 'synth';
  }
  const listeners = [];
  const reply = (m) => setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: m })), latency);

  const SV = { UNDF: 1e300, NA: 2e300, '+INF': 3e300, '-INF': 4e300, EPS: 5e300 };
  const num = (v) => (typeof v === 'string' && v in SV ? SV[v] : v);
  function recAt(sym, i) {
    if (records[sym.index] === 'synth') return { keys: ['r' + String(Math.floor(i / 1000)).padStart(5, '0'), 'c' + String(i % 1000).padStart(3, '0')], values: [Math.round((i * 7919) % 100000) / 100] };
    const arr = records[sym.index] || [];
    return arr.length ? arr[i % arr.length] : undefined;
  }
  function symOf(i) { return symbols.find((s) => s.index === i) || symbols[0]; }
  function realRecords(sym) { return records[sym.index] === 'synth' ? null : records[sym.index] || []; }
  function allFor(sym, p) {
    const base = realRecords(sym);
    let rows = base ? base.slice() : null;
    const filtered = (p.filters && Object.keys(p.filters).length) || (p.valueFilter && (Array.isArray(p.valueFilter) ? p.valueFilter.length : 1)) || p.sort;
    if (!rows) return { rows: null, total: sym.records, unfiltered: sym.records };
    for (const [d, f] of Object.entries(p.filters || {})) {
      const set = new Set(f.labels || []);
      rows = rows.filter((r) => (f.mode === 'exclude' ? !set.has(r.keys[d]) : set.has(r.keys[d])));
    }
    const vfs = p.valueFilter ? (Array.isArray(p.valueFilter) ? p.valueFilter : [p.valueFilter]) : [];
    for (const f of vfs) {
      const slot = f.column - sym.dim;
      rows = rows.filter((r) => {
        const v = num(r.values[slot]);
        if (typeof v !== 'number') return true;
        if (v >= 1e300) return true;
        const inside = (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
        return f.exclude ? !inside : inside;
      });
    }
    if (p.sort) {
      const c = p.sort.column, sg = p.sort.ascending === false ? -1 : 1;
      rows.sort((a, b) => {
        let x, y;
        if (c < sym.dim) { x = (a.keys[c] || '').toLowerCase(); y = (b.keys[c] || '').toLowerCase(); }
        else { x = num(a.values[c - sym.dim]); y = num(b.values[c - sym.dim]); }
        return (x < y ? -1 : x > y ? 1 : 0) * sg;
      });
    }
    const partial = rows.length === base.length && base.length < sym.records && !filtered;
    return { rows, total: partial ? sym.records : rows.length, unfiltered: base.length < sym.records ? sym.records : base.length };
  }
  function labelsOf(sym, d) {
    const seen = new Set();
    for (const r of realRecords(sym) || []) seen.add(r.keys[d]);
    return [...seen];
  }
  function handle(m) {
    const p = m.params;
    const sym = symOf(p.symbolIndex);
    if (m.method === 'records') {
      const a = allFor(sym, p);
      const out = [];
      for (let i = p.offset; i < Math.min(a.total, p.offset + p.limit); i++) out.push(a.rows ? a.rows[i % Math.max(1, a.rows.length)] : recAt(sym, i));
      return { total: a.total, unfiltered: a.unfiltered, records: out.filter(Boolean) };
    }
    if (m.method === 'labels') return { labels: labelsOf(sym, p.column) };
    if (m.method === 'defaults') return { allDefault: D.defaults[sym.index] || [] };
    if (m.method === 'table') {
      const a = allFor(sym, { filters: p.filters, valueFilter: p.valueFilter });
      const rows = a.rows || Array.from({ length: Math.min(a.total, 200000) }, (_, i) => recAt(sym, i));
      const rd = p.rowDims || Array.from({ length: Math.max(0, sym.dim - 1) }, (_, i) => i);
      const cd = p.colDims || [sym.dim - 1];
      const key = (r, dims) => dims.map((d) => r.keys[d]);
      const uniq = (dims) => {
        const m2 = new Map();
        for (const r of rows) { const k = key(r, dims); m2.set(k.join('\u0001'), k); }
        return [...m2.values()].sort((x, y) => x.join('.').toLowerCase() < y.join('.').toLowerCase() ? -1 : 1);
      };
      const R = uniq(rd), C = uniq(cd);
      const ri = new Map(R.map((k, i) => [k.join('\u0001'), i])), ci = new Map(C.map((k, i) => [k.join('\u0001'), i]));
      const r0 = Math.min(p.rowOffset || 0, R.length), r1 = Math.min(R.length, r0 + (p.rowLimit || 1000));
      const c0 = Math.min(p.colOffset || 0, C.length), c1 = Math.min(C.length, c0 + (p.colLimit || 1000));
      const cells = Array.from({ length: r1 - r0 }, () => Array(c1 - c0).fill(null));
      for (const r of rows) {
        const i = ri.get(key(r, rd).join('\u0001')), j = ci.get(key(r, cd).join('\u0001'));
        if (i >= r0 && i < r1 && j >= c0 && j < c1) cells[i - r0][j - c0] = r.values[sym.kind === 'Variable' || sym.kind === 'Equation' ? p.valueField || 0 : 0];
      }
      return { rowCount: R.length, colCount: C.length, rowOffset: r0, colOffset: c0, rowDims: rd, colDims: cd, rowHeaders: R.slice(r0, r1), colHeaders: C.slice(c0, c1), cells };
    }
    throw new Error('unsupported ' + m.method);
  }
  const KEY = 'gdxPreviewState:' + name;
  window.acquireVsCodeApi = function () {
    return {
      postMessage(m) {
        if (m.type === 'ready') reply({ type: 'init', fileName: D.fileName, language: q.get('lang') || 'en' });
        else if (m.type === 'symbols') reply({ type: 'symbols', symbols });
        else if (m.type === 'rpc') {
          try { const result = handle(m); reply({ type: 'rpcResult', reqId: m.reqId, result }); } catch (e) { reply({ type: 'rpcError', reqId: m.reqId, message: String(e.message || e) }); }
        } else if (m.type === 'clipboard') { window.__clipboard = m.text; console.log('clipboard:', JSON.stringify(m.text.slice(0, 200))); }
        else if (m.type === 'saveText') { window.__saved = m; console.log('saveText', m.suggestedName, m.text.length); }
        else console.log('postMessage', m);
      },
      getState() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') || undefined; } catch { return undefined; } },
      setState(s) { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } },
    };
  };
  window.__gdxPreview = { reply, symbols };
})();
