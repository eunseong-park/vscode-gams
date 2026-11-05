// SPDX-License-Identifier: GPL-3.0-or-later
// Request/response plumbing between the compare webview and the extension host.
import type { CompareOp, CompareResults, CompareRpcParams, ToExtension } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
export const vscodeApi = acquireVsCodeApi();
export const send = (m: ToExtension): void => vscodeApi.postMessage(m);

let rpcId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export function rpc<K extends CompareOp>(op: K, params: CompareRpcParams, onId?: (id: number) => void): Promise<CompareResults[K]> {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    onId?.(id);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send({ type: 'rpc', reqId: id, op, params });
  });
}

export function resolveRpc(reqId: number, result: unknown): void {
  const p = pending.get(reqId);
  pending.delete(reqId);
  p?.resolve(result);
}

export function rejectRpc(reqId: number, message: string): void {
  const p = pending.get(reqId);
  pending.delete(reqId);
  p?.reject(new Error(message));
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const isLimitError = (msg: string): boolean => msg.startsWith('[limit]');
