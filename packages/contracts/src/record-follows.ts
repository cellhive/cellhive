import { z } from 'zod';

import { idOf } from './ids.js';

/**
 * Following records (CONTRACTS §22.5; ADR-29 §1, ADR-34 §2; BACKLOG T543).
 * A member follows a record they can read; T545 tells followers about later
 * changes (`record.followed_changed`). Following starts from creating a
 * record by hand (`created`), being assigned to it (`assigned`, T544) or the
 * follow button (`manual`). Unfollowing by hand wins over every automatic
 * source on that record: the person is never followed again automatically
 * there, only by hand.
 */

/** Where a follow came from. Comments (S11) add `commented`. */
export const RECORD_FOLLOW_SOURCES = ['manual', 'created', 'assigned'] as const;
export type RecordFollowSource = (typeof RECORD_FOLLOW_SOURCES)[number];
export const recordFollowSourceSchema = z.enum(RECORD_FOLLOW_SOURCES);

/**
 * Most records one member follows in one organization (BACKLOG "Quy ước S5b"
 * limits). Following by hand past it is `422 VALIDATION_FAILED` /
 * `TOO_MANY_FOLLOWS`; an automatic follow past it is silently skipped.
 * Records the person unfollowed do not count.
 */
export const MAX_RECORD_FOLLOWS_PER_USER = 10_000;

/** Detail code of following past {@link MAX_RECORD_FOLLOWS_PER_USER}. */
export const TOO_MANY_FOLLOWS = 'TOO_MANY_FOLLOWS';

/** Path of `GET|PUT|DELETE /tables/:tableId/records/:recordId/follow`. */
export const recordFollowParamsSchema = z.strictObject({
  tableId: idOf('tbl'),
  recordId: idOf('rec'),
});
export type RecordFollowParams = z.infer<typeof recordFollowParamsSchema>;

/** `GET …/follow`: whether the caller follows the record, and why. */
export const recordFollowSchema = z
  .strictObject({
    following: z.boolean(),
    source: recordFollowSourceSchema.nullable().meta({
      description:
        'What started the follow: `manual` (the follow button), `created` (the caller created ' +
        'the record by hand), `assigned` (the caller was added to a `user` field with ' +
        '`notify_on_assign`). `null` when the caller does not follow the record.',
    }),
  })
  .meta({ id: 'RecordFollow' });
export type RecordFollowDto = z.infer<typeof recordFollowSchema>;
