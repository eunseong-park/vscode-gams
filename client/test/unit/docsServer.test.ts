// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { startDocsServer } from '../../src/help/docsServer';

function get(port: number, p: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

describe('docs server host check (Remote-SSH forwarding)', () => {
  it('rejects foreign Host headers until the forwarded authority is allowed; token still required', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gams-docs-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>x</h1>');
    const s = await startDocsServer(dir);
    try {
      const tok = new URL(s.base).pathname;
      assert.strictEqual(await get(s.port, `${tok}index.html`, `127.0.0.1:${s.port}`), 200);
      assert.strictEqual(await get(s.port, `${tok}index.html`, 'localhost:61234'), 403);
      s.allowHost('localhost:61234');
      assert.strictEqual(await get(s.port, `${tok}index.html`, 'LOCALHOST:61234'), 200);
      assert.strictEqual(await get(s.port, '/wrongtoken/index.html', 'localhost:61234'), 403);
      assert.strictEqual(await get(s.port, `${tok}index.html`, 'evil.example:80'), 403);
    } finally {
      await s.close();
    }
  });

  it('serves under .../docs/ so the docs navtree relpath (style/navtree.js initNavTree) stays inside the server root', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gams-docs-'));
    fs.mkdirSync(path.join(dir, 'style'));
    fs.writeFileSync(path.join(dir, 'UG_x.html'), '<h1>x</h1>');
    fs.writeFileSync(path.join(dir, 'style', 'ftv2pnode.png'), 'png');
    const s = await startDocsServer(dir);
    try {
      const page = new URL('UG_x.html', s.base);
      // initNavTree: pathString = part after the last "docs/"; relpath = "../" * (segments-1) + "style/"
      const pathString = page.pathname.substring(page.pathname.lastIndexOf('docs/') + 'docs/'.length);
      const relpath = '../'.repeat(pathString.split('/').length - 1) + 'style/';
      const img = new URL(relpath + 'ftv2pnode.png', page);
      assert.strictEqual(await get(s.port, img.pathname, `127.0.0.1:${s.port}`), 200);
    } finally {
      await s.close();
    }
  });
  it('serves <lib>_ml/libhtml next to docs (search results link ../gamslib_ml/libhtml/...) but nothing else of the sysdir', async () => {
    const sys = fs.mkdtempSync(path.join(os.tmpdir(), 'gams-sys-'));
    fs.mkdirSync(path.join(sys, 'docs'));
    fs.mkdirSync(path.join(sys, 'gamslib_ml', 'libhtml'), { recursive: true });
    fs.writeFileSync(path.join(sys, 'docs', 'index.html'), 'i');
    fs.writeFileSync(path.join(sys, 'gamslib_ml', 'libhtml', 'gamslib_mini.html'), 't');
    fs.writeFileSync(path.join(sys, 'gamslib_ml', 'mini.1'), 'model');
    fs.writeFileSync(path.join(sys, 'gamslice.txt'), 'secret');
    const s = await startDocsServer(path.join(sys, 'docs'));
    try {
      const h = `127.0.0.1:${s.port}`;
      const base = new URL(s.base);
      const at = (rel: string): string => new URL(rel, base).pathname;
      assert.strictEqual(await get(s.port, at('index.html'), h), 200);
      assert.strictEqual(await get(s.port, at('../gamslib_ml/libhtml/gamslib_mini.html'), h), 200);
      assert.strictEqual(await get(s.port, at('../gamslib_ml/mini.1'), h), 403);
      assert.strictEqual(await get(s.port, at('../gamslice.txt'), h), 403);
      assert.strictEqual(await get(s.port, base.pathname.replace('docs/', '') + 'docs/%2e%2e/gamslice.txt', h), 403);
    } finally {
      await s.close();
    }
  });
});
