import { createHash, randomUUID } from 'node:crypto';

import {
  WIDGET_CACHE_LOCK_MS,
  WIDGET_CACHE_MAX_BYTES,
  WIDGET_CACHE_TTL_JITTER,
  WIDGET_CACHE_TTL_MS,
  WIDGET_CACHE_WAIT_MS,
} from '@cellhive/contracts';

/**
 * Cache of dashboard widget results (SPEC §10.4, CONTRACTS §28.5, BACKLOG
 * T807, "Quyết định S7" #8). The key is
 *
 * ```text
 * dash:<widget>:<sha256(effective query)>:<sha256(permission fingerprint)>:<data_version…>
 * ```
 *
 * - effective query: the planned widget query, the realtime filters, the
 *   zones, the viewer's locale (link titles), the day it runs (date buckets
 *   and KPI periods), a stamp of the
 *   schema of the tables it reads, and {@link WIDGET_QUERY_BUILDER_VERSION};
 * - permission fingerprint: the viewer's permissions on those tables with
 *   the variables of their read rules replaced
 *   (`permissionFingerprintMaterial` of `@cellhive/permissions`) — two
 *   readers share an entry only when they read exactly the same records and
 *   fields; a reader whose fingerprint cannot be computed is never cached
 *   (fail closed: `null` key);
 * - `data_version` of every table the widget reads (source, link targets,
 *   tables behind lookups), so a write is never answered with an older
 *   number and no entry has to be deleted.
 *
 * The key holds hashes, ids and version numbers only — no user id in clear
 * and no value. Entries hold the aggregate result only (never raw records:
 * `records` widgets get no key — their button cells depend on the viewer's
 * edit rights and on automation state, which the key does not hold),
 * `WIDGET_CACHE_TTL_MS` ± 10 % (cleanup only), at most
 * `WIDGET_CACHE_MAX_BYTES`.
 *
 * Cold entries are computed once (cache stampede): the first request takes
 * `dashlock:<key>` (`SET NX PX`), others wait up to `WIDGET_CACHE_WAIT_MS`
 * for the entry, then compute it themselves; requests of one process for
 * the same key share one computation. Valkey failing never fails a widget:
 * the result is computed without the cache (`bypass`).
 */

/**
 * Version of the widget query builder: bump it when the numbers of one query
 * would change. 2: live filters (T808), results carry `ignored`.
 */
export const WIDGET_QUERY_BUILDER_VERSION = 2;

/** Prefix of cache entries (inside the instance-wide Valkey prefix). */
export const WIDGET_CACHE_PREFIX = 'dash:';
/** Prefix of the locks of cold entries. */
export const WIDGET_LOCK_PREFIX = 'dashlock:';

const ENTRY_VERSION = 1;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** JSON with object keys sorted at every level (same value → same text). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) {
      sorted[key] = (item as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

export interface WidgetCacheKeyParts {
  readonly widgetId: string;
  /** Everything the numbers depend on besides permissions and data (hashed). */
  readonly effectiveQuery: unknown;
  /** `permissionFingerprintMaterial` of the viewer (hashed). */
  readonly permissionMaterial: string;
  /** `data_version` of each table read, in a fixed table order. */
  readonly dataVersions: readonly (bigint | number | string)[];
}

/** The cache key of a widget result (without the instance-wide prefix). */
export function widgetCacheKey(parts: WidgetCacheKeyParts): string {
  return [
    `${WIDGET_CACHE_PREFIX}${parts.widgetId}`,
    sha256(stableJson({ builder: WIDGET_QUERY_BUILDER_VERSION, query: parts.effectiveQuery })),
    sha256(parts.permissionMaterial),
    parts.dataVersions.map(String).join('.'),
  ].join(':');
}

/** Valkey commands the cache needs; the api adapts its client (fails fast when down). */
export interface WidgetCacheStore {
  get(key: string): Promise<string | null>;
  /** `SET key value PX ttlMs`. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** `SET key token PX ttlMs NX`: whether the lock was taken. */
  lock(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Deletes the lock when it still holds `token`. */
  unlock(key: string, token: string): Promise<void>;
}

export type WidgetCacheOutcome = 'hit' | 'miss' | 'bypass';

/** Metrics and logs of the cache (`dashboard_cache_total`, `dashboard_cache_coalesced_total`). */
export interface WidgetCacheObserver {
  outcome(result: WidgetCacheOutcome): void;
  /** A request answered by the computation of another one. */
  coalesced(): void;
  /** A Valkey command failed (the request goes on without the cache). */
  error(error: unknown, operation: 'get' | 'set' | 'lock' | 'unlock'): void;
}

export interface WidgetCacheOptions {
  readonly ttlMs?: number;
  readonly ttlJitter?: number;
  readonly maxBytes?: number;
  readonly lockMs?: number;
  readonly waitMs?: number;
  /** Interval of the reads of a waiting request. */
  readonly pollMs?: number;
  readonly random?: () => number;
  readonly now?: () => Date;
}

/** A widget result and where it came from. */
export interface CachedWidgetResult<T> {
  readonly value: T;
  /** ISO time of the computation (a hit keeps the time of the entry). */
  readonly computedAt: string;
  readonly cache: 'hit' | 'miss';
}

interface Entry<T> {
  readonly v: number;
  readonly computed_at: string;
  readonly value: T;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export class WidgetResultCache<T> {
  readonly #store: WidgetCacheStore;
  readonly #observer: WidgetCacheObserver;
  readonly #ttlMs: number;
  readonly #jitter: number;
  readonly #maxBytes: number;
  readonly #lockMs: number;
  readonly #waitMs: number;
  readonly #pollMs: number;
  readonly #random: () => number;
  readonly #now: () => Date;
  readonly #inflight = new Map<string, Promise<CachedWidgetResult<T>>>();

  constructor(
    store: WidgetCacheStore,
    observer: WidgetCacheObserver,
    options: WidgetCacheOptions = {},
  ) {
    this.#store = store;
    this.#observer = observer;
    this.#ttlMs = options.ttlMs ?? WIDGET_CACHE_TTL_MS;
    this.#jitter = options.ttlJitter ?? WIDGET_CACHE_TTL_JITTER;
    this.#maxBytes = options.maxBytes ?? WIDGET_CACHE_MAX_BYTES;
    this.#lockMs = options.lockMs ?? WIDGET_CACHE_LOCK_MS;
    this.#waitMs = options.waitMs ?? WIDGET_CACHE_WAIT_MS;
    this.#pollMs = options.pollMs ?? 50;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => new Date());
  }

  /** Requests of this process computing a key now (tests). */
  get inflight(): number {
    return this.#inflight.size;
  }

  /**
   * The cached result of `key`, else `compute()` stored under it. `key =
   * null` (no fingerprint): computed, never cached (`bypass`). `compute`
   * errors are thrown and never cached.
   */
  async read(key: string | null, compute: () => Promise<T>): Promise<CachedWidgetResult<T>> {
    if (key === null) {
      this.#observer.outcome('bypass');
      return this.fresh(await compute());
    }
    const running = this.#inflight.get(key);
    if (running !== undefined) {
      const shared = await running;
      this.#observer.coalesced();
      this.#observer.outcome('hit');
      return { ...shared, cache: 'hit' };
    }
    const promise = this.load(key, compute);
    this.#inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.#inflight.get(key) === promise) this.#inflight.delete(key);
    }
  }

  private async load(key: string, compute: () => Promise<T>): Promise<CachedWidgetResult<T>> {
    let text: string | null;
    try {
      text = await this.#store.get(key);
    } catch (error) {
      return this.bypass(error, 'get', compute);
    }
    const cached = this.decode(text);
    if (cached !== undefined) {
      this.#observer.outcome('hit');
      return cached;
    }
    const lockKey = `${WIDGET_LOCK_PREFIX}${key}`;
    const token = randomUUID();
    let locked: boolean;
    try {
      locked = await this.#store.lock(lockKey, token, this.#lockMs);
    } catch (error) {
      return this.bypass(error, 'lock', compute);
    }
    if (!locked) {
      // Another request computes it: read again for a while, then compute.
      const waited = await this.waitFor(key);
      if (waited !== undefined) {
        this.#observer.coalesced();
        this.#observer.outcome('hit');
        return waited;
      }
    }
    this.#observer.outcome('miss');
    try {
      const result = this.fresh(await compute());
      await this.store(key, result);
      return result;
    } finally {
      if (locked) {
        await this.#store.unlock(lockKey, token).catch((error: unknown) => {
          this.#observer.error(error, 'unlock');
        });
      }
    }
  }

  private async bypass(
    error: unknown,
    operation: 'get' | 'lock',
    compute: () => Promise<T>,
  ): Promise<CachedWidgetResult<T>> {
    this.#observer.error(error, operation);
    this.#observer.outcome('bypass');
    return this.fresh(await compute());
  }

  private fresh(value: T): CachedWidgetResult<T> {
    return { value, computedAt: this.#now().toISOString(), cache: 'miss' };
  }

  private async store(key: string, result: CachedWidgetResult<T>): Promise<void> {
    const entry: Entry<T> = {
      v: ENTRY_VERSION,
      computed_at: result.computedAt,
      value: result.value,
    };
    const text = JSON.stringify(entry);
    if (Buffer.byteLength(text, 'utf8') > this.#maxBytes) return;
    const ttl = Math.round(this.#ttlMs * (1 - this.#jitter + 2 * this.#jitter * this.#random()));
    try {
      await this.#store.set(key, text, Math.max(1, ttl));
    } catch (error) {
      this.#observer.error(error, 'set');
    }
  }

  private decode(text: string | null): CachedWidgetResult<T> | undefined {
    if (text === null) return undefined;
    try {
      const entry = JSON.parse(text) as Partial<Entry<T>>;
      if (entry.v !== ENTRY_VERSION || typeof entry.computed_at !== 'string') return undefined;
      return { value: entry.value as T, computedAt: entry.computed_at, cache: 'hit' };
    } catch {
      return undefined;
    }
  }

  private async waitFor(key: string): Promise<CachedWidgetResult<T> | undefined> {
    const deadline = Date.now() + this.#waitMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(this.#pollMs, Math.max(1, deadline - Date.now())));
      let text: string | null;
      try {
        text = await this.#store.get(key);
      } catch (error) {
        this.#observer.error(error, 'get');
        return undefined;
      }
      const cached = this.decode(text);
      if (cached !== undefined) return cached;
    }
    return undefined;
  }
}
