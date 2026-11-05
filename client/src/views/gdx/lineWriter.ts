// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from 'fs';

/** Buffered file writer: the 'error' listener is attached at creation; every wait races drain against error. */
export class LineWriter {
  private readonly s: fs.WriteStream;
  private err?: Error;
  private readonly onErr: Array<(e: Error) => void> = [];
  constructor(file: string, create: (f: string) => fs.WriteStream = (f) => fs.createWriteStream(f, { encoding: 'utf8' })) {
    this.s = create(file);
    this.s.on('error', (e) => {
      this.err ??= e;
      this.onErr.splice(0).forEach((f) => f(e));
    });
  }
  async write(text: string): Promise<void> {
    if (this.err) throw this.err;
    if (this.s.write(text)) return;
    await new Promise<void>((res, rej) => {
      const onDrain = (): void => { this.onErr.splice(this.onErr.indexOf(rej), 1); res(); };
      this.onErr.push(rej);
      this.s.once('drain', onDrain);
      if (this.err) rej(this.err);
    });
  }
  /** Ends the stream; rejects with the stream error (also one raised earlier). Never hangs. */
  close(): Promise<void> {
    if (this.err) {
      this.s.destroy();
      return Promise.reject(this.err);
    }
    return new Promise((res, rej) => {
      this.onErr.push(rej);
      this.s.end(() => (this.err ? rej(this.err) : res()));
    });
  }
}
