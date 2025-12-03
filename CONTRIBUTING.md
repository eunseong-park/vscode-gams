# Contributing

Quick build & packaging steps for contributors

- Install dependencies (preferred):

```powershell
npm ci
```

- Build (compile TypeScript):

```powershell
npm run compile
```

`compile` runs `node ./scripts/ensureDepsAndCompile.js`. By default the script will not auto-install missing dev dependencies — if you want it to install automatically you can run:

```powershell
node ./scripts/ensureDepsAndCompile.js --auto-install
```

- Package the extension (produce `.vsix`):

```powershell
npx -y @vscode/vsce package
```

Before packaging: `vscode:prepublish` runs `node ./scripts/checkPrereqs.js` which will:
- Check that `node_modules` exists (if not, it will instruct you to run `npm ci`), and
- Run the TypeScript compiler (`tsc`) via Node to produce `out/extension.js` (if missing).

Files in `scripts/` are developer helpers and are excluded from the published VSIX. They are intended for local convenience only.

Notes and recommendations

- We intentionally do not auto-run `npm install` during packaging. The `checkPrereqs.js` script instructs contributors to run `npm ci` to ensure reproducible installs.
- There are currently no unit tests in this repository. The `test:unit` script is a no-op. If you add tests, please update `package.json` and reintroduce a test framework (we previously used Jest).
- Linting: run `npm run lint` and consider using `npm run lint -- --fix` to apply safe fixes.

If you have questions or want help adding tests or CI, open an issue or a PR — happy to help.

Diagnostics: the extension writes runtime diagnostics to the "GAMS" Output Channel in VS Code.
Open the Output panel (View → Output) and select `GAMS` from the dropdown to see info/warn/error messages from the extension.