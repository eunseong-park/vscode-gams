# Settings and keys

## How do I change a setting?

Press `Ctrl+,` and type the name of the setting in the search box. Or edit `settings.json`. A setting in a workspace overrides your user setting for that folder.

## All settings

| Setting | Default | What it does |
| --- | --- | --- |
| `gams.sysdir` | empty | Folder of your GAMS installation (the one with `gams`). Empty means auto-detect. |
| `gams.defaultParameters` | `[]` | GAMS parameters added to every run, for example `lo=3`. One entry may hold several parameters. |
| `gams.showLogOnRun` | `true` | Open the GAMS Log when a run starts. |
| `gams.openListingAfterRun` | `false` | Open the listing file (`.lst`) after a run. |
| `gams.editor.openLocation` | `beside` | Where the log and listing open: `beside`, `active` or a group number `1` to `9`. |
| `gams.editor.preserveFocus` | `true` | Keep the cursor in your editor when the log or listing opens. |
| `gams.log.maxLines` | `50000` | Longest log kept in the window. The full log goes to a `.log` file. `0` means no limit. |
| `gams.stopGracePeriod` | `10` | Seconds that **GAMS: Stop** waits before it kills GAMS. `0` kills at once. |
| `gams.updateReferencesOnSave` | `false` | Compile after each save to keep definitions and the Symbols view current. Uses a license session each time. |
| `gams.studioColors` | `off` | Use GAMS Studio colors: `off`, `auto`, `light`, `dark`, `distinct-light`, `dracula-dark`, `solarized-light`, `solarized-dark`. |
| `gams.editor.studioParentheses` | `true` | Highlight matching brackets like GAMS Studio. `Ctrl+B` jumps to the match. |
| `gams.editor.bracketNestingColors` | `true` | Color nested brackets by depth. |
| `gams.help.source` | `offline` | Show help from your GAMS installation (`offline`) or on gams.com (`online`). |
| `gams.help.f1` | `true` | Use `F1` for help in GAMS files. Off keeps `F1` for the Command Palette. |
| `gams.gdxSearch.exclude` | `[]` | Extra glob patterns left out of GDX search and the GDX Files view. |
| `gams.gdxSearch.maxFiles` | `5000` | Most GDX files that the search looks at. |
| `gams.gdxSearch.sort` | `name` | First sort order of symbol search: `name`, `file` or `mtime`. |
| `gams.gdxDiff.coloredView` | `true` | Show the GDX Diff result in the colored view. Off opens the plain viewer. |
| `gams.userModelLibraryDir` | empty | Folder with your own `*.glb` libraries. Empty means `~/Documents/GAMS/modellibs`. |
| `gams.modelLibraryTargetDir` | empty | Folder where library models are copied. Empty means the first workspace folder. |
| `gams.connect.arguments` | `[]` | `key=value` entries that replace `%key%` in Connect files. |
| `gams.neos.email` | empty | Your email address for NEOS. Required for **Run on NEOS**. |
| `gams.neos.priority` | `short` | `short` (5 minutes, live log) or `long` (no limit). |
| `gams.neos.server` | `https://neos-server.org:3333` | NEOS address. Must be `https` (`http` only for localhost). |
| `gams.neos.forceGdx` | `true` | Ask NEOS to return a GDX file. |
| `gams.studio.path` | empty | GAMS Studio program for **Open in GAMS Studio**. Empty means auto-detect in `gams.sysdir`. |
| `gams.studio.arguments` | empty | Extra command line arguments for GAMS Studio. |
| `gams.studio.allowRemote` | `false` | Allow **Open in GAMS Studio** in remote windows (SSH, WSL, containers). |
| `gams.serverPath` | empty | Advanced. Path to the language server program. Empty uses the one that comes with the extension. |

## Old settings of version 0.1.x

| Setting | What happens |
| --- | --- |
| `GAMS.executablePath` | Copied once to `gams.sysdir`. |
| `GAMS.commandLineParameters` | Copied once to `gams.defaultParameters`. |
| `GAMS.idePath`, `GAMS.ideArguments` | Copied once to `gams.studio.path` and `gams.studio.arguments`. |
| `GAMS.runProject`, `GAMS.runBatchPath` | Still work. With both set, `F9` runs the batch file in a terminal. |
| `GAMS.projectLst`, `GAMS.projectGDX` | Still work. Files for **Show Listing File** and **Open Corresponding GDX File** when `GAMS.runProject` is on. |
| `GAMS.terminalCwd` | Still works. Working folder for runs, unless a `.gsp` project sets one. |
| `GAMS.listingFileLocation`, `GAMS.preserveFocus` | Still work, used when `gams.editor.openLocation` and `gams.editor.preserveFocus` are not set. |

## All keys

On macOS use `Cmd` for `Ctrl` in the comment, bracket and section keys.

| Key | Command | When |
| --- | --- | --- |
| `F9` | Run | GAMS file, not while debugging |
| `Shift+F9` | Compile | GAMS file, not while debugging |
| `F10` | Run with Parameters | GAMS file, not while debugging |
| `Shift+F10` | Compile with Parameters | GAMS file, not while debugging |
| `F1` | Help for Word at Cursor | GAMS, option and listing files, if `gams.help.f1` is on |
| `Ctrl+/` | Toggle Line Comment (column 1) | GAMS file |
| `Ctrl+K Ctrl+C` | Add Line Comment | GAMS file |
| `Ctrl+K Ctrl+U` | Remove Line Comment | GAMS file |
| `Shift+Alt+A` | Toggle Block Comment (`$onText` / `$offText`) | GAMS file |
| `Ctrl+Shift+R` | Insert New Section | GAMS file |
| `Ctrl+B` | Jump to Matching Parenthesis | GAMS, option and listing files, if `gams.editor.studioParentheses` is on |

`F5` starts debugging with the normal VS Code key. It is not set by this extension.

## How do I get a VS Code key back?

The keys above replace these VS Code keys in GAMS files: `F9` (breakpoint), `Shift+F9` (inline breakpoint), `F10` (step over), `Shift+F10` (context menu), `F1` (Command Palette), `Ctrl+/`, `Ctrl+K Ctrl+C`, `Ctrl+K Ctrl+U`, `Shift+Alt+A` (comments), `Ctrl+B` (sidebar) and `Ctrl+Shift+R` (refactor).

- `F1`: set `gams.help.f1` to false.
- `Ctrl+B`: set `gams.editor.studioParentheses` to false.
- Any key: press `Ctrl+K Ctrl+S`, search the command, right-click it and choose **Remove Keybinding**. Or add a line to `keybindings.json` with a minus before the command name:

```json
{ "key": "ctrl+shift+r", "command": "-gams.insertNewSection" }
```

The other commands are `-gams.run`, `-gams.compile`, `-gams.runWithOptions`, `-gams.compileWithOptions`, `-gams.toggleLineComment`, `-gams.addLineComment`, `-gams.removeLineComment` and `-gams.toggleBlockComment`.
