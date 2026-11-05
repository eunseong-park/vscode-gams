// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Shared registry of active GAMS activities (normal run, debug session, profile run).
 * Background work that would compete for the same <stem>.lst/.ref files (update-on-save compile) checks isBusy().
 * No vscode imports.
 */
let count = 0;

/** Mark a GAMS activity as active; call the returned function (idempotent) when it ends. */
export function beginBusy(): () => void {
  count++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    count--;
  };
}

export function isBusy(): boolean {
  return count > 0;
}

/**
 * Runs `compile` for the latest save, never concurrently and never while busy. Saves arriving during a compile
 * (or while busy) collapse into exactly one follow-up compile.
 */
export class CoalescedRunner {
  private running = false;
  private queued = false;
  constructor(private readonly job: () => Promise<void>, private readonly busy: () => boolean = isBusy) {}

  /** Returns true when the request was started or queued, false when dropped because busy. */
  request(): boolean {
    if (this.busy()) return false;
    if (this.running) {
      this.queued = true;
      return true;
    }
    this.running = true;
    void this.job()
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        if (this.queued) {
          this.queued = false;
          this.request();
        }
      });
    return true;
  }
}
