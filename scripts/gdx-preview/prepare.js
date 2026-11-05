// Build the preview page: bundles the viewer (npm run build output dist/gdxWebview.js is copied), inlines the
// viewer's real stylesheet and the theme variables in a <style nonce> and writes out/index.html with the same
// nonce CSP as the extension's webview (client/src/views/gdx/provider.ts renderHtml), and out/style.css for the
// plain ../index.html.
//   node scripts/gdx-preview/prepare.js        (run `npm run build` first)
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '../..');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const css = esbuild.buildSync({
  entryPoints: [path.join(root, 'client/src/views/gdx/webview/style.ts')], bundle: true, format: 'cjs', write: false, platform: 'node',
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', css)(mod, mod.exports);
const themes = fs.readFileSync(path.join(__dirname, 'themes.css'), 'utf8');
fs.copyFileSync(path.join(root, 'dist/gdxWebview.js'), path.join(out, 'gdxWebview.js'));
fs.writeFileSync(path.join(out, 'style.css'), `${themes}\n${mod.exports.CSS}`);
fs.copyFileSync(path.join(__dirname, 'preview.js'), path.join(out, 'preview.js'));
const datas = fs.readdirSync(out).filter((f) => /^data-.*\.js$/.test(f));
const N = 'previewnonce';
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${N}'; script-src 'nonce-${N}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GDX viewer preview</title>
<style nonce="${N}">${themes}\n${mod.exports.CSS}</style></head>
<body><div id="app"></div>
${datas.map((d) => `<script nonce="${N}" src="${d}"></script>`).join('\n')}
<script nonce="${N}" src="preview.js"></script>
<script nonce="${N}" src="gdxWebview.js"></script>
</body></html>
`;
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(`wrote ${path.join(out, 'index.html')} (${datas.length} data set(s))`);
