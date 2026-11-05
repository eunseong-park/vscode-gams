// SPDX-License-Identifier: GPL-3.0-or-later
// Request/response plumbing between the webview and the extension host.
import type { RpcMethod, ToExtension } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
export const vscodeApi = acquireVsCodeApi();
export const send = (m: ToExtension): void => vscodeApi.postMessage(m);

let rpcId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export function rpc<T>(method: RpcMethod, params: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send({ type: 'rpc', reqId: id, method, params });
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

/** Server memory guards answer with a message starting with this tag (see gams-lsp gdx.rs `check_raw_limit`). */
export const isLimitError = (msg: string): boolean => msg.startsWith('[limit]');
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
