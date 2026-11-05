# File types, project (.gsp), model library, misc parity items

Sources: `studio-src/src/file/{filetype,projectrepo,pexgroupnode,gprimporter,filemeta}.cpp`, `studio-src/src/modeldialog/*`, `studio-src/src/mainwindow.cpp`,
`$GAMS_SYSDIR/{gamslib,*lib_ml/*.glb}`, `$GAMS_SYSDIR/docs/{UG_ModelLibraries,T_STUDIO}.html`.

## 1. File kinds and suffixes (`FileType::mFileTypes`, file/filetype.cpp L33-47)
| Kind | suffixes (first = default) | description | autoReload |
|---|---|---|---|
| Gsp | gsp, pro | GAMS Studio Project | no |
| Gms | gms, inc, dmp (+ user-defined list) | GAMS Source Code | no |
| Txt | txt | Text (editable) | no |
| TxtRO | log | Text (read only) | no |
| Lst | lst | GAMS List File | yes |
| Lxi | lxi | GAMS List File Index | yes |
| Gdx | gdx | GAMS Data | yes |
| Ref | ref | GAMS Ref File | yes |
| Log | ~log | GAMS Log File (virtual) | yes |
| Opt | opt (+ op2..op9, o10..o99, 100+) | Solver Option File | no |
| Pf | pf | GAMS Parameter File | no |
| Guc | yaml (only when basename == `gamsconfig`) | GAMS Config File | no |
| Efi | efi | External Files | no |
| GCon | yaml, yml | GAMS Connect YAML | no |
- Lookup order (`FileType::from(fileName)`, L102-146): iterates list; Guc needs `completeBaseName=="gamsconfig"` (case-ins.) + suffix yaml/yml; GCon matches any other yaml/yml (Guc is earlier in the list, so it wins for gamsconfig.yaml); Opt additionally requires the base name be a known solver (from gmscmpun.txt; if solver list empty any name passes) and accepts numbered option-file suffixes by regex `[oO][pP][2-9]|[oO][1-9]\d|[1-9]\d\d+`; otherwise suffix match, case-insensitive; fallback `None` ("Unknown File").
- User-defined GAMS suffixes (setting) appended to Gms list; forbidden: `"" ref gdx log lst lxi opt yaml exe efi` (`CInvalidUserTypes`, `validateSuffixList`).
- In a .gsp, a file's `type` string is the kind's first suffix (`kindAsStr`); for `type=="gms"` the loader re-derives the type from the file name (`FileType::from(QFileInfo(name).fileName())`) (projectrepo.cpp L449-450).
- GAMS file-name conventions: `.lst` has no automatic extension when `o=`/`lst=` is given w/o suffix; `.gdx`/`.ref` get one (pexgroupnode.cpp L1440-1446).
- Cleanup of run products (`MainWindow::on_actionClean...` L5480-5510, `cleanupKinds {"gdx","gsp","log","lst","ls2","lxi","ref"}` L4604): `<workspace>/<project>.{gdx,lst,lxi,ref}`, `<project>.log*`, scratch dirs.

## 2. Project file (.gsp) – JSON (projectrepo.cpp `getProjectMap` L520-560, `read` L317+, `parseProjectFile` L1258)
UTF-8 JSON object (Qt `QJsonDocument::toJson()`, indented). Legacy wrapper `{ "projects": [ {...} ] }` (settings format) is accepted: first element is used. Paths in the .gsp are **relative to the .gsp's directory** (written with `dir.relativeFilePath`); in Studio's settings JSON they are absolute plus a `"project"` key = gsp path.
Top-level keys:
- `file` main GMS (relative), `pf` parameter file (optional), `projectType` int (0 small, 1 common, 2 search, 3 gams-system; `PExProjectNode::Type`), `path` project base dir (relative), `workDir` working dir (relative), `name`, `options` (array of run-parameter history strings, most recent last as in `getRunParametersHistory`),
  `dynamicMainFile` bool (main = active file), `ownBaseDir` bool, `timestamp` (ISO datetime, optional), `engineJobToken` (optional), `expand` string of `0/1` chars (tree expansion DFS order), `nodes` array.
- `nodes[]`: `{ "file": rel path, "name": display name, "type": "gms|lst|gdx|opt|pf|...", "encoding": "UTF-8", "codecMib": int (legacy, dropped after GAMS 52), "options": [per-file run parameter history] }`.
- Loading: relative paths resolved against gsp dir (`QDir::cleanPath(absoluteFilePath)`); missing files => warning "File not found" unless suffix in ignore list `.lst.lxi.log.` (generated files); main file missing from nodes gets added with warning "Incomplete data for main file fixed". Encoding fallback: `encoding` -> `codecMib` -> default encoding setting. Save only when `needSave` (via `TextFileSaver`, atomic write).
- Legacy IDE import: `GprImporter` reads old GAMS-IDE `.gpr` INI files: sections `[MRUFILES]` (`n=path`, backslashes -> `/`), `[OPENWINDOW_n]` (`FILE`...), `[RP:<file>]` run parameters; offers path relocation when files missing, then creates a project.
- Project node tree: project -> files (flat `listFiles()`), plus virtual group "Generated/log" (`PExLogNode`, `[LST:n]` hrefs target this). Other flags: project `workDir` default = `CommonPaths::defaultWorkingDir()`; default solver/params come from `gamsconfig.yaml` (see options.md).
- Run parameters per run: Studio builds `gams <main.gms> <default args> <history line>`; `curdir`/`workdir` override base/work dirs; `filestem` from main file. Logs in `<workdir>/<project>.log` (`logfile`).

## 3. Model library dialog (modeldialog/*)
- Library index files (all in `$GAMS_SYSDIR`): `gamslib_ml/gamslib.glb` (432 models), `testlib_ml/testlib.glb` (927), `apilib_ml/apilib.glb` (61), `datalib_ml/datalib.glb` (129), `emplib_ml/emplib.glb` (104), `finlib_ml/finlib.glb` (42), `noalib_ml/noalib.glb` (78), `psoptlib_ml/psoptlib.glb` (31); tab labels override `LibraryName`: "Model Library","Test Library","API Library","Data Utilities Library","EMP Library","FIN Library","NOA Library","PSO Library" (modeldialog.cpp L75-92). The model files live next to the glb (`gamslib_ml/<name>.<seq>`, plus data/inc files); `gamslib_ml/` has 482 entries.
- User libraries: every `*.glb` found recursively under setting `userModelLibraryDir` (default `<Documents>/GAMS/modellibs`, `CommonPaths::userModelLibraryDir`), tabs named by their own LibraryName (`loadUserLibs`).
- **GLB format** (`GlbParser::parseFile`, glbparser.cpp; real sample gamslib.glb):
  ```
  Version = 5
  LibraryName = GAMS Model Library
  Columns = 6
  5 = SeqNr            (<displayOrder> = <columnName>[|tooltip])
  6 = Lic|C=Community, D=Demo, L=Requires license
  1 = Name  / 2 = Application Area / 3 = Type / 4 = Description
  InitialSort = 3      (1-based column)
  *$*$*$
  Files = trnsport.1[,more files]      (comma list; required, non-empty)
  [Directory = ...]                    (optional, skipped if line starts with "Directory")
  1 = TRNSPORT ... N = <value>          (exactly Columns lines, order any, `idx = value`, split on FIRST '=')
  <free-text long description until next *$*$*$>
  *$*$*$
  Files = ...
  ```
  Notes: column numbers must be 1..Columns; the column named `Name` (case-ins.) is the model name; duplicate names (case-ins.) get `suffixNumber` (`name_2`, `nameWithSuffix`); parsing stops at a blank line after `*$*$*$` (gamslib does the same); empty library = error. Display order of columns = `colOrder`; sort initially by `InitialSort`. Description dialog shows the long text. Errors are logged "Error while loading model library from GLB file ... (line n)".
- Filtering: free-text regex filter across columns (`FilterLineEdit`), tab-specific selection.
- Loading a model (`MainWindow::openModelFromLib` L1323-1460): input file = first of `Files`; if its suffix is numeric (e.g. `trnsport.1`) -> `<base>.gms`, else the file name. Destination = project workDir ("open in current" setting) or `defaultWorkingDir`. If `<dest>/<inputFile>` exists: ask Open / Replace (rename to backup via `renameToBackup`) / Abort. Then runs the **`$GAMS_SYSDIR/gamslib` executable** (ELF; `GamsLibProcess`, process/gamslibprocess.cpp) with args:
  `gamslib -lib <sysdir>/<glb> <nameWithSuffix | -1> <destDir>` (cwd = destDir; `-1` when no model name = copy by index/none). Equivalent CLI documented in `docs/UG_ModelLibraries.html`: `gamslib modelname|modelnum [target]`, options `-q/-quiet`, `-lib <glb>` (default gamslib_ml/gamslib.glb), internal `-i`, `-g`. After success the .gms is added to a (new or current) project and opened. `receiveModLibLoad` (links from docs/help) calls the same with `gamslib_ml/gamslib.glb` and `<model>.gms`.
  The `gamslib` binary is not a license-restricted GAMS run, but it is a GAMS executable: our extension should either call it identically or implement the copy itself from the glb (`Files = ` list: names inside the `*_ml` dir, numeric suffix = extension-less seq copy -> `.gms`).
  Not on GitHub: all `*.glb` and model sources exist only in the GAMS install.

## 4. Other Studio subsystems worth tracking for parity (not detailed in these notes)
- `studio-src/src/syntax/*`: GAMS syntax highlighter / identifier parsing (basis for TextMate + semantic tokens); `syntax/textmark*` = marks for errors (`[ERR:...]` tags) and LST links.
- `search/*` (find in files incl. regex, scopes: file, project, all), `navigator/*` (quick open / go to line), `gdxdiffdialog/*` (runs `gdxdiff`), `miro/*` (MIRO deployment), `connect/*` (Connect YAML editor, schema-driven), `engine/*` and `neos/*` (remote solve; strip `reference=/rf=`), `gamscom/*` (debugger/profiler socket protocol: params `DebugPort`, `ComPort`), `help/*` (docs lookup: `help::HelpData`), `editors/memorymapper.cpp` (large log/lst memory-mapped viewing; hRef marks `LST:`/`LS2:`).
- Settings keys of note: `userModelLibraryDir`, `defaultWorkspace`, `defaultEncoding`, `gdxViewer/*`, `openInCurrent`, `historySize`. History persists `.gsp` separately from files.
- GAMS install facts: executable names `gams`, `gamslib`, `gdxdump`, `gdxdiff`, `gmsprmun.txt`, `gamserrs.txt`, `gmscmpun.txt` (solver table), `empsyntax.txt`. Only `gmscmpun.txt`, `*.def`, `*.glb`, `apifiles/C/api/*.h` are needed for the features above.
