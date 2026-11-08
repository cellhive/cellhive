import { randomUUID } from 'node:crypto';

import type { QuotaClient } from '../mail/limits.js';

/**
 * Concurrent calls in flight per key, shared by every process through
 * Valkey (the pattern of `createValkeyHostPacer`: constant Lua scripts,
 * times from Valkey's `TIME`). One acquire names several counters
 * — e.g. "this person" and "this organization" — and takes a slot in every
 * one of them atomically, or in none. A slot is a member of a sorted set
 * scored by when its lease ends, so a process that dies mid-call frees it
 * after the lease; a release removes it at once.
 *
 * `acquire` never waits: it answers "go" with a lease, "full" with the
 * counter that refused, or "unavailable" when Valkey cannot be reached
 * (callers fail closed).
 */

/** One counter: its key (without the prefix) and how many slots it has. */
export interface CallSlot {
  readonly key: string;
  readonly limit: number;
}

/** The slots taken; release them once the work ended (whatever the outcome). */
export interface CallSlotLease {
  /** Idempotent; never rejects. */
  release(): Promise<void>;
}

export type CallSlotDecision =
  | { readonly ok: true; readonly lease: CallSlotLease }
  /** `index`: the position of the full counter in the list given to `acquire`. */
  | { readonly ok: false; readonly reason: 'full'; readonly index: number }
  | { readonly ok: false; readonly reason: 'unavailable' };

export interface CallSlots {
  acquire(slots: readonly CallSlot[]): Promise<CallSlotDecision>;
}

/**
 * KEYS: the sorted sets. ARGV: lease ms, member, then the limit of each key.
 * Returns `{1, 0}` (every slot taken) or `{0, i}` (key `i`, 1-based, full).
 */
const ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local lease = tonumber(ARGV[1])
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i + 2]) then return {0, i} end
end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], now + lease, ARGV[2])
  redis.call('PEXPIRE', KEYS[i], lease + 1000)
end
return {1, 0}
`;

/** KEYS: the sorted sets; ARGV[1] member. */
const RELEASE_SCRIPT = `
for i = 1, #KEYS do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1
`;

export interface ValkeyCallSlotsOptions {
  /** Key prefix of the process (`ob:`). */
  readonly keyPrefix?: string;
  /** A slot never released frees itself after this. */
  readonly leaseMs: number;
}

export function createValkeyCallSlots(
  client: QuotaClient,
  options: ValkeyCallSlotsOptions,
): CallSlots {
  const prefix = options.keyPrefix ?? 'ob:';
  const { leaseMs } = options;
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new RangeError('leaseMs must be a positive integer');
  }
  const run = async (script: string, keys: readonly string[], ...args: (string | number)[]) => {
    await client.ready?.();
    return client.eval(script, keys.length, ...keys, ...args);
  };

  return {
    async acquire(slots) {
      if (slots.length === 0) throw new RangeError('acquire needs at least one slot');
      for (const slot of slots) {
        if (!Number.isInteger(slot.limit) || slot.limit < 1) {
          throw new RangeError('a slot limit must be a positive integer');
        }
      }
      const keys = slots.map((slot) => `${prefix}${slot.key}`);
      const member = randomUUID();
      let result: unknown;
      try {
        result = await run(
          ACQUIRE_SCRIPT,
          keys,
          leaseMs,
          member,
          ...slots.map((slot) => slot.limit),
        );
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      const [go, full] = Array.isArray(result) ? result.map(Number) : [0, 0];
      if (go !== 1) {
        if (full === undefined || full < 1) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'full', index: full - 1 };
      }
      let released = false;
      return {
        ok: true,
        lease: {
          release: async () => {
            if (released) return;
            released = true;
            // Best effort: a lost release only keeps the slots until their lease.
            await run(RELEASE_SCRIPT, keys, member).catch(() => undefined);
          },
        },
      };
    },
  };
}
