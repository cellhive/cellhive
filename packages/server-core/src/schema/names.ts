import { isShortId, newShortId } from '@cellhive/contracts';

/**
 * Physical names of user data (SPEC §5.3). Every identifier `SchemaService`
 * puts into SQL is built here from a short id stored in meta (never from a
 * user-chosen name) and checked against its pattern before use, then quoted
 * with `sql.id()`.
 */

/** Schema of the user data tables. */
export const DATA_SCHEMA = 'data';

export const DATA_TABLE_NAME_PATTERN = /^t_[0-9a-z]{12}$/;
export const FIELD_COLUMN_NAME_PATTERN = /^f_[0-9a-z]{12}$/;
export const DELETED_COLUMN_NAME_PATTERN = /^(f_[0-9a-z]{12})__deleted_([0-9]{1,12})$/;
export const JUNCTION_TABLE_NAME_PATTERN = /^l_[0-9a-z]{12}$/;
/** `l_x__old_<epoch ms>`: links removed by a link `to_single` conversion, kept 7 days (T404). */
export const LINK_BACKUP_TABLE_NAME_PATTERN = /^(l_[0-9a-z]{12})__old_([0-9]{1,15})$/;
/** `f_x__old_<epoch ms>`: the column of a field before a type conversion (T403). */
export const OLD_COLUMN_NAME_PATTERN = /^(f_[0-9a-z]{12})__old_([0-9]{1,15})$/;
/** `f_x__new_<epoch ms>`: the column a running type conversion fills (T403). */
export const SHADOW_COLUMN_NAME_PATTERN = /^(f_[0-9a-z]{12})__new_([0-9]{1,15})$/;

function assertPattern(kind: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new TypeError(`Invalid ${kind}: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertShortId(shortId: string): string {
  if (!isShortId(shortId)) throw new TypeError(`Invalid short id: ${JSON.stringify(shortId)}`);
  return shortId;
}

/** `t_<shortId>`, the table name inside schema `data`. */
export function dataTableName(shortId: string = newShortId()): string {
  return `t_${assertShortId(shortId)}`;
}

/** `f_<shortId>`, the column of a field. */
export function fieldColumnName(shortId: string = newShortId()): string {
  return `f_${assertShortId(shortId)}`;
}

/** `l_<shortId>`, the junction of a link field (SPEC §5.3, §5.6). */
export function junctionTableName(shortId: string = newShortId()): string {
  return `l_${assertShortId(shortId)}`;
}

export function assertDataTableName(name: string): string {
  return assertPattern('data table name', name, DATA_TABLE_NAME_PATTERN);
}

export function assertFieldColumnName(name: string): string {
  return assertPattern('field column name', name, FIELD_COLUMN_NAME_PATTERN);
}

export function assertDeletedColumnName(name: string): string {
  return assertPattern('deleted column name', name, DELETED_COLUMN_NAME_PATTERN);
}

export function assertJunctionTableName(name: string): string {
  return assertPattern('junction table name', name, JUNCTION_TABLE_NAME_PATTERN);
}

export function assertLinkBackupTableName(name: string): string {
  return assertPattern('link backup table name', name, LINK_BACKUP_TABLE_NAME_PATTERN);
}

/**
 * `l_x__old_<epoch ms>` (T404): the links a `to_single` conversion of the
 * junction `l_x` removed, with the link each cut cell kept, for the 7-day
 * revert.
 */
export function linkBackupTableName(junction: string, convertedAt: Date): string {
  assertJunctionTableName(junction);
  const epoch = convertedAt.getTime();
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('Invalid conversion time');
  return `${junction}__old_${String(epoch)}`;
}

/** `f_x__deleted_<epoch seconds>` (SPEC §5.5): the column of a soft-deleted field. */
export function deletedColumnName(column: string, deletedAt: Date): string {
  assertFieldColumnName(column);
  const epoch = Math.floor(deletedAt.getTime() / 1000);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('Invalid deletion time');
  return `${column}__deleted_${String(epoch)}`;
}

export function assertOldColumnName(name: string): string {
  return assertPattern('old column name', name, OLD_COLUMN_NAME_PATTERN);
}

/**
 * `f_x__old_<epoch ms>` (SPEC §5.5 step 1): the column keeping the values of
 * a field before a type conversion, for 7 days. Milliseconds, so two
 * conversions of one field in the same second never collide.
 */
export function oldColumnName(column: string, convertedAt: Date): string {
  assertFieldColumnName(column);
  const epoch = convertedAt.getTime();
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('Invalid conversion time');
  return `${column}__old_${String(epoch)}`;
}

export function assertShadowColumnName(name: string): string {
  return assertPattern('shadow column name', name, SHADOW_COLUMN_NAME_PATTERN);
}

/**
 * `f_x__new_<epoch ms>`: the column a type conversion fills while the field
 * still reads its old column (BACKLOG S4 design decision #8).
 */
export function shadowColumnName(column: string, convertedAt: Date): string {
  assertFieldColumnName(column);
  const epoch = convertedAt.getTime();
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('Invalid conversion time');
  return `${column}__new_${String(epoch)}`;
}

/** `f_x` from `f_x__deleted_<epoch>`. */
export function canonicalColumnOf(deletedColumn: string): string {
  const match = DELETED_COLUMN_NAME_PATTERN.exec(deletedColumn);
  if (match?.[1] === undefined) {
    throw new TypeError(`Invalid deleted column name: ${JSON.stringify(deletedColumn)}`);
  }
  return match[1];
}

/**
 * Index names are unique per schema, so they start with the table name:
 * `t_x_created_at_idx`, `t_x_f_y_trgm`, … Compaction builds the new table
 * with its own prefix and renames the indexes afterwards (ADR-20 step 7).
 */
export type IndexSuffix =
  | 'created_at_idx'
  | 'deleted_at_idx'
  | 'parent_idx'
  | `${string}_${'trgm' | 'gin' | 'uniq' | 'due'}`;

/**
 * Suffix of the optional btree index on a date column that the time
 * scanner reads by range (BACKLOG T508, `SchemaService.ensureDueIndex`).
 */
export const DUE_INDEX_SUFFIX = '_due';

export function indexName(table: string, suffix: IndexSuffix): string {
  assertDataTableName(table);
  const name = `${table}_${suffix}`;
  // PostgreSQL truncates identifiers to 63 bytes, which could merge names.
  if (name.length > 63) throw new RangeError(`Index name too long: ${name}`);
  return name;
}

/** Primary key constraint (and index) of a data table. */
export function primaryKeyName(table: string): string {
  return `${assertDataTableName(table)}_pkey`;
}

/**
 * Self-referencing foreign key of the `__parent_id` column (sub-records,
 * SPEC §5.7). Added after compaction renamed the new table, so it always
 * carries the table's own name.
 */
export function parentForeignKeyName(table: string): string {
  return `${assertDataTableName(table)}_parent_fkey`;
}

/** Sequence behind `__auto` (`GENERATED ALWAYS AS IDENTITY`). */
export function autoSequenceName(table: string): string {
  return `${assertDataTableName(table)}___auto_seq`;
}

/** CHECK constraint that keeps a single-value `text[]` column at ≤ 1 element. */
export function singleValueCheckName(column: string): string {
  return `${assertFieldColumnName(column)}_single`;
}

/** `name` with the table prefix `from` replaced by `to` (index names after compaction). */
export function renamePrefixed(name: string, from: string, to: string): string {
  assertDataTableName(from);
  assertDataTableName(to);
  if (!name.startsWith(`${from}_`)) {
    throw new TypeError(`${name} does not start with ${from}_`);
  }
  return `${to}${name.slice(from.length)}`;
}
