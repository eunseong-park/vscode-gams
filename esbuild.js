// Bundles client/src/extension.ts -> dist/extension.js
const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

(async () => {
  const ctx = await esbuild.context({
    entryPoints: ['client/src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  });
  // Browser bundle for the GDX viewer webview.
  const wctx = await esbuild.context({
    entryPoints: ['client/src/views/gdx/webview/main.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: 'dist/gdxWebview.js',
    sourcemap: false,
    minify: production,
    logLevel: 'info',
  });
  // Excel export (exceljs): a separate bundle, loaded on demand (client/src/views/xlsx/load.ts).
  const xctx = await esbuild.context({
    entryPoints: ['client/src/views/xlsx/bundle.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/xlsx.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  });
  // Browser bundle for the GDX compare webview.
  const cctx = await esbuild.context({
    entryPoints: ['client/src/views/gdxCompare/webview/main.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: 'dist/gdxCompareWebview.js',
    sourcemap: false,
    minify: production,
    logLevel: 'info',
  });
  if (watch) {
    await ctx.watch();
    await wctx.watch();
    await cctx.watch();
    await xctx.watch();
  } else {
    await ctx.rebuild();
    await wctx.rebuild();
    await cctx.rebuild();
    await xctx.rebuild();
    await ctx.dispose();
    await wctx.dispose();
    await cctx.dispose();
    await xctx.dispose();
  }
})().catch((e) => { console.error(e); process.exit(1); });
