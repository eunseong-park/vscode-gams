// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Language ids of GAMS source code. `.inc` files have their own id (`gams-inc`) only so that the Explorer can
 * show them with their own icon (VS Code takes file icons from `contributes.languages[].icon`); they get every
 * feature of `gams` (grammar, language server, run/compile, debugger, commands). Keep in sync with package.json
 * (`editorLangId =~ /^gams(-inc)?$/`) and the language server (`GAMS_LANGS` in server/crates/gams-lsp).
 */
export const GAMS_LANGS: readonly string[] = ['gams', 'gams-inc'];

/** True for a GAMS source language id (`gams`, `gams-inc`). */
export function isGamsLang(languageId: string | undefined): boolean {
  return languageId !== undefined && GAMS_LANGS.includes(languageId);
}

/** True for a document in a GAMS source language (any scheme). */
export function isGamsSource(doc: { languageId: string } | undefined): boolean {
  return isGamsLang(doc?.languageId);
}

/** True for a GAMS source document saved on disk (the files that can be run, compiled, debugged). */
export function isGamsFile(doc: { languageId: string; uri: { scheme: string } } | undefined): boolean {
  return isGamsSource(doc) && doc?.uri.scheme === 'file';
}

/** Document selector for the GAMS source languages. */
export function gamsSelector(scheme?: string): { language: string; scheme?: string }[] {
  return GAMS_LANGS.map((language) => (scheme ? { scheme, language } : { language }));
}
