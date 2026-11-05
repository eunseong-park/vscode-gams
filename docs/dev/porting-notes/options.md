# Options: optgams.def / opt<solver>.def, command-line parameters, .opt editor, gamsconfig.yaml

Sources: `studio-src/src/option/{option,optiontokenizer,gamsuserconfig,...}.cpp`, `studio-src/src/support/solverconfiginfo.cpp`, `studio-src/src/file/filemeta.cpp`,
`$GAMS_SYSDIR/{optgams.def,opt*.def,opt*.yaml,gmscmpun.txt,gamsconfig_schema.json,gamsconfig_personal.yaml}`, `$GAMS_SYSDIR/apifiles/C/api/{optcc.h,...}`.
Studio does NOT parse the .def files itself: it calls the GAMS **opt** C library (`liboptdclib64.so`, loaded via `optCreateD(&h, sysdir, msg, len)`). A Rust port can
either FFI-load `liboptdclib64.so` (hand-written externs from `optcc.h`) or parse .def text (format below, inferred from the sample files; not formally documented).

## 1. Loading definitions (`Option::readDefinitionFile`, option.cpp ~L470-650)
Call sequence (opt API, `$GAMS_SYSDIR/apifiles/C/api/optcc.h`):
`optSetExitIndicator(0); optSetScreenIndicator(0); optSetErrorCallback(cb); optCreateD(&h, sysdir)`; `optReadDefinition(h, path/to/optgams.def)` (**returns 0 on success**, nonzero = error!);
then
- synonyms: `i=1..optSynonymCount` -> `optGetSynonym(h,i,syn,name)`; `optIsDeprecated(h,syn)` marks deprecated synonyms. Synonym map: UPPER(synonym) -> option name.
- groups: `1..optGroupCount` -> `optGetGroupNr(h,i,name,&group,&helpCtx,help)`; group hidden iff helpCtx==0.
- `optEOLChars(h, buf)` (end-of-line comment chars), `optSeparator(h,buf)` (default " "), `optStringQuote(h,buf)`.
- per option `i=1..optCount`: `optGetHelpNr` (name, description), `optGetInfoNr` (defined, definedR, refnr, dataType, optType, optSubType), `optGetOptHelpNr` (helpContext, group; **helpContext==0 => hidden/"invalid"**), `optGetValuesNr`, `optGetTypeName`, `optIsDeprecated`,
  bounds by type: Integer `optGetBoundsInt(lo,hi,def)`, Double `optGetBoundsDbl`, EnumInt/Boolean default from `optGetValuesNr`, String/EnumStr/StrList `optGetDefaultStr`; enums: `optGetEnumCount`, per j `optGetEnumHelp(i,j,&helpCtx,text)`, `optGetEnumValue(i,j,&ival,sval)`; enum hidden iff helpCtx==0.
- Enums (optcc.h): dataType None0 Integer1 Double2 String3 StrList4; optType Integer0 Double1 String2 Boolean3 EnumStr4 EnumInt5 MultiList6 StrList7 Macro8 Immediate9; subType Required0 NoValue1 Optional2 TwoValues3.
- Option name lookup is case-insensitive (keys stored UPPER). Synonym resolution `getNameFromSynonym`.
- Special-case extras for `optgams.def` only: option `solver` and each model-type option (LP, MIP, ... see below) get their value list from the solver config (section 5): `SolverConfigInfo::solverNames()` / `solversForModelType()`; model-type default from `defaultSolverFormodelTypeName`.

## 2. .def text format (as seen in `$GAMS_SYSDIR/optgams.def`, `optcplex.def`; inferred)
- `*` comment lines; sections: options (first), `* multi list section`, `* synonym section`, `* deprecated section`, `* indicator section` (solvers), `* Groups`, ends `*** End of file`.
- Option line: `name type <refnr> <default> [lo hi] <group> <helpctx> description` where the numeric tail depends on type (observed):
  `integer <ref> <def> <lo> <hi> <grp> <hlp> text`; `double` same; `boolean <ref> <def> <grp> <hlp> text`; `string <ref> "<def>" <grp> <hlp> text`;
  `enumint <ref> <def> <grp> <hlp> text` / `enumstr <ref> "<def>" <grp> <hlp> text` each followed by enum rows ` <value> <helpctx> <text>` (leading space; `helpctx 0` = hidden value);
  `strlist <ref> <grp> <hlp> text`; `immediate <name> <grp> <hlp> text`; `multilist <ref> <grp> <hlp> text` followed by continuation line(s) listing member names (e.g. `InputDir` -> InputDir1..40).
  `mindouble/maxdouble/maxint` symbolic bounds. A leading `.` in a name (e.g. `.divflt`) = indexed option family (user writes `divflt(1) val`-style/`name idx`). `helpctx 0` hides the option from UI (still parseable).
- Synonyms: `<alias> synonym <option>`. Deprecated: `<verTag> deprecated` header then indented ` Name [text]` rows. Groups: `<ident> group <number> <helpctx> <text>`.
- Indicators (solver .def): `myeolchar EOLCOMM #|!|;#!|*` (EOL comment chars; first is used when writing), `indic indicator SEPARATOR " "|"="`, `indicator STRINGQUOTE`.
- Companion YAML `$GAMS_SYSDIR/opt<solver>.yaml` (only 8 present: convert cplex gurobi knitro minos odhcplex snopt xpress): `%TAG !i!` gsi infos; `items: name: !i!b|!i!i|!i!f|!i!s|!i!set_i|!i!set_s_ic {lo,up,def,val,ref,n_max}` - a machine-readable alternative for those solvers. Studio does not use it.
- Which def file per solver: `$GAMS_SYSDIR/gmscmpun.txt` (Windows: gmscmpnt.txt), header `solverId fileType dictType licCodes defaultOkFlag hiddenFlag linesToFollow modelTypes`, then lines: `scriptName [defFileName]`, `[exeName]`, `[libName auditCode solverInterfaceType [threadSafe]]`.
  Studio reads it via `cfgCreateD/cfgReadConfig(CommonPaths::configFile())`, `cfgAlgName/cfgAlgHidden/cfgDefFileName/cfgModelTypeName/cfgDefaultAlg/cfgAlgCapability` (support/solverconfiginfo.cpp). Default def file name when none listed = `opt<lowercase solver>.def`
  (`SolverConfigInfo::solverAliasNames`); e.g. CONOPT4 -> optconopt.def, CONVERT -> optconvert.def. 33 .def files ship (`gevopt.def` + opt*.def incl. `optgams.def`, `optgamschk.def`).

## 3. Command-line parameter editor model (`OptionTokenizer`, optiontokenizer.cpp)
- `tokenize(str)` (L112): hand-rolled scanner -> `OptionItem{key,value,keyPosition,valuePosition,optionId,recurrent,recurrentIndices,disabled,error}`.
  Key = chars until space or `=`; between key and value: spaces and at most ONE `=`; value: if starts with `"` it runs to the closing `"` then to next space, else to next space. Item with no value is allowed (keyword-only).
  Key may start with `-` or `/` (stripped for lookup); `--name` / `//name` double-dash = GAMS compile-time variable (`optionId=-1`, name must match `^[a-zA-Z]+[_a-zA-Z0-9]*$`, `Option::isDoubleDashedOption`).
  Synonym -> canonical via `getNameFromSynonym`. Duplicate ids flagged `recurrent` (except `immediate` types); later value overrides (Override_Option warnings).
- `format()` (L225): error list with ranges + messages: "(Unknown option)", "(Deprecated option, will be ignored)", "(Option keyword expected for value ...)", double-dash name errors, value errors.
- Value validation `Option::getValueErrorType` (option.cpp L130-230): enumint: int in value list; enumstr: case-insens. in list; integer: int or `maxint/minint`, or a float with |d-round(d)|<0.01, within [lo,hi]; double: float or `eps`/`maxdouble`/`mindouble`, in range; boolean: `0|1`; immediate: always OK; empty value => Missing_Value. Error enum: No_Error, Invalid_Key, Incorrect_Value_Type, Value_Out_Of_Range, Deprecated_Option, Override_Option, UserDefined_Error, Invalid_minVersion, Invalid_maxVersion, Missing_Value (option.h L32).
- `normalize(items)` rejoins as `key=value` pairs. Studio table view columns: `id | Key | Value` (gamsparamtablemodel.cpp L41); definition tree columns: Option, Synonym, DefValue, Range, Type, Description, Debug Entry (gamsoptiondefinitionmodel/optiondefinitionmodel.cpp L34). Groups = tree parents; hidden groups/options filtered.
- Studio-injected default args on every run (pexgroupnode.cpp `analyzeParameters` L1136): `logoption=3 ide=1 errorlog=99 errmsg=1 pagesize=0 lstTitleleftaligned=1` (+`DebugPort`/`ComPort`). If the user overrides one, a warning is logged. Path-valued options (curdir, workdir, gdx, ref, lst, logfile, parmfile) are normalized relative to the working dir (`cleanPath`, L1203-1260). `gdx` default => `<stem>.gdx`; `reference` default => `<stem>.ref`.
- Run history (`GamsParameterWidget::loadCommandLine(history)`) keeps previous command lines; `ParmFile` option opens a `.pf` file (kind Pf, edited with optgams.def).

## 4. .opt / .pf editor (`SolverOptionEditor`, `OptionTokenizer::readOptionFile/writeOptionFile/getOptionItemFromStr`)
- Which def: `FileMeta::createEdit` (filemeta.cpp ~L1429): for `.opt` use `SolverConfigInfo::solverOptDefFileName(baseName)`, for `.pf` use `optgams.def`; fallback `opt<basename>.def` in sysdir; else open as plain text with a log error.
- Suffix recognition (file/filetype.cpp `FileType::from`): `.opt` OR `.op2-.op9`, `.o10-.o99`, `.100+` (regex `[oO][pP][2-9]|[oO][1-9]\d|[1-9]\d\d+`) **and** completeBaseName must be a known solver name (from gmscmpun.txt, case-insens.).
- Line model `SolverOptionItem{key,value,text(EOL comment),disabled,optionId,error,recurrent}`. `readOptionFile`: each physical line -> item; `getOptionItemFromStr`: empty line/line starting with a comment char (`*` or first EOL char) => disabled/comment item;
  otherwise the text is fed to `optResetAll; optReadFromStr(h,text)` and the items with `defined||definedR` are queried (`optGetInfoNr`, `optGetValuesNr`, `optListCountStr/optReadFromListStr` for strlist) to extract canonical key/value; errors come from the opt message callback (`logAndClearMessage`, getErrorType L834-966, maps library messages -> OptionErrorType).
  Re-implementing without the lib: split `key<sep>value [EOLchar comment]` with the def's SEPARATOR (default whitespace or `=`), strip `"` quotes, key case-insensitive, synonyms allowed, `.`-prefixed names as `name idx` families.
- Write (`formatOption`, L611): disabled lines get `<firstCommentChar> key<sep>value`; string/strlist values containing spaces are wrapped in `"`; enabled: `key<sep>value [ <eol> comment]`; indicator-less default sep " ". Warnings are logged for Invalid_Key / Incorrect_Value_Type / Value_Out_Of_Range / Deprecated / Override on save.
- Table columns: `id | Key | Value | Comment` (Comment only if EOL char defined; solveroptiontablemodel.cpp L39). Checkbox column = enabled/disabled(commented). Recurrent options are marked; "replace/add" behavior on duplicate insert (L383-387).

## 5. gamsconfig.yaml (GAMS user config, "GUC")
- Studio uses the GAMS **guc** library (`gucCreateD(&h, sysdir)`, `gucReadGAMSConfig(h, path)`, `gucGetItemCount`, `gucGetItemKV(h,pos,key,&isset,&ival,sval,len)` with keys `guciGSection, gucsName, gucsValue, gucsMinVersion, gucsMaxVersion, guciPathVariable`,
  writers `gucStartSectionItem(h, gucCommandLineParameters|gucEnvironmentVariables, key, &pos)`, `gucAddItemKV`, `gucDoneSectionItem`, `gucMakeNoneItem`, `gucWriteGAMSConfig`, `gucGetErrorMessage`) - `option/gamsuserconfig.cpp`.
- File name `gamsconfig.yaml` (commonpaths.cpp L66; suffix yaml with completeBaseName `gamsconfig` => FileKind::Guc), looked for in project/work dir and user config dir (`GamsConfigPath`: Linux `~/.config/GAMS`, Windows `Documents/GAMS`). Editor tabs: command line parameters (key,value,minVersion,maxVersion) and environment variables (name,value,minVersion,maxVersion,pathVariable). Parameter validation via `OptionTokenizer::validate(ParamConfigItem*)` and optgams.def; version fields must match `^[1-9][0-9](\.[0-9]){0,2}$`.
- Schema (official): `$GAMS_SYSDIR/gamsconfig_schema.json` (draft-06): top-level `commandLineParameters` (array of `{<name>: {value, minVersion?, maxVersion?}}`), `environmentVariables` (same + `pathVariable: bool`). Example `gamsconfig_personal.yaml` lists default solvers (`- LP:\n    value: HIGHS`). `gamsLegacyConfig.yaml` also ships.
  Port plan: validate with the JSON schema, treat param names via optgams.def (case-insens., synonyms), provide completion of values from the enum lists.
