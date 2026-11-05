// Minimal stdio JSON-RPC client for server/target/debug/gams-lsp (used by dump.js and bench.js).
const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.resolve(__dirname, '../../server/target/debug/gams-lsp');

function start(sysdir, server = process.env.GAMS_LSP || SERVER) {
  const p = spawn(server, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  let id = 0;
  const pending = new Map();
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const m = /Content-Length: (\d+)/i.exec(buf.slice(0, i).toString());
      const len = Number(m[1]);
      if (buf.length < i + 4 + len) return;
      const msg = JSON.parse(buf.slice(i + 4, i + 4 + len).toString());
      buf = buf.slice(i + 4 + len);
      const w = msg.id !== undefined && pending.get(msg.id);
      if (w) { pending.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result); }
    }
  });
  const write = (o) => { const s = JSON.stringify({ jsonrpc: '2.0', ...o }); p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
  const request = (method, params) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); write({ id: i, method, params }); });
  const ready = request('initialize', { capabilities: {}, initializationOptions: { sysdir } }).then(() => write({ method: 'initialized', params: {} }));
  return { proc: p, request, ready, stop: () => { p.kill(); } };
}
module.exports = { start, SERVER };
