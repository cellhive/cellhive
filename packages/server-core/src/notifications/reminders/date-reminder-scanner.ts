import {
  DATE_REMINDER_MAX_PER_SCAN,
  DATE_REMINDER_USER_FIELD_TYPES,
  isId,
  type DateReminderData,
  type DateReminderOption,
  type Id,
} from '@cellhive/contracts';

import { listDateReminderFields, type DateReminderField } from '../../db/cross-tenant-lookups.js';
import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { orgScope, withTxScope, type OrgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';
import { RecordQueryService } from '../../records/record-query.service.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { reminderOf } from '../../schema/reminders.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import { windowOf } from '../../time-scan/cursor-store.js';
import { dueRuleOf } from '../../time-scan/rule.js';
import { TimeScanCore } from '../../time-scan/scan-core.js';
import { enqueueNotification, MAX_NOTIFICATION_RECIPIENTS } from '../fanout.js';

import { DateReminderCursorsRepository } from './date-reminder-cursors.repository.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { FieldRow } from '../../db/schema.js';
import type { AccessDefaults } from '../../import/member-access.js';
import type { DueScanRow } from '../../records/due/due-scan.js';
import type { SystemScanAccess } from '../../records/due/system-scan.js';
import type { SchemaService } from '../../schema/schema.service.js';

/** Fields listed per page by a scan. */
export const DATE_REMINDER_FIELD_PAGE = 500;
/** Records read per page by the scan of one field. */
export const DATE_REMINDER_SCAN_PAGE = 500;

/** What happened to one field in one scan (logged: ids, codes and counts only). */
export type DateReminderOutcome =
  /** At least one reminder queued; the whole window was read. */
  | 'reminded'
  /** Nothing due in the window (or no window yet). */
  | 'idle'
  /** The reminder is off or the field is gone: the cursor is removed. */
  | 'turned_off'
  /** The field, its table or its base cannot be read (trash): the window passes. */
  | 'field_unavailable'
  /** `field_user`: the recipient field is gone or of another type: the window passes. */
  | 'recipient_field_unavailable'
  /** The per-scan cap was reached; the rest is reminded of next scan. */
  | 'capped'
  /**
   * The scan of this field failed (statement timeout, database error…): the
   * cursor did not move, the next scan tries again; the other fields (other
   * organizations) are scanned anyway (QA T559 H2).
   */
  | 'error';

export interface DateReminderResult {
  readonly organizationId: Id<'org'>;
  readonly fieldId: Id<'fld'>;
  readonly outcome: DateReminderOutcome;
  /** Reminders queued (`notifications.fanout` jobs). */
  readonly reminders: number;
  /** `error`: the code of the failure (`AppError` code or `internal`) — never its message. */
  readonly errorCode?: string;
}

export interface DateReminderTick {
  readonly fields: number;
  readonly reminders: number;
  readonly results: readonly DateReminderResult[];
}

export interface DateReminderScannerOptions {
  /** Zone of date-only values when neither the field nor the organization has one. */
  readonly defaults: AccessDefaults;
  /** Reads the date field (system scan context); default: a service on `db`. */
  readonly records?: RecordQueryService;
  /** Creates the scan index of a date column (`SchemaService.ensureDueIndex`); none in tests. */
  readonly schema?: Pick<SchemaService, 'ensureDueIndex'>;
  /** Reminders queued per field per scan at most (`DATE_REMINDER_MAX_PER_SCAN`). */
  readonly maxPerScan?: number;
  /** Records read per page (`DATE_REMINDER_SCAN_PAGE`). */
  readonly pageSize?: number;
  /** Called when the scan index cannot be created (the scan goes on without it). */
  readonly onIndexError?: (error: unknown, fieldId: Id<'fld'>) => void;
}

/** The users of a `user` (list) or `created_by` (single) cell, de-duplicated, in order. */
export function reminderRecipientsOf(cell: unknown): Id<'usr'>[] {
  const items: unknown[] = Array.isArray(cell)
    ? cell
    : cell === null || cell === undefined
      ? []
      : [cell];
  const out: Id<'usr'>[] = [];
  for (const item of items) {
    const id =
      typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
    if (isId('usr', id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Where the cursor of a field goes after a capped scan: a keyset — the due
 * moment it stopped at and the last record reminded of (QA S5b M7). Records
 * are scanned in `(value, record id)` order, so every record due at that
 * moment up to it was handled; the next scan seeks past them
 * (`TimeScanRequest.resumeAfter`). `boundary_record_ids` keeps that one id
 * (rows written before T560 held every id reminded of at the moment; their
 * last one is the same keyset). Pure.
 */
export function nextBoundary(
  stoppedAt: number,
  lastReminded: Id<'rec'>,
): { readonly dueAt: Date; readonly recordIds: Id<'rec'>[] } {
  return { dueAt: new Date(stoppedAt), recordIds: [lastReminded] };
}

/** The keyset a capped scan left in the cursor, if any (see {@link nextBoundary}). */
export function resumePointOf(previous: {
  readonly dueAt: number | null;
  readonly recordIds: readonly Id<'rec'>[];
}): { readonly due: number; readonly id: Id<'rec'> } | null {
  const id = previous.recordIds.at(-1);
  return previous.dueAt === null || id === undefined ? null : { due: previous.dueAt, id };
}

/**
 * The date reminder consumer of the shared time scan core (BACKLOG T547,
 * ADR-34 §1, CONTRACTS §22.6): the per-minute
 * `notifications.date_reminder_scan` finds every field whose reminder is on
 * (`listDateReminderFields`, ids only) and handles each in its own
 * transaction, in its organization's scope:
 *
 * - the cursor (`meta.date_reminder_cursors`) is locked; no cursor = the
 *   reminder is off. The window is `(max(scanned_until, armed_at), now]`:
 *   only moments passing after the reminder was turned on or changed remind,
 *   and a stopped worker resumes where it stopped;
 * - records are read with the system scan context of `RecordQueryService`
 *   (every live record, never the trash, only the date field and the
 *   recipient field — no member's read rule): the time scan core keeps the
 *   records whose date (+ offset; date-only values at `time_of_day` in the
 *   field's zone, else the organization's — ADR-21) falls in the window;
 * - for each, the recipients are the users of the recipient field **now**
 *   (`field_user`) or the fixed `user_ids`, and one `date.reminder`
 *   notification request is queued (`notifications.fanout`, which checks
 *   each recipient reads the record and the date field when it runs —
 *   ADR-29 §1), `group_key = <field>:<record>:<value>`: a record is reminded
 *   of once per value, again for a new value, never twice for a value it
 *   comes back to;
 * - at most `maxPerScan` reminders per field per scan; the rest next scan
 *   (the cursor stops just before the moment it reached and remembers the
 *   records of that moment already reminded of); the cursor moves in the
 *   same transaction as the queued reminders.
 *
 * Not an automation (ADR-34 §1): no `run_as`, no run, no breaker. The clock
 * is the caller's `now` (tests inject it). Never logs dates, values or users.
 */
export class DateReminderScanner {
  private readonly cursors: DateReminderCursorsRepository;
  private readonly fields: FieldsRepository;
  private readonly tables: TablesRepository;
  private readonly organizations: OrganizationsRepository;
  private readonly records: RecordQueryService;
  private readonly core: TimeScanCore;
  private readonly maxPerScan: number;
  private readonly pageSize: number;

  constructor(
    private readonly db: Db,
    private readonly options: DateReminderScannerOptions,
  ) {
    this.cursors = new DateReminderCursorsRepository(db);
    this.fields = new FieldsRepository(db);
    this.tables = new TablesRepository(db);
    this.organizations = new OrganizationsRepository(db);
    this.records =
      options.records ?? new RecordQueryService(db, { defaultTimeZone: options.defaults.timeZone });
    this.core = new TimeScanCore(this.records, {
      ...(options.schema === undefined ? {} : { schema: options.schema }),
      ...(options.onIndexError === undefined ? {} : { onIndexError: options.onIndexError }),
    });
    this.maxPerScan = options.maxPerScan ?? DATE_REMINDER_MAX_PER_SCAN;
    this.pageSize = options.pageSize ?? DATE_REMINDER_SCAN_PAGE;
    for (const [name, value] of [
      ['maxPerScan', this.maxPerScan],
      ['pageSize', this.pageSize],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  /** `notifications.date_reminder_scan`: every field with a reminder once. */
  async scanAll(now: Date): Promise<DateReminderTick> {
    const results: DateReminderResult[] = [];
    let after: DateReminderField | null = null;
    for (;;) {
      const page = await listDateReminderFields(this.db.kysely, {
        after,
        limit: DATE_REMINDER_FIELD_PAGE,
      });
      for (const item of page) results.push(await this.scanFieldIsolated(item, now));
      after = page.at(-1) ?? null;
      if (page.length < DATE_REMINDER_FIELD_PAGE) break;
    }
    return {
      fields: results.length,
      reminders: results.reduce((sum, item) => sum + item.reminders, 0),
      results,
    };
  }

  /** One field whose failure never stops the scan of the fields after it. */
  private async scanFieldIsolated(item: DateReminderField, now: Date): Promise<DateReminderResult> {
    try {
      return await this.scanField(item, now);
    } catch (error) {
      return {
        ...item,
        outcome: 'error',
        reminders: 0,
        errorCode: error instanceof AppError ? error.code : 'internal',
      };
    }
  }

  /** One field (also for tests). */
  async scanField(item: DateReminderField, now: Date): Promise<DateReminderResult> {
    const scope = orgScope(item.organizationId);
    const result = (outcome: DateReminderOutcome, reminders = 0): DateReminderResult => ({
      ...item,
      outcome,
      reminders,
    });
    // The scan index first, outside the transaction (it takes the table's schema lock).
    const listed = await this.fields.getById(scope, item.fieldId);
    if (listed !== undefined && reminderOf(listed) !== null) {
      await this.core.ensureIndex(scope, item.fieldId);
    }
    return this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const cursor = await this.cursors.lock(txScope, item.fieldId);
      if (cursor === undefined) return result('turned_off');
      const field = await this.fields.getById(txScope, item.fieldId);
      const reminder = field === undefined ? null : reminderOf(field);
      if (field === undefined || reminder === null) {
        // `SchemaService` removes the cursor with the reminder; heal a stray one.
        await this.cursors.remove(txScope, [item.fieldId]);
        return result('turned_off');
      }
      const window = windowOf(cursor, now);
      if (window === null) return result('idle');
      // Whatever happens below, this window is handled (nothing reminds late).
      const done = async (
        outcome: DateReminderOutcome,
        reminders = 0,
        until: Date = now,
        boundary: { readonly dueAt: Date; readonly recordIds: readonly Id<'rec'>[] } | null = null,
      ) => {
        await this.cursors.advance(txScope, item.fieldId, until, boundary);
        return result(outcome, reminders);
      };

      const rule = dueRuleOf(
        field,
        { offsetMinutes: reminder.offset_minutes, timeOfDay: reminder.time_of_day },
        {
          organization: await this.organizationTimeZone(txScope),
          fallback: this.options.defaults.timeZone,
        },
      );
      if (rule === null) return done('field_unavailable');
      const userFieldId = await this.recipientField(txScope, field, reminder);
      if (userFieldId === false) return done('recipient_field_unavailable');
      const table = await this.tables.getById(txScope, field.table_id);
      if (table === undefined) return done('field_unavailable');
      let access: SystemScanAccess;
      try {
        access = await this.records.systemScanAccess(
          scope,
          field.table_id,
          userFieldId === null ? [field.id] : [field.id, userFieldId],
        );
      } catch (error) {
        // The table or its base is in the trash (or gone).
        if (error instanceof AppError && error.code === 'NOT_FOUND') {
          return done('field_unavailable');
        }
        throw error;
      }

      const previous = {
        dueAt: cursor.boundaryDueAt?.getTime() ?? null,
        recordIds: cursor.boundaryRecordIds,
      };
      // The core seeks past it; the id check stays for rows written before T560.
      const resume = resumePointOf(previous);
      const skip = new Set(previous.recordIds);
      // The latest reminder of this scan: its moment and record (the boundary if capped).
      const stop: { at: number | null; last: Id<'rec'> | null } = { at: null, last: null };
      const onDue = async (runTx: Tx, record: DueScanRow, due: number): Promise<boolean> => {
        // Reminded of by the capped scan that stopped at this very moment.
        if (previous.dueAt === due && skip.has(record.id)) return false;
        const recipients =
          reminder.recipients === 'users'
            ? reminder.user_ids
            : reminderRecipientsOf(userFieldId === null ? null : record.fields?.[userFieldId]);
        if (recipients.length === 0) return false;
        const data: DateReminderData = {
          field_id: field.id,
          due_at: new Date(due).toISOString(),
          value: record.value,
        };
        await enqueueNotification(runTx, {
          organizationId: item.organizationId,
          type: 'date.reminder',
          baseId: table.base_id,
          tableId: field.table_id,
          entityType: 'record',
          entityId: record.id,
          actor: null,
          groupKey: `${field.id}:${record.id}:${record.value}`,
          userIds: recipients.slice(0, MAX_NOTIFICATION_RECIPIENTS),
          recordId: record.id,
          // `field_user`: also the recipient field — being in a field one cannot
          // read is not disclosed (QA T559, as for `record.assigned`).
          fieldIds: userFieldId === null ? [field.id] : [field.id, userFieldId],
          data: { ...data },
        });
        stop.at = due;
        stop.last = record.id;
        return true;
      };

      // Read in the core's own read transactions; reminders are queued in this one.
      const scanned = await this.core.scan(scope, {
        tx,
        tableId: field.table_id,
        fieldId: field.id,
        rule,
        window,
        access,
        ...(userFieldId === null ? {} : { fields: [userFieldId] }),
        pageSize: this.pageSize,
        maxHits: this.maxPerScan,
        ...(resume === null ? {} : { resumeAfter: resume }),
        onDue,
      });
      switch (scanned.outcome) {
        case 'unavailable':
          return done('field_unavailable', scanned.hits, scanned.until);
        case 'capped':
          return done(
            'capped',
            scanned.hits,
            scanned.until,
            // Capped right after a reminder: `stop` holds it.
            stop.at === null || stop.last === null ? null : nextBoundary(stop.at, stop.last),
          );
        case 'done':
          return done(scanned.hits > 0 ? 'reminded' : 'idle', scanned.hits, scanned.until);
      }
    });
  }

  /**
   * The recipient field of a `field_user` reminder (`null` for `users`), or
   * `false` when it is gone, of another table or no longer a user field.
   */
  private async recipientField(
    scope: OrgScope,
    field: FieldRow,
    reminder: DateReminderOption,
  ): Promise<Id<'fld'> | null | false> {
    if (reminder.recipients === 'users') return null;
    const userField = await this.fields.getById(scope, reminder.user_field_id);
    if (
      userField?.table_id !== field.table_id ||
      !(DATE_REMINDER_USER_FIELD_TYPES as readonly string[]).includes(userField.type)
    ) {
      return false;
    }
    return userField.id;
  }

  private async organizationTimeZone(scope: OrgScope): Promise<unknown> {
    const organization = await this.organizations.findById(scope.organizationId, scope.tx);
    const settings = organization?.settings;
    return typeof settings === 'object' && settings !== null && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)['timezone']
      : undefined;
  }
}
