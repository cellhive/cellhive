import { randomUUID } from 'node:crypto';

import type { QuotaClient } from '../mail/limits.js';
import type { Id } from '@cellhive/contracts';

/**
 * Pacing of outbound HTTP calls per destination (ADR-35 §4, S5b-review
 * §11 #2; BACKLOG T600), shared by every worker through Valkey with
 * constant Lua scripts — the Valkey client helper of `mail/limits.ts`
 * (`QuotaClient`: wait for the connection, then `EVAL`), as the Telegram
 * pacers (T550). Three limits, checked atomically in one script:
 *
 * 1. a **pause** per (organization, host), set from a `Retry-After` of a
 *    `429`/`503` (at most one hour): no call to that host until then;
 * 2. at most **2 calls in flight** per organization (a semaphore whose
 *    slots expire after a lease, should a worker die mid-call), so one
 *    organization with a slow destination does not take every worker;
 * 3. a **token bucket** per (organization, host): 10 calls per second,
 *    bursts of 20 — over any span of `t` seconds at most `20 + 10 t` calls.
 *
 * `acquire` never sleeps: it answers "go" with a lease, or "wait until …"
 * so the job reschedules itself (`run_at`) without holding a worker or a
 * database connection. Valkey unreachable → "wait" with reason
 * `unavailable` (the caller retries later without counting an attempt).
 */

/** CONTRACTS §25.6. */
export const HOST_PACER_RATE_PER_SEC = 10;
export const HOST_PACER_BURST = 20;
export const HOST_PACER_MAX_IN_FLIGHT_PER_ORG = 2;
/** A slot never released frees itself after this (longer than one call, 10 s). */
export const HOST_PACER_LEASE_MS = 30_000;
/** Longest pause a `Retry-After` may set. */
export const HOST_PACER_MAX_PAUSE_MS = 60 * 60 * 1000;
/** How long to wait when Valkey cannot be reached. */
const UNAVAILABLE_RETRY_MS = 5_000;
/** Longest wait answered while the semaphore is full (a slot usually frees sooner). */
const IN_FLIGHT_RETRY_MS = 1_000;

export interface HostPacerTarget {
  readonly organizationId: Id<'org'>;
  /** `OutboundUrl.host` (ASCII lower case). */
  readonly host: string;
}

/** A call may start; release the slot once it ended (whatever the outcome). */
export interface HostPacerLease {
  /** Idempotent; never rejects. */
  release(): Promise<void>;
}

export type HostPacerDecision =
  | { readonly ok: true; readonly lease: HostPacerLease }
  | {
      readonly ok: false;
      readonly reason: 'paused' | 'in_flight' | 'rate' | 'unavailable';
      /** Try again at this time (Valkey's clock, or the local one when unavailable). */
      readonly waitUntil: Date;
    };

export interface HostPacer {
  acquire(target: HostPacerTarget): Promise<HostPacerDecision>;
  /**
   * Pauses calls to the host until `until` (clamped to one hour from now);
   * never shortens a longer pause. Best effort: failures are swallowed.
   */
  pause(target: HostPacerTarget, until: Date): Promise<void>;
}

/**
 * KEYS: pause, bucket, in-flight set. ARGV: rate/s, burst, max in flight,
 * lease ms, member, in-flight retry ms. Returns `{1, 0}` (go, slot taken)
 * or `{0, wait-until ms, reason}` with reason 1 = paused, 2 = in flight,
 * 3 = rate. Times are Valkey's (`TIME`) so every worker agrees.
 */
const ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local paused = tonumber(redis.call('GET', KEYS[1]) or '0')
if paused > now then return {0, paused, 1} end
local lease = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[3]) then
  local first = redis.call('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')
  return {0, math.min(tonumber(first[2]), now + tonumber(ARGV[6])), 2}
end
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local state = redis.call('HMGET', KEYS[2], 'tokens', 'at')
local tokens = tonumber(state[1]) or burst
local at = tonumber(state[2]) or now
if now > at then tokens = math.min(burst, tokens + (now - at) * rate / 1000) end
if tokens < 1 then
  return {0, now + math.ceil((1 - tokens) * 1000 / rate), 3}
end
redis.call('HSET', KEYS[2], 'tokens', tostring(tokens - 1), 'at', tostring(math.max(now, at)))
redis.call('PEXPIRE', KEYS[2], math.ceil(burst * 1000 / rate) + 1000)
redis.call('ZADD', KEYS[3], now + lease, ARGV[5])
redis.call('PEXPIRE', KEYS[3], lease + 1000)
return {1, 0}
`;

/** KEYS[1] in-flight set; ARGV[1] member. */
const RELEASE_SCRIPT = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

/**
 * KEYS[1] pause; ARGV: until ms, max pause ms. Keeps the later of the two
 * pauses; the key expires with the pause.
 */
const PAUSE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local untilMs = math.min(tonumber(ARGV[1]), now + tonumber(ARGV[2]))
if untilMs <= now then return 0 end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= untilMs then return 0 end
redis.call('SET', KEYS[1], tostring(untilMs), 'PX', untilMs - now)
return 1
`;

export interface ValkeyHostPacerOptions {
  /** Key prefix of the process (`ob:`). */
  readonly keyPrefix?: string;
  readonly ratePerSec?: number;
  readonly burst?: number;
  readonly maxInFlightPerOrg?: number;
  readonly leaseMs?: number;
  /** Local clock, only for the "unavailable" answer. */
  readonly now?: () => number;
}

export function createValkeyHostPacer(
  client: QuotaClient,
  options: ValkeyHostPacerOptions = {},
): HostPacer {
  const prefix = options.keyPrefix ?? 'ob:';
  const rate = options.ratePerSec ?? HOST_PACER_RATE_PER_SEC;
  const burst = options.burst ?? HOST_PACER_BURST;
  const maxInFlight = options.maxInFlightPerOrg ?? HOST_PACER_MAX_IN_FLIGHT_PER_ORG;
  const leaseMs = options.leaseMs ?? HOST_PACER_LEASE_MS;
  const now = options.now ?? Date.now;
  for (const [name, value] of [
    ['ratePerSec', rate],
    ['burst', burst],
    ['maxInFlightPerOrg', maxInFlight],
    ['leaseMs', leaseMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  // The host is ASCII (punycode) without `:`, so the keys cannot collide.
  const pauseKey = (t: HostPacerTarget) => `${prefix}http:pause:${t.organizationId}:${t.host}`;
  const bucketKey = (t: HostPacerTarget) => `${prefix}http:bucket:${t.organizationId}:${t.host}`;
  const inFlightKey = (t: HostPacerTarget) => `${prefix}http:inflight:${t.organizationId}`;
  const run = async (script: string, numKeys: number, ...args: (string | number)[]) => {
    await client.ready?.();
    return client.eval(script, numKeys, ...args);
  };

  return {
    async acquire(target) {
      const member = randomUUID();
      let result: unknown;
      try {
        result = await run(
          ACQUIRE_SCRIPT,
          3,
          pauseKey(target),
          bucketKey(target),
          inFlightKey(target),
          rate,
          burst,
          maxInFlight,
          leaseMs,
          member,
          IN_FLIGHT_RETRY_MS,
        );
      } catch {
        return {
          ok: false,
          reason: 'unavailable',
          waitUntil: new Date(now() + UNAVAILABLE_RETRY_MS),
        };
      }
      const [go, until, reason] = Array.isArray(result) ? result.map(Number) : [0, 0, 0];
      if (go === 1) {
        let released = false;
        return {
          ok: true,
          lease: {
            release: async () => {
              if (released) return;
              released = true;
              // Best effort: a lost release only keeps the slot until its lease.
              await run(RELEASE_SCRIPT, 1, inFlightKey(target), member).catch(() => undefined);
            },
          },
        };
      }
      return {
        ok: false,
        reason: reason === 1 ? 'paused' : reason === 2 ? 'in_flight' : 'rate',
        waitUntil: new Date(until ?? now() + IN_FLIGHT_RETRY_MS),
      };
    },
    async pause(target, until) {
      await run(PAUSE_SCRIPT, 1, pauseKey(target), until.getTime(), HOST_PACER_MAX_PAUSE_MS).catch(
        () => undefined,
      );
    },
  };
}
