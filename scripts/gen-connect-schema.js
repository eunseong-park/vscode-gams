#!/usr/bin/env node
/*
 * Generates schemas/connect/connect.schema.json (JSON Schema draft-07) for a GAMS Connect YAML file
 * from the official Cerberus agent schemas shipped with GAMS:
 *   $GAMS_SYSDIR/GMSPython/lib/python3*\/site-packages/gams/connect/agents/schema/<Agent>.yaml
 * No documentation text is extracted (the GAMS docs have no open license). From the offline docs
 * $GAMS_SYSDIR/docs/UG_GAMSCONNECT.html only the anchor ids are read: where the anchor `<AGENT>_<OPTION>`
 * matches an option name of that agent exactly, the option gets a `markdownDescription` that links to
 * https://www.gams.com/latest/docs/UG_GAMSCONNECT.html#<anchor>. Same for agents (`#<AGENT>`).
 *
 * Usage: GAMS_SYSDIR=<GAMS system directory> node scripts/gen-connect-schema.js [--out file]
 *
 * File structure and semantics (gams/connect/connectdatabase.py `_execute`, sysdir connectdriver.py):
 * a Connect file is a YAML list of single-key dicts `{AgentName: {options}}` (a single dict is accepted by
 * the driver too; the generated schema models the documented list form). Every option dict is validated
 * with Cerberus (gams/connect/connectvalidator.py: Validator + custom `excludes`), after normalization
 * (defaults inserted).
 *
 * Cerberus -> JSON Schema mapping (anything else makes the generator fail loudly):
 *   type (str|list)  -> type (string, integer, boolean, float|number -> number, list -> array, dict -> object)
 *   default          -> default (annotation only; a field with a default is never required, because Cerberus
 *                       normalization inserts it before the `required` check)
 *   required         -> required[] of the enclosing object, only when the field has no `default`
 *   nullable         -> "null" added to type / enum, or a {type:null} branch in oneOf
 *   allowed          -> enum
 *   min / max        -> minimum / maximum
 *   schema (dict)    -> properties; Cerberus rejects unknown keys unless allow_unknown -> additionalProperties
 *   schema (list)    -> items
 *   oneof            -> oneOf (Cerberus requires exactly one match, same as JSON Schema)
 *   excludes         -> per object: if the field is present and non-null, the excluded fields must be null/absent
 *                       (ConnectValidator._validate_excludes treats null as missing)
 * No JSON Schema equivalent / not modelled:
 *   - Cerberus normalization (defaults are only annotations).
 *   - "required" fields that carry a default and `excludes` (e.g. ExcelReader index/symbols) are not enforced
 *     by Cerberus either (normalization fills null); the agent code checks them at run time.
 *   - Agent-specific run-time checks done in the agent code (e.g. valid symbol names, Excel ranges).
 *   - %name% text substitutions are applied by the driver before YAML parsing; values containing them in
 *     non-string positions (e.g. `trace: %t%`) cannot be validated.
 *   - Top level: a single agent dict (instead of a list) is accepted by the driver but not by this schema.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TYPE_MAP = { string: 'string', integer: 'integer', boolean: 'boolean', float: 'number', number: 'number', list: 'array', dict: 'object' };
const KNOWN_RULES = new Set(['type', 'default', 'required', 'nullable', 'allowed', 'min', 'max', 'schema', 'oneof', 'excludes', 'allow_unknown']);

function fail(where, msg) {
  throw new Error(`${where}: ${msg}`);
}

/** Convert one Cerberus rule dict to a JSON Schema. `descFor(name)` returns a doc link (markdown) or undefined. */
function convertRule(rule, where, descFor) {
  for (const k of Object.keys(rule)) if (!KNOWN_RULES.has(k)) fail(where, `unsupported Cerberus rule '${k}'`);
  const s = {};
  const types = rule.type === undefined ? undefined : Array.isArray(rule.type) ? rule.type : [rule.type];
  if (types) {
    const mapped = types.map((t) => TYPE_MAP[t] ?? fail(where, `unsupported type '${t}'`));
    s.type = mapped.length === 1 ? mapped[0] : mapped;
  }
  if ('default' in rule) s.default = rule.default;
  if (rule.allowed !== undefined) {
    if (types && types.includes('list')) fail(where, "'allowed' on a list type is not supported");
    s.enum = [...rule.allowed];
  }
  if (rule.min !== undefined) s.minimum = rule.min;
  if (rule.max !== undefined) s.maximum = rule.max;
  if (rule.schema !== undefined) {
    if (!types || types.length !== 1) fail(where, "'schema' needs exactly one type (dict or list)");
    if (types[0] === 'dict') Object.assign(s, convertFields(rule.schema, where, descFor, rule.allow_unknown === true));
    else if (types[0] === 'list') s.items = convertRule(rule.schema, where + '[]', descFor);
    else fail(where, `'schema' on type ${types[0]}`);
  } else if (types && types.length === 1 && types[0] === 'object' && rule.allow_unknown === undefined) {
    // dict without schema: free-form mapping
  }
  if (rule.oneof !== undefined) {
    s.oneOf = rule.oneof.map((r, i) => convertRule(r, `${where}/oneof[${i}]`, descFor));
  }
  if (rule.nullable === true) {
    if (s.oneOf) s.oneOf.push({ type: 'null' });
    else if (s.type !== undefined) s.type = [].concat(s.type, 'null');
    if (s.enum) s.enum.push(null);
  }
  return s;
}

/** Cerberus field map -> object schema pieces (properties, required, additionalProperties, excludes). */
function convertFields(fields, where, descFor, allowUnknown) {
  const props = {};
  const required = [];
  const allOf = [];
  for (const [name, rule] of Object.entries(fields)) {
    const sub = convertRule(rule, `${where}/${name}`, descFor);
    const d = descFor(name);
    if (d) sub.markdownDescription = d;
    props[name] = sub;
    if (rule.required === true && !('default' in rule)) required.push(name);
    if (rule.excludes !== undefined) {
      const ex = Array.isArray(rule.excludes) ? rule.excludes : [rule.excludes];
      allOf.push({
        if: { required: [name], properties: { [name]: { not: { type: 'null' } } } },
        then: { properties: Object.fromEntries(ex.map((e) => [e, { type: 'null' }])) },
      });
    }
  }
  const out = { properties: props };
  if (required.length) out.required = required;
  out.additionalProperties = allowUnknown;
  if (allOf.length) out.allOf = allOf;
  return out;
}

const DOC_URL = 'https://www.gams.com/latest/docs/UG_GAMSCONNECT.html';
const docLink = (anchor) => `[Documentation](${DOC_URL}#${anchor})`;

/** Set of anchor ids (`<a class="anchor" id="...">`) of UG_GAMSCONNECT.html; no text is read. */
function parseAnchors(html) {
  return new Set([...html.matchAll(/<a class="anchor" id="([A-Za-z0-9_]+)"><\/a>/g)].map((m) => m[1]));
}

function findSchemaDir(sysdir) {
  const lib = path.join(sysdir, 'GMSPython', 'lib');
  for (const py of fs.readdirSync(lib).filter((d) => /^python3/.test(d)).sort()) {
    const d = path.join(lib, py, 'site-packages', 'gams', 'connect', 'agents', 'schema');
    if (fs.existsSync(d)) return d;
  }
  throw new Error(`no gams/connect/agents/schema below ${lib}`);
}

function generate(sysdir) {
  const yaml = require('js-yaml');
  const schemaDir = findSchemaDir(sysdir);
  const anchors = parseAnchors(fs.readFileSync(path.join(sysdir, 'docs', 'UG_GAMSCONNECT.html'), 'utf8'));
  const gamsVersion = (fs.readFileSync(path.join(sysdir, 'gamsstmp.txt'), 'utf8').match(/\d+\.\d+\.\d+/) ?? ['unknown'])[0];
  const branches = [];
  for (const file of fs.readdirSync(schemaDir).filter((f) => f.endsWith('.yaml')).sort()) {
    const agent = file.replace(/\.yaml$/, '');
    const fields = yaml.load(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
    const AG = agent.toUpperCase();
    const link = (n) => {
      const id = `${AG}_${n.toUpperCase()}`;
      return anchors.has(id) ? docLink(id) : undefined;
    };
    const body = convertFields(fields, agent, link, false);
    const agentSchema = { type: 'object', ...body };
    if (anchors.has(AG)) agentSchema.markdownDescription = docLink(AG);
    branches.push({
      title: agent,
      type: 'object',
      properties: { [agent]: agentSchema },
      required: [agent],
      additionalProperties: false,
    });
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $comment: `GENERATED by scripts/gen-connect-schema.js from GAMS ${gamsVersion}: structure derived from the Cerberus agent schemas of the gamsapi package (GAMS-dev/gams.connect, MIT License, Copyright (c) GAMS Development Corp. and GAMS Software GmbH; see THIRD_PARTY_NOTICES.md); documentation links point to docs/UG_GAMSCONNECT.html anchors on gams.com, no documentation text is included. Do not edit; see header comment of the generator for the mapping and its limits.`,
    title: 'GAMS Connect file',
    description: 'List of GAMS Connect agent instructions, one single-key mapping per agent.',
    type: 'array',
    items: { oneOf: branches },
  };
}

module.exports = { convertRule, convertFields, parseAnchors, generate, findSchemaDir };

if (require.main === module) {
  const sysdir = process.env.GAMS_SYSDIR;
  if (!sysdir) {
    console.error('set GAMS_SYSDIR to the GAMS system directory');
    process.exit(2);
  }
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : path.join(__dirname, '..', 'schemas', 'connect', 'connect.schema.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(generate(sysdir), null, 2) + '\n');
  console.log('wrote', out);
}
