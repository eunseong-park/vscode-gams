// SPDX-License-Identifier: GPL-3.0-or-later
// Error codes and messages from src/gxfile.cpp (ERR_* constants, errorCodeToStr).
pub const ERR_NOERROR: i32 = 0;
pub const ERR_NOFILE: i32 = -100000;
pub const ERR_FILEERROR: i32 = -100001;
pub const ERR_BADMODE: i32 = -100002;
pub const ERR_BADDIMENSION: i32 = -100003;
pub const ERR_BADELEMENTINDEX: i32 = -100004;
pub const ERR_BADSYMBOLINDEX: i32 = -100005;
pub const ERR_ELEMENTSEQUENCE: i32 = -100006;
pub const ERR_DUPLICATESYMBOL: i32 = -100007;
pub const ERR_DATANOTSORTED: i32 = -100008;
pub const ERR_DATADUPLICATE: i32 = -100009;
pub const ERR_UNKNOWNFILTER: i32 = -100010;
pub const ERR_BADSTRINGFORMAT: i32 = -100011;
pub const ERR_BADIDENTFORMAT: i32 = -100012;
pub const ERR_UELCONFLICT: i32 = -100013;
pub const ERR_DUPLICATESPECVAL: i32 = -100014;
pub const ERR_BADERRORRECORD: i32 = -100015;
pub const ERR_DUPLICATEUEL: i32 = -100016;
pub const ERR_BADUELSTR: i32 = -100017;
pub const ERR_UNDEFUEL: i32 = -100018;
pub const ERR_UELSECONDWRITE: i32 = -100019;
pub const ERR_UELNOTEMPTY: i32 = -100020;
pub const ERR_BAD_FILTER_NR: i32 = -100021;
pub const ERR_BAD_FILTER_INDX: i32 = -100022;
pub const ERR_FILTER_UNMAPPED: i32 = -100023;
pub const ERR_OBSOLETE_FUNCTION: i32 = -100024;
pub const ERR_RAWNOTSORTED: i32 = -100025;
pub const ERR_BAD_ALIAS_DIM: i32 = -100026;
pub const ERR_BADDATAMARKER_DATA: i32 = -100029;
pub const ERR_BADDATAMARKER_DIM: i32 = -100030;
pub const ERR_OPEN_BOI: i32 = -100031;
pub const ERR_OPEN_FILEHEADER: i32 = -100032;
pub const ERR_OPEN_FILEVERSION: i32 = -100033;
pub const ERR_OPEN_FILEMARKER: i32 = -100034;
pub const ERR_OPEN_SYMBOLMARKER1: i32 = -100035;
pub const ERR_OPEN_SYMBOLMARKER2: i32 = -100036;
pub const ERR_OPEN_UELMARKER1: i32 = -100037;
pub const ERR_OPEN_UELMARKER2: i32 = -100038;
pub const ERR_OPEN_TEXTMARKER1: i32 = -100039;
pub const ERR_OPEN_TEXTMARKER2: i32 = -100040;
pub const ERR_BADDATAFORMAT: i32 = -100041;
pub const ERR_OUT_OF_MEMORY: i32 = -100043;
pub const ERR_ZLIB_NOT_FOUND: i32 = -100044;
pub const ERR_OPEN_ACROMARKER1: i32 = -100045;
pub const ERR_OPEN_ACROMARKER2: i32 = -100046;
pub const ERR_BADACROINDEX: i32 = -100047;
pub const ERR_BADACRONUMBER: i32 = -100048;
pub const ERR_BADACRONAME: i32 = -100049;
pub const ERR_ACRODUPEMAP: i32 = -100050;
pub const ERR_ACROBADADDITION: i32 = -100051;
pub const ERR_UNKNOWNDOMAIN: i32 = -100052;
pub const ERR_BADDOMAIN: i32 = -100053;
pub const ERR_NODOMAINDATA: i32 = -100054;
pub const ERR_ALIASSETEXPECTED: i32 = -100055;
pub const ERR_BADDATATYPE: i32 = -100056;
pub const ERR_NOSYMBOLFORCOMMENT: i32 = -100057;
pub const ERR_DOMAINVIOLATION: i32 = -100058;
pub const ERR_FILEALREADYOPEN: i32 = -100059;
pub const ERR_FILETOOLDFORAPPEND: i32 = -100060;
pub const ERR_OPEN_DOMSMARKER1: i32 = -100061;
pub const ERR_OPEN_DOMSMARKER2: i32 = -100062;
pub const ERR_OPEN_DOMSMARKER3: i32 = -100063;
pub const ERR_GDXCOPY: i32 = -100100;
pub const ERR_PARAMETER: i32 = -100101;
pub const ERR_DLL_NOT_FOUND: i32 = -100102;
pub const ERR_CREATE_DIR: i32 = -100103;
pub const ERR_FILE_OPEN: i32 = -100104;
pub const ERR_FILE_WRITE: i32 = -100105;
pub const ERR_UEL_LENGTH: i32 = -100106;
pub const ERR_UEL_REGISTER: i32 = -100107;
pub const ERR_EXPL_TEXT: i32 = -100108;
pub const ERR_DIMENSION: i32 = -100109;
pub const ERR_WRITE_SYMBOL: i32 = -100110;
pub const ERR_CLOSE_FILE: i32 = -100111;
pub const ERR_CANNOT_DELETE: i32 = -100112;
pub const ERR_CANNOT_RENAME: i32 = -100113;

pub(crate) const MESSAGES: &[(i32, &str)] = &[
    (ERR_NOFILE, "File name is empty"),
    (ERR_FILEERROR, "File I/O error"),
    (ERR_NOERROR, "No error"),
    (ERR_BADMODE, "Bad mode"),
    (ERR_BADDIMENSION, "Bad dimension"),
    (ERR_BAD_ALIAS_DIM, "Bad dimension for aliased set"),
    (ERR_BADELEMENTINDEX, "Bad UEL Nr"),
    (ERR_BADSYMBOLINDEX, "Bad symbol number"),
    (ERR_ELEMENTSEQUENCE, "Element out of sequence"),
    (ERR_DUPLICATESYMBOL, "Duplicate symbol"),
    (ERR_DATANOTSORTED, "Data is not sorted"),
    (ERR_DATADUPLICATE, "Duplicate keys"),
    (ERR_UNKNOWNFILTER, "Unknown filter"),
    (ERR_BADSTRINGFORMAT, "Bad quotes"),
    (ERR_BADIDENTFORMAT, "Illegal identifier"),
    (ERR_UELCONFLICT, "UEL string with different index"),
    (ERR_DUPLICATESPECVAL, "Duplicate special value"),
    (ERR_BADERRORRECORD, "Bad Error record number"),
    (ERR_DUPLICATEUEL, "Duplicate UEL"),
    (ERR_BADUELSTR, "Bad UEL string"),
    (ERR_UNDEFUEL, "Unknown UEL"),
    (ERR_UELSECONDWRITE, "gdx file has UEL table already"),
    (ERR_UELNOTEMPTY, "UEL table is not empty"),
    (ERR_BAD_FILTER_NR, "Bad filter number"),
    (ERR_BAD_FILTER_INDX, "Bad index in filter"),
    (ERR_FILTER_UNMAPPED, "Unmapped index in filter"),
    (ERR_OBSOLETE_FUNCTION, "Use of obsolete function"),
    (ERR_RAWNOTSORTED, "Data not sorted when writing raw"),
    (ERR_BADACROINDEX, "Bad index for acronym"),
    (ERR_BADACRONUMBER, "Bad acronym record number"),
    (ERR_BADACRONAME, "Bad acronym name for update"),
    (ERR_ACRODUPEMAP, "Bad acronym index for update"),
    (ERR_ACROBADADDITION, "Bad addition to acronym table"),
    (ERR_UNKNOWNDOMAIN, "Unknown domain"),
    (ERR_BADDOMAIN, "Domain not set with dim=1"),
    (ERR_NODOMAINDATA, "Set has no data"),
    (ERR_ALIASSETEXPECTED, "Set expected for domain"),
    (ERR_BADDATATYPE, "Bad data type"),
    (ERR_NOSYMBOLFORCOMMENT, "No symbol to add comment to"),
    (ERR_DOMAINVIOLATION, "Domain violation"),
    (ERR_FILEALREADYOPEN, "File is already open"),
    (ERR_FILETOOLDFORAPPEND, "File version to old for append"),
    (ERR_OPEN_DOMSMARKER1, "Expected data marker (DOMS_1) not found in GDX file"),
    (ERR_OPEN_DOMSMARKER2, "Expected data marker (DOMS_2) not found in GDX file"),
    (ERR_OPEN_DOMSMARKER3, "Expected data marker (DOMS_3) not found in GDX file"),
    (ERR_BADDATAMARKER_DATA, "Expected data marker (DATA) not found in GDX file"),
    (ERR_BADDATAMARKER_DIM, "Expected data marker (DIM) not found in GDX file"),
    (ERR_OPEN_BOI, "Expected data marker (BOI) not found in GDX file"),
    (ERR_OPEN_FILEHEADER, "Expected data marker (FILEHEADER) not found in GDX file"),
    (ERR_OPEN_FILEMARKER, "Expected data marker (FILEMARKER) not found in GDX file"),
    (ERR_OPEN_SYMBOLMARKER1, "Expected data marker (SYMBOL_1) not found in GDX file"),
    (ERR_OPEN_SYMBOLMARKER2, "Expected data marker (SYMBOL_2) not found in GDX file"),
    (ERR_OPEN_UELMARKER1, "Expected data marker (UEL_1) not found in GDX file"),
    (ERR_OPEN_UELMARKER2, "Expected data marker (UEL_2) not found in GDX file"),
    (ERR_OPEN_TEXTMARKER1, "Expected data marker (TEXT_1) not found in GDX file"),
    (ERR_OPEN_TEXTMARKER2, "Expected data marker (TEXT_2) not found in GDX file"),
    (ERR_OPEN_ACROMARKER1, "Expected data marker (ACRO_1) not found in GDX file"),
    (ERR_OPEN_ACROMARKER2, "Expected data marker (ACRO_2) not found in GDX file"),
    (ERR_OPEN_FILEVERSION, "GDX file version not supported"),
    (ERR_BADDATAFORMAT, "File not recognized as a GDX file"),
    (ERR_OUT_OF_MEMORY, "Out of memory"),
    (ERR_ZLIB_NOT_FOUND, "Compression library not found"),
    (ERR_GDXCOPY, "GDXCOPY: Unknown error"),
    (ERR_PARAMETER, "GDXCOPY: Parameter error"),
    (ERR_DLL_NOT_FOUND, "GDXCOPY: DLL not found"),
    (ERR_CREATE_DIR, "GDXCOPY: Cannot create directory"),
    (ERR_FILE_OPEN, "GDXCOPY: File open failed"),
    (ERR_FILE_WRITE, "GDXCOPY: Cannot open file for write"),
    (ERR_UEL_LENGTH, "GDXCOPY: UEL length exceeds maximum"),
    (ERR_UEL_REGISTER, "GDXCOPY: Cannot register UELs"),
    (ERR_EXPL_TEXT, "GDXCOPY: Cannot save explanatory text"),
    (ERR_DIMENSION, "GDXCOPY: Dimension exceeds maximum"),
    (ERR_WRITE_SYMBOL, "GDXCOPY: Error writing symbol"),
    (ERR_CLOSE_FILE, "GDXCOPY: Error closing file"),
    (ERR_CANNOT_DELETE, "GDXCOPY: Cannot delete file"),
    (ERR_CANNOT_RENAME, "GDXCOPY: Cannot rename file"),
];
