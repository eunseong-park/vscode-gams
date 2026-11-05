// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * TCP side of GAMS Studio src/gamscom/server.cpp (gamscom::Server): listens on the first free
 * localhost port in 3563..4563, accepts exactly one GAMS connection, decodes replies with
 * GamsComParser and sends calls (addBP/delBP/run/stepLine/pause/writeGDX).
 * GPL-3.0-or-later. Pure node module: no vscode imports.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { CallKeyword, ComFeature, DebugState, encodeCall, FIRST_DEBUG_PORT, GamsComEvents, GamsComParser, LAST_DEBUG_PORT, splitBpArgs } from './protocol';

/** server.cpp mPortsInUse (process wide) */
const portsInUse = new Set<number>();
const MAX_OPEN_PORTS = 100;

export interface ComServerEvents extends Omit<GamsComEvents, 'reply'> {
  connected?(): void;
  disconnected?(): void;
  stateChanged?(s: DebugState): void;
  /** raw traffic, for transcripts / verbose logging */
  traffic?(dir: 'in' | 'out', data: string): void;
}

export class ComServer {
  private server?: net.Server;
  private socket?: net.Socket;
  private parser?: GamsComParser;
  private _port = -1;
  private _state: DebugState = 'None';
  private subRuns = 0;

  constructor(
    /** working directory (Server::mPath, used for the temp GDX) */
    readonly workDir: string,
    readonly features: number,
    private readonly ev: ComServerEvents,
  ) {}

  get port(): number {
    return this._port;
  }

  get state(): DebugState {
    return this._state;
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  /** Server::start: first free port from 3563 */
  async start(): Promise<boolean> {
    if (this.server) return true;
    if (portsInUse.size >= MAX_OPEN_PORTS) {
      this.ev.log?.(`GAMScom-Server reached the limit of ${MAX_OPEN_PORTS} ports.`);
      return false;
    }
    for (let port = FIRST_DEBUG_PORT; port <= LAST_DEBUG_PORT; ++port) {
      if (portsInUse.has(port)) continue;
      const srv = net.createServer((s) => this.newConnection(s));
      const ok = await new Promise<boolean>((resolve) => {
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        this.server = srv;
        this._port = port;
        portsInUse.add(port);
        return true;
      }
      srv.close();
    }
    this.ev.log?.('GAMScom-Server could not find a free port!');
    return false;
  }

  /** Server::gdxTempFile */
  gdxTempFile(): string {
    return path.join(this.workDir, `temp${this._port}.gdx`);
  }

  private setState(s: DebugState): void {
    if (this._state === s) return;
    this._state = s;
    this.ev.stateChanged?.(s);
  }

  private newConnection(socket: net.Socket): void {
    if (this.socket) {
      this.ev.log?.('GAMScom-Server: already connected to a socket');
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding('utf8');
    const ev = this.ev;
    this.parser = new GamsComParser(
      {
        features: (f) => ev.features?.(f),
        linesMap: (f, l, c) => ev.linesMap?.(f, l, c),
        linesMapDone: (inc) => ev.linesMapDone?.(inc),
        paused: (c) => {
          this.setState('Paused');
          ev.paused?.(c);
        },
        gdxReady: (f) => ev.gdxReady?.(f),
        profileData: (e) => ev.profileData?.(e),
        log: (m) => ev.log?.(m),
        reply: (packets) => packets.forEach((p) => this.write(p)),
      },
      this.features,
      (p) => fs.existsSync(p),
    );
    socket.on('data', (d: string) => {
      ev.traffic?.('in', d);
      this.parser?.push(d);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      ev.disconnected?.();
    });
    socket.on('error', (e) => ev.log?.(`GAMScom-Server: socket error: ${e.message}`));
    this.setState('Prepare');
    // Studio: a second connection (sub-run) re-triggers the map-done handling
    if (this.subRuns++) ev.linesMapDone?.(this.parser.includes);
    ev.connected?.();
  }

  private write(packet: string): void {
    if (!this.socket || this.socket.destroyed) return;
    this.ev.traffic?.('out', packet);
    this.socket.write(packet);
  }

  /** Server::callProcedure */
  call(keyword: CallKeyword, args: string[] = []): void {
    if (!this.connected) {
      const more = args.length > 1 ? ` (and ${args.length - 1} more)` : '';
      this.ev.log?.(`GAMScom-Server: Socket not open, can't process '${keyword}${args.length ? ':' + args[0] + "'" + more : "'"}`);
      return;
    }
    for (const p of encodeCall(keyword, args, this.ev.log)) this.write(p);
  }

  addBreakpoint(contLine: number): void {
    this.call('addBP', [String(contLine)]);
  }

  /** Returns false when the breakpoints could not be sent (not connected or a call line too long). */
  addBreakpoints(contLines: readonly number[]): boolean {
    const args = splitBpArgs(contLines);
    if (args.length === 0) return true;
    if (!this.connected) {
      this.call('addBP', args);
      return false;
    }
    let ok = true;
    for (const p of encodeCall('addBP', args, (m) => { ok = false; this.ev.log?.(m); })) this.write(p);
    return ok;
  }

  delBreakpoint(contLine: number): void {
    this.call('delBP', [String(contLine)]);
  }

  clearBreakpoints(): void {
    this.call('delBP');
  }

  sendRun(): void {
    this.call('run');
    this.setState('Running');
  }

  sendStepLine(): void {
    this.call('stepLine');
    this.setState('Running');
  }

  sendPause(): void {
    this.call('pause');
  }

  sendWriteGdx(file: string): void {
    this.call('writeGDX', [path.normalize(file)]);
  }

  /** Server::stopAndDelete */
  stop(): void {
    this.setState('Finished');
    const s = this.socket;
    this.socket = undefined;
    s?.destroy();
    if (this.server) {
      portsInUse.delete(this._port);
      this.server.close();
      this.server = undefined;
    }
  }
}

export { ComFeature };
