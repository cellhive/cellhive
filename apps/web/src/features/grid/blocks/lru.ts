/**
 * Recency order of cached blocks (FRONTEND §3.3: at most 30 per grid). Only
 * bookkeeping: the caller drops the evicted blocks from the query cache.
 */
export class LruOrder<K> {
  // Map iteration order is insertion order: first = least recently used.
  readonly #order = new Map<K, true>();

  get size(): number {
    return this.#order.size;
  }

  has(key: K): boolean {
    return this.#order.has(key);
  }

  /** Marks `key` as the most recently used. */
  touch(key: K): void {
    this.#order.delete(key);
    this.#order.set(key, true);
  }

  delete(key: K): void {
    this.#order.delete(key);
  }

  keys(): K[] {
    return [...this.#order.keys()];
  }

  /**
   * Least recently used keys to drop so that at most `max` remain, never
   * one in `keep` (blocks on screen); they are removed from the order.
   */
  evict(max: number, keep: ReadonlySet<K> = new Set()): K[] {
    const evicted: K[] = [];
    let excess = this.#order.size - max;
    for (const key of this.#order.keys()) {
      if (excess <= 0) break;
      if (keep.has(key)) continue;
      evicted.push(key);
      excess -= 1;
    }
    for (const key of evicted) this.#order.delete(key);
    return evicted;
  }
}
