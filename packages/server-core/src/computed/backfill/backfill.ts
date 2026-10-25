import { sql } from 'kysely';

import { withTxScope, type OrgScope } from '../../db/repository.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { assertDataTableName, assertFieldColumnName, DATA_SCHEMA } from '../../schema/names.js';
import { schemaLockKey } from '../../schema/policy.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import { ComputeModel } from '../definition/compute-model.js';
import { computedFingerprint } from '../definition/fingerprint.js';
import { loadBaseSchemaRows } from '../definition/schema-rows.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** Alias of the formula's row in the backfill `UPDATE` (a code constant). */
const ROW_ALIAS = 'cr';

export interface ComputedBackfillBatchInput {
  /** The stored computed field whose column is filled. */
  readonly fieldId: Id<'fld'>;
  /** Rows after this `__auto` (0 at the start). */
  readonly afterAuto: bigint;
  readonly limit: number;
  /** Organization zone (ADR-21). */
  readonly timeZone: string;
  /**
   * The definition the job computes: the batch does nothing (`superseded`)
   * once `expected.fieldId` has another fingerprint (T456 backfill job).
   */
  readonly expected?: { readonly fieldId: Id<'fld'>; readonly fingerprint: string };
  /** `lock_timeout` of the batch transaction (schema lock and row locks, T474). */
  readonly lockTimeoutMs: number;
}

export type ComputedBackfillBatchResult =
  | {
      readonly status: 'more' | 'done';
      readonly tableId: Id<'tbl'>;
      /** Rows written by this batch (every row, the trash included). */
      readonly rows: number;
      readonly cursor: bigint;
      /** First batch only (`afterAuto = 0`): rows of the table, for the progress. */
      readonly total?: number;
    }
  /** The field is gone, no longer stored, or no longer analyses (T460 `REF`). */
  | { readonly status: 'skipped' }
  /** `expected` has another definition now: a newer job computes it. */
  | { readonly status: 'superseded' };

/**
 * One batch of `computed.backfill` (BACKLOG T456, SPEC §5.9), in `tx`: the
 * table's schema lock (shared, like a record write, so no DDL changes the
 * column meanwhile), the field's current definition, then one set-based
 * `UPDATE data.t_x AS cr SET f_y = (<compiled>) FROM (next rows by __auto)`
 * — every row, the trash included (a restored record is up to date). The
 * value is computed for every record, never with a person's read scope
 * (stored values, BACKLOG S4b #1). No event, audit, `__version` or
 * `__updated_*` change (ADR-23 §2). The caller's `statement_timeout`
 * (30 s, SPEC §9.5) cancels a batch that is too slow; `lockTimeoutMs`
 * applies to every lock of the batch, so waiting for another transaction
 * is `55P03` (retried by the job), not a timeout (T474).
 */
export async function runComputedBackfillBatch(
  tx: Tx,
  scope: OrgScope,
  db: Db,
  input: ComputedBackfillBatchInput,
): Promise<ComputedBackfillBatchResult> {
  const txScope = withTxScope(scope, tx);
  const fields = new FieldsRepository(db);
  const located = await fields.getById(txScope, input.fieldId);
  if (located === undefined) return { status: 'skipped' };
  // `lock_timeout` for the whole batch (T474), not only the schema lock: a
  // batch waiting for rows another transaction holds (an import, a bulk
  // write) fails fast with `55P03` and the job retries it, instead of
  // waiting until its `statement_timeout` and marking the field `TIMEOUT`.
  await sql`SELECT set_config('lock_timeout', ${`${String(input.lockTimeoutMs)}ms`}, true)`.execute(
    tx,
  );
  await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${schemaLockKey(located.table_id)}, 0))`.execute(
    tx,
  );
  if (input.expected !== undefined && input.expected.fieldId !== input.fieldId) {
    const other = await fields.getById(txScope, input.expected.fieldId);
    if (other !== undefined && other.table_id !== located.table_id) {
      await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${schemaLockKey(other.table_id)}, 0))`.execute(
        tx,
      );
    }
  }

  // Re-read under the lock: the definition may have changed meanwhile.
  if (input.expected !== undefined) {
    const start = await fields.getById(txScope, input.expected.fieldId);
    if (start === undefined || computedFingerprint(start) !== input.expected.fingerprint) {
      return { status: 'superseded' };
    }
  }
  const field = await fields.getById(txScope, input.fieldId);
  if (
    field === undefined ||
    (field.type !== 'formula' && field.type !== 'lookup') ||
    field.compute_mode !== 'stored' ||
    field.db_column_name === null
  ) {
    return { status: 'skipped' };
  }
  const table = await new TablesRepository(db).getById(txScope, field.table_id);
  if (table === undefined) return { status: 'skipped' };
  const rows = await loadBaseSchemaRows(db, txScope, table.base_id);
  const model = new ComputeModel(rows, { timeZone: input.timeZone });
  const value = model.storedValue(field, ROW_ALIAS);
  if (value === null) return { status: 'skipped' };

  const data = sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
  const column = sql.id(assertFieldColumnName(field.db_column_name));
  const { rows: result } = await sql<{ rows: number; last: string | null }>`
    WITH batch AS (
      SELECT b.__id, b.__auto FROM ${data} AS b
       WHERE b.__auto > ${input.afterAuto.toString()}::bigint
       ORDER BY b.__auto
       LIMIT ${input.limit}
    ), done AS (
      UPDATE ${data} AS ${sql.id(ROW_ALIAS)}
         SET ${column} = ${value}
        FROM batch
       WHERE ${sql.id(ROW_ALIAS, '__id')} = batch.__id
      RETURNING batch.__auto
    )
    SELECT count(*)::int AS rows, max(__auto)::text AS last FROM done
  `.execute(tx);
  const written = result[0]?.rows ?? 0;
  const last = result[0]?.last;
  let total: number | undefined;
  if (input.afterAuto === 0n) {
    const counted = await sql<{
      total: number;
    }>`SELECT count(*)::int AS total FROM ${data}`.execute(tx);
    total = counted.rows[0]?.total ?? written;
  }
  return {
    status: written < input.limit ? 'done' : 'more',
    tableId: table.id,
    rows: written,
    cursor: last === null || last === undefined ? input.afterAuto : BigInt(last),
    ...(total === undefined ? {} : { total }),
  };
}
