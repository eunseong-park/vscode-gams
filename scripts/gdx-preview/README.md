# GDX viewer preview harness

Open the real GDX webview bundle in a normal browser (no VS Code needed) with a mocked
`acquireVsCodeApi` and responses dumped from the real language server, for visual checks of
layout, themes and interaction.

```sh
npm run build                                   # builds dist/gdxWebview.js
cd server && cargo build -p gams-lsp && cd ..   # only needed to (re)dump data
node scripts/gdx-preview/dump.js server/crates/gams-gdx/tests/fixtures/mini.gdx mini
node scripts/gdx-preview/dump.js $GAMS_SYSDIR/testlib_ml/g20_001.gdx g20 1500
node scripts/gdx-preview/dump.js $GAMS_SYSDIR/gamslib_ml/glcalift.gdx glcalift 2000
node scripts/gdx-preview/prepare.js             # writes out/style.css and out/index.html (nonce CSP like the extension)
```

Then open `scripts/gdx-preview/index.html` (or `out/index.html`, which uses the same nonce CSP as the real
webview) with URL parameters:

| parameter | meaning |
| --- | --- |
| `file=mini\|g20\|glcalift` | dumped data set |
| `theme=dark\|light\|hc-dark\|hc-light` | approximations of the VS Code theme variables (`themes.css`) |
| `latency=15` | milliseconds before the mocked host answers |
| `synthetic=100000000` | adds a 2-D parameter `synth` with that many records (scrolling / truncation tests) |
| `lang=de` | `vscode.env.language` (thousands separator) |

The mock (`preview.js`) re-implements paging, sort, label / value filters, labels, defaults and pivot over the dumped
records; it approximates the Rust server (e.g. pivot header order) and cycles dumped records beyond the dump for
symbols that were only partly dumped. State is kept in `sessionStorage` like `vscode.setState`.

* `shot.js` takes headless-Chrome screenshots and can drive the page (JS snippets or `mouse:down:x,y` steps), no
  extra dependencies (uses a Chrome/Chromium found in `~/.cache/ms-playwright`, `/usr/bin` or `$CHROME`).
* `bench.js <file.gdx> [symbolIndex]` times the server requests (paging, sort, filter, labels, pivot) and prints the
  server's RSS; `GAMS_LSP=<path>` selects another binary (e.g. the release build).
* Large synthetic GDX files: `cargo run --release -p gams-gdx --example gen_synthetic -- out.gdx 5000000 2 [compress=0|1]` (written with `gdx-rs`, no GAMS needed)
  (writing GDX needs no GAMS license).
