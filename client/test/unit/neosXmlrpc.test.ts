// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { encodeCall, encodeFault, encodeResponse, parseCall, parseResponse, XmlRpcFault, XmlRpcParseError } from '../../src/neos/xmlrpc';

// Examples follow the XML-RPC specification (http://xmlrpc.com/spec.md) and the types Studio's xmlrpc.cpp handles.
describe('NEOS XML-RPC', () => {
  it('encodes a call like Studio prepareCall (int, string, array, base64)', () => {
    const x = encodeCall('getIntermediateResultsNonBlocking', [42, 'pw<&>', 7]);
    assert.strictEqual(
      x,
      '<?xml version="1.0" encoding="UTF-8"?><methodCall><methodName>getIntermediateResultsNonBlocking</methodName><params>'
      + '<param><value><int>42</int></value></param><param><value><string>pw&lt;&amp;&gt;</string></value></param>'
      + '<param><value><int>7</int></value></param></params></methodCall>',
    );
    assert.ok(!encodeCall('ping').includes('<params>'));
    assert.ok(encodeCall('m', [Buffer.from('hello')]).includes('<base64>aGVsbG8=</base64>'));
    assert.ok(encodeCall('m', [[1, 'a']]).includes('<array><data><value><int>1</int></value><value><string>a</string></value></data></array>'));
    assert.ok(encodeCall('m', [true, 1.5]).includes('<boolean>1</boolean>'));
    assert.ok(encodeCall('m', [1.5]).includes('<double>1.5</double>'));
    assert.ok(encodeCall('m', [{ a: 1 }]).includes('<struct><member><name>a</name><value><int>1</int></value></member></struct>'));
    assert.ok(encodeCall('m', [new Date(Date.UTC(2020, 3, 14, 16, 23, 55))]).includes('<dateTime.iso8601>20200414T16:23:55</dateTime.iso8601>'));
  });

  it('round-trips values through call encoding', () => {
    const vals = ['x', 3, -5, 2.5, true, false, null, Buffer.from([0, 1, 255]), [1, ['n']], { a: 'b', c: [1] }, 'a\nb  c'];
    const back = parseCall(encodeCall('m', vals));
    assert.strictEqual(back.method, 'm');
    assert.deepStrictEqual(back.params, vals);
  });

  it('parses the spec response with array and struct', () => {
    const r = parseResponse(`<?xml version="1.0"?><methodResponse><params><param><value><array><data>
      <value><i4>12</i4></value><value><string>South Dakota</string></value><value>untyped</value></data></array></value></param>
      <param><value><struct><member><name>lowerBound</name><value><i4>18</i4></value></member>
      <member><name>upperBound</name><value><double>139.5</double></value></member></struct></value></param></params></methodResponse>`);
    assert.deepStrictEqual(r, [[12, 'South Dakota', 'untyped'], { lowerBound: 18, upperBound: 139.5 }]);
  });

  it('parses base64 with line breaks and a NEOS style submitJob result', () => {
    const b = Buffer.from('log line\nsecond');
    const enc = b.toString('base64').replace(/(.{8})/g, '$1\n');
    const r = parseResponse(`<methodResponse><params><param><value><array><data><value><base64>${enc}</base64></value><value><int>15</int></value></data></array></value></param></params></methodResponse>`);
    const arr = r[0] as [Buffer, number];
    assert.ok(Buffer.isBuffer(arr[0]));
    assert.strictEqual(arr[0].toString(), 'log line\nsecond');
    assert.strictEqual(arr[1], 15);
  });

  it('decodes entities, CDATA, comments and booleans', () => {
    const r = parseResponse('<methodResponse><!-- c --><params><param><value><string>a &lt;b&gt; &amp; &#65;&#x42; <![CDATA[<raw>]]></string></value></param>'
      + '<param><value><boolean>1</boolean></value></param><param><value><boolean>0</boolean></value></param><param><value><nil/></value></param></params></methodResponse>');
    assert.deepStrictEqual(r, ['a <b> & AB <raw>', true, false, null]);
  });

  it('throws XmlRpcFault for fault responses', () => {
    assert.throws(() => parseResponse(encodeFault(4, 'Too many parameters.')), (e: unknown) =>
      e instanceof XmlRpcFault && e.faultCode === 4 && e.faultString === 'Too many parameters.');
  });

  it('rejects malformed documents', () => {
    for (const bad of ['', 'not xml', '<methodResponse><params>', '<a></b>', '<methodCall/>',
      '<methodResponse><params><param><value><int>x</int></value></param></params></methodResponse>',
      '<methodResponse><params><param><value><wat>1</wat></value></param></params></methodResponse>',
      '<methodResponse></methodResponse>']) {
      assert.throws(() => parseResponse(bad), (e: unknown) => e instanceof XmlRpcParseError, bad);
    }
  });

  it('server side helpers agree with the client', () => {
    assert.deepStrictEqual(parseResponse(encodeResponse([1, 'pw'])), [[1, 'pw']]);
  });
});
