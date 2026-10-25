import { orgScope } from '../db/repository.js';
import { LinkFanout } from '../records/links/link-fanout.js';
import { FieldsRepository } from '../schema/fields.repository.js';
import { TablesRepository } from '../schema/tables.repository.js';

import { realtimePublisherOf } from './bus.js';
import { ComputedImages } from './computed-values.js';
import { RealtimeRecordChangePublisher } from './publishers.js';

import type { Db } from '../db/create-db.js';
import type { FieldRow } from '../db/schema.js';
import type { RecordChange, RecordChangeField } from '../records/record-change-publisher.js';
import type { Id } from '@cellhive/contracts';

/**
 * Link cells of other tables show records of `tableId` differently because
 * its primary field did (BACKLOG T459, S4-review §4 #11, CONTRACTS §7): the
 * field's options or type changed, or its auto numbers were recomputed.
 * Every link field whose linked table is `tableId` (both sides, self-links)
 * publishes one write on its own table — a `record.updated` (`event_id:
 * null`, same `version`) per linking record, **without values** and titles
 * only (`link_fanout`, T402): each subscriber group that reads some of those
 * records and may see the titles gets one `record.batch` (client refetch);
 * groups that may not see the titles get nothing (ids are unchanged).
 *
 * Runs after the change committed (its own read-only transaction), only
 * when `fieldId` is the table's primary field and a bus is attached. Best
 * effort: errors go to `onError`.
 */
export async function publishLinkTitlesChanged(
  db: Db,
  organizationId: Id<'org'>,
  tableId: Id<'tbl'>,
  fieldId: Id<'fld'>,
  onError: (error: unknown) => void = () => undefined,
): Promise<void> {
  if (realtimePublisherOf(db) === undefined) return;
  try {
    const writes = await db.withTx(async (tx) => {
      const scope = orgScope(organizationId, tx);
      const table = await new TablesRepository(db).getById(scope, tableId);
      if (table?.primary_field_id !== fieldId) return [];
      const plans = await new LinkFanout(db).plan(scope, table, null, 'title', 'all', {
        locale: 'en',
        timeZone: 'UTC',
      });
      const images = new ComputedImages(db);
      const out: {
        changes: RecordChange[];
        fields: RecordChangeField[];
        plan: (typeof plans)[number];
      }[] = [];
      for (const plan of plans) {
        const byId = new Map<string, FieldRow>([
          ...plan.model.fields.map((field) => [field.id as string, field.row] as const),
          ...plan.model.links.map((link) => [link.id as string, link.row] as const),
        ]);
        const imaged = new Set<string>();
        const changes = plan.changes.map((change): RecordChange => {
          for (const key of Object.keys(change.before)) imaged.add(key);
          for (const key of Object.keys(change.after)) imaged.add(key);
          return {
            type: change.type,
            organizationId,
            baseId: plan.table.base_id,
            tableId: plan.table.id,
            recordId: change.recordId,
            version: change.version,
            changedFieldIds: change.changedFieldIds,
            eventId: null,
            actor: { type: 'system', id: null },
            actorUserId: null,
            before: change.before,
            after: change.after,
            values: {},
          };
        });
        const fields = [...imaged].flatMap((key): RecordChangeField[] => {
          const row = byId.get(key);
          return row === undefined ? [] : [{ id: row.id, type: row.type, options: row.options }];
        });
        out.push({ ...(await images.augment(scope, plan.table, changes, fields)), plan });
      }
      return out;
    });
    const publisher = new RealtimeRecordChangePublisher(db);
    for (const write of writes) {
      await publisher.publish(write.changes, write.fields, [write.plan.link], write.plan.fanout);
    }
  } catch (error) {
    onError(error);
  }
}

/**
 * `publishLinkTitlesChanged` for a committed schema change of a field
 * (`schema.changed` `updated` / `converted`): only the primary field of a
 * table matters. Looks the field up first (one query).
 */
export async function publishLinkTitlesOfField(
  db: Db,
  organizationId: Id<'org'>,
  fieldId: Id<'fld'>,
  onError?: (error: unknown) => void,
): Promise<void> {
  if (realtimePublisherOf(db) === undefined) return;
  try {
    const field = await new FieldsRepository(db).getById(orgScope(organizationId), fieldId);
    if (field?.is_primary !== true) return;
    await publishLinkTitlesChanged(db, organizationId, field.table_id, fieldId, onError);
  } catch (error) {
    onError?.(error);
  }
}
