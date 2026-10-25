import { NOTIFICATION_RECORD_IDS_MAX, type Id } from '@cellhive/contracts';

import { orgScope } from '../../../db/repository.js';
import { TablesRepository } from '../../../schema/tables.repository.js';
import {
  parseWebhookNotificationGroupKey,
  webhookNotificationKey,
} from '../../flush/webhook-groups.js';
import { RecordFollowHooks } from '../../follows/record-follow-hooks.js';

import type { Db } from '../../../db/create-db.js';
import type { ActorType } from '../../../db/schema.js';
import type { GroupedNotificationRequest, ReadableParts } from '../../fanout.js';
import type { NotificationGroup, NotificationGrouper } from '../../flush/notification-flusher.js';

/** `group_key` of a grouped `record.assigned`: one per (assignee, batch, table). */
export function assignedGroupKey(batchId: string, tableId: Id<'tbl'>): string {
  return `${batchId}:${tableId}`;
}

interface Assignee {
  readonly userId: Id<'usr'>;
  readonly tableId: Id<'tbl'>;
  /**
   * Records (in append order) → the `user` fields the assignee was added to
   * on that record: a record counts for them only through a field they read
   * (QA T559 H1 — not "one of all the batch's fields").
   */
  readonly fieldsByRecord: Map<Id<'rec'>, Set<Id<'fld'>>>;
  /** Every field of the entry, in append order. */
  readonly fieldIds: Set<Id<'fld'>>;
}

/** The records of `entry` the assignee reads through a field they read, in append order. */
function visibleRecords(entry: Assignee, readable: ReadableParts): Id<'rec'>[] {
  const fields = new Set(readable.fieldIds);
  return readable.recordIds.filter((recordId) => {
    for (const fieldId of entry.fieldsByRecord.get(recordId) ?? []) {
      if (fields.has(fieldId)) return true;
    }
    return false;
  });
}

/**
 * The grouper of `assigned` (BACKLOG T544; ADR-34 §2, "Quyết định S5b" #7):
 * the rows a bulk write appended to the group of its `batch.id` become **one
 * `record.assigned` per assignee** (per table of the batch — a batch is one
 * call, so in practice one table): `entity_type = table`,
 * `group_key = <batch.id>:<table_id>` (a re-run, or a later flush of the
 * same batch, writes nothing twice), `data = { batch_id, count, record_ids,
 * field_ids }` where `count` is the number of the batch's records the
 * assignee **reads now** (none → no notification, `cannot_read_record`),
 * `record_ids` the first {@link NOTIFICATION_RECORD_IDS_MAX} of them and
 * `field_ids` the fields they were added to that they read (none →
 * `cannot_read_field`). A record counts only when the assignee reads a
 * field they were added to **on that record** (QA T559 H1: being in a
 * field they cannot read is not disclosed, as for a single write). The users behind the change are left out. In the
 * flush transaction, the assignee follows the records they read
 * (`source = assigned`, `RecordFollowHooks.autoFollow`: switch, cap,
 * "unfollowing by hand wins").
 *
 * The group of the writes of an incoming webhook's runs (T608, ADR-35 §6:
 * buffer key `webhook:<hok>:<tbl>`) is grouped the same way — same checks,
 * same follows — with `batch_id = null`, `source = { incoming_webhook_id }`
 * and `group_key = webhook:<hok>:<tbl>:<first buffer row id>` (one
 * notification per assignee and window; a record assigned several times in
 * the window counts once).
 */
export class RecordAssignedGrouper implements NotificationGrouper {
  readonly kind = 'assigned' as const;
  readonly #tables: TablesRepository;
  readonly #follows: RecordFollowHooks;

  constructor(db: Db) {
    this.#tables = new TablesRepository(db);
    this.#follows = new RecordFollowHooks(db);
  }

  async group(group: NotificationGroup): Promise<GroupedNotificationRequest[]> {
    const scope = orgScope(group.organizationId, group.tx);
    const webhook = parseWebhookNotificationGroupKey(group.groupKey);
    const firstRowId = group.rows[0]?.id;
    if (firstRowId === undefined) return [];
    const assignees = new Map<string, Assignee>();
    const actors = new Set<Id<'usr'>>();
    let actor: { type: ActorType; id: string } | null = null;
    for (const row of group.rows) {
      if (row.actor_type !== null && row.actor_id !== null) {
        actor ??= { type: row.actor_type, id: row.actor_id };
        if (row.actor_type === 'user') actors.add(row.actor_id as Id<'usr'>);
      }
      if (row.user_id === null) continue;
      const key = `${row.user_id} ${row.table_id}`;
      let entry = assignees.get(key);
      if (entry === undefined) {
        entry = {
          userId: row.user_id,
          tableId: row.table_id,
          fieldsByRecord: new Map(),
          fieldIds: new Set(),
        };
        assignees.set(key, entry);
      }
      let fields = entry.fieldsByRecord.get(row.record_id);
      if (fields === undefined) {
        fields = new Set();
        entry.fieldsByRecord.set(row.record_id, fields);
      }
      for (const fieldId of row.field_ids) {
        fields.add(fieldId);
        entry.fieldIds.add(fieldId);
      }
    }

    const baseOf = new Map<Id<'tbl'>, Id<'bse'> | null>();
    const requests: GroupedNotificationRequest[] = [];
    for (const entry of [...assignees.values()].sort(byUserThenTable)) {
      if (!baseOf.has(entry.tableId)) {
        // A table in the trash or purged: nobody reads its records.
        const table = await this.#tables.getById(scope, entry.tableId);
        baseOf.set(entry.tableId, table === undefined ? null : table.base_id);
      }
      const baseId = baseOf.get(entry.tableId) ?? null;
      if (baseId === null) continue;
      requests.push({
        type: 'record.assigned',
        baseId,
        tableId: entry.tableId,
        entityType: 'table',
        entityId: entry.tableId,
        actor,
        groupKey:
          webhook === null
            ? assignedGroupKey(group.groupKey, entry.tableId)
            : webhookNotificationKey(group.groupKey, firstRowId),
        recipients: [entry.userId],
        skipUserIds: [...actors],
        requires: {
          recordIds: [...entry.fieldsByRecord.keys()],
          anyFieldIds: [...entry.fieldIds],
        },
        dataFor: (_userId, readable) => {
          const records = visibleRecords(entry, readable);
          if (records.length === 0) return null;
          const used = new Set<Id<'fld'>>();
          for (const recordId of records) {
            for (const fieldId of entry.fieldsByRecord.get(recordId) ?? []) used.add(fieldId);
          }
          return {
            batch_id: webhook === null ? group.groupKey : null,
            count: records.length,
            record_ids: records.slice(0, NOTIFICATION_RECORD_IDS_MAX),
            field_ids: readable.fieldIds.filter((fieldId) => used.has(fieldId)),
            ...(webhook === null
              ? {}
              : { source: { incoming_webhook_id: webhook.incomingWebhookId } }),
          };
        },
        onAccepted: async (userId, readable) => {
          await this.#follows.autoFollow(scope, {
            tableId: entry.tableId,
            userId,
            recordIds: visibleRecords(entry, readable),
            source: 'assigned',
          });
        },
      });
    }
    return requests;
  }
}

function byUserThenTable(a: Assignee, b: Assignee): number {
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  return a.tableId < b.tableId ? -1 : a.tableId > b.tableId ? 1 : 0;
}
