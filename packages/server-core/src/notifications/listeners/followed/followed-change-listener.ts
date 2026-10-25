import { isId, NOTIFICATION_WEBHOOK_WINDOW_MS, type Id } from '@cellhive/contracts';
import { isComputedField } from '@cellhive/permissions';

import { isBulkEvent } from '../../../automation/dispatch/event-match.js';
import { FieldsRepository } from '../../../schema/fields.repository.js';
import {
  NotificationBuffer,
  type NotificationBufferOptions,
} from '../../buffer/notification-buffer.js';
import { webhookNotificationGroupKey } from '../../flush/webhook-groups.js';
import { RecordFollowsRepository } from '../../follows/record-follows.repository.js';

import type { Db } from '../../../db/create-db.js';
import type { OrgScope } from '../../../db/repository.js';
import type { EventDocument } from '../../../events/event.js';

/** What {@link FollowedChangeListener.onEvent} did with one event (ids/codes only). */
export type FollowedChangeOutcome =
  /** Not a `record.updated` of a record of a table. */
  | 'not_record_update'
  /** Values recomputed by formulas/lookups (`via.computed_recompute`). */
  | 'computed'
  /** A bulk change (ADR-26 §2): followers are not told (ADR-29 §1). */
  | 'bulk'
  /** No change on a field that still exists and is not computed. */
  | 'no_fields'
  /** Nobody follows the record. */
  | 'no_followers'
  /** Appended to the `followed` group of the record. */
  | 'buffered';

export interface FollowedChangeListenerOptions {
  /** Clock and delays of the buffer (tests); default: the real clock, 60 s. */
  readonly buffer?: NotificationBufferOptions;
}

/**
 * The producer of `record.followed_changed` (BACKLOG T545; ADR-29 §1,
 * ADR-34 §2), called by `events.dispatch` for every event **in the dispatch
 * transaction** (the outbox rule: buffered iff the event is marked
 * dispatched — a redelivered event is never seen twice).
 *
 * Only a single (not bulk, ADR-26 §2) `record.updated` that is not a
 * recompute of computed values, with `changes` on fields that still exist
 * and are not computed (recomputed values folded into the write's event are
 * left out), of a record somebody follows (muted rows do not count), is
 * kept: one row
 * of the `followed` buffer group of the record (`group_key` = record id) —
 * the changed field ids and the actor, never a value — and the group's
 * debounced `notifications.flush` (60 s, `preserve_run_at`). Changes by
 * automations, API tokens and share links count like a user's. Who is told,
 * and what, is decided when the group is flushed
 * (`FollowedChangeGrouper`). A write of an incoming webhook's run
 * (`via.incoming_webhook_id`, T608 — ADR-35 §6) goes to the group of
 * (hook, table) (`webhook:<hok>:<tbl>`) instead, flushed 60 s after its first
 * row: one notification per follower, hook, table and window.
 */
export class FollowedChangeListener {
  readonly #follows: RecordFollowsRepository;
  readonly #fields: FieldsRepository;
  readonly #buffer: NotificationBuffer;

  constructor(db: Db, options: FollowedChangeListenerOptions = {}) {
    this.#follows = new RecordFollowsRepository(db);
    this.#fields = new FieldsRepository(db);
    this.#buffer = new NotificationBuffer(db, options.buffer);
  }

  /** `scope` must carry the dispatch transaction. */
  async onEvent(scope: OrgScope, event: EventDocument): Promise<FollowedChangeOutcome> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('FollowedChangeListener needs a transaction scope');
    const tableId = event.table_id;
    const recordId = event.entity_id;
    if (
      event.type !== 'record.updated' ||
      event.entity_type !== 'record' ||
      tableId === undefined ||
      !isId('rec', recordId)
    ) {
      return 'not_record_update';
    }
    if (event.via?.computed_recompute === true) return 'computed';
    if (isBulkEvent(event)) return 'bulk';
    const changed = Object.keys(event.changes ?? {}).filter((key): key is Id<'fld'> =>
      isId('fld', key),
    );
    if (changed.length === 0) return 'no_fields';

    // Cheapest test first: most records have no follower.
    const followers = await this.#follows.followersOf(scope, tableId, [recordId]);
    if ((followers.get(recordId)?.length ?? 0) === 0) return 'no_followers';

    // A field deleted since the change is not a change any more; recomputed
    // values (formula, lookup, …) folded into the write's own event are not
    // changes anybody made (ADR-29: computed values do not notify). Kept in
    // the table's field order (`changes` keys come in no useful order).
    const wanted = new Set<string>(changed);
    const fieldIds = (await this.#fields.listByTable(scope, tableId))
      .filter(
        (field) => wanted.has(field.id) && !isComputedField({ id: field.id, type: field.type }),
      )
      .map((field) => field.id);
    if (fieldIds.length === 0) return 'no_fields';

    // T608 (ADR-35 §6): a write of an incoming webhook's run joins the group
    // of (hook, table) instead of the record's, same 60 s from the first row.
    const hookId = event.via?.incoming_webhook_id;
    await this.#buffer.append(tx, {
      organizationId: scope.organizationId,
      kind: 'followed',
      groupKey: hookId === undefined ? recordId : webhookNotificationGroupKey(hookId, tableId),
      ...(hookId === undefined ? {} : { delayMs: NOTIFICATION_WEBHOOK_WINDOW_MS }),
      rows: [
        {
          userId: null,
          tableId,
          recordId,
          fieldIds,
          actor: event.actor.id === null ? null : { type: event.actor.type, id: event.actor.id },
        },
      ],
    });
    return 'buffered';
  }
}
