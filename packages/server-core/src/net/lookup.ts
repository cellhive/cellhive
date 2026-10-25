import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * Who a lookup is for: the limiter of system lookups caps the slots one
 * `key` (the organization) may hold ({@link limitHostLookup}).
 */
export interface HostLookupContext {
  readonly key?: string;
}

/** Resolves a host name to its addresses (all families, A + AAAA). */
export type HostLookup = (host: string, context?: HostLookupContext) => Promise<readonly string[]>;

/** The system resolver (`getaddrinfo`), every address in resolver order. */
export const systemHostLookup: HostLookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * System lookups of outbound HTTP calls one process runs at once (QA S5c).
 * `getaddrinfo` runs on the libuv threadpool (4 threads by default) and
 * keeps its thread until the system resolver gives up — often longer than
 * our 5 s timeout. Without a cap, a destination whose name server never
 * answers fills the pool: every other lookup of the worker (other
 * organizations' deliveries, the PostgreSQL and Valkey host names when a
 * connection is opened again) and file/zlib work would wait behind it.
 */
export const MAX_CONCURRENT_SYSTEM_LOOKUPS = 2;

/**
 * Slots of {@link MAX_CONCURRENT_SYSTEM_LOOKUPS} one organization may hold,
 * hung lookups included: a name server that never answers ties up at most
 * this many threads of the process, so the other organizations always keep
 * a slot (review fix: one organization calling such a host held both slots
 * and every other organization's lookup timed out in the queue).
 */
export const MAX_SYSTEM_LOOKUPS_PER_ORG = 1;

/**
 * Longest wait for a slot of the system resolver. Shorter than the lookup
 * timeout of `resolveOutboundTarget` (5 s), so a call that waited too long
 * always ends with {@link LOOKUP_QUEUE_TIMEOUT} — a wait the outbox gives
 * back without counting an attempt — and never with the target's timeout.
 */
export const SYSTEM_LOOKUP_QUEUE_WAIT_MS = 2_000;

/** `code` of the error of a call that waited longer than `maxWaitMs` for a slot. */
export const LOOKUP_QUEUE_TIMEOUT = 'ELOOKUPQUEUE';

/**
 * A lookup that never ran: it waited too long for a slot of the process.
 * Not the destination's fault — the outbox tries again later without
 * counting an attempt.
 */
export class LookupQueueTimeoutError extends Error {
  readonly code = LOOKUP_QUEUE_TIMEOUT;

  constructor() {
    super('lookup queue timeout');
    this.name = 'LookupQueueTimeoutError';
  }
}

/** Whether `error` is a {@link LookupQueueTimeoutError} (or carries its code). */
export function isLookupQueueTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === LOOKUP_QUEUE_TIMEOUT
  );
}

/**
 * `lookup` with at most `max` calls running at once, and at most
 * `maxPerKey` of them for one `context.key` (calls without a key only count
 * against `max`). Later calls wait their turn in arrival order — a waiter
 * whose key is at its cap lets the next ones pass — at most `maxWaitMs`
 * (then they leave the queue and reject with a
 * {@link LookupQueueTimeoutError}, so a flood never builds a backlog). A
 * slot is freed when the underlying call settles — not when a caller stops
 * waiting (`withTimeout`): a hung lookup keeps its slot, so it can never
 * take more than `max` threads, nor one key more than `maxPerKey`.
 */
export function limitHostLookup(
  lookup: HostLookup,
  max: number,
  maxWaitMs = Number.POSITIVE_INFINITY,
  maxPerKey = Number.POSITIVE_INFINITY,
): HostLookup {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
  if (maxPerKey !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxPerKey) || maxPerKey < 1)) {
    throw new RangeError('maxPerKey must be a positive integer');
  }
  let running = 0;
  const held = new Map<string, number>();
  const waiting: { readonly key: string | undefined; readonly go: () => void }[] = [];
  const canRun = (key: string | undefined) =>
    running < max && (key === undefined || (held.get(key) ?? 0) < maxPerKey);
  const take = (key: string | undefined) => {
    running += 1;
    if (key !== undefined) held.set(key, (held.get(key) ?? 0) + 1);
  };
  // A freed slot goes straight to the first waiter that may run (taken before
  // it resumes), so no newcomer can slip in and run more than `max` lookups.
  const release = (key: string | undefined) => {
    running -= 1;
    if (key !== undefined) {
      const left = (held.get(key) ?? 1) - 1;
      if (left === 0) held.delete(key);
      else held.set(key, left);
    }
    for (let index = 0; index < waiting.length && running < max;) {
      const waiter = waiting[index];
      if (waiter !== undefined && canRun(waiter.key)) {
        waiting.splice(index, 1);
        take(waiter.key);
        waiter.go();
      } else {
        index += 1;
      }
    }
  };
  const turn = (key: string | undefined) =>
    new Promise<void>((resolve, reject) => {
      const waiter = {
        key,
        go: () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        },
      };
      const timer = Number.isFinite(maxWaitMs)
        ? setTimeout(() => {
            const index = waiting.indexOf(waiter);
            if (index !== -1) waiting.splice(index, 1);
            reject(new LookupQueueTimeoutError());
          }, maxWaitMs)
        : undefined;
      waiting.push(waiter);
    });
  return async (host, context) => {
    const key = context?.key;
    if (canRun(key)) take(key);
    else await turn(key);
    try {
      return await lookup(host);
    } finally {
      release(key);
    }
  };
}

/**
 * The system resolver of outbound HTTP calls: at most
 * {@link MAX_CONCURRENT_SYSTEM_LOOKUPS} at once, {@link MAX_SYSTEM_LOOKUPS_PER_ORG}
 * per organization (`context.key`), a slot waited for at most
 * {@link SYSTEM_LOOKUP_QUEUE_WAIT_MS}.
 */
export function createSystemLookupLimiter(lookup: HostLookup = systemHostLookup): HostLookup {
  return limitHostLookup(
    lookup,
    MAX_CONCURRENT_SYSTEM_LOOKUPS,
    SYSTEM_LOOKUP_QUEUE_WAIT_MS,
    MAX_SYSTEM_LOOKUPS_PER_ORG,
  );
}

/** The limited system resolver of this process ({@link createSystemLookupLimiter}). */
export const limitedSystemHostLookup: HostLookup = createSystemLookupLimiter();

/** Rejects with `onTimeout()` when `promise` has not settled after `ms`. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(onTimeout());
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
