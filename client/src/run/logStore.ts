/*
 * Bounded, chunked storage of the cleaned log shown in the "GAMS Log" document. Pure module: no vscode imports.
 *
 * - Lines are kept as text chunks (O(1) append, no per-line objects); link targets are kept sparsely per chunk
 *   so a link provider can build link objects per chunk once and only for chunks that changed.
 * - At most `maxLines` lines (rounded up to whole chunks) stay in memory. When the first lines are dropped,
 *   everything so far is written to `spillPath` (Studio keeps the whole log; here it is the complete
 *   `<stem>.log` next to the listing) and the following lines are appended to that file, so the log is
 *   never lost. The document starts with a note line that says so.
 */
import * as fs from 'fs';
import type { LogLine } from './logSession';
import type { ResolvedTarget } from './logParser';

export interface StoredLink {
  /** Line within the chunk. */
  line: number;
  start: number;
  end: number;
  target: ResolvedTarget;
}

export interface LogChunk {
  /** Absolute index (over the whole run) of the chunk's first line. */
  firstLine: number;
  lines: number;
  /** Lines joined with `\n`, each terminated by `\n`. */
  text: string;
  links: StoredLink[];
  /** Number of characters of `text` already written to the spill file. */
  spilled: number;
}

export const DEFAULT_MAX_LINES = 50000;

export class LogStore {
  private chunks: LogChunk[] = [];
  private total = 0;
  private dropped = 0;
  private cache?: string;
  private spillPath?: string;
  private spill?: fs.WriteStream;
  private spillFailed = false;
  private spillUsed = false;
  private readonly chunkLines: number;

  constructor(private maxLines = DEFAULT_MAX_LINES, chunkLines?: number) {
    this.chunkLines = chunkLines ?? Math.max(20, Math.min(2000, Math.floor((maxLines > 0 ? maxLines : 40000) / 20)));
  }

  /** Start a new log. `spillPath`: where the complete log goes once lines are dropped. */
  reset(spillPath?: string, maxLines = this.maxLines): void {
    this.closeSpill();
    this.maxLines = maxLines;
    this.chunks = [];
    this.total = 0;
    this.dropped = 0;
    this.cache = undefined;
    this.spillPath = spillPath;
    this.spillFailed = false;
    this.spillUsed = false;
  }

  /** Lines dropped from the start. */
  get droppedLines(): number {
    return this.dropped;
  }

  /** Lines appended since reset (including dropped ones). */
  get totalLines(): number {
    return this.total;
  }

  /** The first document line is the truncation note. */
  get headerLines(): number {
    return this.dropped > 0 ? 1 : 0;
  }

  /** Lines of text() (note included). */
  get lineCount(): number {
    return this.total - this.dropped + this.headerLines;
  }

  /** Complete log on disk (set once lines were dropped and the file could be written). */
  get spillFile(): string | undefined {
    return this.dropped > 0 && this.spillUsed && !this.spillFailed ? this.spillPath : undefined;
  }

  get chunkList(): readonly LogChunk[] {
    return this.chunks;
  }

  note(): string {
    const file = this.spillFile;
    return `*** Log truncated: the first ${this.dropped} of ${this.total} lines are not shown` +
      (file ? `. Full log: ${file}` : ' (the full log could not be written to disk).');
  }

  append(l: LogLine): void {
    let c = this.chunks[this.chunks.length - 1];
    if (!c || c.lines >= this.chunkLines) {
      c = { firstLine: this.total, lines: 0, text: '', links: [], spilled: 0 };
      this.chunks.push(c);
    }
    for (const k of l.links) c.links.push({ line: c.lines, start: k.start, end: k.end, target: k.target });
    c.text += l.text + '\n';
    c.lines++;
    this.total++;
    this.cache = undefined;
    if (this.maxLines > 0) this.enforceLimit();
    else if (this.spill) this.syncSpill();
  }

  private enforceLimit(): void {
    // drop whole chunks from the front while the rest still holds `maxLines`
    while (this.chunks.length > 1 && this.total - this.dropped - this.chunks[0].lines >= this.maxLines) {
      if (!this.spill && !this.spillFailed) this.openSpill();
      this.syncSpill();
      const c = this.chunks.shift() as LogChunk;
      this.dropped += c.lines;
    }
  }

  private openSpill(): void {
    if (!this.spillPath) {
      this.spillFailed = true;
      return;
    }
    try {
      const s = fs.createWriteStream(this.spillPath, { encoding: 'utf8' });
      s.on('error', () => {
        this.spillFailed = true;
        this.cache = undefined;
      });
      this.spill = s;
      this.spillUsed = true;
    } catch {
      this.spillFailed = true;
    }
  }

  /** Write the lines not yet on disk to the spill file (called with every dropped chunk and by the document's refresh). */
  syncSpill(): void {
    if (!this.spill) return;
    for (const c of this.chunks) {
      if (c.spilled < c.text.length) {
        this.spill.write(c.text.substring(c.spilled));
        c.spilled = c.text.length;
      }
    }
  }

  closeSpill(): void {
    if (!this.spill) return;
    this.syncSpill();
    this.spill.end();
    this.spill = undefined;
  }

  /** Complete document text. */
  text(): string {
    if (this.cache === undefined) {
      const body = this.chunks.map((c) => c.text).join('');
      this.cache = this.dropped > 0 ? this.note() + '\n' + body : body;
    }
    return this.cache;
  }
}
