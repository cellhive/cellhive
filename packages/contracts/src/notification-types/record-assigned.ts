import { z } from 'zod';

import { idOf } from '../ids.js';

/**
 * Most record ids kept in the `data` of one grouped notification (CONTRACTS
 * §22): the others are only counted (`count`).
 */
export const NOTIFICATION_RECORD_IDS_MAX = 20;

/**
 * Where a grouped notification's writes came from (ADR-35 §6, T608): an
 * incoming webhook whose automation runs made them. Its id only — never its
 * name (the recipient may not manage the base).
 */
export const notificationSourceSchema = z.strictObject({
  incoming_webhook_id: idOf('hok'),
});
export type NotificationSource = z.infer<typeof notificationSourceSchema>;

/**
 * `record.assigned` (ADR-29 §1, ADR-34 §2; produced from T544): the
 * recipient was added to a `user` field with `notify_on_assign`. A single
 * write: `batch_id = null`, `count = 1`, the record in `record_ids`. A bulk
 * write (ADR-26 §2): one notification per recipient and `batch.id` — `count`
 * is the number of records of the batch the recipient could read when it
 * was flushed, `record_ids` the first {@link NOTIFICATION_RECORD_IDS_MAX} of
 * them. `field_ids`: the `user` fields the recipient was added to.
 * Writes of the runs of an incoming webhook (ADR-35 §6, T608): grouped per
 * (hook, table) over a minute like a bulk write, with `batch_id = null` and
 * `source = { incoming_webhook_id }`.
 */
export const recordAssignedDataSchema = z
  .strictObject({
    batch_id: z.string().min(1).max(64).nullable(),
    count: z.int().min(1),
    record_ids: z.array(idOf('rec')).min(1).max(NOTIFICATION_RECORD_IDS_MAX),
    field_ids: z.array(idOf('fld')).min(1).max(500),
    source: notificationSourceSchema.optional(),
  })
  .refine((data) => data.record_ids.length <= data.count, {
    message: 'record_ids cannot hold more records than count',
    path: ['record_ids'],
  });
export type RecordAssignedData = z.infer<typeof recordAssignedDataSchema>;
