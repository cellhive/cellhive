/**
 * Collects ids announced one message at a time and hands them over in
 * batches: `delayMs` after the first id of a batch, or at once when the
 * batch reaches `max` ids. Used for `record.added` (one `POST …/records/query
 * { ids }` per batch, FRONTEND §5) and for row removals.
 */
export class IdBatcher {
  readonly #flush: (ids: readonly string[]) => void;
  readonly #delayMs: number;
  readonly #max: number;
  #ids = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(options: { flush: (ids: readonly string[]) => void; delayMs: number; max: number }) {
    this.#flush = options.flush;
    this.#delayMs = options.delayMs;
    this.#max = options.max;
  }

  get size(): number {
    return this.#ids.size;
  }

  add(ids: Iterable<string>): void {
    if (this.#disposed) return;
    for (const id of ids) {
      this.#ids.add(id);
      if (this.#ids.size >= this.#max) this.flush();
    }
    if (this.#ids.size > 0 && this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.flush();
      }, this.#delayMs);
    }
  }

  /** Drops ids not handed over yet (e.g. removed before they were fetched). */
  delete(ids: Iterable<string>): void {
    for (const id of ids) this.#ids.delete(id);
  }

  /** Forgets every id not handed over yet. */
  clear(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#ids.clear();
  }

  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#ids.size === 0 || this.#disposed) return;
    const ids = [...this.#ids];
    this.#ids = new Set();
    this.#flush(ids);
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#ids.clear();
  }
}
