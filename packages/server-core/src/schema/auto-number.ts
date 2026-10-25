import { autoNumberOptionsSchema, formatAutoNumber } from '@cellhive/field-types';
import { sql } from 'kysely';

import { assertDataTableName, assertFieldColumnName, DATA_SCHEMA } from './names.js';

import type { Tx } from '../db/create-db.js';
import type { FieldRow } from '../db/schema.js';

/**
 * `auto_number` values (SPEC §5.5) — the contract `RecordMutationService`
 * (T107) follows when it inserts records:
 *
 * 1. `reserveAutoValues(tx, table, n)` takes `n` values from the table's
 *    `__auto` identity sequence (in the insert transaction);
 * 2. each record is inserted with `OVERRIDING SYSTEM VALUE` and its reserved
 *    `__auto`, and `__created_at` set explicitly (or read back as `now()` of
 *    the transaction);
 * 3. every active `auto_number` column of the table gets
 *    `autoNumberCells(fields, { autoValue, createdAt, timeZone })`, the org
 *    time zone deciding `created_time` rules.
 *
 * So the formatted value is written in the same `INSERT` (no second UPDATE,
 * no trigger to keep in sync with the rules) and formatting has a single
 * implementation (`formatAutoNumber`). Existing records are (re)numbered by
 * the `schema.recompute_auto_number` job, enqueued by `SchemaService` when an
 * `auto_number` field is added or its rules change; its record writes go
 * through `RecordMutationService` (T107).
 */

/** Reserves `count` consecutive-in-order `__auto` values of `data.<table>`. */
export async function reserveAutoValues(tx: Tx, table: string, count: number): Promise<bigint[]> {
  if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) {
    throw new RangeError('reserveAutoValues: count must be between 0 and 10000');
  }
  if (count === 0) return [];
  const qualified = `${DATA_SCHEMA}.${assertDataTableName(table)}`;
  const { rows } = await sql<{ value: bigint }>`
    SELECT nextval(pg_get_serial_sequence(${qualified}, '__auto')) AS value
      FROM generate_series(1, ${count}::int)
  `.execute(tx);
  return rows.map((row) => row.value);
}

export interface AutoNumberCellInput {
  readonly autoValue: bigint | number | string;
  readonly createdAt: Date;
  readonly timeZone: string;
}

/**
 * Column → formatted value for every active `auto_number` field in `fields`
 * (other fields are ignored).
 */
export function autoNumberCells(
  fields: readonly Pick<FieldRow, 'type' | 'options' | 'db_column_name' | 'deleted_at'>[],
  input: AutoNumberCellInput,
): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const field of fields) {
    if (
      field.type !== 'auto_number' ||
      field.deleted_at !== null ||
      field.db_column_name === null
    ) {
      continue;
    }
    const options = autoNumberOptionsSchema.parse(field.options);
    cells[assertFieldColumnName(field.db_column_name)] = formatAutoNumber(
      options.style.rules,
      input,
    );
  }
  return cells;
}
