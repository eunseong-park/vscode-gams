// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * The small subset of the Debug Adapter Protocol used by the GAMS debug adapter.
 * Hand-written (no @vscode/debugprotocol dependency); field names follow the DAP specification.
 * Pure module: no vscode imports.
 */

export interface ProtocolMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
}

export interface Request extends ProtocolMessage {
  type: 'request';
  command: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments?: any;
}

export interface Response extends ProtocolMessage {
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface Event extends ProtocolMessage {
  type: 'event';
  event: string;
  body?: unknown;
}

export interface Source {
  name?: string;
  path?: string;
}

export interface SourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
}

export interface Breakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: Source;
  line?: number;
  reason?: 'pending' | 'failed';
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
  presentationHint?: 'normal' | 'label' | 'subtle';
}

export interface Scope {
  name: string;
  presentationHint?: string;
  variablesReference: number;
  namedVariables?: number;
  expensive: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  presentationHint?: { kind?: string; attributes?: string[] };
}
