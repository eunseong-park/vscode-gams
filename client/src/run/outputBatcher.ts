import * as vscode from 'vscode';

/** Collects lines for the output channel and appends them in batches (one append per 100 ms instead of one call per line). */
export class OutputBatcher implements vscode.Disposable {
  private buf: string[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly channel: Pick<vscode.OutputChannel, 'append' | 'clear'>) {}

  add(line: string): void {
    this.buf.push(line);
    if (this.buf.length >= 5000) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 100);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buf.length) return;
    const text = this.buf.join('\n') + '\n';
    this.buf = [];
    this.channel.append(text);
  }

  /** Forget pending lines and clear the channel (new run). */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.buf = [];
    this.channel.clear();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
