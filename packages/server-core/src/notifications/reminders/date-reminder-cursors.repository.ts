import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** A date reminder cursor as the scan reads it (locked). */
export interface DateReminderCursor {
  readonly fieldId: Id<'fld'>;
  readonly armedAt: Date;
  readonly scannedUntil: Date;
  /** Due moment a capped scan stopped at (`null`: the last scan read its whole window). */
  readonly boundaryDueAt: Date | null;
  /** Records due at `boundaryDueAt` already reminded of. */
  readonly boundaryRecordIds: readonly Id<'rec'>[];
}

/**
 * `meta.date_reminder_cursors` (migration 0041, BACKLOG T547, ADR-34 §1):
 * one row per `datetime` field whose `options.reminder` is on. Written by
 * `SchemaService` (through `schema/reminders.ts`) in the transaction of the
 * field change — armed, re-armed, removed — and read under a row lock by the
 * per-minute scan, which moves it forward in the transaction that queues the
 * reminders. Scoped by `organization_id`.
 */
export class DateReminderCursorsRepository
  extends TenantRepository<'date_reminder_cursors'>
  implements TenantRepositoryContract<DateReminderCursorsRepository>
{
  constructor(db: Db) {
    super(db, 'date_reminder_cursors');
  }

  /**
   * (Re-)arms the cursor of a field at `at`: only moments after `at` remind.
   * The window restarts there and any capped-scan boundary is dropped.
   */
  async arm(scope: OrgScope, fieldId: Id<'fld'>, at: Date): Promise<void> {
    await this.executor(scope)
      .insertInto('meta.date_reminder_cursors')
      .values({
        organization_id: scope.organizationId,
        field_id: fieldId,
        armed_at: at,
        scanned_until: at,
      })
      .onConflict((conflict) =>
        conflict.columns(['organization_id', 'field_id']).doUpdateSet({
          armed_at: at,
          scanned_until: sql<Date>`greatest(meta.date_reminder_cursors.scanned_until, ${at}::timestamptz)`,
          boundary_due_at: null,
          boundary_record_ids: sql<Id<'rec'>[]>`'{}'::text[]`,
        }),
      )
      .execute();
  }

  /** Removes the cursors of `fieldIds` (reminder off, field in the trash). Returns how many. */
  async remove(scope: OrgScope, fieldIds: readonly Id<'fld'>[]): Promise<number> {
    if (fieldIds.length === 0) return 0;
    const result = await this.executor(scope)
      .deleteFrom('meta.date_reminder_cursors')
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', 'in', [...fieldIds])
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * The cursor of a field, locked until the transaction ends; `undefined`
   * when the reminder is off (no row). Needs a transaction scope.
   */
  async lock(scope: OrgScope, fieldId: Id<'fld'>): Promise<DateReminderCursor | undefined> {
    if (scope.tx === undefined) throw new TypeError('lock needs a transaction scope');
    const row = await this.executor(scope)
      .selectFrom('meta.date_reminder_cursors')
      .select(['field_id', 'armed_at', 'scanned_until', 'boundary_due_at', 'boundary_record_ids'])
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : cursorOf(row);
  }

  /**
   * Moves the cursor of a field to `until` (never backwards) and stores the
   * capped-scan boundary (`null` clears it).
   */
  async advance(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    until: Date,
    boundary: { readonly dueAt: Date; readonly recordIds: readonly Id<'rec'>[] } | null,
  ): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.date_reminder_cursors')
      .set({
        scanned_until: sql<Date>`greatest(scanned_until, ${until}::timestamptz)`,
        boundary_due_at: boundary?.dueAt ?? null,
        boundary_record_ids: boundary === null ? [] : [...boundary.recordIds],
      })
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .execute();
  }

  /** The cursor of a field, if any (tests, diagnostics). */
  async get(scope: OrgScope, fieldId: Id<'fld'>): Promise<DateReminderCursor | undefined> {
    const row = await this.executor(scope)
      .selectFrom('meta.date_reminder_cursors')
      .select(['field_id', 'armed_at', 'scanned_until', 'boundary_due_at', 'boundary_record_ids'])
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .executeTakeFirst();
    return row === undefined ? undefined : cursorOf(row);
  }
}

function cursorOf(row: {
  field_id: Id<'fld'>;
  armed_at: Date;
  scanned_until: Date;
  boundary_due_at: Date | null;
  boundary_record_ids: Id<'rec'>[];
}): DateReminderCursor {
  return {
    fieldId: row.field_id,
    armedAt: row.armed_at,
    scannedUntil: row.scanned_until,
    boundaryDueAt: row.boundary_due_at,
    boundaryRecordIds: row.boundary_record_ids,
  };
}
