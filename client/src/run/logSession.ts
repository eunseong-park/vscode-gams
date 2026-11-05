// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Turns the raw GAMS stdout stream into cleaned log lines with link targets and
 * compile-error records. Mirrors the flow of Studio's MemoryMapper::parseNewLine /
 * createErrorMarks (src/editors/memorymapper.cpp) feeding PExProjectNode::setErrorText.
 * Pure module: no vscode imports.
 */
import { extractLinks, HRefContext, MarksBlockState, newState, resolveHRef, ResolvedTarget } from './logParser';

export interface LogLink {
  /** Offsets into LogLine.text. */
  start: number;
  end: number;
  target: ResolvedTarget;
}

export interface LogLine {
  text: string;
  links: LogLink[];
}

export interface ErrorEntry {
  /** GAMS error number; -1 for "*** Error at line N: text". */
  errNr: number;
  /** Source location from the leading FIL tag (undefined when absent or unresolvable). */
  source?: ResolvedTarget;
  /** Listing location from the LST tag. */
  lst?: ResolvedTarget;
  /** Message text: following indented lines, trimmed (Studio's error text). */
  message: string;
  /** Visible log line that introduced the error. */
  logLine: string;
  /**
   * The location was not part of the error line (execution errors, `*** Error at line N: text`)
   * but taken from the preceding `--- file.gms(N)[FIL:...]` progress line. Extension addition, not in Studio.
   */
  inferred?: boolean;
}

export interface LogSessionEvents {
  onLine?: (line: LogLine) => void;
  onError?: (err: ErrorEntry) => void;
}

/**
 * VS Code splits a document at \r\n, \r and \n only. Studio's MemoryMapper::addProcessLog treats a \r that
 * is not followed by \n as "overwrite the last line" (progress output), so only the text after the last \r
 * is kept; the separators U+2028 / U+2029 / U+0085 (line breaks for other editors) become blanks.
 */
export function normalizeLine(raw: string): string {
  let t = raw;
  const cr = t.lastIndexOf('\r');
  if (cr >= 0) {
    // "a\r\r" keeps the last non-empty part; a trailing \r (from \r\n) is dropped
    const parts = t.split('\r');
    t = '';
    for (let i = parts.length - 1; i >= 0 && t === ''; i--) t = parts[i];
  }
  return /[\u2028\u2029\u0085]/.test(t) ? t.replace(/[\u2028\u2029\u0085]/g, ' ') : t;
}

export class LogSession {
  /** Every emitted line (disabled with `retain: false` for long runs; the consumer keeps its own copy). */
  readonly lines: LogLine[] = [];
  readonly errors: ErrorEntry[] = [];
  private pending = '';
  private current?: ErrorEntry & { texts: string[] };
  private state: MarksBlockState = newState();
  /** Location of the last `--- file(N)[FIL:...]` line: where an execution error happened. */
  private lastFil?: ResolvedTarget;

  constructor(
    private readonly ctx: HRefContext,
    private readonly exists: (p: string) => boolean,
    private readonly ev: LogSessionEvents = {},
    private readonly retain = true,
  ) {}

  /** Feed a stdout/stderr chunk; complete lines are processed, the remainder buffered. */
  push(chunk: string): void {
    const data = this.pending ? this.pending + chunk : chunk;
    let start = 0;
    let idx: number;
    while ((idx = data.indexOf('\n', start)) >= 0) {
      this.processLine(normalizeLine(data.substring(start, idx)));
      start = idx + 1;
    }
    this.pending = start === 0 ? data : data.substring(start);
  }

  /** Process any unterminated trailing line and finalize a pending error. */
  end(): void {
    if (this.pending.length) {
      const t = normalizeLine(this.pending);
      this.pending = '';
      if (t !== '') this.processLine(t);
    }
    this.finishError();
  }

  private finishError(): void {
    const c = this.current;
    if (!c) return;
    this.current = undefined;
    const entry: ErrorEntry = {
      errNr: c.errNr,
      source: c.source,
      lst: c.lst,
      message: c.texts.join('\n'),
      logLine: c.logLine,
      ...(c.inferred ? { inferred: true } : {}),
    };
    this.errors.push(entry);
    this.ev.onError?.(entry);
  }

  private processLine(raw: string): void {
    // Continuation lines of a compile error: Studio appends indented lines ("   ...").
    if (this.current) {
      if (raw.length >= 4 && raw.startsWith('   ')) {
        this.current.texts.push(raw.trim());
        this.emit({ text: raw, links: [] });
        return;
      }
      this.finishError();
    }

    const r = extractLinks(raw, this.state);
    this.state = r.state;
    if (r.text === null) return; // [TIT:...] lines are hidden
    const text = r.text;
    const m = r.state.marks;
    if (m.hRef.startsWith('LS2:"') && r.state.switchLst) {
      const f = r.state.switchLst;
      this.ctx.ls2 = /^([A-Za-z]:)?\//.test(f) ? f : this.ctx.workDir.replace(/[\\/]+$/, '') + '/' + f;
    }

    const links: LogLink[] = [];
    const lstTarget = m.hRef.startsWith('LST:') || m.hRef.startsWith('LS2:')
      ? resolveHRef(m.hRef, this.ctx, this.exists) : undefined;
    const srcTarget = m.errRef ? resolveHRef(m.errRef, this.ctx, this.exists) : undefined;
    // Studio: the hRef mark is what a click in the log follows; the errRef feeds the editor error marks.
    const lineTarget = m.hRef && !m.hRef.startsWith('LS2:"')
      ? resolveHRef(m.hRef, this.ctx, this.exists) : undefined;
    const clickTarget = lineTarget ?? srcTarget;
    if (clickTarget && text.length > 0) links.push({ start: 0, end: text.length, target: clickTarget });

    this.emit({ text, links });

    if (m.hRef.startsWith('FIL:') && lineTarget) this.lastFil = lineTarget;

    if (r.hasError && m.errNr !== 0) {
      // Execution errors ("*** Error at line N: text", errNr -1) carry no source tag: locate them with the
      // preceding "--- file.gms(N)[FIL:...]" progress line (extension addition, Studio shows no mark).
      let source = srcTarget;
      let inferred = false;
      if (!source && m.errNr < 0 && this.lastFil) {
        const at = /^\*\*\* Error at line (\d+)/.exec(text);
        source = { file: this.lastFil.file, line: at ? parseInt(at[1], 10) : this.lastFil.line, col: 0 };
        inferred = true;
      }
      this.current = {
        errNr: m.errNr,
        source,
        inferred,
        lst: lstTarget,
        message: '',
        texts: m.errNr < 0 ? [r.state.errData.text.trim()].filter((s) => s) : [],
        logLine: text,
      };
    }
  }

  private emit(l: LogLine): void {
    if (this.retain) this.lines.push(l);
    this.ev.onLine?.(l);
  }
}
