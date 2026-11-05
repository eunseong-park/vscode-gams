// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Read-only static HTTP server for the offline GAMS docs, bound to 127.0.0.1. The help panel shows the docs in an
 * iframe; a frame pointing at an asWebviewUri resource URL is not served (nested navigations do not go through the
 * webview's resource loader: the panel stays blank - verified in the integration environment), whereas a plain
 * http://127.0.0.1 frame works and keeps location/search/hash semantics that the docs scripts rely on.
 *
 * Hardening: loopback only; every URL starts with an unguessable per-server token (other local web pages cannot
 * guess it) and the Host header must be the loopback address (DNS rebinding); GET/HEAD only; no directory
 * listing; the resolved real path must stay inside the docs directory. No vscode imports.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { LINK_INTERCEPT_SOURCE } from './links';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.gms': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};

/** Posted to the parent frame by every served HTML page once it has loaded (lets the panel and the tests see the real content). */
export const LOADED_PING_SOURCE = `<script>(function(){function p(){try{var h=document.querySelector('h1,.title,h2');`
  + `parent.postMessage({gamsDocLoaded:true,title:document.title,heading:h?h.textContent.trim():'',href:location.href},'*');}catch(e){}}`
  + `if(document.readyState==='complete')p();else addEventListener('load',p);`
  // Zoom requested by the help panel shell (only messages from the parent window are accepted).
  + `addEventListener('message',function(e){if(e.source!==parent||!e.data||typeof e.data.gamsZoom!=='number')return;`
  + `var z=Math.min(3,Math.max(0.5,e.data.gamsZoom));document.documentElement.style.zoom=String(z);});`
  + `})();</script>`;

/** Test only (GAMS_EXT_TEST): the shell can ask a page to click the element matching a selector. */
export const TEST_HOOK_SOURCE = `<script>addEventListener('message',function(e){if(e.source!==parent||!e.data||typeof e.data.gamsTestClick!=='string')return;`
  + `var a=document.querySelector(e.data.gamsTestClick);if(a)a.click();});</script>`;

export interface DocsServer {
  /** `http://127.0.0.1:<port>/<token>/` (with trailing slash). */
  readonly base: string;
  readonly port: number;
  /** Pages (relative paths) served so far, for tests. */
  readonly served: string[];
  /** Also accept requests whose Host header is `authority` (e.g. a port forwarded by asExternalUri over Remote-SSH). */
  allowHost(authority: string): void;
  close(): Promise<void>;
}

/**
 * Serves `<sysdir>/docs/**` and the model library pages `<sysdir>/<lib>_ml/libhtml/**` (the docs and their search
 * index link to `../<lib>_ml/libhtml/...`), under `/<token>/docs/...` and `/<token>/<lib>_ml/libhtml/...`, i.e. the
 * same relative layout as in the GAMS installation. Nothing else of the system directory is reachable.
 */
export function startDocsServer(docsDir: string, opts: { testHooks?: boolean } = {}): Promise<DocsServer> {
  const docsRoot = fs.realpathSync(docsDir);
  const sysRoot = path.dirname(docsRoot);
  const token = crypto.randomBytes(16).toString('hex');
  const served: string[] = [];
  let port = 0;
  const hosts = new Set<string>();
  const sockets = new Set<import('net').Socket>();
  const inside = (file: string, dir: string): boolean => file === dir || file.startsWith(dir + path.sep);
  const server = http.createServer((req, res) => {
    const fail = (code: number): void => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(String(code)); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405);
    if (!hosts.has((req.headers.host ?? '').toLowerCase())) return fail(403);
    let rel: string;
    try {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      // `.../docs/` in the path: the docs scripts (style/navtree.js initNavTree) locate the docs root by the last "docs/".
      const prefix = `/${token}/`;
      if (!u.pathname.startsWith(prefix)) return fail(403);
      rel = decodeURIComponent(u.pathname.substring(prefix.length));
    } catch { return fail(400); }
    if (rel.includes('\0')) return fail(400);
    const top = rel.split('/');
    const allowedArea = top[0] === 'docs' || (/^[a-z0-9]+_ml$/i.test(top[0] ?? '') && top[1] === 'libhtml');
    if (!allowedArea) return fail(403);
    const isDocs = top[0] === 'docs';
    const inArea = isDocs ? top.slice(1).join('/') : top.slice(2).join('/');
    const area = isDocs ? docsRoot : path.join(sysRoot, top[0], 'libhtml');
    let file: string;
    try { file = fs.realpathSync(path.join(area, inArea)); } catch { return fail(404); }
    let areaReal: string;
    try { areaReal = fs.realpathSync(area); } catch { return fail(404); }
    if (!inside(file, areaReal)) return fail(403);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return fail(404); }
    if (!st.isFile()) return fail(404);
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (ext === '.html' || ext === '.htm') {
      served.push(isDocs ? inArea : rel);
      let body: string;
      try { body = fs.readFileSync(file, 'utf8'); } catch { return fail(404); }
      const buf = Buffer.from(body + LOADED_PING_SOURCE + LINK_INTERCEPT_SOURCE + (opts.testHooks ? TEST_HOOK_SOURCE : ''), 'utf8');
      res.writeHead(200, { ...headers, 'Content-Length': buf.length });
      res.end(req.method === 'HEAD' ? undefined : buf);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      hosts.add(`127.0.0.1:${port}`);
      resolve({
        base: `http://127.0.0.1:${port}/${token}/docs/`,
        port,
        served,
        allowHost: (a: string) => { hosts.add(a.toLowerCase()); },
        close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }),
      });
    });
  });
}
