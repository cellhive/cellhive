import { z } from 'zod';

import { idOf } from '../ids.js';

import { NOTIFICATION_RECORD_IDS_MAX, notificationSourceSchema } from './record-assigned.js';

/** Most actors kept in the `data` of one `record.followed_changed` (CONTRACTS §22). */
export const NOTIFICATION_ACTOR_IDS_MAX = 5;

/**
 * Most followers of one record notified by one flush of its changes
 * (CONTRACTS §22.1, BACKLOG "Quy ước S5b"): the first ones in user id order,
 * the users behind the changes left out first.
 */
export const NOTIFICATION_FOLLOWERS_MAX = 1000;

/**
 * `record.followed_changed` (ADR-29 §1, ADR-34 §2; produced from T545):
 * changes to a record the recipient follows, gathered per record over the
 * follow debounce. `field_ids`: the changed fields **the recipient reads**
 * (filtered per recipient when it is written; a recipient reading none of
 * them gets nothing); `change_count`: the gathered changes that touched at
 * least one of those fields; `actor_ids`: the users behind those changes
 * still in the organization, in the order of their first change (at most
 * {@link NOTIFICATION_ACTOR_IDS_MAX}).
 *
 * Writes of the runs of an incoming webhook (ADR-35 §6, T608) are gathered
 * per (hook, table) instead of per record: the notification is about the
 * table and also has `record_count` (the records of the window the recipient
 * follows and reads that had a change they see), `record_ids` (the first
 * {@link NOTIFICATION_RECORD_IDS_MAX} of them) and `source`. The three are
 * present together or not at all.
 */
export const recordFollowedChangedDataSchema = z
  .strictObject({
    field_ids: z.array(idOf('fld')).min(1).max(500),
    change_count: z.int().min(1),
    actor_ids: z.array(idOf('usr')).max(NOTIFICATION_ACTOR_IDS_MAX),
    record_ids: z.array(idOf('rec')).min(1).max(NOTIFICATION_RECORD_IDS_MAX).optional(),
    record_count: z.int().min(1).optional(),
    source: notificationSourceSchema.optional(),
  })
  .refine(
    (data) =>
      (data.record_ids === undefined) === (data.record_count === undefined) &&
      (data.record_ids === undefined) === (data.source === undefined),
    { message: 'record_ids, record_count and source go together', path: ['record_ids'] },
  )
  .refine(
    (data) =>
      data.record_ids === undefined ||
      data.record_count === undefined ||
      (data.record_ids.length <= data.record_count && data.record_count <= data.change_count),
    { message: 'record_ids ≤ record_count ≤ change_count', path: ['record_count'] },
  );
export type RecordFollowedChangedData = z.infer<typeof recordFollowedChangedDataSchema>;
