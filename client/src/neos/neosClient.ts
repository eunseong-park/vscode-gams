// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * NEOS XML-RPC client over node http(s). Port of GAMS Studio src/neos/httpmanager.cpp
 * (POST text/xml, User-Agent "neos/1.0", TLS >= 1.2) and the call set of neosmanager.cpp.
 * Unlike Studio's Qt manager, every request has an idle timeout and can be aborted.
 * Pure module: no vscode imports.
 */
import * as http from 'http';
import * as https from 'https';
import { encodeCall, parseResponse, XmlRpcFault, XmlRpcValue } from './xmlrpc';

/** Studio NeosProcess constructor: mManager->setUrl("https://neos-server.org:3333"). */
export const DEFAULT_NEOS_URL = 'https://neos-server.org:3333';

export type NeosErrorKind = 'network' | 'timeout' | 'tls' | 'http' | 'protocol' | 'fault' | 'aborted';

export class NeosError extends Error {
  constructor(readonly kind: NeosErrorKind, message: string) {
    super(message);
    this.name = 'NeosError';
  }
}

const TLS_CODES = /^(CERT_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED|UNABLE_TO_|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH|ERR_CERT)/;

/** Response size caps (bytes of the XML body): status/log calls vs. result downloads. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export interface NeosClientOptions {
  /** Override the cap for ordinary calls (default 16 MB) / result downloads (default 512 MB). */
  maxResponseBytes?: number;
  maxDownloadBytes?: number;
  /** Idle timeout per request in ms (no bytes sent/received). Default 60000. */
  timeoutMs?: number;
  /** Studio "Ignore" in the SSL error dialog. */
  ignoreTlsErrors?: boolean;
}

export class NeosClient {
  readonly url: URL;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxDownload: number;
  ignoreTlsErrors: boolean;
  private readonly inflight = new Set<http.ClientRequest>();
  private aborted = false;

  constructor(url: string, opts: NeosClientOptions = {}) {
    let u: URL;
    try { u = new URL(url); } catch { throw new NeosError('protocol', `Invalid NEOS server URL "${url}"`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NeosError('protocol', `Unsupported NEOS server URL "${url}" (use http or https)`);
    this.url = u;
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.maxBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.maxDownload = opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
    this.ignoreTlsErrors = !!opts.ignoreTlsErrors;
  }

  /** Abort all running requests; further calls fail with kind 'aborted'. */
  abort(): void {
    this.aborted = true;
    for (const r of this.inflight) r.destroy(new NeosError('aborted', 'Aborted'));
  }

  /** Allow new calls again after abort() (used to send killJob after cancelling polls). */
  reset(): void {
    this.aborted = false;
  }

  call(method: string, params: XmlRpcValue[] = [], download = false): Promise<XmlRpcValue[]> {
    const cap = download ? this.maxDownload : this.maxBytes;
    if (this.aborted) return Promise.reject(new NeosError('aborted', 'Aborted'));
    const body = Buffer.from(encodeCall(method, params), 'utf8');
    const mod = this.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (f: () => void): void => { if (!settled) { settled = true; this.inflight.delete(req); f(); } };
      const req = mod.request(
        this.url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/xml', 'Content-Length': body.length, 'User-Agent': 'neos/1.0' },
          minVersion: 'TLSv1.2',
          rejectUnauthorized: !this.ignoreTlsErrors,
        } as https.RequestOptions,
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const tooBig = (): void => {
            done(() => reject(new NeosError('protocol', `NEOS response exceeds the size limit of ${cap >= 1048576 ? Math.round(cap / 1048576) + ' MB' : cap + ' bytes'}`)));
            res.destroy();
            req.destroy();
          };
          if (Number(res.headers['content-length']) > cap) return tooBig();
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > cap) return tooBig();
            chunks.push(c);
          });
          res.on('error', (e) => done(() => reject(this.wrap(e))));
          res.on('aborted', () => done(() => reject(new NeosError('network', 'Connection closed by the server'))));
          res.on('end', () => {
            if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
              return done(() => reject(new NeosError('http', `HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim())));
            }
            try {
              const result = parseResponse(Buffer.concat(chunks).toString('utf8'));
              done(() => resolve(result));
            } catch (e) {
              done(() => reject(e instanceof XmlRpcFault
                ? new NeosError('fault', e.message)
                : new NeosError('protocol', `Invalid response from NEOS server: ${(e as Error).message}`)));
            }
          });
        },
      );
      this.inflight.add(req);
      req.setTimeout(this.timeoutMs, () => req.destroy(new NeosError('timeout', `No response from NEOS server within ${Math.round(this.timeoutMs / 1000)} s`)));
      req.on('error', (e) => done(() => reject(this.wrap(e))));
      req.end(body);
    });
  }

  private wrap(e: Error): NeosError {
    if (e instanceof NeosError) return e;
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (TLS_CODES.test(code)) return new NeosError('tls', `${e.message}${code ? ` (${code})` : ''}`);
    return new NeosError('network', `${e.message}${code && !e.message.includes(code) ? ` (${code})` : ''}`);
  }

  private async first(method: string, params: XmlRpcValue[] = [], download = false): Promise<XmlRpcValue> {
    const r = await this.call(method, params, download);
    if (r.length < 1) throw new NeosError('protocol', `Empty response to ${method}`);
    return r[0];
  }

  // ---- typed wrappers (NeosManager) ----

  async ping(): Promise<string> { return String(await this.first('ping')); }
  async version(): Promise<string> { return String(await this.first('version')); }

  /** Returns [jobNumber, password]; jobNumber 0 => password holds the server's error text (Studio reSubmitJob). */
  async submitJob(jobXml: string): Promise<{ jobNumber: number; password: string }> {
    const r = await this.first('submitJob', [jobXml]);
    if (!Array.isArray(r) || r.length < 2) throw new NeosError('protocol', 'Unexpected submitJob response');
    return { jobNumber: Number(r[0]), password: String(r[1]) };
  }

  async getJobStatus(job: number, pw: string): Promise<string> { return String(await this.first('getJobStatus', [job, pw])); }
  async getCompletionCode(job: number, pw: string): Promise<string> { return String(await this.first('getCompletionCode', [job, pw])); }
  async killJob(job: number, pw: string): Promise<string> { return String(await this.first('killJob', [job, pw])); }

  async getJobInfo(job: number, pw: string): Promise<string[]> {
    const r = await this.first('getJobInfo', [job, pw]);
    return Array.isArray(r) ? r.map(String) : [];
  }

  /** Returns the new log bytes and the next offset (Studio keeps mLogOffset). */
  async getIntermediateResultsNonBlocking(job: number, pw: string, offset: number): Promise<{ data: Buffer; offset: number }> {
    const r = await this.first('getIntermediateResultsNonBlocking', [job, pw, offset]);
    if (!Array.isArray(r) || r.length < 2) throw new NeosError('protocol', 'Unexpected getIntermediateResultsNonBlocking response');
    return { data: asBuffer(r[0]), offset: Number(r[1]) };
  }

  async getFinalResultsNonBlocking(job: number, pw: string): Promise<Buffer> {
    return asBuffer(await this.first('getFinalResultsNonBlocking', [job, pw], true));
  }

  async getOutputFile(job: number, pw: string, fileName: string): Promise<Buffer> {
    return asBuffer(await this.first('getOutputFile', [job, pw, fileName], true));
  }
}

function asBuffer(v: XmlRpcValue): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  throw new NeosError('protocol', 'Expected binary data in NEOS response');
}
