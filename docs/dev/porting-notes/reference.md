# Reference file (.ref) – format and Studio derived features

Sources: `studio-src/src/reference/*`, `$GAMS_SYSDIR/docs/T_STUDIO.html` (section "Reference File Viewer").
No `.ref` sample ships in the sysdir (only .glb library indexes found); the format below is reverse-derived from the
parser, NOT verified against a real file (we may not run `gams`). Official GAMS docs do not specify the record layout.

## How the .ref is produced
- GAMS parameter `Reference=<file>` / `rf=<file>` (`optgams.def`, option "Reference"). Studio: `PExProjectNode::analyzeParameters`
  maps option id "Reference" -> `setParameter("ref", ...)`, `value=="default"` => `<filestem>.ref` (studio-src/src/file/pexgroupnode.cpp ~L1243);
  `setParameter` appends ".ref" if no suffix (pexgroupnode.cpp ~L1442). Log shows a clickable `[REF:"path"]` tag (editors/logparser.cpp `extractLinks`).
- Studio default args for every run: `logoption=3 ide=1 errorlog=99 errmsg=1 pagesize=0 lstTitleleftaligned=1` (pexgroupnode.cpp L1136).

## File layout (whitespace-separated tokens, split on `\s+`, empty tokens skipped)
Parser: `Reference::parseFile` (studio-src/src/reference/reference.cpp). Lines are CR/LF-trimmed and decoded with the
project encoding. Three consecutive sections, each introduced/terminated by counts:

### Section 1 – reference records (until a line whose first token is `0`)
Each line needs >= 11 tokens (else error). After dropping token[0] (record index), the indexes below are into the rest:

| idx | field | use |
|---|---|---|
| 0 | symbol id (int, unique per symbol) | key into `mReference` |
| 1 | symbol name | |
| 2 | symbol type string | `SymbolDataType::typeFrom` (see below) |
| 3 | reference type string | `ReferenceDataType::typeFrom` |
| 4 | (ignored) | |
| 5 | line number (1-based; <=0 = none) | |
| 6 | column number (1-based) | |
| 7,8 | (ignored) | |
| 9.. | location (file path; may contain spaces) | `line.mid(line.lastIndexOf(recordList.at(9)))` - i.e. text from the LAST occurrence of token 9 to end of line |

Quirk: for paths with spaces the "last occurrence of token 9" trick can mis-cut; a Rust port should rather take the raw line
tail after the 9th (post-index) token boundary. Each line creates the `SymbolReferenceItem(id,name,type)` on first sight and calls
`addReferenceInfo` (adds location to ordered `mFileUsed` list, de-duplicated with native separators).

Reference type strings (case-insensitive match against any alias; `referencedatatype.cpp ReferenceDataType::list`), enum value in brackets:
`declared`/Declared [Declare=1], `defined` [Define=2], `assign` [Assign=3], `impl-asn` [ImplicitAssign=4], `ref` [Reference=5],
`index` [Index=6], `control` [Control=7]; anything else -> Unknown(0) and the record is dropped (`addReferenceInfo` default).
Descriptions (verbatim from Studio): declared = first appearance; defined = table/data-list init or equation definition starts;
assign = LHS of assignment; impl-asn = equation/variable updated implicitly by a solve; control = set is (part of) driving index in
assignment/equation/loop/indexed operation; ref = RHS, display, equation, model, solve, put; index = set used as driving index only for set labels
(only appears in the unique-element xref map).

Symbol type strings (`SymbolDataType::list`, symboldatatype.cpp; match any alias, case-insensitive; aliases = `CODE,PLURAL,Label`):
`FUNCT`[1] `SET`[2] `ACRNM`[3] `PARAM`[4] `VAR`[5] `EQU`[6] `MODEL`[7] `FILE`[8] `MACRO`[9]; unknown -> 0. Synthetic: FileUsed=99, Unused=100 (not in file).

### Section 2 – symbol table
Starting line (the terminating `0` line of section 1): `0 <N> ...`; needs >=2 tokens; N = number of following symbol lines.
Parser reads exactly N lines (`expectedLineread = N + lineread`), each needs >= 6 tokens:

`<id> <name> <type-code?> <?> <dim> <numElements> <domainId_1..domainId_dim> <explanatory text...>`

- token0 id; token1 name (-> `mSymbolNameMap[name]=id`); token4 dimension; token5 number of elements;
  tokens 6..6+dim-1 domain symbol ids (ints; 0 / ids of sets; the universe `*` appears as an id that may not be in section 1);
  remaining tokens joined with a single space = explanatory text (original whitespace collapsed).
- Tokens 2 and 3 (type/subtype) are NOT read here: type comes from section 1. Symbols in this table that never appeared in section 1 are skipped
  (`!mReference.contains(id)` -> continue), so only referenced symbols are retained. (Hence an unreferenced symbol is never shown, though
  the "Unused" tab = symbols that have only declare/define records.)

### Section 3 – files-used tree (optional; absent in older GAMS)
After section 2, if lines remain: a line `0 <M>`; first token must be `0`, else error. M = number of file records. Each record needs >= 6 tokens:

`<id> <globalLine> <refType> <parentId> <localLine> <location (rest of line, tokens re-joined with ' ')>`

Stored as `FileReferenceItem` columns: Location, Type, GlobalLine, LocalLine, Id, ParentId, FirstEntry (filereferenceitem.cpp). Root = synthetic id 0.
`filterFileUsedReference()` links to parent only for types `INCLUDE INPUT GDXIN GDXOUT BATINCLUDE SYSINCLUDE LIBINCLUDE`; first occurrence of a location
sets FirstEntry=true (compact view counts those). Fallback when section 3 missing: flat list from `mFileUsed` (parentId 0).
Note: `mFileUsed` order = first appearance order of locations in section 1.

## Error / reload semantics
`mLastErrorLine == -1` => success (`ReferenceState::SuccessfullyLoaded`); else if file size unchanged since last read or already retried => `UnsuccessfullyLoaded`,
otherwise one pending reload (file may still be written while GAMS runs). `parseFile` early-outs if file size equals the last read size.
Failure still calls `addSymbolReferenceItem()` so partial data is kept. Port: tolerate truncated files, retry once.

## Derived data (SymbolReferenceItem, symbolreferenceitem.cpp)
Per symbol: id, name, SymbolType, dimension, domain ids, numberOfElements, explanatoryText, and 7 ordered lists of `ReferenceItem{symbolId,name,type,location,line,col}`:
declare, define, assign, implicitAssign, reference, control, index. `isUnused()` = assign+implicitAssign+reference+control+index all empty.
`Reference::addSymbolReferenceItem` buckets symbols into per-type lists (Set, Acronym, Parameter, Variable, Equation, Model, Function, Macro, File) plus Unused list.

## Viewer features to reproduce (T_STUDIO.html; referenceviewer.cpp, symboltablemodel.cpp)
- Tabs: All Symbols (cols Entry, Name, Type, Dim, Domain, Text), Set, Acronym, Parameter, Variable, Equation, Model, Function, Macro, File (cols Entry, Name, Dim, Domain, Text; File: Entry, Name, Text), Unused, File Used (cols File Location, Type, Line; tree; "Compact View" = only FirstEntry rows).
- Right pane: reference list per selected symbol, grouped by reference type (Declared, Defined, Assigned, Implicitly Assigned, Controlled, Referenced, Indexed), rows = file / line / column; tooltip shows full path:line:col.
- Domain column rendered by resolving domain ids to names via `mReference[id]->name()` (id with no entry => `*`/blank).
- Jump to source: `MainWindow::on_referenceTo` / `FileMeta::referenceTo` (mainwindow.cpp ~L6105, file/filemeta.cpp L1121): ref line/col are 1-based -> subtract 1 when >0;
  col == -1 => select whole line; otherwise search the symbol name case-insensitively in `lineText.left(column)` (last occurrence) and select it, else select word at column;
  for Define records `oneColumn` selection (select to end of word) is used. Missing file => error "File not found".
- Symbol-name -> definition lookup for LSP: `findReferenceFromName` + declare/define lists gives go-to-definition/references; position data is exact (file,line,col), preferable to heuristic lookup.
- Run flags: `rf=` is only produced if the user sets it or "Create RF" run option; Engine/NEOS strip `reference=`/`rf=` (engine/engineprocess.cpp L203, neos/neosprocess.cpp L138).
