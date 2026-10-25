import { sql, type RawBuilder, type SqlBool } from 'kysely';

import {
  assertDataTableName,
  DATA_SCHEMA,
  FIELD_COLUMN_NAME_PATTERN,
  OLD_COLUMN_NAME_PATTERN,
} from '../../schema/names.js';

import type { DbExecutor } from '../../db/create-db.js';
import type { TableRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * Keyset reads of one column of a data table for field type conversions
 * (T403): the preview counts and the revert preview. Rows come in `__auto`
 * order, every row including the trash (a conversion rewrites them all).
 * Reached only through `RecordQueryService.scanColumn` (AGENTS.md rule 1).
 */

/** System columns a converted field may read from (created/updated at/by). */
const SYSTEM_SOURCE_COLUMNS: ReadonlySet<string> = new Set([
  '__created_at',
  '__updated_at',
  '__created_by',
  '__updated_by',
]);

/** Alias of the data table in scan statements; read rules are compiled for it. */
export const SCAN_ALIAS = 't';

export interface ColumnScanRequest {
  /** `f_…`, `f_…__old_<ms>` or a created/updated at/by system column. */
  readonly column: string;
  /** Also read this column (revert preview: the converted column). */
  readonly compareColumn?: string;
  /** Rows with `__auto` greater than this. */
  readonly afterAuto: bigint;
  readonly limit: number;
}

export interface ColumnScanRow {
  readonly id: Id<'rec'>;
  readonly auto: bigint;
  /** Driver value of `column`. */
  readonly value: unknown;
  /** Driver value of `compareColumn` (`undefined` without it). */
  readonly compare: unknown;
  /** The caller may read the record (live or trash) under its read rule. */
  readonly readable: boolean;
  /** `__updated_at` of the record (revert: written after the conversion?). */
  readonly updatedAt: Date;
}

/** Throws unless `column` is a field column, an old conversion column or a system source. */
export function assertScanColumn(column: string): string {
  if (
    FIELD_COLUMN_NAME_PATTERN.test(column) ||
    OLD_COLUMN_NAME_PATTERN.test(column) ||
    SYSTEM_SOURCE_COLUMNS.has(column)
  ) {
    return column;
  }
  throw new TypeError(`Not a scannable column: ${JSON.stringify(column)}`);
}

/** One batch of {@link ColumnScanRequest}; `readable` is the caller's read rule on `t`. */
export async function scanColumnBatch(
  executor: DbExecutor,
  table: Pick<TableRow, 'db_table_name'>,
  request: ColumnScanRequest,
  readable: RawBuilder<SqlBool>,
): Promise<ColumnScanRow[]> {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
    throw new RangeError('scanColumnBatch: limit must be a positive integer');
  }
  const t = (column: string) => sql.id(SCAN_ALIAS, assertScanColumn(column));
  const compare = request.compareColumn === undefined ? sql`NULL` : t(request.compareColumn);
  const { rows } = await sql<{
    id: Id<'rec'>;
    auto: string;
    value: unknown;
    compare: unknown;
    readable: boolean | null;
    updated_at: Date;
  }>`
    SELECT ${sql.id(SCAN_ALIAS, '__id')} AS id,
           ${sql.id(SCAN_ALIAS, '__auto')}::text AS auto,
           ${t(request.column)} AS value,
           ${compare} AS compare,
           (${readable}) AS readable,
           ${sql.id(SCAN_ALIAS, '__updated_at')} AS updated_at
      FROM ${sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name))} AS ${sql.id(SCAN_ALIAS)}
     WHERE ${sql.id(SCAN_ALIAS, '__auto')} > ${request.afterAuto.toString()}::bigint
     ORDER BY ${sql.id(SCAN_ALIAS, '__auto')}
     LIMIT ${request.limit}
  `.execute(executor);
  return rows.map((row) => ({
    id: row.id,
    auto: BigInt(row.auto),
    value: row.value,
    compare: request.compareColumn === undefined ? undefined : row.compare,
    readable: row.readable === true,
    updatedAt: row.updated_at,
  }));
}
