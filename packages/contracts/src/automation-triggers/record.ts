import { z } from 'zod';

import { idOf } from '../ids.js';

/**
 * Record triggers (SPEC §11.2, ADR-26): `record.created`, `record.updated`,
 * `record.deleted`. Frame of BACKLOG T502; matching, `skip_bulk` and the
 * fan-out cap belong to T503 (`events.dispatch`).
 */

/** Most fields one `record.updated` trigger may watch. */
export const MAX_WATCH_FIELDS = 50;

const skipBulkSchema = z.boolean().default(false).meta({
  description:
    'Ignore bulk changes and imports (ADR-26 §2–3): no run and no circuit-breaker count for them',
});

export const recordCreatedTriggerSchema = z
  .strictObject({
    type: z.literal('record.created'),
    table_id: idOf('tbl'),
    skip_bulk: skipBulkSchema,
  })
  .meta({ id: 'RecordCreatedTrigger' });

export const recordUpdatedTriggerSchema = z
  .strictObject({
    type: z.literal('record.updated'),
    table_id: idOf('tbl'),
    watch_fields: z.array(idOf('fld')).min(1).max(MAX_WATCH_FIELDS).meta({
      description: 'Runs only when one of these fields changes value',
    }),
    skip_bulk: skipBulkSchema,
  })
  .meta({ id: 'RecordUpdatedTrigger' });

export const recordDeletedTriggerSchema = z
  .strictObject({
    type: z.literal('record.deleted'),
    table_id: idOf('tbl'),
    skip_bulk: skipBulkSchema,
  })
  .meta({ id: 'RecordDeletedTrigger' });
