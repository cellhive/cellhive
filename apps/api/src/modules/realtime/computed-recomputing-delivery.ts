import { tableChannel } from '@cellhive/contracts';

import type { DeliveryStrategy } from './delivery.js';
import type { BaseAccess } from '../../common/access/access.service.js';
import type { ComputedRecomputingEnvelope } from '@cellhive/server-core';

/** The field is readable (not `no_perm`) in a table the subscriber sees. */
function fieldReadable(base: BaseAccess | null, envelope: ComputedRecomputingEnvelope): boolean {
  if (base === null) return false;
  const table = base.access.tables[envelope.table_id];
  if (table === undefined || (table.perm as string) === 'no_perm') return false;
  const perm: string | undefined = table.fields[envelope.field_id];
  return perm !== undefined && perm !== 'no_perm';
}

/**
 * `computed.recomputing` (CONTRACTS §7, T459): progress of the backfill or
 * recompute job of a stored formula/lookup field, to `table:` subscribers
 * who read the field (a `locked` field still shows its header progress;
 * a `no_perm` field or a hidden table is never named).
 */
export const computedRecomputingDelivery: DeliveryStrategy<ComputedRecomputingEnvelope> = {
  type: 'computed.recomputing',
  channels(envelope) {
    return [tableChannel(envelope.table_id)];
  },
  deliver(envelope, subscribers) {
    return subscribers
      .filter((subscriber) => fieldReadable(subscriber.base, envelope))
      .map((subscriber) => ({
        subscriber,
        message: {
          type: 'computed.recomputing',
          channel: subscriber.channel,
          field_id: envelope.field_id,
          progress: envelope.progress,
          status: envelope.status,
        },
      }));
  },
};
