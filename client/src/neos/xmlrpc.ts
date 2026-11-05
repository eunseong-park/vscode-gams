// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Minimal XML-RPC (http://xmlrpc.com/spec.md) encoder/decoder.
 * Port of GAMS Studio src/neos/xmlrpc.cpp (types array, base64, boolean, dateTime.iso8601,
 * double, int/i4, string, struct), extended to the full spec where the NEOS server may answer
 * with it: <fault>, <nil/>, <i8>, untyped <value>text</value> (= string), XML entities, CDATA.
 * Pure module: no vscode imports.
 * Original: Copyright (c) 2017-2026 GAMS Software GmbH / GAMS Development Corp., GPL-3.0-or-later.
 */

export type XmlRpcValue =
  | string
  | number
  | boolean
  | null
  | Date
  | Buffer
  | XmlRpcValue[]
  | { [member: string]: XmlRpcValue };

export class XmlRpcFault extends Error {
  constructor(readonly faultCode: number, readonly faultString: string) {
    super(`XML-RPC fault ${faultCode}: ${faultString}`);
    this.name = 'XmlRpcFault';
  }
}

export class XmlRpcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlRpcParseError';
  }
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// XML 1.0 forbids most C0 control characters; drop them rather than emit a broken document.
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function encodeValue(v: XmlRpcValue): string {
  if (v === null) return '<value><nil/></value>';
  if (typeof v === 'string') return `<value><string>${escapeXml(v.replace(ILLEGAL_XML, ''))}</string></value>`;
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new XmlRpcParseError(`Cannot encode non-finite number ${v}`);
    return Number.isInteger(v) && Math.abs(v) <= 2147483647
      ? `<value><int>${v}</int></value>`
      : `<value><double>${v}</double></value>`;
  }
  if (Buffer.isBuffer(v)) return `<value><base64>${v.toString('base64')}</base64></value>`;
  if (v instanceof Date) {
    const d = v;
    const s = `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    return `<value><dateTime.iso8601>${s}</dateTime.iso8601></value>`;
  }
  if (Array.isArray(v)) return `<value><array><data>${v.map(encodeValue).join('')}</data></array></value>`;
  const members = Object.entries(v)
    .map(([k, x]) => `<member><name>${escapeXml(k)}</name>${encodeValue(x)}</member>`)
    .join('');
  return `<value><struct>${members}</struct></value>`;
}

/** Studio XmlRpc::prepareCall. */
export function encodeCall(method: string, params: XmlRpcValue[] = []): string {
  const ps = params.length ? `<params>${params.map((p) => `<param>${encodeValue(p)}</param>`).join('')}</params>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><methodCall><methodName>${escapeXml(method)}</methodName>${ps}</methodCall>`;
}

/** Server side encoding (used by the mock server in tests). */
export function encodeResponse(result: XmlRpcValue): string {
  return `<?xml version="1.0"?><methodResponse><params><param>${encodeValue(result)}</param></params></methodResponse>`;
}

export function encodeFault(code: number, message: string): string {
  return `<?xml version="1.0"?><methodResponse><fault>${encodeValue({ faultCode: code, faultString: message })}</fault></methodResponse>`;
}

// ---- parsing: tiny XML tree builder -------------------------------------------------------

interface XNode {
  name: string;
  children: XNode[];
  /** concatenated character data directly inside the element (entities decoded) */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENTITIES[e] ?? m;
  });
}

function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', children: [], text: '' };
  const stack: XNode[] = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const cur = stack[stack.length - 1];
    if (lt < 0) {
      cur.text += decodeEntities(xml.substring(i));
      break;
    }
    if (lt > i) cur.text += decodeEntities(xml.substring(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) throw new XmlRpcParseError('Unterminated comment');
      i = e + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) throw new XmlRpcParseError('Unterminated CDATA section');
      cur.text += xml.substring(lt + 9, e);
      i = e + 3;
    } else if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) throw new XmlRpcParseError('Unterminated processing instruction');
      i = e + 2;
    } else if (xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0) throw new XmlRpcParseError('Unterminated declaration');
      i = e + 1;
    } else if (xml.startsWith('</', lt)) {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0) throw new XmlRpcParseError('Unterminated end tag');
      const name = xml.substring(lt + 2, e).trim();
      if (stack.length < 2 || stack[stack.length - 1].name !== name) {
        throw new XmlRpcParseError(`Unexpected end tag </${name}>`);
      }
      stack.pop();
      i = e + 1;
    } else {
      // start tag; find '>' outside of quotes
      let j = lt + 1;
      let q = '';
      while (j < n) {
        const c = xml[j];
        if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
        j++;
      }
      if (j >= n) throw new XmlRpcParseError('Unterminated start tag');
      let body = xml.substring(lt + 1, j);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const name = body.trim().split(/\s/)[0];
      if (!name) throw new XmlRpcParseError('Empty tag name');
      const node: XNode = { name, children: [], text: '' };
      cur.children.push(node);
      if (!selfClose) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new XmlRpcParseError(`Unclosed element <${stack[stack.length - 1].name}>`);
  if (root.children.length !== 1) throw new XmlRpcParseError('Expected exactly one root element');
  return root.children[0];
}

function child(node: XNode, name: string): XNode | undefined {
  return node.children.find((c) => c.name === name);
}

function toValue(node: XNode): XmlRpcValue {
  if (node.name !== 'value') throw new XmlRpcParseError(`Expected <value>, found <${node.name}>`);
  const t = node.children[0];
  if (!t) return node.text; // untyped value = string (spec)
  const s = t.text.trim();
  switch (t.name.toLowerCase()) {
    case 'string':
      return t.text;
    case 'int':
    case 'i4':
    case 'i8': {
      if (!/^[+-]?\d+$/.test(s)) throw new XmlRpcParseError(`Invalid integer "${s}"`);
      return parseInt(s, 10);
    }
    case 'double': {
      const d = Number(s);
      if (s === '' || Number.isNaN(d)) throw new XmlRpcParseError(`Invalid double "${s}"`);
      return d;
    }
    case 'boolean':
      return s === '1' || s.toLowerCase() === 'true';
    case 'base64':
      return Buffer.from(s.replace(/\s+/g, ''), 'base64');
    case 'datetime.iso8601': {
      const m = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
      if (!m) throw new XmlRpcParseError(`Invalid dateTime "${s}"`);
      return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    }
    case 'nil':
      return null;
    case 'array': {
      const data = child(t, 'data');
      if (!data) throw new XmlRpcParseError('<array> without <data>');
      return data.children.map(toValue);
    }
    case 'struct': {
      const res: { [k: string]: XmlRpcValue } = {};
      for (const m of t.children) {
        if (m.name !== 'member') throw new XmlRpcParseError(`Unexpected <${m.name}> in <struct>`);
        const name = child(m, 'name');
        const val = child(m, 'value');
        if (!name || !val) throw new XmlRpcParseError('<member> needs <name> and <value>');
        res[name.text] = toValue(val);
      }
      return res;
    }
    default:
      throw new XmlRpcParseError(`Unsupported value type <${t.name}>`);
  }
}

/**
 * Parse a methodResponse: returns the parameter list, throws XmlRpcFault for <fault>.
 * (Studio's XmlRpc::parseParams silently returns an empty list on malformed input; we throw.)
 */
export function parseResponse(xml: string): XmlRpcValue[] {
  const root = parseXml(xml);
  if (root.name !== 'methodResponse') throw new XmlRpcParseError(`Expected <methodResponse>, found <${root.name}>`);
  const fault = child(root, 'fault');
  if (fault) {
    const v = child(fault, 'value');
    const f = v ? toValue(v) : null;
    if (f && typeof f === 'object' && !Array.isArray(f) && !Buffer.isBuffer(f) && !(f instanceof Date)) {
      throw new XmlRpcFault(Number(f.faultCode ?? 0), String(f.faultString ?? ''));
    }
    throw new XmlRpcFault(0, 'Malformed fault');
  }
  const params = child(root, 'params');
  if (!params) throw new XmlRpcParseError('methodResponse without <params>');
  return params.children.map((p) => {
    const v = child(p, 'value');
    if (p.name !== 'param' || !v) throw new XmlRpcParseError('Malformed <param>');
    return toValue(v);
  });
}

/** Parse a methodCall (server side, used by the mock NEOS server). */
export function parseCall(xml: string): { method: string; params: XmlRpcValue[] } {
  const root = parseXml(xml);
  if (root.name !== 'methodCall') throw new XmlRpcParseError(`Expected <methodCall>, found <${root.name}>`);
  const name = child(root, 'methodName');
  if (!name) throw new XmlRpcParseError('methodCall without <methodName>');
  const params = child(root, 'params');
  const list = (params?.children ?? []).map((p) => {
    const v = child(p, 'value');
    if (!v) throw new XmlRpcParseError('Malformed <param>');
    return toValue(v);
  });
  return { method: name.text.trim(), params: list };
}
