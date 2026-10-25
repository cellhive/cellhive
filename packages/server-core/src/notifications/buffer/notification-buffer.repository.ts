import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { ActorType } from '../../db/schema.js';
import type { Id, NotificationBufferKind } from '@cellhive/contracts';

/** A row to append to `meta.notification_buffer`. */
export interface NewNotificationBufferRow {
  /** The recipient when the producer knows it (`assigned`); `null` when the flush finds them. */
  readonly userId: Id<'usr'> | null;
  readonly tableId: Id<'tbl'>;
  readonly recordId: Id<'rec'>;
  readonly fieldIds: readonly Id<'fld'>[];
  readonly actor: { readonly type: ActorType; readonly id: string } | null;
}

/** A buffered row, as a flush reads it. */
export interface NotificationBufferRow {
  /** `bigint` identity, as text (stable order: append order). */
  readonly id: string;
  readonly kind: NotificationBufferKind;
  readonly group_key: string;
  readonly user_id: Id<'usr'> | null;
  readonly table_id: Id<'tbl'>;
  readonly record_id: Id<'rec'>;
  readonly field_ids: readonly Id<'fld'>[];
  readonly actor_type: ActorType | null;
  readonly actor_id: string | null;
  readonly created_at: Date;
}

/**
 * `meta.notification_buffer` (migration 0038, BACKLOG T542, ADR-34 §2): rows
 * of bulk notifications waiting for `notifications.flush`, by
 * (`kind`, `group_key`). Every query is scoped by `organization_id`; the
 * cross-tenant sweep of rows whose flush job was lost is
 * `listStaleNotificationBuffers` (`db/cross-tenant-lookups.ts`).
 */
export class NotificationBufferRepository
  extends TenantRepository<'notification_buffer'>
  implements TenantRepositoryContract<NotificationBufferRepository>
{
  constructor(db: Db) {
    super(db, 'notification_buffer');
  }

  async append(
    scope: OrgScope,
    kind: NotificationBufferKind,
    groupKey: string,
    rows: readonly NewNotificationBufferRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.executor(scope)
      .insertInto('meta.notification_buffer')
      .values(
        rows.map((row) => ({
          organization_id: scope.organizationId,
          kind,
          group_key: groupKey,
          user_id: row.userId,
          table_id: row.tableId,
          record_id: row.recordId,
          field_ids: [...new Set(row.fieldIds)],
          actor_type: row.actor?.type ?? null,
          actor_id: row.actor?.id ?? null,
        })),
      )
      .execute();
  }

  /** Distinct records buffered in one group (what `flushWhenCount` compares with). */
  async countRecords(
    scope: OrgScope,
    kind: NotificationBufferKind,
    groupKey: string,
  ): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.notification_buffer')
      .select((eb) => eb.fn.count<string>('record_id').distinct().as('records'))
      .where('organization_id', '=', scope.organizationId)
      .where('kind', '=', kind)
      .where('group_key', '=', groupKey)
      .executeTakeFirst();
    return Number(row?.records ?? 0);
  }

  /**
   * Every row of one group, in append order, locked `FOR UPDATE SKIP LOCKED`
   * until the scope's transaction ends: a concurrent flush of the same group
   * skips them, rows appended meanwhile wait for the next flush.
   */
  async lockGroup(
    scope: OrgScope,
    kind: NotificationBufferKind,
    groupKey: string,
  ): Promise<NotificationBufferRow[]> {
    if (scope.tx === undefined) throw new TypeError('lockGroup needs a transaction scope');
    const rows = await this.executor(scope)
      .selectFrom('meta.notification_buffer')
      .select([
        'id',
        'kind',
        'group_key',
        'user_id',
        'table_id',
        'record_id',
        'field_ids',
        'actor_type',
        'actor_id',
        'created_at',
      ])
      .where('organization_id', '=', scope.organizationId)
      .where('kind', '=', kind)
      .where('group_key', '=', groupKey)
      .orderBy('id')
      .forUpdate()
      .skipLocked()
      .execute();
    return rows.map((row) => ({
      ...row,
      id: String(row.id),
      kind: row.kind as NotificationBufferKind,
      field_ids: row.field_ids,
    }));
  }

  /**
   * Deletes every buffered row about the table's records: purging a table,
   * in the purge transaction (its meta row stays with `purged_at`, so the
   * foreign key does not cascade then — T543 note, T560). Returns the rows deleted.
   */
  async deleteForTable(scope: OrgScope, tableId: Id<'tbl'>): Promise<number> {
    const result = await this.executor(scope)
      .deleteFrom('meta.notification_buffer')
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Deletes flushed rows (in the flush transaction). */
  async delete(scope: OrgScope, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.executor(scope)
      .deleteFrom('meta.notification_buffer')
      .where('organization_id', '=', scope.organizationId)
      // One array parameter, whatever the size of the group.
      .where(sql<boolean>`id = ANY(${[...ids]}::bigint[])`)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
