# LST outline (.lxi), LST<->GMS links, log tags

Sources: `studio-src/src/lxiviewer/*`, `editors/logparser.cpp`, `file/pexgroupnode.cpp`, `$GAMS_SYSDIR/docs/RN_50.html`, `docs/RN_32.html`, `docs/RN_34.html`.
No `.lxi`/`.lst` samples ship in the sysdir. Format is not documented in official docs beyond release notes; derived from the parser.

## Producing the .lxi
- GAMS writes `<lstbasename>.lxi` next to the `.lst` only when `ide=1` (Studio always passes `ide=1`, see `PExProjectNode::analyzeParameters`, pexgroupnode.cpp L1136).
  RN_50: without IDE=1 GAMS now *deletes* stale .lxi files, so existence of a non-empty .lxi implies it matches the .lst.
- LxiViewer derives path from the lst: `info.path()+"/"+info.completeBaseName()+".lxi"` (lxiviewer.cpp ctor; RN_32 fixed names with multiple dots - use completeBaseName, i.e. strip only the last suffix).
- If .lxi missing or size 0 the outline pane is hidden and the .lst opens as plain text (`LxiViewer::loadLxi`). Reloaded when lst reloads (filemeta.cpp L848).

## .lxi line format (LxiParser::parseFile, lxiparser.cpp)
Text lines, split on a single space `' '`: `<K> <lineNr> <text...>`
- `K` = one-letter section code; `lineNr` = 1-based line number in the .lst; `text` = rest joined with ' ' (leading spaces preserved as extra empty fields).
- Lines with < 2 fields (blank lines) are skipped (RN_32: crash on empty lines fixed).
- Codes -> group captions (`LxiParser::initCaptions`):
  A "???", B "SubTitle", C "Solve Summary", D "Equation", E "Column", F "SolEQU", G "SolVAR", H "Solution", I "Display", J "Message".
- Tree building: `B` entries are top-level (parent = root). For any other code, when `idx != lastIdx` a *virtual* parent node (lineNr = -1, caption from the table) is
  appended under root and subsequent entries become its children until the code changes. (Studio quirk: the virtual node is created with `lastIdx` as its index and
  `mCaptions[idx]` as caption.) Initial `lastIdx = "B"`. Each real entry is also pushed to flat lists `lineNrs` and `treeItems` (virtual nodes excluded).
  Consequence: a run of the same non-B code shares one group; two separate Display runs separated by a B entry produce two groups.
- Port suggestion: DocumentSymbol tree: B -> top-level symbols; other groups -> container symbols with children; range start line = lineNr-1.

## Sync tree <-> text
- Click/double-click/Enter on item -> `jumpToLine`: `textView.jumpTo(lineNr-1, 0)` + line marker; virtual node (lineNr -1) jumps to first child when collapsed (lxiviewer.cpp).
- Cursor move in text -> `jumpToTreeItem`: with `lineNrs` sorted ascending, pick the last item with `lineNr-1 <= cursorLine` (index 0 if cursor is before the second item); expands parent and selects it.

## Log -> LST links (log tags)
Log lines (logoption=3, stdout) may end with bracketed tags; handled in `LogParser::extractLinks`, `quickParse` (logparser.cpp):
- `[LST:<n>]` jump to line n of main .lst (`<project lst param>`), `[LS2:<n>]` same for secondary lst, `[LS2:"<file>"]` switches secondary lst file (`mbState.switchLst`, -> `PExProjectNode::switchLst` sets param `ls2`).
- `[FIL:"<path>"]`, `[REF:"<path>"]`, `[DIR:"<path>"]` file/ref/dir links; `[INC:"<file>",<line>,<col>]`, `[LIB:...]`, `[SYS:...]` for include files (3-letter codes list `{"LST","LS2","INC","LIB","SYS","DIR"}` in `PExProjectNode::resolveHRef`, pexgroupnode.cpp L412). A plain quoted `"file",line,col` form is also resolved relative to workDir.
- `[TIT:...]` => line suppressed. Quoted text with `'`/`"` inside brackets is not treated as a tag (quickParse tracks quotes). Two tags at the end of a line = `[ERR:...][LST:n]`.
- Error lines: `*** Error <nr> in <file> <text> [ERR:"file",line,col][LST:n]` (starts with "*** Error "); `*** Error at line n: msg` variant => errNr -1. The ERR tag gives `file,line,col` to jump into the .gms; the LST tag gives the .lst line holding the detailed message (errmsg=1 puts the message inline in the lst).
- `resolveHRef` include search: `INC` -> workDir, then `InputDir`/`IDir` (path list, also numbered `InputDir1..40`); `SYS` -> `sysIncDir`/`SDir` (relative to system dir) or system dir; `LIB` -> `libIncDir`/`LDir` then `<gams standard data path>/inclib`; tries the name, then name+".gms".

## LST file parsing in Studio
Studio does NOT parse the .lst body beyond the .lxi index and log tags; it opens it as a read-only `TextView` (kind Lst, `EditorType::lxiLstChild`) with a splitter (tree 1:3 text). Studio default params: `pagesize=0 lstTitleleftaligned=1` (no page breaks / headers left aligned) so lines map 1:1. For `[LST:n]` use n directly as 1-based line.
Search dialog treats lxi/lst viewers specially (search/findadapter.cpp -> text view).
