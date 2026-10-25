import {
  isId,
  NOTIFICATION_ACTOR_IDS_MAX,
  NOTIFICATION_FOLLOWERS_MAX,
  NOTIFICATION_RECORD_IDS_MAX,
  type Id,
  type RecordFollowedChangedData,
} from '@cellhive/contracts';

import { OrgMembersRepository } from '../../../db/repositories/org-members.repository.js';
import { orgScope } from '../../../db/repository.js';
import { TablesRepository } from '../../../schema/tables.repository.js';
import {
  parseWebhookNotificationGroupKey,
  webhookNotificationKey,
  type WebhookNotificationGroup,
} from '../../flush/webhook-groups.js';
import { RecordFollowsRepository } from '../../follows/record-follows.repository.js';

import type { Db } from '../../../db/create-db.js';
import type { ActorType } from '../../../db/schema.js';
import type { NotificationBufferRow } from '../../buffer/notification-buffer.repository.js';
import type { GroupedNotificationRequest, ReadableParts } from '../../fanout.js';
import type { NotificationGroup, NotificationGrouper } from '../../flush/notification-flusher.js';

type Actor = { readonly type: ActorType; readonly id: string } | null;

/**
 * The `followed` grouper of `notifications.flush` (BACKLOG T545; ADR-29 §1,
 * ADR-34 §2): the changes to one record buffered over the follow debounce
 * become **one** `record.followed_changed` per follower.
 *
 * - Candidates: the record's followers **now** (muted rows left out, read in
 *   the flush transaction), the users behind any change of the group left
 *   out (reason `actor` — even for the changes of another user), then the
 *   first {@link NOTIFICATION_FOLLOWERS_MAX} in user id order.
 * - Each candidate must read the record (read rule, live, outside the trash
 *   — a record deleted meanwhile drops the whole group: `cannot_read_record`)
 *   and at least one changed field (`cannot_read_field` otherwise), checked
 *   by `NotificationFanout.runGrouped`.
 * - Per recipient, only the changes that touched a field they read count:
 *   `field_ids` = those fields (in order of first change), `change_count` =
 *   those changes, `actor_ids` = their users still in the organization
 *   (at most {@link NOTIFICATION_ACTOR_IDS_MAX}), and the notification's
 *   `actor` = the author of the latest of them — a change to fields hidden
 *   from them is never counted nor attributed.
 * - `group_key = <record_id>:<flush job id>` (a re-run of the same job writes
 *   nothing twice; the next debounce window gets its own notification).
 *   Without a job (a flush run in-process) the id of the group's first
 *   buffer row stands in for it.
 *
 * The group of the writes of an incoming webhook's runs (T608, ADR-35 §6:
 * buffer key `webhook:<hok>:<tbl>`, many records of one table) is grouped by
 * {@link groupWebhook} instead.
 */
export class FollowedChangeGrouper implements NotificationGrouper {
  readonly kind = 'followed' as const;

  constructor(private readonly db: Db) {}

  async group(group: NotificationGroup): Promise<readonly GroupedNotificationRequest[]> {
    const first = group.rows[0];
    if (first === undefined) return [];
    const webhook = parseWebhookNotificationGroupKey(group.groupKey);
    if (webhook !== null) return this.groupWebhook(group, webhook, first);
    const scope = orgScope(group.organizationId, group.tx);
    const tableId = first.table_id;
    const recordId = first.record_id;
    // Rows of the same record (the group key); a stray one is ignored.
    const rows = group.rows.filter((row) => row.record_id === recordId && row.table_id === tableId);
    // The base of the table, even in the trash (then nobody reads the record).
    const table = await new TablesRepository(this.db).getById(scope, tableId, {
      includeDeleted: true,
    });
    if (table === undefined) return [];

    const userActors = unique(rows.flatMap((row) => userActorOf(row)));
    const actorsInOrg = new Set<string>(
      (await new OrgMembersRepository(this.db).listWithUserByIds(scope, userActors)).map(
        (member) => member.user_id,
      ),
    );
    const skip = new Set<string>(userActors);
    const follows = new RecordFollowsRepository(this.db);
    const changedFields = unique(rows.flatMap((row) => row.field_ids));

    return [
      {
        type: 'record.followed_changed',
        baseId: table.base_id,
        tableId,
        entityType: 'record',
        entityId: recordId,
        actor: actorOf(rows.at(-1) ?? first),
        groupKey: `${recordId}:${group.jobId ?? `row${first.id}`}`,
        recipients: async () => {
          const followers = (await follows.followersOf(scope, tableId, [recordId])).get(recordId);
          const list = followers ?? [];
          return [
            // Kept so that the flush logs them as `actor`.
            ...list.filter((userId) => skip.has(userId)),
            ...list.filter((userId) => !skip.has(userId)).slice(0, NOTIFICATION_FOLLOWERS_MAX),
          ];
        },
        skipUserIds: userActors,
        requires: { recordIds: [recordId], anyFieldIds: changedFields },
        dataFor: (_userId, readable) => {
          const seen = changesSeen(rows, readable);
          if (seen.length === 0) return null;
          return {
            field_ids: [...readable.fieldIds],
            change_count: seen.length,
            actor_ids: unique(seen.flatMap((row) => userActorOf(row)))
              .filter((userId) => actorsInOrg.has(userId))
              .slice(0, NOTIFICATION_ACTOR_IDS_MAX),
          } satisfies RecordFollowedChangedData;
        },
        actorFor: (_userId, readable) => {
          const seen = changesSeen(rows, readable);
          const latest = seen.at(-1);
          return latest === undefined ? null : actorOf(latest);
        },
      },
    ];
  }

  /**
   * One `record.followed_changed` per follower for the window of (hook,
   * table) (T608, ADR-35 §6): `entity_type = table`, `group_key =
   * webhook:<hok>:<tbl>:<first buffer row id>`.
   *
   * - Candidates: the followers **now** of any record of the window (muted
   *   rows left out), the users behind any change left out (`actor`), the
   *   first {@link NOTIFICATION_FOLLOWERS_MAX} in user id order.
   * - Each must read the base, at least one record of the window and at
   *   least one changed field (`NotificationFanout.runGrouped`).
   * - Per recipient, a change counts only when it is on a record they
   *   **follow** and **read** now and touched a field they read: `field_ids`
   *   = the fields they read of those changes (never a field of a record
   *   they cannot read or do not follow), `change_count` = those changes,
   *   `record_count` = their records, `record_ids` = the first
   *   {@link NOTIFICATION_RECORD_IDS_MAX} of them (append order),
   *   `actor_ids`/`actor` as for one record, `source = { incoming_webhook_id }`.
   *   Nothing left → nothing for them (`cannot_read_record`).
   */
  private async groupWebhook(
    group: NotificationGroup,
    webhook: WebhookNotificationGroup,
    first: NotificationBufferRow,
  ): Promise<readonly GroupedNotificationRequest[]> {
    const scope = orgScope(group.organizationId, group.tx);
    const tableId = webhook.tableId;
    // Rows of the group's table; a stray one is ignored.
    const rows = group.rows.filter((row) => row.table_id === tableId);
    if (rows.length === 0) return [];
    const table = await new TablesRepository(this.db).getById(scope, tableId, {
      includeDeleted: true,
    });
    if (table === undefined) return [];

    const recordIds = unique(rows.map((row) => row.record_id));
    const userActors = unique(rows.flatMap((row) => userActorOf(row)));
    const actorsInOrg = new Set<string>(
      (await new OrgMembersRepository(this.db).listWithUserByIds(scope, userActors)).map(
        (member) => member.user_id,
      ),
    );
    const skip = new Set<string>(userActors);
    const changedFields = unique(rows.flatMap((row) => row.field_ids));
    // Followers per record, read once in the flush transaction.
    const followers = await new RecordFollowsRepository(this.db).followersOf(
      scope,
      tableId,
      recordIds,
    );
    const followedBy = new Map<string, Set<Id<'rec'>>>();
    for (const [recordId, users] of followers) {
      for (const userId of users) {
        const set = followedBy.get(userId) ?? new Set<Id<'rec'>>();
        set.add(recordId);
        followedBy.set(userId, set);
      }
    }
    const seenBy = (userId: Id<'usr'>, readable: ReadableParts): NotificationBufferRow[] => {
      const followed = followedBy.get(userId);
      if (followed === undefined) return [];
      const records = new Set<string>(readable.recordIds.filter((id) => followed.has(id)));
      return changesSeen(rows, readable).filter((row) => records.has(row.record_id));
    };

    return [
      {
        type: 'record.followed_changed',
        baseId: table.base_id,
        tableId,
        entityType: 'table',
        entityId: tableId,
        actor: actorOf(rows.at(-1) ?? first),
        groupKey: webhookNotificationKey(group.groupKey, first.id),
        recipients: () => {
          const list = [...followedBy.keys()].sort() as Id<'usr'>[];
          return Promise.resolve([
            // Kept so that the flush logs them as `actor`.
            ...list.filter((userId) => skip.has(userId)),
            ...list.filter((userId) => !skip.has(userId)).slice(0, NOTIFICATION_FOLLOWERS_MAX),
          ]);
        },
        skipUserIds: userActors,
        requires: { recordIds, anyFieldIds: changedFields },
        dataFor: (userId, readable) => {
          const seen = seenBy(userId, readable);
          if (seen.length === 0) return null;
          const touched = new Set<string>(seen.flatMap((row) => row.field_ids));
          const records = unique(seen.map((row) => row.record_id));
          return {
            field_ids: readable.fieldIds.filter((fieldId) => touched.has(fieldId)),
            change_count: seen.length,
            actor_ids: unique(seen.flatMap((row) => userActorOf(row)))
              .filter((actorId) => actorsInOrg.has(actorId))
              .slice(0, NOTIFICATION_ACTOR_IDS_MAX),
            record_ids: records.slice(0, NOTIFICATION_RECORD_IDS_MAX),
            record_count: records.length,
            source: { incoming_webhook_id: webhook.incomingWebhookId },
          } satisfies RecordFollowedChangedData;
        },
        actorFor: (userId, readable) => {
          const latest = seenBy(userId, readable).at(-1);
          return latest === undefined ? null : actorOf(latest);
        },
      },
    ];
  }
}

/** The changes of the group that touched at least one field the recipient reads. */
function changesSeen(
  rows: readonly NotificationBufferRow[],
  readable: ReadableParts,
): NotificationBufferRow[] {
  const fields = new Set<string>(readable.fieldIds);
  return rows.filter((row) => row.field_ids.some((fieldId) => fields.has(fieldId)));
}

function actorOf(row: NotificationBufferRow): Actor {
  return row.actor_type === null || row.actor_id === null
    ? null
    : { type: row.actor_type, id: row.actor_id };
}

function userActorOf(row: NotificationBufferRow): Id<'usr'>[] {
  return row.actor_type === 'user' && row.actor_id !== null && isId('usr', row.actor_id)
    ? [row.actor_id]
    : [];
}

/** Distinct values in order of first appearance. */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
