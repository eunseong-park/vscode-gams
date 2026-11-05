// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * `yaml.schemas` (Red Hat YAML extension setting) helpers for the Connect schema. No vscode imports.
 * Format: { "<schema uri or path>": "<glob>" | ["<glob>", ...] }.
 */
import * as path from 'path';

export const SCHEMA_REL = 'schemas/connect/connect.schema.json';

export type YamlSchemas = Record<string, string | string[]>;

export function isConnectSchemaKey(key: string): boolean {
  return key.replace(/\\/g, '/').endsWith('/' + SCHEMA_REL);
}

export const EXTENSION_ID = 'eunseong-park.vscode-gams';

/**
 * Does `key` point into an install folder of this extension (`<extensions dir>/<publisher>.<name>-<version>[-<target>]/`)?
 * Only such keys are migrated: a key of a different extension, a workspace copy or another tool that merely ends in
 * `/schemas/connect/connect.schema.json` is the user's own and stays untouched.
 */
export function isOwnInstallKey(key: string, extensionId: string = EXTENSION_ID): boolean {
  let k = key.replace(/\\/g, '/');
  try { k = decodeURIComponent(k); } catch { /* keep as is */ }
  if (!k.endsWith('/' + SCHEMA_REL)) return false;
  const parts = k.substring(0, k.length - SCHEMA_REL.length - 1).split('/');
  const folder = parts[parts.length - 1] ?? '';
  const esc = extensionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}-\\d+\\.\\d+\\.\\d+(?:[-+][\\w.+-]*)?$`, 'i').test(folder);
}

/** Add `glob` to the entry of `schemaKey` (keeps every other entry); returns a new object. */
export function addAssociation(schemas: YamlSchemas | undefined, schemaKey: string, glob: string): YamlSchemas {
  const out: YamlSchemas = { ...(schemas ?? {}) };
  const cur = out[schemaKey];
  const list = cur === undefined ? [] : Array.isArray(cur) ? [...cur] : [cur];
  if (!list.includes(glob)) list.push(glob);
  out[schemaKey] = list;
  return out;
}

/**
 * The extension's install folder changes with every version: rewrite entries that point to another copy of the
 * Connect schema (same relative path) to `schemaKey`. Returns undefined when nothing needs to change.
 */
export function migrateKeys(schemas: YamlSchemas | undefined, schemaKey: string): YamlSchemas | undefined {
  if (!schemas) return undefined;
  const stale = Object.keys(schemas).filter((k) => k !== schemaKey && isOwnInstallKey(k));
  if (!stale.length) return undefined;
  let out: YamlSchemas = { ...schemas };
  for (const k of stale) {
    const globs = ([] as string[]).concat(out[k]);
    delete out[k];
    for (const g of globs) out = addAssociation(out, schemaKey, g);
  }
  return out;
}

/** Is `file` matched by an exact path entry of the Connect schema (globs are compared as written)? */
export function isAssociated(schemas: YamlSchemas | undefined, file: string, roots: string[]): boolean {
  for (const [k, v] of Object.entries(schemas ?? {})) {
    if (!isConnectSchemaKey(k)) continue;
    for (const g of ([] as string[]).concat(v)) {
      if (path.isAbsolute(g) ? path.normalize(g) === path.normalize(file) : roots.some((r) => path.resolve(r, g) === path.normalize(file))) return true;
    }
  }
  return false;
}

/** Path written into yaml.schemas: relative to the workspace folder when inside it (portable), else absolute. */
export function globFor(file: string, folder: string | undefined): string {
  if (folder) {
    const rel = path.relative(folder, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return file.split(path.sep).join('/');
}

/** Default pattern contributed through `yamlValidation`. */
export function isConnectFileName(file: string): boolean {
  return /\.connect\.ya?ml$/i.test(file);
}
