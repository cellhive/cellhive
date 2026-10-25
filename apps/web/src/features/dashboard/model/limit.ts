/**
 * At most `max` tasks at once, the rest wait in order (T811: widget data
 * requests, at most 4 in parallel per client — the server's per-user queue
 * is 4 too, CONTRACTS §28.3). A task whose signal aborts while waiting
 * leaves the queue without running.
 */
export class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  get active(): number {
    return this.running;
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.running < this.max) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', abort);
        this.running += 1;
        resolve();
      };
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException('Aborted', 'AbortError'),
        );
      };
      if (signal?.aborted === true) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(start);
    });
  }

  private release(): void {
    this.running -= 1;
    const next = this.waiting.shift();
    next?.();
  }
}

/** Widget data requests in flight per tab. */
export const MAX_PARALLEL_WIDGET_REQUESTS = 4;
export const widgetRequests = new Limiter(MAX_PARALLEL_WIDGET_REQUESTS);
