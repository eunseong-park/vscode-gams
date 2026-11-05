# Changelog

## [Unreleased]

### Added
- **GAMS: Select GAMS Installation** and a status bar item: lists the GAMS versions found (on `PATH` and in the standard folders), shows the version in use (`GAMS 54.6`, or `GAMS: not found`), and saves the choice in `gams.sysdir` for this workspace or all workspaces. The item sits with the run status item, which shows the running job while a model runs.
- New icon set: a new Marketplace icon and an own Explorer icon for every GAMS file type (`.gms`, `.inc`, `.opt`, `.lst`, `.gdx`, `.ref`, `.lxi`, `.gsp`); source files are orange, generated files dark.
- Icon-only languages `gams-gdx` (GAMS Data (GDX), `.gdx`), `gams-ref` (GAMS Reference, `.ref`), `gams-lxi` (GAMS Listing Index, `.lxi`) and `gams-gsp` (GAMS Project, `.gsp`), so these files get their icons. `.gdx` still opens in the GDX viewer.

### Changed
- Documentation: new section on where the extension looks for GAMS and how to set it.
- GitHub workflows use Node 22.
- `.inc` files now have their own language id `gams-inc` ("GAMS Include"), for their own icon. They keep every feature of `gams` (highlighting, language server, run/compile, debugger, commands and keybindings). Language-specific settings under `"[gams]"` no longer apply to `.inc` files: add them under `"[gams-inc]"` as well. A `files.associations` entry that maps a pattern to `gams` still works (that file gets language `gams`).

## [0.3.0] - Pre-release: rebuilt from scratch as a port of GAMS Studio

An unofficial port of features of the open-source GAMS Studio (not affiliated with GAMS Development Corp.).

### BREAKING CHANGES for 0.1.x users
- License changed from Apache-2.0 to GPL-3.0-or-later.
- Keybindings: F10 was "show listing", it is now "Run with parameters" (like Studio); Shift+F9 was "run with GDX creation", it is now "Compile".
- `.lst` and `.gdx` files are no longer registered as language `gams`: listings are language `gams-lst`, GDX files open in the GDX viewer (custom editor).
- Settings were renamed from `GAMS.*` to `gams.*`. They are migrated once on activation (executable path -> `gams.sysdir`, command line parameters -> `gams.defaultParameters`, IDE path/arguments -> `gams.studio.*`); `GAMS.runProject`, `GAMS.runBatchPath`, `GAMS.projectLst`, `GAMS.projectGDX`, `GAMS.terminalCwd`, `GAMS.preserveFocus` and `GAMS.listingFileLocation` stay supported (deprecated) and work as in 0.1.4. Old settings are never deleted automatically.

### Added
- Ctrl+/ column-1 line comment toggle and Shift+Alt+A block comment (`$onText`/`$offText`); Insert New Section (Ctrl+Shift+R) with optional level.
- Open in GAMS Studio for `.gms`, `.gdx`, `.lst` (`gams.studio.path`, `gams.studio.arguments`, `gams.studio.allowRemote`).
- Rust language server: Studio's syntax highlighter (semantic tokens and TextMate grammar), outline, folding, hover, definition, references, workspace symbols, completion, document links; Studio color palettes.
- Run, compile, run/compile with parameters, interrupt, stop, clickable log, projects and main files.
- GDX viewer, GDX diff and compare, workspace GDX search, Excel/CSV export; model library; Symbols view.
- Debugger, step debugger and profiler; NEOS; GAMS Connect (schema validation, run); context help (F1) with offline documentation.
- Extension additions (not in Studio): comment section headers (`* Name ---`) as nested outline sections with folding; MPSGE language support inside `$onText` blocks starting with `$MODEL:` (semantic tokens `gamsMpsgeSection`/`gamsMpsgeField`, TextMate scopes, outline, folding, completion, hover).
- Bracket nesting colors from the Studio highlighter (`gams/bracketDepths`, setting `gams.editor.bracketNestingColors`): brackets in descriptions, custom `$eolCom` comments, comments, strings and `$onText` blocks are not colored; VS Code's own bracket pair colorization is off for `[gams]`.
- Platform-specific packages for linux-x64 and win32-x64.

- Long logs: the GAMS Log document is chunked and capped (`gams.log.maxLines`, default 50000; the complete log goes to `<filestem>.log`), links are built incrementally and output channel writes are batched, so a 400k-line run no longer blocks the extension host.
- Run, compile, debug and profile share one preparation: all modified GAMS files (and project files) are saved, `gams.sysdir` is validated (error with "Open Settings"), the project / main file and its parameters are applied (also for dynamic main files), and errors from the log appear in Problems. Execution errors (`*** Error at line N`) get a Problems entry too (extension addition).
- `gams.defaultParameters` entries may hold several parameters; output locations follow Studio's `curdir`/`workdir`/`filestem` rules; "Run with parameters" shows GDX / reference / profiling as toggles in the same pick.

### Changed
- GDX files are read and written by `gdx-rs`, a pure Rust port of the official GDX library (GAMS-dev/gdx, MIT; no C code, zlib via `flate2`/`miniz_oxide`). The GDX viewer, export, compare, workspace GDX search and GDX Files view no longer need a GAMS installation or `gams.sysdir` (GDX Diff still runs `gdxdiff` from the sysdir). Reading is verified against the GDX C library on every GDX file of GAMS 54.6 and on generated files with millions of records, and is about 2-2.7x faster.

### Legacy support
- The 0.1.x settings `GAMS.runProject` + `GAMS.runBatchPath` (F9 runs the batch file in a terminal), `GAMS.terminalCwd`, `GAMS.projectLst`/`GAMS.projectGDX` (new commands Show Listing File / Open Corresponding GDX File), `GAMS.listingFileLocation` and `GAMS.preserveFocus` keep working (deprecated), including the Run Project status bar toggle.
- New settings `gams.openListingAfterRun`, `gams.editor.openLocation`, `gams.editor.preserveFocus`.
- GAMS tasks (`"type": "gams"` in tasks.json: `file`, `parameters`, `compile`) run through the extension's runner (log, links, Problems) and can be chained with shell tasks via `dependsOn`.

## Earlier versions (0.1.x, Apache-2.0)

### [0.1.4] - 2025-12-08

#### Changed
- `Toggle Line Comment` command now closely matches VS Code's native behavior, improving multi-selection and toggle logic.
- GAMS execution now uses VS Code's Tasks API (`vscode.ShellExecution` for batch files and `vscode.ProcessExecution` for GAMS executable) for better integration and robustness, allowing users to specify `GAMS.executablePath` for reliable execution regardless of system PATH configuration.

#### Removed
- Obsolete `GAMS.terminalLocation` setting and related internal code.

### [0.1.3] - 2025-12-04

#### Changed
- Commands and keybindings now use case-insensitive matching for file extensions, ensuring menu items appear regardless of filename casing (for example `file.GdX` or `file.GMS`).
- Opening GDX files is more reliable across platforms.
- Status bar items (`GAMS Settings`, `Run Project`) only show when editing GAMS files.
- The `Run Project` toggle now saves to the workspace settings when possible.

#### Fixed
- Minor fixes and reliability improvements.

### [0.1.1] - 2025-11-25

#### Added
- Implemented Code Folding for GAMS files, supporting:
  - Comment-based sections (e.g., `*** Section Name ---`).
  - GAMS `$ontext`/`$offtext` blocks.
  - GAMS declaration blocks (e.g., `SET`, `PARAMETER`, `EQUATION`).

### [0.1.0] - 2025-11-24
#### Added
- "Insert New Section" command (`ctrl+shift+r`) to insert a new section with a formatted header.
#### Fixed
- Fixed a bug in the document outline feature that caused it to fail when encountering a section without a name.

### [0.0.11] - 2025-11-24

#### Added
* Added `GAMS.listingFileLocation` setting to customize where the listing file opens.

### [0.0.10] - 2025-11-24

#### Changed

* Updated extension icon to `images/letter-gams.png`.

### [0.0.9] - 2025-11-24

#### Added

* Added tip to `README.md` for MPSGE syntax highlighting.

#### Fixed

* Resolved `vsce package` error by explicitly adding `activationEvents` property.

### [0.0.8] - 2025-11-24

#### Added

* Implemented "Toggle Line Comment" functionality (uses `*`).
* Added Document Symbol Provider for GAMS files, enabling outline view for declarations and sections.

#### Changed

* Updated syntax highlighting for improved accuracy and consistency across various GAMS language constructs (keywords, options, comments, strings).
* Added '#' as a recognized line comment character in syntax highlighting.

### [0.0.7] - 2025-02-20

#### Changed

* Improved syntax highlighting for plural/singular forms of field names in MPSGE.

### [0.0.6] - 2025-01-15

#### Fixed

* Corrected syntax highlighting for variables.

### [0.0.5] - 2024-11-21

#### Added

* Added a button to the status bar to quickly open GAMS extension settings.
* Added a status bar button to toggle the `runProject` setting, displaying the current status (`On`/`Off`).

### [0.0.4] - 2024-06-07

#### Added

* Users can now add command-line parameters.

### [0.0.3] - 2024-05-20

#### Added

* Added "Open GDX with GAMS IDE" button and context menu in the explorer.

#### Fixed

* Fixed syntax highlighting issues.

### [0.0.2] - 2024-05-06

#### Added

* Support for running project batch files.
* Icons for GAMS-related files.

### [0.0.1] - 2024-04-01

#### Added

* Initial release of the extension.
