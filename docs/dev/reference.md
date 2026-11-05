# Reference (detailed notes for maintainers)

> **Unofficial.** This extension is an independent port of features of the open-source [GAMS Studio](https://github.com/GAMS-dev/studio) to Visual Studio Code. It is **not affiliated with, endorsed by or supported by GAMS Development Corp.** "GAMS" is a trademark of its owner. A GAMS installation and license are required for runs.

Extension id `eunseong-park.vscode-gams` (successor of 0.1.x). Source and issues: <https://github.com/eunseong-park/vscode-gams>. Licensed under GPL-3.0-or-later (see `LICENSE`).

The extension is a TypeScript client plus a Rust language server (`gams-lsp`) in `server/`.

## Requirements

- A GAMS installation (the "system directory") for running models, option files, the model library, documentation and `gdxdiff`. The extension runs `gams` from it and loads its option library at runtime. A valid GAMS license is needed for runs.
- GDX features (viewer, Excel/CSV export, compare, workspace GDX search, GDX Files view) do **not** need GAMS: GDX files are read by `gdx-rs`, a pure Rust port of the official GDX library ([GAMS-dev/gdx](https://github.com/GAMS-dev/gdx), MIT). Only **GAMS: GDX Diff...** runs `gdxdiff` from the sysdir.
- The sysdir is taken from `gams.sysdir`, otherwise auto-detected (`gams` on PATH, newest `/opt/gams/*`, then `C:/GAMS/*`).
- VS Code 1.95 or newer. Prebuilt VSIX targets: linux-x64 and win32-x64.

## Features

- Languages: GAMS (`.gms`, `.inc`, `.dmp`), GAMS option files (`.opt`, `.op2`-`.op9`, `.pf`, ...), listing files (`.lst`).
- Syntax highlighting (semantic tokens plus TextMate grammar), optionally with Studio's color palettes.
- Language server: outline, folding, hover, go to definition, find references, workspace symbols, completion, document links.
- Outline sections from comment headers (`* Data ------`) and MPSGE language support (extension additions, not in GAMS Studio), see "Comment sections" and "MPSGE models" below.
- Run, compile, interrupt and stop GAMS runs with a clickable log; GAMS activity bar view with a Symbols tree.
- GDX viewer (custom editor for `*.gdx`) with sort/filter, pivot, charts, search, resizable columns and panels, CSV export; GDX Diff.
- Workspace GDX search (extension addition, not in GAMS Studio): **GAMS: Find Symbol in GDX Files** (QuickPick over all `.gdx` files; filter with `type:par,var`, `dim:2`, `file:glob`, `/regex/`; the sort button cycles name/file/modification time) and **GAMS: Find Element in GDX Files** (label, `/regex/`, `case:` prefix; lists the symbols that use the label and the key position). Both open the GDX viewer on the symbol. The **GDX Files** view in the GAMS sidebar shows files grouped by folder with their symbols, refreshes when `.gdx` files change and offers Open / Compare with... Files are indexed by the language server (cached by path, mtime and size) and are never kept open. Settings: `gams.gdxSearch.exclude` (besides `files.exclude` and `search.exclude`), `gams.gdxSearch.maxFiles`, `gams.gdxSearch.sort`.
- GDX compare (extension addition, not in GAMS Studio): **GAMS: Compare with...** (Explorer context menu on `.gdx` files, also in the GDX Files view; select two files, or one and pick the second) opens a side-by-side view. Symbols are listed with status badges (only in A / only in B / equal / different, counts of changed / added / removed rows) and a name / status filter; the A and B grids scroll together, records are aligned by key, changed cells are highlighted, added rows are green and removed rows red, with absolute and relative difference columns, **Only differences**, next / previous difference (F7 / Shift+F7), Variable / Equation attribute selection and the number format / thousands separator of the viewer. The comparison follows the shipped `gdxdiff` (checked record by record against it with generated file pairs): `Eps`, `RelEps`, `SetDesc`, `Field`, `CmpDefaults` and `CmpDomains` are in the **Options** menu (`IgnoreOrder` only shrinks gdxdiff's output file and is a **GAMS: GDX Diff...** option only). Like gdxdiff, a parameter or variable record that exists in one file only and equals the default record (0, or the default of the variable type, within the tolerances and for the compared fields) is *not* a difference unless `CmpDefaults` is on (such a row is listed as equal); equations and set elements always count. An element without text is different from an element with the text `Y`. Aliases are compared like the set they alias (an alias of the universe `*` has one record per label); with `CmpDomains` symbols with different domains are different and their records are not compared. **CSV** exports one symbol to a file or several into a folder with `summary.csv`; **Excel** writes a Summary sheet plus one sheet per symbol (frozen header, filter, same colors, numbers as numbers, special values as text, Excel's 1,048,576 row limit noted in the summary). `GAMS: GDX Diff...` opens its result in a colored diff view (inserted / changed / removed rows paired from the `dif1` / `dif2` / `ins1` / `ins2` records; **Raw view** returns to the GDX viewer; setting `gams.gdxDiff.coloredView`). A gdxdiff result opened in the GDX viewer offers the colored view as well (`GAMS: Open gdxdiff Result as Colored Diff`).
- GDX viewer Excel export (port of Studio's export dialog): **Export to Excel...** chooses symbols, "Apply Filters", "Hidden Attributes", the Excel and Connect files and the EPS / INF / -INF / UNDEF / NA substitutions. **Export** writes the workbook natively (one sheet per symbol in the layout of the list or table view; GAMS is not started) and a GAMS Connect file (GDXReader, Filter, Projection, ExcelWriter as Studio writes it) that reproduces it with `gamsconnect`; **Save Connect file only** writes just the YAML. The workbook is cell-for-cell what the Connect ExcelWriter writes (checked by running the generated file with `gamsconnect` on 45 GDX files): no header rows for sets and parameters (no domain names), a header row with the attribute names for variables and equations (blank above the labels), column labels for the table view, numbers with 16 significant digits, acronyms as `UNDEF`, element text only where an element has one (a text `Y` is kept, an element without text gets no cell). Aliases of the universe (`Alias (u,*)`) are not exported, neither to the workbook nor to the Connect file, because the Connect GDXReader does not support them (the message names them). CSV export writes the element text of sets the same way (empty for elements without text). Extension option **Header row with domain names** (off by default = the Studio layout above; remembered): list sheets get a first row with the domain names (relaxed `*` as `uni_N`, repeated names as `name_N`, like the compare export) followed by `value` (parameters), `text` (sets) or the exported attribute names (variables / equations); table sheets get the row-dimension names in the top-left header cells; the header is frozen and has an autofilter. GAMS Connect's ExcelWriter has no option for such a row (`columnDimension` only spreads the last dimensions over header rows), so the header exists in the workbook only; the generated Connect file stays Studio-identical and starts with a comment saying so. The compare view's Excel export already has a frozen, filterable header row with the same key column names.
- `gams.openGdxSymbol` (uri, symbol name) opens a GDX file in the viewer with the symbol selected.
- Model library browser (`GAMS: Open Model Library`).
- Debugger (`gams` debug type, Step Debugger) and profiler.

Keybindings (when editing GAMS files): F9 Run, Shift+F9 Compile, F10 Run with Parameters, Shift+F10 Compile with Parameters (these four are inactive while debugging so VS Code's debugger keeps F9 toggle breakpoint, F10 step over, Shift+F9 inline breakpoint and Shift+F10 context menu; GAMS Studio's own debugger uses F11 / Shift+F11, which this extension does not bind), Ctrl+/ (Cmd+/ on macOS) Toggle Line Comment, Ctrl+K Ctrl+C / Ctrl+K Ctrl+U Add / Remove Line Comment, Shift+Alt+A Toggle Block Comment, Ctrl+Shift+R Insert New Section.

Keybindings that replace a VS Code default in GAMS editors, and how to get the default back (Keyboard Shortcuts, `Ctrl+K Ctrl+S`, search the command, "Remove Keybinding"; or add `{ "key": "...", "command": "-<command>" }` to `keybindings.json`):

| Key | VS Code default | GAMS command | Disable |
| --- | --- | --- | --- |
| F1 | Command Palette | `gams.contextHelp` | setting `gams.help.f1` = `false` |
| Ctrl+/ | Toggle Line Comment | `gams.toggleLineComment` | `-gams.toggleLineComment` |
| Ctrl+K Ctrl+C / Ctrl+K Ctrl+U | Add / Remove Line Comment | `gams.addLineComment` / `gams.removeLineComment` | `-gams.addLineComment`, `-gams.removeLineComment` |
| Shift+Alt+A | Toggle Block Comment | `gams.toggleBlockComment` | `-gams.toggleBlockComment` |
| Ctrl+Shift+R | Refactor | `gams.insertNewSection` | `-gams.insertNewSection` |
| Ctrl+B | Toggle Sidebar | `gams.jumpToMatchingParenthesis` | setting `gams.editor.studioParentheses` = `false` |
| F9, Shift+F9, F10, Shift+F10 | Toggle breakpoint, inline breakpoint, step over, context menu | run / compile (with parameters) | `-gams.run`, `-gams.compile`, `-gams.runWithOptions`, `-gams.compileWithOptions` |

## Editing helpers

- **Why VS Code's built-in comment commands are replaced**: the language configuration declares no `lineComment` / `blockComment`. The built-in *Toggle Line Comment* (menu Edit), *Add/Remove Line Comment* and *Toggle Block Comment* would put `*` at the indentation (code, not a comment) or insert `$onText` / `$offText` inline (which comments out the rest of the file), so for GAMS files those built-in menu items do nothing. Use the GAMS commands below (Ctrl+/, Ctrl+K Ctrl+C, Ctrl+K Ctrl+U, Shift+Alt+A, also in the editor context menu).
- **Add / Remove Line Comment** (`gams.addLineComment`, `gams.removeLineComment`; Ctrl+K Ctrl+C / Ctrl+K Ctrl+U): always comment, or always uncomment, the selected lines at column 1.
- **Toggle Line Comment** (`gams.toggleLineComment`): a GAMS `*` comment must start in column 1, so VS Code's built-in toggle (which inserts the marker at the indentation) would produce code, not a comment. The command inserts `*` (plus a space, see `editor.comments.insertSpace`) at column 1 and removes a column-1 `*` (and one space) again; empty lines follow `editor.comments.ignoreEmptyLines`. Works with several selections as one undo step.
- **Toggle Block Comment** (`gams.toggleBlockComment`): wraps the selected lines in `$onText` / `$offText` lines at column 1, or removes such a pair; when the selection already contains the `$onText` and `$offText` lines (or they directly surround it) they are removed.
- **Insert New Section** (`gams.insertNewSection`): asks for a name and inserts `* Name ------...` (74 characters wide). Start the name with `**`, `***` ... to create a deeper level.

## Parentheses (Studio behavior)

With `gams.editor.studioParentheses` (default on) the pair next to the cursor is highlighted like in GAMS Studio (green when matching, red when mismatched or unmatched, also across lines; brackets in comments, strings and `$onText` are ignored), and **Ctrl+B** (Cmd+B on macOS) jumps to the matching parenthesis and back instead of toggling the sidebar. VS Code's own match box is turned off for GAMS (`[gams]` `editor.matchBrackets: "never"`); when you set the option to `false`, re-enable `editor.matchBrackets` for `[gams]` yourself. Nested brackets are colored by nesting level with VS Code's bracket colors (`editorBracketHighlight.*`, cycling by depth, a mismatched bracket in the unexpected-bracket color), but based on Studio's bracket structure: brackets in comments (also end-of-line comments with a custom `$eolCom`), quoted strings, unquoted symbol descriptions (`m0(g)  Imports (cif)`) and `$onText` blocks (including MPSGE blocks) are not colored, which VS Code's own colorizer cannot tell. VS Code's colorizer is therefore turned off for `[gams]` (`configurationDefaults`); `gams.editor.bracketNestingColors` (default on) toggles the GAMS colors, it does not change your settings. The matching pair is highlighted with a background, so it combines with the nesting colors.

## Comment sections (extension addition, not in GAMS Studio)

A column-1 comment line of the form `* Name ---` (at least three dashes after a blank, the name is the text before them; `**`, `***` ... make deeper levels) is a section header. Headers nest in the **Outline**: the number of `*` is the level, declarations (and MPSGE models) are shown below the header that precedes them, and a header closes all open sections of the same or a deeper level. Each section can be folded (header line to the last non-blank line before the next header of the same or a higher level). Headers inside `$onText` blocks and indented `*` lines are not GAMS comments and are ignored. Documents without headers keep the flat outline. **Insert New Section** (Ctrl+Shift+R) writes such a header.

## MPSGE models (extension addition, not in GAMS Studio)

GAMS Studio shows an MPSGE model as an ordinary `$onText ... $offText` comment. This extension recognizes the block when its first non-blank, non-`*` line starts with `$MODEL:<name>` (the form read by `$sysInclude mpsgeset <name>`) and offers:

- Semantic highlighting of the MPSGE text: section keywords (`$SECTORS:`, `$COMMODITIES:`, `$CONSUMERS:`, `$AUXILIARY:`, `$PROD:`, `$DEMAND:`, `$CONSTRAINT:`, `$REPORT:` and the switches `$ECHOP:`, `$PEPS:`, `$EULCHK:`, `$WALCHK:`, `$FUNLOG:`, `$DATECH:`) as token type `gamsMpsgeSection`, record field labels (`O: I: D: E: Q: P: A: T: N: M: R: V: W: s: t:`, nest identifiers such as `a:` or `i.tl(m):`, `PROD:`/`DEMAND:` in `$REPORT:`) as `gamsMpsgeField`, names as `gamsIdentifier`, numbers as `gamsAssignValue`, quoted labels as `gamsAssignLabel`, `*` and `!` comments as `gamsComment`, and the `!` descriptors of the declaration blocks as `gamsDescription`. With `gams.studioColors`, sections use Studio's *Declaration Keyword* color and fields Studio's *Keyword* color (Studio has no MPSGE colors; this is our choice). Text outside MPSGE blocks is highlighted exactly as before.
- A TextMate grammar layer with MPSGE scopes (`storage.type.section.mpsge.gams`, `keyword.other.field.mpsge.gams`, ...) inside `$onText` after a `$MODEL:` line.
- Outline (the model with its sections and the declared variables) and folding of the MPSGE sections.
- Completion inside blocks: section keywords after a `$` in column 1, field labels at the start of a record and after the lead field (`Q: P: A: T: N: M:` for `$PROD:`, `Q: P:` / `Q: R:` for `$DEMAND:`, ...), with the documentation text. VS Code does not offer suggestions while typing inside comments by default: press Ctrl+Space or enable `editor.quickSuggestions` for comments.
- Hover on section keywords, field labels and declared variables with the text of the MPSGE documentation (`UG_MPSGE*.html`, `mpsge.pdf` of the GAMS installation).

The syntax was read from the official MPSGE documents only; see `docs/dev/sources.md`. MPSGE models cannot be solved without the GAMS/MPSGE preprocessor and license; the extension only reads the text.

## Open in GAMS Studio

**GAMS: Open in GAMS Studio** (Explorer and editor title menus for `.gms`, `.gdx`, `.lst`) starts the real GAMS Studio detached on the file. `gams.studio.path` is detected when empty: `<sysdir>/studio/studio.AppImage` (Linux), `<sysdir>/studio/studio.exe` (Windows), `/Applications/GAMS Studio.app` (macOS); `gams.studio.arguments` adds command line arguments. In a remote window (SSH, WSL, containers) Studio would start on the *remote* machine and needs a display there, so the command is hidden unless `gams.studio.allowRemote` is on.

## Upgrading from 0.1.x

Version 0.2.0 is a rebuild from scratch (same extension id, so VS Code updates it in place). Things that changed:

- **License**: Apache-2.0 -> GPL-3.0-or-later.
- **Keybindings**: F10 was "show listing", it is now "Run with parameters" (as in Studio); Shift+F9 was "run with GDX creation", it is now "Compile". `.lst` and `.gdx` files are no longer language `gams` (listings are language `gams-lst`, GDX files open in the GDX viewer). Ctrl+/ and Ctrl+Shift+R keep working as before.
- **Settings** were renamed from `GAMS.*` to `gams.*`. On first start the extension migrates what it can and shows one notification; it never deletes your old settings (the notification offers "Remove old settings"):
  - `GAMS.executablePath` (path to `gams[.exe]`) -> `gams.sysdir` (its directory)
  - `GAMS.commandLineParameters` -> `gams.defaultParameters`
  - `GAMS.idePath` / `GAMS.ideArguments` -> `gams.studio.path` / `gams.studio.arguments`
  - `GAMS.runProject`, `GAMS.runBatchPath`, `GAMS.projectLst`, `GAMS.projectGDX`, `GAMS.terminalCwd`, `GAMS.preserveFocus`, `GAMS.listingFileLocation`: not migrated, still supported (deprecated), see [Legacy 0.1.x settings](#legacy-01x-settings-and-gams-tasks).

Commands (category "GAMS"): Run, Compile, Run/Compile with Parameters..., Interrupt, Stop, Show Log, Refresh/Filter/Clear Filter Symbols, GDX Diff..., Open Model Library, Run Debugger, Step Debugger, Open Snapshot in GDX Viewer, Run with Profiler, Show/Clear Profile.

Settings: `gams.sysdir`, `gams.defaultParameters`, `gams.serverPath`, `gams.showLogOnRun`, `gams.openListingAfterRun`, `gams.editor.openLocation`, `gams.editor.preserveFocus`, `gams.studioColors`, `gams.updateReferencesOnSave` (each save starts a compile that uses a license session; off by default), `gams.userModelLibraryDir`, `gams.modelLibraryTargetDir`, `gams.stopGracePeriod` (Stop sends the GAMS interrupt first and kills only after this many seconds, default 10, so network-license sessions close cleanly; Stop twice kills at once; 0 = immediate kill like Studio).

## Legacy 0.1.x settings and GAMS tasks

Read from the user/workspace values of `GAMS.*`, behavior as in 0.1.4:

- `GAMS.runProject` = true with `GAMS.runBatchPath`: **Run** (F9) runs the batch file in a VS Code terminal (shell task "GAMS") instead of GAMS, working directory `GAMS.terminalCwd` or the file's directory. Without `runBatchPath`, F9 is a normal run. 0.1.4 did not open anything after the run; `GAMS: Show Listing File` opens `GAMS.projectLst` (else `<file>.lst`) and `GAMS: Open Corresponding GDX File` opens `GAMS.projectGDX` (else `<file>.gdx`) in the GDX viewer, both with `runProject` on. With `gams.openListingAfterRun` the listing opens when the batch task ends. The "Run Project: On/Off" status bar item (toggle command `GAMS: Toggle Run Project`) shows while `GAMS.runProject` is set.
- `GAMS.terminalCwd` also is the working directory of normal runs, unless a `.gsp` project sets one.
- `GAMS.listingFileLocation` (`Beside`, `Active`, `One`..`Nine`) and `GAMS.preserveFocus` are fallbacks for `gams.editor.openLocation` and `gams.editor.preserveFocus` (defaults `beside`, `true`; values `beside`, `active`, `1`..`9`), which place the listing and the log view. `gams.openListingAfterRun` (default off, as in Studio) opens the listing after a run. Links in the log are opened by VS Code and not affected.
- "Remove old settings" in the start notification deletes these keys and so turns the legacy behavior off. For `runBatchPath` the notification also offers "Create task from run script", which adds a shell task "GAMS project run" (command = `runBatchPath`, cwd = `terminalCwd`) to `.vscode/tasks.json` without touching existing tasks.

**Tasks**: `{ "type": "gams", "file": "${file}", "parameters": ["lo=3"], "compile": false }` (all optional; `file` defaults to the active GAMS file, relative paths to the workspace folder). The provider offers "GAMS: Run <file>" and "GAMS: Compile <file>". They run through the extension's runner (log view, links, Problems, project main file and `gams.defaultParameters`) in a pseudoterminal; closing the terminal stops GAMS. Chain several steps with `dependsOn`:

```json
{ "label": "prepare data", "type": "shell", "command": "python prep.py" },
{ "label": "model", "type": "gams", "file": "model.gms", "dependsOn": ["prepare data"] }
```

## Context help (F1)

`F1` in a GAMS editor (setting `gams.help.f1`, default on; the Command Palette stays on `Ctrl+Shift+P`) or `GAMS: Help for Word at Cursor` opens the documentation for the word under the cursor, like GAMS Studio: `$` options jump to `UG_DollarControlOptions.html`, keywords/declarations to the keyword index, other words to the documentation search, solver options in `.opt` files to the solver manual (`S_<SOLVER>.html#<SOLVER><option>`), `.pf` options to the GAMS call options, `.lst` files to the Studio listing-viewer chapter. `gams.help.source` = `offline` (default) shows `<sysdir>/docs` in a "GAMS Help" panel (falls back to the online docs when missing); `online` opens `https://www.gams.com/<major>/docs/...` in the browser. Keyword hovers get an "Open documentation" link. Links to other sites (and files such as `.xlsx`, `.pdf`, `.gms`) are opened in the browser or offered for saving instead of in the panel. Limitation: back/forward in the panel only follow page loads, not in-page anchor jumps.

## Running on NEOS

`GAMS: Run on NEOS` ports the GAMS Studio NEOS integration. It first runs GAMS locally (`action=c xsave previousWork=1`, which does not solve) and then sends the resulting restart file (`.g00`), your GAMS parameters and your email address to the NEOS Server (`https://neos-server.org:3333` by default, setting `gams.neos.server`). Your model is therefore visible to the NEOS operators; NEOS offers no confidentiality guarantee. Read the [NEOS terms of use](https://neos-server.org/neos/termofuse.html). Before the first submission the extension shows these terms and asks you to agree. "Submit, don't ask again" is only offered afterwards, and `GAMS: Reset NEOS Terms Confirmation` undoes both.

NEOS requires an email address: set `gams.neos.email` (it is never filled in from anywhere else). Other settings: `gams.neos.priority` (`short`: 5 minute limit, log streamed live; `long`: no limit, job number and password are printed in the log) and `gams.neos.forceGdx`. Results are unpacked with `gmsunzip` into `<workdir>/<model>/` and linked from the GAMS log. `GAMS: Stop` sends `killJob` to NEOS (the server may ignore it) or stops the local step using `gams.stopGracePeriod`.

## GAMS Connect

- **Validation, completion and hover help** for Connect YAML files come from the [YAML extension by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) (`redhat.vscode-yaml`, recommended, not required; the extension offers to install it once). Files named `*.connect.yaml` / `*.connect.yml` are validated automatically; for any other YAML file run **GAMS: Treat as Connect File**, which adds the file to `yaml.schemas` in the workspace settings (user settings when no folder is open). A setting is used instead of a `# yaml-language-server: $schema=` modeline because it leaves the file untouched (Connect files are read by `gamsconnect`, and the modeline would have to hold a path into the extension's version-specific install folder); stale paths are repaired on activation.
- The JSON Schema `schemas/connect/connect.schema.json` is generated from the official Cerberus agent schemas of the GAMS installation (`node scripts/gen-connect-schema.js`, uses `GAMS_SYSDIR`); option descriptions come from the offline GAMS Connect documentation. Cerberus rules without a JSON Schema equivalent are listed in the generator's header.
- **GAMS: Run Connect File** (also the play button in the editor title of Connect files) runs `<sysdir>/gamsconnect <file> [key=value ...]` in the file's directory, shows the output in the "GAMS Connect" output channel and, after success, offers to open the written `.gdx` files (`GDXWriter` agents) in the GDX viewer. `gams.connect.arguments` supplies the `key=value` substitutions for `%key%` in the file. Official examples use unquoted placeholders such as `%PLACEHOLDER%` as values; a plain YAML scalar must not start with `%`, so the Red Hat YAML parser reports an error for them. Quote the value (`"%PLACEHOLDER%"`) to get a clean validation. Cancel the progress notification to stop (interrupt first, kill after `gams.stopGracePeriod`).
- Snippets: `gams-connect-excel-to-gdx`, `gams-connect-csv-to-gdx`, `gams-connect-gdx-to-excel` (YAML files).

## Building from source

Needs Node 22+ and Rust (cargo). No GAMS installation is needed to build: GDX files are handled by the pure Rust crate `server/crates/gdx-rs` (no C code; zlib via `flate2`/`miniz_oxide`), the OPT shared library is loaded at runtime from the GAMS system directory (via `libloading`). Tests that need a GAMS install skip with a note when `GAMS_SYSDIR` is not set or lacks the libraries.

The GDX oracle tests compare `gdx-rs` (and the `gams-gdx` API on top of it) with the official GDX C library of a GAMS installation, on every `.gdx` of the installation and the repository, on generated files with more than a million records (compressed and uncompressed) and on files written by `gdx-rs`; `gdxdump` from the sysdir checks that Rust- and C-written files have identical contents:

```
GAMS_SYSDIR=<GAMS system directory> cargo test --release --manifest-path server/Cargo.toml -p gdx-rs -p gams-gdx --features gdx-rs/capi-oracle,gams-gdx/capi-oracle
```

```
npm ci
npm run build          # bundle the client
npm run lint
npm test               # unit tests
npm run package:linux  # server + VSIX (linux-x64)
npm run package:win32  # cross-compile gams-lsp.exe + VSIX (win32-x64)
```

`package:win32` needs mingw-w64 (`x86_64-w64-mingw32-gcc`) and `rustup target add x86_64-pc-windows-gnu`; the linker and static linking of libgcc/winpthread are configured in `server/.cargo/config.toml`. `node scripts/build-server.js [target]` builds the server for any target into `server/bin`.

Rust tests that do not need GAMS: `cargo test --manifest-path server/Cargo.toml -p gams-syntax -p gams-ref -p gams-lst`.

## Provenance

Behavior is ported only from the official GAMS Studio sources, the GAMS installation, and the GAMS documentation. Every ported fact is recorded with its source file in `docs/dev/sources.md`.

## Known limitations

- MPSGE (extension): the TextMate layer cannot look ahead and starts at any `$MODEL:` line inside an `$onText` block; the semantic tokens and all server features use the exact rule (first non-blank, non-`*` line). Prose before `$MODEL:` makes the block an ordinary comment.
- Most features that execute GAMS (run, compile, reference updates, debugger, profiler) need a GAMS installation and license; the extension does not ship GAMS.
- The Windows and macOS builds are produced by CI (`.github/workflows/release.yml`) and have not been run on those systems by the authors.
- Only a subset of Studio is ported (no MIRO or GAMS Engine integration).

## Licenses
- This extension is licensed under GPL-3.0-or-later (see `LICENSE`). It ports logic and syntax tables from GAMS Studio (GPL-3.0).
- Third-party components (bundled npm packages, Rust crates, MIT-licensed GAMS-dev code) are listed with their license texts in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The GAMS documentation is not bundled. Documentation is read from your GAMS installation (`docs/`) or linked on https://www.gams.com; hovers and completion items only link to it.
- GAMS is a trademark of GAMS Development Corp. This extension is unofficial and not affiliated with or endorsed by GAMS.
