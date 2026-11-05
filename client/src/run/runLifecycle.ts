// SPDX-License-Identifier: GPL-3.0-or-later
export interface RunHooks {
  /** this run is still the most recent one (its log/diagnostics belong to the visible session) */
  isCurrentRun(): boolean;
  /** the runner's active process is still this run's process */
  isCurrentProc(): boolean;
  appendLine(text: string): void;
  /** process exited (or failed to start): back to idle */
  onProcFinished(): void;
  /** output flushed, "Process ended" written: notify reference file etc. */
  onFinalized(): void;
}

export interface RunSessionLike {
  end(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ProcLike { on(ev: string, fn: (...a: any[]) => void): unknown }

/**
 * Wire a GAMS process to a run. `exit` flips running -> idle (only if the run is still current);
 * `close` (stdio drained, possibly much later) flushes output and finalizes — ignored for stale runs.
 * If `close` does not arrive shortly after `exit` (grandchild holding the pipes), finalize anyway.
 */
export function attachRun(proc: ProcLike, session: RunSessionLike, hooks: RunHooks, closeGraceMs = 2000): void {
  let exited = false;
  let finalized = false;
  let timer: NodeJS.Timeout | undefined;

  const finalize = (text: string): void => {
    if (finalized) return;
    finalized = true;
    if (timer) clearTimeout(timer);
    if (!hooks.isCurrentRun()) return;
    session.end();
    hooks.appendLine(text);
    hooks.onFinalized();
  };
  const describe = (code: number | null, sig: string | null): string =>
    `*** Process ended${sig ? ` by signal ${sig}` : ` with exit code ${code}`}`;
  let endText = '*** Process ended';

  const markExited = (): void => {
    if (exited) return;
    exited = true;
    if (hooks.isCurrentProc()) hooks.onProcFinished();
  };

  proc.on('error', (e: Error) => {
    if (finalized) return;
    markExited();
    finalize(`*** Could not start GAMS: ${e.message}`);
  });
  proc.on('exit', (code: number | null, sig: string | null) => {
    endText = describe(code, sig);
    markExited();
    timer = setTimeout(() => finalize(endText), closeGraceMs);
  });
  proc.on('close', (code: number | null, sig: string | null) => {
    if (!exited) endText = describe(code, sig);
    markExited();
    finalize(endText);
  });
}
