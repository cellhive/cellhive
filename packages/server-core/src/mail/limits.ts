import { randomUUID } from 'node:crypto';

import { EmailSendError } from './smtp-errors.js';

/**
 * Email sending limits (BACKLOG "Quyết định S5" #8, T513, T541):
 * - `SendRateLimiter`: at most `SMTP_MAX_PER_SEC` messages within **any**
 *   sliding second per process, as the SMTP server sees them: a message
 *   holds its slot from the start of the SMTP transaction until one second
 *   after it ended (S5-review §4 #15 — counting only starts let a slow round
 *   followed by a fast one put 2 × the limit within one second);
 * - `MemorySendPacer` / `createValkeySendPacer`: the same sliding window per
 *   key, in the process or shared by every process through Valkey (constant
 *   Lua scripts) — the helper for Telegram (bucket per bot, T550);
 * - `EmailQuota`: at most N messages per clock hour per key, in Valkey —
 *   the organization (`EMAIL_MAX_PER_HOUR_PER_ORG`) and, through the same
 *   interface, a sender identity with its own SMTP (T530 hook). A message
 *   over the limit is not sent and waits for the next hour; callers give up
 *   after `EMAIL_QUOTA_MAX_WAIT_MS` (`email_quota_exceeded`). Valkey not
 *   connected yet (right after start; commands are not queued while
 *   offline) → wait up to {@link VALKEY_READY_TIMEOUT_MS}, then a temporary
 *   `smtp_temporary` error that callers retry (S5-review §4 #14).
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

// --- Sliding-window pacing -------------------------------------------------------------

/** A turn to send one message; give it back once the send ended (sent or failed). */
export interface SendSlot {
  /** Idempotent; never rejects. The send keeps counting for one window after this. */
  release(): Promise<void>;
}

/** At most `limit` sends per key within any sliding window. */
export interface SendPacer {
  /** Resolves when one more send may start for `key` (in call order within a process). */
  acquire(key: string): Promise<SendSlot>;
}

export interface SendPacerOptions {
  /** Sends per window (1 … 1 000 000). */
  readonly limit: number;
  /** Default 1 000 ms. */
  readonly windowMs?: number;
  /**
   * A slot never released stops counting after this (lost process, bug).
   * Default {@link SEND_SLOT_LEASE_MS}.
   */
  readonly leaseMs?: number;
  readonly clock?: Clock;
}

/** Longest a send may hold its slot without releasing it (SMTP timeouts are shorter). */
export const SEND_SLOT_LEASE_MS = 5 * 60_000;

function checkedPacerOptions(options: SendPacerOptions): {
  limit: number;
  windowMs: number;
  leaseMs: number;
  clock: Clock;
} {
  const windowMs = options.windowMs ?? 1000;
  const leaseMs = options.leaseMs ?? SEND_SLOT_LEASE_MS;
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000_000) {
    throw new RangeError('limit must be an integer in 1 … 1 000 000');
  }
  if (!Number.isInteger(windowMs) || windowMs < 1) {
    throw new RangeError('windowMs must be a positive integer');
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new RangeError('leaseMs must be a positive integer');
  }
  return { limit: options.limit, windowMs, leaseMs, clock: options.clock ?? systemClock };
}

interface Hold {
  /** When the hold stops counting: start + lease + window while sending, end + window after. */
  expiresAt: number;
}

interface WindowState {
  holds: Hold[];
  /** Tail of the FIFO of `acquire` calls. */
  queue: Promise<unknown>;
  /** Wakes the waiter at the head of the queue when a slot is released. */
  wake: (() => void) | null;
}

/**
 * Sliding window per key in this process. A send counts from the moment it
 * may start until one window after it released its slot, so any window of
 * that length — of starts as of arrivals at the server — holds at most
 * `limit` sends: every send arriving in a window was counted when the last
 * of them started. A burst of `limit` at once is allowed. Keys are few
 * (one per SMTP, per bot): their state is kept.
 */
export class MemorySendPacer implements SendPacer {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly leaseMs: number;
  private readonly clock: Clock;
  private readonly states = new Map<string, WindowState>();

  constructor(options: SendPacerOptions) {
    const checked = checkedPacerOptions(options);
    this.limit = checked.limit;
    this.windowMs = checked.windowMs;
    this.leaseMs = checked.leaseMs;
    this.clock = checked.clock;
  }

  acquire(key: string): Promise<SendSlot> {
    let state = this.states.get(key);
    if (state === undefined) {
      state = { holds: [], queue: Promise.resolve(), wake: null };
      this.states.set(key, state);
    }
    const current = state;
    const turn = current.queue.then(() => this.waitForSlot(current));
    current.queue = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(state: WindowState): Promise<SendSlot> {
    for (;;) {
      const now = this.clock.now();
      state.holds = state.holds.filter((hold) => hold.expiresAt > now);
      if (state.holds.length < this.limit) {
        const hold: Hold = { expiresAt: now + this.leaseMs + this.windowMs };
        state.holds.push(hold);
        let released = false;
        return {
          release: () => {
            if (!released) {
              released = true;
              hold.expiresAt = Math.min(hold.expiresAt, this.clock.now() + this.windowMs);
              state.wake?.();
            }
            return Promise.resolve();
          },
        };
      }
      const next = Math.min(...state.holds.map((hold) => hold.expiresAt));
      // Until the first hold expires — at most one window, since holds still
      // sending end long before their lease — or until a release.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (state.wake === finish) state.wake = null;
          resolve();
        };
        state.wake = finish;
        void this.clock.sleep(Math.min(next - now, this.windowMs)).then(finish);
      });
    }
  }
}

/**
 * The per-process `SMTP_MAX_PER_SEC` limiter of the mail service: one
 * sliding second over whole SMTP transactions (see {@link MemorySendPacer}).
 */
export class SendRateLimiter {
  private readonly pacer: MemorySendPacer;

  constructor(perSecond: number, clock: Clock = systemClock) {
    this.pacer = new MemorySendPacer({ limit: perSecond, windowMs: 1000, clock });
  }

  /** Resolves when one more message may start; release the slot when the send ended. */
  acquire(): Promise<SendSlot> {
    return this.pacer.acquire('smtp');
  }
}

// --- Valkey connection ----------------------------------------------------------------

/** How long a command waits for the Valkey connection (start, reconnect) before failing. */
export const VALKEY_READY_TIMEOUT_MS = 3_000;

/** The connection state of a Valkey client (ioredis): `status` and its `ready`/`end` events. */
export interface ValkeyConnection {
  readonly status: string;
  once(event: 'ready' | 'end', listener: () => void): unknown;
  removeListener(event: 'ready' | 'end', listener: () => void): unknown;
}

/**
 * Resolves once the client is `ready`: at once when it is, after the
 * connection in progress (start, reconnect) otherwise — the clients run
 * without an offline queue, so a command sent meanwhile fails with "Stream
 * isn't writeable". Rejects after `timeoutMs`, or when the client was
 * closed for good (`end`).
 */
export function valkeyReady(
  client: ValkeyConnection,
  timeoutMs: number = VALKEY_READY_TIMEOUT_MS,
): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  if (client.status === 'end') {
    return Promise.reject(new Error('The Valkey connection is closed.'));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      client.removeListener('ready', onReady);
      client.removeListener('end', onEnd);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('The Valkey connection is closed.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The Valkey connection is not ready.'));
    }, timeoutMs);
    client.once('ready', onReady);
    client.once('end', onEnd);
  });
}

/** The commands of a Valkey client (ioredis) the quota and the shared pacer use. */
export interface ValkeyScriptClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/** The part of a Valkey client (ioredis) the quota needs. */
export interface QuotaClient extends ValkeyScriptClient {
  /**
   * Resolves once commands can be sent ({@link valkeyReady}); without it
   * commands are sent at once.
   */
  ready?(): Promise<void>;
}

/**
 * The quota (and pacer) client of an ioredis connection: every command
 * first waits for the connection ({@link valkeyReady}).
 */
export function valkeyQuotaClient(
  client: ValkeyScriptClient & ValkeyConnection,
  readyTimeoutMs: number = VALKEY_READY_TIMEOUT_MS,
): QuotaClient {
  return {
    eval: (script, numKeys, ...args) => client.eval(script, numKeys, ...args),
    get: (key) => client.get(key),
    ready: () => valkeyReady(client, readyTimeoutMs),
  };
}

/** The shared pacer could not reach Valkey, or no slot became free within `maxWaitMs`. */
export class SendPacerUnavailableError extends Error {
  readonly reason: 'unavailable' | 'timeout';

  constructor(reason: 'unavailable' | 'timeout') {
    super(
      reason === 'timeout'
        ? 'No send slot became free in time.'
        : 'The send rate limit is not available right now.',
    );
    this.name = 'SendPacerUnavailableError';
    this.reason = reason;
  }
}

/**
 * Acquire: drops holds that stopped counting, then adds one while fewer than
 * the limit remain. Scores are the time a hold stops counting, on Valkey's
 * clock (every process agrees). Returns `{1, 0}` or `{0, ms until the first
 * hold stops counting}`. KEYS[1] bucket; ARGV: limit, window ms, lease ms,
 * member.
 */
const PACER_ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + lease + window, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], lease + window + 1000)
  return {1, 0}
end
local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, tonumber(first[2]) - now}
`;

/** Release: the hold counts until one window from now (never longer than before). ARGV: window ms, member. */
const PACER_RELEASE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
return redis.call('ZADD', KEYS[1], 'XX', 'LT', now + tonumber(ARGV[1]), ARGV[2])
`;

export interface ValkeySendPacerOptions extends SendPacerOptions {
  /** Distinguishes buckets (`telegram`). */
  readonly scope: string;
  /** Key prefix of the process (`ob:`). */
  readonly keyPrefix?: string;
  /** Give up waiting for a slot after this (default 60 s): {@link SendPacerUnavailableError}. */
  readonly maxWaitMs?: number;
}

/**
 * The sliding window of {@link MemorySendPacer} shared by every process
 * through Valkey (a sorted set per key, constant Lua scripts): for limits
 * of an external service per account — Telegram 25 messages per second per
 * bot (T550). While a key is full, callers poll at most every quarter
 * window; order between waiters is not guaranteed. Failures throw
 * {@link SendPacerUnavailableError}: callers treat them as temporary.
 * `clock` only paces the polling; the window runs on Valkey's clock.
 */
export function createValkeySendPacer(
  client: QuotaClient,
  options: ValkeySendPacerOptions,
): SendPacer {
  const { limit, windowMs, leaseMs, clock } = checkedPacerOptions(options);
  const prefix = options.keyPrefix ?? 'ob:';
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const keyOf = (key: string) => `${prefix}pace:${options.scope}:${key}`;
  const run = async (script: string, ...args: (string | number)[]): Promise<unknown> => {
    try {
      await client.ready?.();
      return await client.eval(script, 1, ...args);
    } catch {
      throw new SendPacerUnavailableError('unavailable');
    }
  };
  return {
    async acquire(key) {
      const bucket = keyOf(key);
      const member = randomUUID();
      const deadline = clock.now() + maxWaitMs;
      for (;;) {
        const result = await run(PACER_ACQUIRE_SCRIPT, bucket, limit, windowMs, leaseMs, member);
        const [allowed, waitMs] = Array.isArray(result) ? result.map(Number) : [0, windowMs];
        if (allowed === 1) {
          let released = false;
          return {
            release: async () => {
              if (released) return;
              released = true;
              // Best effort: a lost release only keeps the slot until its lease.
              await run(PACER_RELEASE_SCRIPT, bucket, windowMs, member).catch(() => undefined);
            },
          };
        }
        const remaining = deadline - clock.now();
        if (remaining <= 0) throw new SendPacerUnavailableError('timeout');
        const wait = Math.max(5, Math.min(waitMs ?? windowMs, Math.ceil(windowMs / 4)));
        await clock.sleep(Math.min(wait, remaining));
      }
    },
  };
}

// --- Hourly quota ----------------------------------------------------------------------

/** Give up waiting for the hourly quota after 24 hours (BACKLOG T513). */
export const EMAIL_QUOTA_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

export type QuotaDecision =
  | { readonly allowed: true; readonly used: number }
  | { readonly allowed: false; readonly used: number; readonly retryAt: Date };

/** Hourly message counter for one kind of key (organization or identity id). */
export interface EmailQuota {
  /** Counts one message for `key` if the hour still has room. */
  take(key: string, now?: Date): Promise<QuotaDecision>;
  /** Gives back the message counted by `take` at `at` (it was not sent). */
  release(key: string, at: Date): Promise<void>;
  /** Messages counted for `key` in the current hour. */
  used(key: string, now?: Date): Promise<{ used: number; resetsAt: Date }>;
}

const TAKE_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return {0, used} end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return {1, used}
`;

const RELEASE_SCRIPT = `
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then return redis.call('DECR', KEYS[1]) end
return 0
`;

export interface ValkeyEmailQuotaOptions {
  /** Messages per clock hour per key. */
  readonly limit: number;
  /** Distinguishes counters (`org`, `identity`). */
  readonly scope: string;
  /** Key prefix of the process (`ob:`). */
  readonly keyPrefix?: string;
}

function hourStart(at: Date): number {
  return Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;
}

/** Valkey is not reachable (yet): a temporary failure every caller retries. */
function quotaUnavailable(): EmailSendError {
  return new EmailSendError(
    'smtp_temporary',
    'The email limits cannot be checked right now; try again later.',
    { retryable: true, reason: 'temporary' },
  );
}

/**
 * Fixed clock-hour windows in Valkey; checking and counting is one atomic
 * script. Every command waits for the connection first (`client.ready`);
 * a connection that does not come up in time or a failed command throws
 * {@link quotaUnavailable} — never the client's own error.
 */
export function createValkeyEmailQuota(
  client: QuotaClient,
  options: ValkeyEmailQuotaOptions,
): EmailQuota {
  const prefix = options.keyPrefix ?? 'ob:';
  const keyOf = (key: string, at: Date) =>
    `${prefix}email:quota:${options.scope}:${key}:${String(hourStart(at) / HOUR_MS)}`;
  const command = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      await client.ready?.();
      return await run();
    } catch {
      throw quotaUnavailable();
    }
  };
  return {
    async take(key, now = new Date()) {
      const start = hourStart(now);
      // Keep the counter one minute past the hour (clock skew between processes).
      const ttlMs = start + HOUR_MS - now.getTime() + 60_000;
      const result = await command(() =>
        client.eval(TAKE_SCRIPT, 1, keyOf(key, now), options.limit, Math.max(1, ttlMs)),
      );
      const [allowed, used] = Array.isArray(result) ? result.map(Number) : [0, options.limit];
      return allowed === 1
        ? { allowed: true, used: used ?? 0 }
        : { allowed: false, used: used ?? options.limit, retryAt: new Date(start + HOUR_MS) };
    },
    async release(key, at) {
      await command(() => client.eval(RELEASE_SCRIPT, 1, keyOf(key, at)));
    },
    async used(key, now = new Date()) {
      const value = await command(() => client.get(keyOf(key, now)));
      return { used: Number(value ?? '0'), resetsAt: new Date(hourStart(now) + HOUR_MS) };
    },
  };
}
