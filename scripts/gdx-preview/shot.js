// Headless-Chrome screenshots / scripted interaction of the preview page via the DevTools protocol (no extra deps).
//   node scripts/gdx-preview/shot.js [--chrome <path>] <out.png> "<query>" <width>x<height> ["<js to evaluate first>" ...]
// e.g. node shot.js dark-wide.png "file=g20&theme=dark" 1200x700 "document.querySelector('.splitter')"
// The page is out/index.html; each JS snippet is evaluated (awaited) after load, with 400 ms between steps.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
let chrome = process.env.CHROME || '';
if (args[0] === '--chrome') { chrome = args[1]; args.splice(0, 2); }
const [outFile, query, size, ...steps] = args;
if (!chrome) {
  const cands = [
    ...['google-chrome', 'chromium', 'chromium-browser'].map((n) => `/usr/bin/${n}`),
    ...(fs.existsSync(path.join(os.homedir(), '.cache/ms-playwright'))
      ? fs.readdirSync(path.join(os.homedir(), '.cache/ms-playwright')).filter((d) => d.startsWith('chromium-')).map((d) => path.join(os.homedir(), '.cache/ms-playwright', d, 'chrome-linux64/chrome'))
      : []),
  ];
  chrome = cands.find((c) => fs.existsSync(c));
}
if (!chrome) { console.error('No Chrome/Chromium found (set CHROME=...)'); process.exit(1); }
const [W, H] = size.split('x').map(Number);
const page = 'file://' + path.join(__dirname, 'out/index.html') + '?' + query;
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'gdxshot-'));

(async () => {
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars=false', `--user-data-dir=${udd}`, '--remote-debugging-port=0', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { port = Number(fs.readFileSync(path.join(udd, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { /* wait */ }
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    else if (m.method === 'Log.entryAdded') logs.push(m.params.entry.level + ': ' + m.params.entry.text);
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: page });
  await new Promise((r) => setTimeout(r, 1200));
  for (const s of steps) {
    // "mouse:<down|move|up|click>:x,y" drives real mouse input (pointer events) instead of evaluating JS
    const mm = /^mouse:(down|move|up|click|dbl):(\d+),(\d+)$/.exec(s);
    if (mm) {
      const [, kind, x, y] = mm;
      const ev = (type, buttons, clickCount = 1) => send('Input.dispatchMouseEvent', { type, x: Number(x), y: Number(y), button: 'left', buttons, clickCount });
      if (kind === 'move') await ev('mouseMoved', 1);
      else if (kind === 'down') await ev('mousePressed', 1);
      else if (kind === 'up') await ev('mouseReleased', 0);
      else if (kind === 'dbl') { await ev('mousePressed', 1); await ev('mouseReleased', 0); await ev('mousePressed', 1, 2); await ev('mouseReleased', 0, 2); }
      else { await ev('mousePressed', 1); await ev('mouseReleased', 0); }
      await new Promise((r2) => setTimeout(r2, 250));
      continue;
    }
    const r = await send('Runtime.evaluate', { expression: s, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) logs.push('step failed: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    else if (r.result?.result?.value !== undefined) console.log('=>', JSON.stringify(r.result.result.value));
    await new Promise((r2) => setTimeout(r2, 400));
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'));
  console.log('wrote', outFile);
  if (logs.length) console.log(logs.join('\n'));
  ws.close();
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(udd, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp profile; harmless */ }
})().catch((e) => { console.error(e); process.exit(1); });
