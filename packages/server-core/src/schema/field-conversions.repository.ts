import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type {
  FieldConversionKindValue,
  FieldConversionRow,
  FieldConversionStatus,
  JsonbInput,
  JsonObject,
} from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * Statuses of a conversion with a column of its own in the data table: the
 * shadow column while `running`, the old column once `succeeded` (until
 * reverted or cleaned). A `failed` conversion dropped its shadow column.
 */
export const LIVE_CONVERSION_STATUSES = [
  'running',
  'succeeded',
] as const satisfies readonly FieldConversionStatus[];

export interface InsertFieldConversionInput {
  readonly jobId: Id<'job'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  readonly fromDefinition: JsonObject;
  readonly toDefinition: JsonObject;
  readonly oldColumnName: string | null;
  /** `null` for a link conversion (T404), like the shadow column. */
  readonly newColumnName: string | null;
  readonly shadowColumnName: string | null;
  /** Default `column` (T403). */
  readonly kind?: FieldConversionKindValue;
  /** Link conversions: the other side of the link (locked too while running). */
  readonly partner?: { readonly tableId: Id<'tbl'>; readonly fieldId: Id<'fld'> } | null;
  /** `to_single`: the backup of the removed links. */
  readonly backupTableName?: string | null;
  readonly context: JsonObject;
  readonly maxAuto: bigint | number;
  readonly counts: JsonObject;
  readonly createdBy: Id<'usr'> | null;
  readonly expiresAt: Date;
}

/**
 * `meta.field_conversions` (T403): field type conversions, keyed by their
 * `field.convert` job. Every query is scoped by `organization_id`.
 */
export class FieldConversionsRepository
  extends TenantRepository<'field_conversions'>
  implements TenantRepositoryContract<FieldConversionsRepository>
{
  constructor(db: Db) {
    super(db, 'field_conversions');
  }

  async insert(scope: OrgScope, input: InsertFieldConversionInput): Promise<FieldConversionRow> {
    return this.executor(scope)
      .insertInto('meta.field_conversions')
      .values({
        job_id: input.jobId,
        organization_id: scope.organizationId,
        table_id: input.tableId,
        field_id: input.fieldId,
        from_definition: input.fromDefinition,
        to_definition: input.toDefinition,
        old_column_name: input.oldColumnName,
        new_column_name: input.newColumnName,
        shadow_column_name: input.shadowColumnName,
        kind: input.kind ?? 'column',
        partner_table_id: input.partner?.tableId ?? null,
        partner_field_id: input.partner?.fieldId ?? null,
        backup_table_name: input.backupTableName ?? null,
        context: input.context,
        max_auto: input.maxAuto,
        counts: input.counts,
        created_by: input.createdBy,
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getByJob(scope: OrgScope, jobId: Id<'job'>): Promise<FieldConversionRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.field_conversions')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', '=', jobId)
      .executeTakeFirst();
  }

  /** Locks the row of a conversion (`FOR UPDATE`) in the scope's transaction. */
  async lockByJob(scope: OrgScope, jobId: Id<'job'>): Promise<FieldConversionRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.field_conversions')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', '=', jobId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * The latest conversion of the field, whatever its status (the revert
   * only ever applies to it).
   */
  async latestForField(
    scope: OrgScope,
    fieldId: Id<'fld'>,
  ): Promise<FieldConversionRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.field_conversions')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .orderBy('created_at', 'desc')
      .orderBy('job_id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** Conversions of the table with a column of their own (running: shadow; succeeded: old). */
  async listLiveByTable(scope: OrgScope, tableId: Id<'tbl'>): Promise<FieldConversionRow[]> {
    return this.executor(scope)
      .selectFrom('meta.field_conversions')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('status', 'in', [...LIVE_CONVERSION_STATUSES])
      .orderBy('created_at')
      .orderBy('job_id')
      .execute();
  }

  /**
   * Ids of the fields of the table being converted now: their schema cannot
   * change (`409 SCHEMA_LOCKED`). Includes the other side of a running link
   * conversion of another field (T404, ADR-28 §3: both tables are locked for
   * the fields concerned).
   */
  async runningFieldIds(scope: OrgScope, tableId: Id<'tbl'>): Promise<Set<Id<'fld'>>> {
    const own = await this.executor(scope)
      .selectFrom('meta.field_conversions')
      .select('field_id')
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('status', '=', 'running')
      .execute();
    const partners = await this.executor(scope)
      .selectFrom('meta.field_conversions')
      .select('partner_field_id')
      .where('organization_id', '=', scope.organizationId)
      .where('partner_table_id', '=', tableId)
      .where('status', '=', 'running')
      .execute();
    return new Set([
      ...own.map((row) => row.field_id),
      ...partners.flatMap((row) => (row.partner_field_id === null ? [] : [row.partner_field_id])),
    ]);
  }

  /**
   * Ids of the fields of the table whose values are being converted now:
   * record writes to them answer `409 SCHEMA_LOCKED` (BACKLOG S4 open
   * question #8). Link conversions do not lock writes (ADR-28 §3: the
   * junction keeps its structure).
   */
  async writeLockedFieldIds(scope: OrgScope, tableId: Id<'tbl'>): Promise<Set<Id<'fld'>>> {
    const rows = await this.executor(scope)
      .selectFrom('meta.field_conversions')
      .select('field_id')
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('status', '=', 'running')
      .where('kind', '=', 'column')
      .execute();
    return new Set(rows.map((row) => row.field_id));
  }

  /**
   * Conversions of the given fields that changed them and were not
   * reverted (`succeeded`, `cleaned`), oldest first (record history renders
   * values written before a conversion with the definition of then).
   */
  async listForFields(
    scope: OrgScope,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<FieldConversionRow[]> {
    if (fieldIds.length === 0) return [];
    return (
      this.executor(scope)
        .selectFrom('meta.field_conversions')
        .selectAll()
        .where('organization_id', '=', scope.organizationId)
        .where('field_id', 'in', [...fieldIds])
        .where('status', 'in', ['succeeded', 'cleaned'])
        // Link conversions keep the type: values render with the current definition.
        .where('kind', '=', 'column')
        .orderBy('created_at')
        .orderBy('job_id')
        .execute()
    );
  }

  /** Backfill progress: rows up to `cursorAuto` are converted; `counts` so far. */
  async setProgress(
    scope: OrgScope,
    jobId: Id<'job'>,
    progress: { readonly cursorAuto: bigint; readonly counts: JsonbInput },
  ): Promise<FieldConversionRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.field_conversions')
      .set({ cursor_auto: progress.cursorAuto, counts: progress.counts })
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', '=', jobId)
      .where('status', '=', 'running')
      .returningAll()
      .executeTakeFirst();
  }

  /** `running → succeeded | failed`. */
  async markFinished(
    scope: OrgScope,
    jobId: Id<'job'>,
    status: 'succeeded' | 'failed',
    counts: JsonbInput,
  ): Promise<FieldConversionRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.field_conversions')
      .set({ status, counts, finished_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', '=', jobId)
      .where('status', '=', 'running')
      .returningAll()
      .executeTakeFirst();
  }

  /** `succeeded → reverted` (the old column is back). */
  async markReverted(scope: OrgScope, jobId: Id<'job'>): Promise<FieldConversionRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.field_conversions')
      .set({ status: 'reverted', reverted_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', '=', jobId)
      .where('status', '=', 'succeeded')
      .returningAll()
      .executeTakeFirst();
  }

  /** `succeeded → cleaned` (the old column was dropped). */
  async markCleaned(scope: OrgScope, jobId: Id<'job'>): Promise<FieldConversionRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.field_conversions')
      .set({ status: 'cleaned', cleaned_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', '=', jobId)
      .where('status', '=', 'succeeded')
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Conversions of the fields of `tableId` or of `fieldIds` (links of other
   * tables touching it), or whose other side is in `tableId`, whatever
   * their status (the purge of the table, T461).
   */
  async listTouching(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<FieldConversionRow[]> {
    return this.executor(scope)
      .selectFrom('meta.field_conversions')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where((eb) =>
        eb.or([
          eb('table_id', '=', tableId),
          eb('partner_table_id', '=', tableId),
          ...(fieldIds.length === 0 ? [] : [eb('field_id', 'in', [...fieldIds])]),
        ]),
      )
      .orderBy('job_id')
      .execute();
  }

  /** `succeeded → cleaned` for several conversions at once (their columns/backups are gone). */
  async markManyCleaned(scope: OrgScope, jobIds: readonly Id<'job'>[]): Promise<Id<'job'>[]> {
    if (jobIds.length === 0) return [];
    const rows = await this.executor(scope)
      .updateTable('meta.field_conversions')
      .set({ status: 'cleaned', cleaned_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', 'in', [...jobIds])
      .where('status', '=', 'succeeded')
      .returning('job_id')
      .execute();
    return rows.map((row) => row.job_id);
  }
}
