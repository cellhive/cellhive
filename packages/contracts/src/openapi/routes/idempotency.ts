import { z } from 'zod';

import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '../../records.js';

/** Description of `Idempotency-Key` on a write `POST` (CONTRACTS §1.1). */
export const IDEMPOTENCY_NOTE =
  'With an `Idempotency-Key` header the response is stored for 24 hours per user: sending the ' +
  'same key again returns the stored response (header `Idempotent-Replayed: true`); the same ' +
  'key with another request, or while the first request is still running, is ' +
  '`409 IDEMPOTENCY_KEY_REUSED`. Failed requests are not stored; a request that left its key ' +
  'in progress for more than 60 seconds is considered dead and the key can be reused.';

/** The optional `Idempotency-Key` request header. */
export const idempotencyHeaders = z.object({
  [IDEMPOTENCY_KEY_HEADER]: idempotencyKeySchema.optional(),
});

/** `409` description with `IDEMPOTENCY_KEY_REUSED` added to the route's own conflicts. */
export function withIdempotencyConflict(existing: string | undefined): string {
  return existing === undefined
    ? '`IDEMPOTENCY_KEY_REUSED`'
    : `${existing}; or \`IDEMPOTENCY_KEY_REUSED\``;
}
