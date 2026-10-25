/**
 * Refetch pacing of `dashboard.data_changed` (T811, SPEC §10.4 "debounce
 * 5 s"): the server already gathers record changes over 5 s per dashboard,
 * so the first hint of a quiet period refetches at once (a change shows in
 * ≤ ~5 s, not 10) and hints inside the next 5 s are gathered into one more
 * refetch when the window ends — at most one refetch per table and window.
 */
export const DATA_CHANGED_WINDOW_MS = 5_000;

export interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export class RefreshGate {
  private pending = new Set<string>();
  private timer: unknown = null;

  constructor(
    private readonly flush: (tableIds: ReadonlySet<string>) => void,
    private readonly windowMs = DATA_CHANGED_WINDOW_MS,
    private readonly timers: Timers = {
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) => {
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
  ) {}

  /** Tables of one hint. */
  push(tableIds: readonly string[]): void {
    if (this.timer === null) {
      // Leading edge: refetch now, then open the window.
      this.flush(new Set(tableIds));
      this.open();
      return;
    }
    for (const id of tableIds) this.pending.add(id);
  }

  dispose(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending = new Set();
  }

  private open(): void {
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (this.pending.size === 0) return;
      const tables = this.pending;
      this.pending = new Set();
      this.flush(tables);
      this.open();
    }, this.windowMs);
  }
}
