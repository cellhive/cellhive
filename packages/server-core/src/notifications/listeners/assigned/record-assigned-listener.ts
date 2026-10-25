import { isId, NOTIFICATION_WEBHOOK_WINDOW_MS, type Id } from '@cellhive/contracts';

import { isBulkEvent } from '../../../automation/dispatch/event-match.js';
import { OrgMembersRepository } from '../../../db/repositories/org-members.repository.js';
import { orgScope, type OrgScope } from '../../../db/repository.js';
import { AppError } from '../../../errors/app-error.js';
import {
  loadMemberAccessBase,
  resolveMemberBaseAccess,
  type AccessDefaults,
  type MemberAccessBase,
} from '../../../import/member-access.js';
import { FieldsRepository } from '../../../schema/fields.repository.js';
import { NotificationBuffer } from '../../buffer/notification-buffer.js';
import { enqueueNotification } from '../../fanout.js';
import { webhookNotificationGroupKey } from '../../flush/webhook-groups.js';
import { RecordFollowHooks } from '../../follows/record-follow-hooks.js';

import { assignmentsOf } from './assignments.js';

import type { Db } from '../../../db/create-db.js';
import type { ActorType, FieldRow, JsonValue } from '../../../db/schema.js';
import type { EventDocument } from '../../../events/event.js';
import type { RecordQueryService } from '../../../records/record-query.service.js';

export interface RecordAssignedListenerOptions {
  /** Instance defaults used to resolve an assignee's access (automatic follow). */
  readonly defaults: AccessDefaults;
  /** Reads the record as the assignee (automatic follow). */
  readonly records: RecordQueryService;
  /** The grouping buffer of bulk writes; default: one on `db` (tests pin its clock). */
  readonly buffer?: NotificationBuffer;
}

/** What the listener did with one event (ids and counts only). */
export type RecordAssignedOutcome =
  /** Not a record write that can assign (type, recomputed values, no changes). */
  | { readonly status: 'ignored' }
  /** No flagged `user` field gained a member of the organization. */
  | { readonly status: 'none' }
  /** Single write: one `notifications.fanout` per assignee; follows written now. */
  | {
      readonly status: 'queued';
      readonly recipients: number;
      readonly followed: number;
    }
  /** Bulk write (group of `batch.id`) or incoming webhook write (group of hook and table). */
  | { readonly status: 'buffered'; readonly recipients: number; readonly flushNow: boolean };

/**
 * `record.assigned` (BACKLOG T544; ADR-29 §1, ADR-34 §2, "Quyết định S5b"
 * #7), called by `events.dispatch` after the automation part, in its
 * transaction (`scope.tx`): the outbox rule — the notification exists iff
 * the dispatch commits, and a redelivered event (already dispatched) never
 * gets here twice.
 *
 * For a `record.created|updated` (never values recomputed by
 * `computed_recompute`), each `user` field with `options.notify_on_assign`
 * in `changes` (storage form) assigns the users it **gained** (a new record:
 * all of them); a field deleted or converted since is not flagged any more
 * and assigns nobody. The user behind the change is left out (assigning
 * yourself, a `current_user` default); an automation, API token or share
 * link has no user to leave out, so its assignments are notified. Users who
 * are not members of the organization any more are dropped.
 *
 * - **Single write** (not bulk, ADR-26 §2): one `notifications.fanout` per
 *   assignee (`entity_type = record`, `group_key = <event_id>:<user>`, the
 *   record and at least one of their fields required when it runs), so the
 *   notification is realtime; and, when the assignee reads the record and
 *   one of those fields **now**, the automatic follow (`source = assigned`,
 *   `RecordFollowHooks.autoFollow`: their switch, the cap, "unfollowing by
 *   hand wins") in this transaction.
 * - **Bulk write**: one row per assignee in the `assigned` group of
 *   `batch.id` (`NotificationBuffer`); the group is flushed once every record
 *   of the call is buffered (`flushWhenCount = batch.size`) or after 10 s —
 *   an import, whose chunks share one `batch.id`, 10 s after its last row
 *   (`debounce: from_last`). {@link RecordAssignedGrouper} writes one
 *   notification per assignee and follows there.
 * - **Write of an incoming webhook's run** (`via.incoming_webhook_id`, not
 *   bulk — T608, ADR-35 §6): one row per assignee in the `assigned` group of
 *   (hook, table) (`webhook:<hok>:<tbl>`), flushed 60 s after its first row
 *   (`from_first`); the grouper writes one notification per assignee and
 *   window (with `source`) and follows there. Nothing is written now.
 */
export class RecordAssignedListener {
  readonly #fields: FieldsRepository;
  readonly #members: OrgMembersRepository;
  readonly #follows: RecordFollowHooks;
  readonly #buffer: NotificationBuffer;

  constructor(
    private readonly db: Db,
    private readonly options: RecordAssignedListenerOptions,
  ) {
    this.#fields = new FieldsRepository(db);
    this.#members = new OrgMembersRepository(db);
    this.#follows = new RecordFollowHooks(db);
    this.#buffer = options.buffer ?? new NotificationBuffer(db);
  }

  async handle(scope: OrgScope, event: EventDocument): Promise<RecordAssignedOutcome> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('RecordAssignedListener needs a transaction scope');
    if (event.type !== 'record.created' && event.type !== 'record.updated') {
      return { status: 'ignored' };
    }
    if (event.via?.computed_recompute === true) return { status: 'ignored' };
    const { table_id: tableId, base_id: baseId, changes } = event;
    const recordId = event.entity_type === 'record' ? event.entity_id : null;
    if (
      tableId === undefined ||
      baseId === undefined ||
      recordId === null ||
      !isId('rec', recordId) ||
      changes === undefined
    ) {
      return { status: 'ignored' };
    }
    const changed = Object.keys(changes).filter((key) => isId('fld', key));
    if (changed.length === 0) return { status: 'ignored' };

    const flagged = (await this.#fields.listByIds(scope, changed))
      .filter(
        (field) =>
          field.table_id === tableId &&
          field.deleted_at === null &&
          field.type === 'user' &&
          notifiesOnAssign(field),
      )
      .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (flagged.length === 0) return { status: 'none' };

    const actorUserId =
      event.actor.type === 'user' && event.actor.id !== null && isId('usr', event.actor.id)
        ? event.actor.id
        : null;
    const assignments = assignmentsOf(
      changes,
      flagged.map((field) => field.id),
      actorUserId,
    );
    for (const userId of [...assignments.keys()]) {
      // Only members can be told (and the buffer references `org_members`).
      if ((await this.#members.get(scope, userId)) === undefined) assignments.delete(userId);
    }
    if (assignments.size === 0) return { status: 'none' };

    const actor: { type: ActorType; id: string } | null =
      event.actor.id === null ? null : { type: event.actor.type, id: event.actor.id };

    if (isBulkEvent(event) && event.batch !== undefined) {
      const imported = event.via?.import_job_id !== undefined;
      const { flushNow } = await this.#buffer.append(tx, {
        organizationId: scope.organizationId,
        kind: 'assigned',
        groupKey: event.batch.id,
        rows: [...assignments].map(([userId, fieldIds]) => ({
          userId,
          tableId,
          recordId,
          fieldIds,
          actor,
        })),
        // An import's `batch.size` is the size of one chunk, not of the job.
        ...(imported ? { debounce: 'from_last' as const } : { flushWhenCount: event.batch.size }),
      });
      return { status: 'buffered', recipients: assignments.size, flushNow };
    }

    const hookId = event.via?.incoming_webhook_id;
    if (hookId !== undefined) {
      // T608 (ADR-35 §6): a single write of an incoming webhook's run joins the
      // group of (hook, table) — one notification per assignee and window.
      await this.#buffer.append(tx, {
        organizationId: scope.organizationId,
        kind: 'assigned',
        groupKey: webhookNotificationGroupKey(hookId, tableId),
        rows: [...assignments].map(([userId, fieldIds]) => ({
          userId,
          tableId,
          recordId,
          fieldIds,
          actor,
        })),
        debounce: 'from_first',
        delayMs: NOTIFICATION_WEBHOOK_WINDOW_MS,
      });
      return { status: 'buffered', recipients: assignments.size, flushNow: false };
    }

    for (const [userId, fieldIds] of assignments) {
      await enqueueNotification(tx, {
        organizationId: scope.organizationId,
        type: 'record.assigned',
        baseId,
        tableId,
        entityType: 'record',
        entityId: recordId,
        actor,
        groupKey: `${event.id}:${userId}`,
        userIds: [userId],
        recordId,
        anyFieldIds: fieldIds,
        data: { batch_id: null, count: 1, record_ids: [recordId], field_ids: fieldIds },
      });
    }

    let followed = 0;
    const readers = new AssigneeReads(this.db, this.options, scope.organizationId, baseId);
    for (const [userId, fieldIds] of assignments) {
      if (!(await readers.reads(userId, tableId, recordId, fieldIds))) continue;
      const added = await this.#follows.autoFollow(scope, {
        tableId,
        userId,
        recordIds: [recordId],
        source: 'assigned',
      });
      followed += added.length;
    }
    return { status: 'queued', recipients: assignments.size, followed };
  }
}

/** `options.notify_on_assign` of a `user` field (stored options, SPEC §5.5). */
function notifiesOnAssign(field: FieldRow): boolean {
  const options: JsonValue = field.options;
  return (
    typeof options === 'object' &&
    options !== null &&
    !Array.isArray(options) &&
    options.notify_on_assign === true
  );
}

/**
 * Whether an assignee reads the record and at least one of the fields they
 * were added to **now** — the check of the notification (CONTRACTS §22.2),
 * done for the automatic follow of a single write (P40: an assignee who
 * cannot read the record does not follow it). Committed state, outside the
 * dispatch transaction (a failed read never aborts it); the base is read
 * once per event.
 */
class AssigneeReads {
  #base: Promise<MemberAccessBase | undefined> | undefined;

  constructor(
    private readonly db: Db,
    private readonly options: RecordAssignedListenerOptions,
    private readonly organizationId: Id<'org'>,
    private readonly baseId: Id<'bse'>,
  ) {}

  async reads(
    userId: Id<'usr'>,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<boolean> {
    const scope = orgScope(this.organizationId);
    this.#base ??= loadMemberAccessBase(this.db, scope, this.baseId);
    const shared = await this.#base;
    if (shared === undefined) return false;
    const access = await resolveMemberBaseAccess(
      this.db,
      scope,
      { userId, baseId: this.baseId },
      this.options.defaults,
      shared,
    );
    const table = access?.record.resolved.access.tables[tableId];
    if (access === undefined || table === undefined) return false;
    if (!fieldIds.some((fieldId) => table.fields[fieldId] !== undefined)) return false;
    try {
      return await this.options.records.matchRecord(scope, tableId, recordId, access.record, null);
    } catch (error) {
      // The table is gone or not readable any more: nothing to follow.
      if (error instanceof AppError) return false;
      throw error;
    }
  }
}
