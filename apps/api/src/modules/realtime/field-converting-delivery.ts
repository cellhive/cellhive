import { baseChannel, tableChannel } from '@cellhive/contracts';

import type { DeliveryStrategy } from './delivery.js';
import type { BaseAccess } from '../../common/access/access.service.js';
import type { FieldConvertingEnvelope } from '@cellhive/server-core';

function fieldVisible(base: BaseAccess | null, envelope: FieldConvertingEnvelope): boolean {
  if (base === null) return false;
  if (base.access.is_admin) return true;
  const fields = base.access.tables[envelope.table_id]?.fields;
  return fields !== undefined && Object.hasOwn(fields, envelope.field_id);
}

/**
 * `field.converting` (CONTRACTS §7, T403): progress of a field type
 * conversion for everyone with the base open — subscribers of `table:` and
 * `base:` who see the field now (never a `no_perm` field or a hidden table).
 */
export const fieldConvertingDelivery: DeliveryStrategy<FieldConvertingEnvelope> = {
  type: 'field.converting',
  channels(envelope) {
    return [tableChannel(envelope.table_id), baseChannel(envelope.base_id)];
  },
  deliver(envelope, subscribers) {
    return subscribers
      .filter((subscriber) => fieldVisible(subscriber.base, envelope))
      .map((subscriber) => ({
        subscriber,
        message: {
          type: 'field.converting',
          channel: subscriber.channel,
          field_id: envelope.field_id,
          job_id: envelope.job_id,
          status: envelope.status,
          progress: envelope.progress,
          from_type: envelope.from_type,
          to_type: envelope.to_type,
          actor_id: envelope.actor_id,
          ...(envelope.link_change === undefined ? {} : { link_change: envelope.link_change }),
        },
      }));
  },
};
