import { deliveryErrorOf } from './deliver.js';

import type { HttpDeliveryRow } from '../db/schema.js';
import type { HostPacer } from '../net/host-pacer.js';
import type { HttpDeliverySummary } from '@cellhive/contracts';

/**
 * `delivery` of an HTTP step in the run detail (CONTRACTS §21, §25.5):
 * host, attempts, status, last HTTP status and error, next attempt — never
 * the URL, headers, bodies or secret values (the row's `request_enc` and
 * `response` are not read).
 */
export function httpDeliverySummaryOf(row: HttpDeliveryRow): HttpDeliverySummary {
  const pending = row.status === 'pending' || row.status === 'sending';
  return {
    id: row.id,
    target_host: row.target_host,
    attempts: row.attempts,
    status: row.status,
    last_status: row.last_status,
    last_error: deliveryErrorOf(row.last_error),
    next_attempt_at: pending ? row.next_attempt_at.toISOString() : null,
  };
}

/**
 * A pacer that never makes anyone wait — the default of test task lists
 * only; the worker always passes the Valkey pacer shared by every process
 * (`createValkeyHostPacer`).
 */
export const unpacedHostPacer: HostPacer = {
  acquire: () => Promise.resolve({ ok: true, lease: { release: () => Promise.resolve() } }),
  pause: () => Promise.resolve(),
};
