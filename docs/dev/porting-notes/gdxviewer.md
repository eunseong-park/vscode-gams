# GDX viewer – gdxcc usage and viewer semantics

Sources: `studio-src/src/gdxviewer/{gdxviewer,gdxsymboltablemodel,gdxsymbol,tableviewmodel,...}.cpp`, `studio-src/src/numerics/doubleFormat.c`,
`$GAMS_SYSDIR/apifiles/C/api/{gdxcc.h,gclgms.h}`, libs `$GAMS_SYSDIR/libgdxcclib64.so` (loader, `gdxCreateD`) and `libgdxdclib64.so` (implementation).
Studio uses the **legacy gdxcc API** (not gdxcc "gdxGetDomain"/GAMS Transfer). Handles are `gdxHandle_t`.

## 1. Call sequence (all under a per-file QMutex `mGdxMutex`; one handle per open viewer)
1. Init (`GdxViewer::GdxViewer`, gdxviewer.cpp L63-69): `gdxSetExitIndicator(0)`, `gdxSetScreenIndicator(0)`, `gdxSetErrorCallback(cb)`, `gdxCreateD(&h, sysdir, msg, GMS_SSSIZE)` (fails => "Could not load GDX library").
2. Open (`GdxViewer::init` L323): `gdxOpenRead(h, path, &errNr)`; on errNr: `gdxClose`, `gdxErrorStr(h, errNr, msg)`, dialog "Unable to Open GDX File" with Retry. (File may be mid-write by GAMS; Studio retries/reloads on file change - `reload()` polls every 50 ms while a drag/invalidate is pending; closes with `gdxClose` in `freeSymbols`.)
3. Counts (`GdxSymbolTableModel` ctor, gdxsymboltablemodel.cpp L35): `gdxSystemInfo(h, &symCount, &uelCount)`.
4. UEL table (`loadUel2Label` L193): for `i=0..uelCount` `gdxUMUelGet(h, i, label[GMS_UEL_IDENT_SIZE=64], &map)` -> `mUel2Label[i]` (index 0 = empty/"universe" placeholder; UEL numbers are 1-based). Out-of-range uel lookups fall back to a live `gdxUMUelGet`. Reverse: `gdxUMFindUEL(h, label, &uelNr, &uelMap)` (`label2Uel`).
5. Set element text pool (`loadStringPool` L202): `mStrPool[0]="Y"`; `for strNr=1; gdxGetElemText(h, strNr, text, &node); ++strNr` until false. `getElementText(n)`: n<=0 -> "Y", else `gdxGetElemText`. For sets, the record "value" is the text index (cast to int).
6. Symbols (`loadGDXSymbols` L97): `for i=0..symCount` (**0 = universe `*`, hidden in the UI**). Per symbol (`GdxSymbol::loadMetaData/loadDomains`, gdxsymbol.cpp L353-395):
   `gdxSymbolInfo(h, nr, name, &dim, &type)`; `gdxSymbolInfoX(h, nr, &recCount, &subType, explText)`;
   `type==GMS_DT_EQU -> subType=gmsFixEquType(subType)`, `GMS_DT_VAR -> gmsFixVarType(subType)` (macros in gclgms.h; -1 if unknown); for alias (`GMS_DT_ALIAS`) `subType` = symbol number of the aliased set (`aliasedSymbol()`).
   Domains: `gdxSymbolGetDomainX(h, nr, domPtrs)` (**names; relaxed domain gives set name or `*`**; use GDXSTRINDEXPTRS_INIT over `char[GMS_MAX_INDEX_DIM][GMS_SSSIZE]`); universe: `["*"]`. No `gdxSymbolGetDomain` (numeric) usage.
7. Data read on demand when a symbol is selected (`GdxSymbol::loadData` L226-290): `gdxDataReadRawStart(h, nr, &nrRecs)` then `nrRecs` x `gdxDataReadRaw(h, keys[GMS_MAX_INDEX_DIM], values[GMS_VAL_MAX], &dimFirst)`, then `gdxDataReadDone`. Raw = file order, UEL numbers, no domain mapping. Loading is incremental, cancellable (`stopLoadingData`), resumable by re-reading and skipping `mLoadedRecCount` records; error -> `gdxErrorStr(gdxGetLastError())`.
   Storage: `mKeys[rec*dim+d]` (int UEL), `mValues`: Set/Par 1 double per record (set: text index), Var/Equ 5 doubles (`.l .m .lo .up .scale`). Tracks per-dim min/max UEL, per-column min/max for values `< GMS_SV_UNDEF`. Invalid (negative) UEL => `mHasInvalidUel`, sort/filter disabled.
8. Acronyms: `gdxAcronymName(h, val, buf)` for value >= `GMS_SV_ACR` (formatValue, gdxsymbol.cpp L428).
Not used by Studio: gdxFindSymbol, gdxGetUEL, gdxDataReadMap*, gdxGetDomain, gdxSymbolGetComment, gdxFileVersion, gdxGetSpecialValues (it uses the library defaults, see below). A Rust port may call the same API via hand-written externs (`gdxCreateD`... in `gdxcc.c` shows how: dlopen `libgdxdclib64.so`, symbols prefixed `d_`).

## 2. Constants (gclgms.h)
`GMS_DT_SET0 PAR1 VAR2 EQU3 ALIAS4 (MAX5)`; `GMS_VAL_LEVEL0 MARGINAL1 LOWER2 UPPER3 SCALE4 (MAX5)`; var types UNKNOWN0 BINARY1 INTEGER2 POSITIVE3 NEGATIVE4 FREE5 SOS1 6 SOS2 7 SEMICONT8 SEMIINT9; eq types E0 G1 L2 N3 X4 C5 B6; `GMS_SSSIZE=256`, `GMS_UEL_IDENT_SIZE=64`.
Special values: `UNDEF=1e300 NA=2e300 PINF=3e300 MINF=4e300 EPS=5e300 ACR=10e300` (gclgms.h L110-115; **raw read returns these constants only after gdxcc maps them - default mapping is in effect**, Studio never calls `gdxSetSpecialValues`).
Default records (`gmsDefRecVar`, `gmsDefRecEqu`, gclgms.h L189-211) drive "all default" column squeezing: e.g. free var `{0,0,-inf,+inf,1}`, binary `{0,0,0,1,1}`, `=e=` `{0,0,0,0,1}`.

## 3. Symbol table view (GdxSymbolTableModel)
Columns: `Entry(nr) | Name | Type | Dim | Records | Loaded(hidden) | Text(explText)`; proxy sorts case-insensitively on `Qt::UserRole` (numeric for Entry/Records), default sort Name asc; filter regex on Name column (col 1; selectable scope); universe row hidden.
Type string `typeAsString`: Set [(Singleton) if subtype==`GMS_SETTYPE_SINGLETON`], Parameter, Variable (+" (Binary|Integer|Positive|Negative|Free|SOS1|SOS2|SemiCont|SemiInt|Unknown)"), Equation (+" (=e=|=g=|=l=|=n=|=x=|=c=|=b=)"), Alias, else Unknown.
Number formatting of Entry/Records uses locale group separators (`%L1`).

## 4. List (record) view of a symbol (GdxSymbol model)
- Columns: dim labels, then Set: `Text`; Parameter: `Value`; Var/Equ: `Level, Marginal, Lower, Upper, Scale` (columnCount = dim+1 / dim+5; `mNumericalColumnCount` 0/1/5). Dim header = `<domainName> <superscript index>`.
- Cell text: key -> `uel2Label(key)`; set -> element text (`"Y"` for index 0); numbers: if `val < UNDEF` format with `DoubleFormatter::format(val, fmt, precision, squeeze, decSep)` else `UNDF`,`NA`,`+INF`,`-INF`,`EPS`, acronym name if `>= ACR`. Formats `Format::{g=0,f=1,e=2}` -> C functions `x2gfmt/x2fixed/x2efmt` in `studio-src/src/numerics/doubleFormat.c` (GPL, portable to Rust). precision 0=full (`gFormatFull`). Copy uses EditRole with chosen decimal separator (setting `gdxViewer/gdxDecSepCopy`: studio '.', system locale, custom).
- Display limit: `rowCount = min(filteredRecs, maxDisplayRecords)` (default `INT_MAX/64`, view sets limit from max widget height); `isDataTruncated()` => banner.
- Sorting (`GdxSymbol::sort`, L625-690): stable sort on `mRecSortIdx`. Key column: compare **case-insensitive label rank** (`labelCompIdx[uel]`, precomputed by sorting all `uel2Label(0..uelCount)` case-insensitively, `createSortIndex`); UELs beyond table size sort by number. Set/alias value column: by element text (case-sensitive `QString <`). Numeric: specials mapped by `specVal2SortVal`: UNDEF->5e300, NA->4e300, PINF->3e300, MINF->-DBL_MAX, EPS->4.94e-324 (so EPS sorts just above 0, MINF lowest); acronyms keep raw value. Sort re-applies filter afterwards.
- Filtering (`filterRows`, L690+): per dimension `LabelFilter` (set of shown UELs via `isUelShown`; dialog lists `uelsInColumn` in first-seen order, supports regex/case/exact/ invert, plus "quick select" list); per numeric column `ValueFilter{min,max,exclude,showUndef,showNA,showPInf,showMInf,showEps,showAcronym}`: finite values (`<UNDEF`) filtered by `[min,max]` (or excluded), specials by their flag. (Studio bug: value filter uses `mValues[rec*mNumericalColumnCount+i]`, fine because stride==5/1.) `Reset filters` restores all.
- "Squeeze defaults": hide Var/Equ value columns where every record equals the default (`calcDefaultColumns`), user-toggle show Level/Marginal/Lower/Upper/Scale (settings `gdxDefaultShow*`, `gdxDefaultSqueezeDefaults`).
- Search highlight: regex over displayed text.

## 5. Table (pivot) view (TableViewModel, tableviewmodel.cpp L233-330)
- `initTableView(nrColDim, dimOrder)`: default `colDim=1`, order `0..dim-1`. For each filtered/sorted record: rowHeader = first `dim-colDim` keys (via dimOrder), colHeader = last `colDim` keys. Var/Equ: colHeader additionally gets the value index (0..4) appended, giving 5 sub-columns per col-key. `mTvKeysToValIdx[rowKey+colKey] -> value index` hash.
- Headers are de-duplicated (first-seen via sets) then `std::stable_sort`ed as **UEL-number lists** (numeric order, i.e. GDX UEL registration order, NOT alphabetical). Header text via `uel2Label`.
- Empty: `mNeedDummyRow/Column` when no row/col dims (scalars or dim==colDim): shows a "Value"/"Text" dummy header; empty table "No Data"/"Loading Data".
- Missing cell = blank (QVariant()), not zero/default. Sets show element text. Table view disabled/limited for big symbols (UI offers it for dim >= 2; `GdxSymbolView::showTableView`); user can drag domains between row/column areas (TableViewDomainModel) and the state (colDim, dimOrder, column widths, filters) is persisted per symbol (`GdxSymbolViewState`, settings key `gdxViewer/states`).
- Default Var/Equ columns in table view computed per column (`calcDefaultColumnsTableView`) with `col % GMS_VAL_MAX`.

## 6. Other
- Encoding: all strings from gdxcc are decoded with the project's QStringDecoder (default UTF-8). Symbol/domain names use the same decoder; `GdxSymbol::decode` = UTF-8 stateless.
- Export (`exportdialog/exportdriver/exportmodel.cpp`): exports selected symbols through the GAMS `gdxdump`/connect CSV/xlsx drivers (see exportdriver.cpp: writes a Connect YAML and runs `gamsconnect`/GAMS `GDXDump`); not covered here.
- Auto reload: GDX files are `autoReload=true` FileType (file/filetype.cpp); Studio reopens (`reload`) when file changed and viewer not busy.
- LSP/Rust port suggestion: crate that dlopens `libgdxdclib64.so` per above sequence (or reads GDX v7 binary itself - not documented officially; prefer API). Produce JSON: `{symbols:[{nr,name,type,subtype,dim,records,domains,text}]}` then on demand records paged.
