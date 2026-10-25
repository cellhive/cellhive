import { getFieldType, isComputedFieldType, isImplementedFieldType } from '@cellhive/field-types';

import {
  checkConstraintNamesOf,
  dataTableExists,
  foreignKeysReferencing,
  indexNamesOf,
  liveColumns,
  type CatalogColumn,
} from './catalog.js';
import { DUE_INDEX_SUFFIX, parentForeignKeyName, singleValueCheckName } from './names.js';
import {
  PARENT_COLUMN,
  PARENT_COLUMN_EXPECTED,
  parentIndexName,
  planColumn,
  planComputedColumn,
  SYSTEM_COLUMNS,
  systemIndexNames,
  type ColumnPlan,
  type ExpectedColumn,
} from './physical.js';

import type { DbExecutor } from '../db/create-db.js';
import type { FieldRow, TableRow } from '../db/schema.js';

/**
 * The physical plan of a stored field (its options re-parsed by the type's
 * schema); `null` when the type has no column. Types reserved for S4 have no
 * physical plan yet and throw.
 */
export function planStoredField(
  field: Pick<
    FieldRow,
    'type' | 'options' | 'db_column_name' | 'is_primary' | 'unique_values' | 'result_type'
  >,
  table: Pick<TableRow, 'db_table_name' | 'collation'>,
): ColumnPlan | null {
  // A link keeps its values in its junction, not in a column (SPEC §5.6); a
  // parent in the system column `__parent_id` (SPEC §5.7, `parentColumnKept`).
  if (field.type === 'link' || field.type === 'parent') return null;
  // A button has no value, so no column (T517).
  if (field.type === 'button') return null;
  // A stored computed field (T456) has a column of its result type; a virtual one none.
  if (isComputedFieldType(field.type)) {
    if (field.db_column_name === null) return null;
    return planComputedColumn(field.db_column_name, field.result_type, table.collation);
  }
  if (!isImplementedFieldType(field.type)) {
    throw new TypeError(`Field type ${field.type} has no physical column yet`);
  }
  const definition = getFieldType(field.type);
  if (definition === undefined || field.db_column_name === null) return null;
  return planColumn(
    {
      type: field.type,
      options: definition.optionsSchema.parse(field.options),
      column: field.db_column_name,
      isPrimary: field.is_primary,
      uniqueValues: field.unique_values,
    },
    table.db_table_name,
    table.collation,
  );
}

/**
 * Whether the table keeps `__parent_id` (sub-records, T405): it has a
 * `parent` field that is active, or in the trash and not purged.
 */
export function parentColumnKept(fields: readonly Pick<FieldRow, 'type' | 'purged_at'>[]): boolean {
  return fields.some((field) => field.type === 'parent' && field.purged_at === null);
}

function sameColumn(actual: CatalogColumn, expected: ExpectedColumn): boolean {
  return (
    actual.dataType === expected.dataType &&
    actual.udtName === expected.udtName &&
    actual.collation === expected.collation &&
    actual.notNull === expected.notNull
  );
}

function describeColumn(column: ExpectedColumn): string {
  return `${column.udtName}${column.collation === null ? '' : ` COLLATE ${column.collation}`}${column.notNull ? ' NOT NULL' : ''}`;
}

/**
 * Compares the catalog of `data.<table.db_table_name>` with the meta rows of
 * the table (`fields` must include the trash) and returns every mismatch as
 * an English sentence; an empty list means meta and the physical table agree
 * exactly:
 * - the system columns (SPEC §5.4) exist with their types;
 * - each active field with a column has it, typed as `pgType` says, with its
 *   single-value CHECK and its indexes;
 * - each deleted field not purged has only its `__deleted_` column; a purged
 *   one has none;
 * - no other column, index or CHECK constraint exists.
 */
export async function checkSchemaConsistency(
  executor: DbExecutor,
  table: Pick<TableRow, 'id' | 'db_table_name' | 'collation'>,
  fields: readonly FieldRow[],
  /** Columns kept by type conversions (`f_x__old_<ms>`, T403): type only, no constraint. */
  oldColumns: readonly { readonly name: string; readonly plan: ColumnPlan }[] = [],
): Promise<string[]> {
  const name = table.db_table_name;
  if (!(await dataTableExists(executor, name))) return [`table data.${name} does not exist`];
  const problems: string[] = [];
  const columns = new Map(
    (await liveColumns(executor, name)).map((column) => [column.name, column]),
  );
  const indexes = new Set(await indexNamesOf(executor, name));
  const checks = new Set(await checkConstraintNamesOf(executor, name));
  const expectedColumns = new Set<string>();
  const expectedIndexes = new Set<string>([`${name}_pkey`, ...systemIndexNames(name)]);
  const expectedChecks = new Set<string>();

  for (const system of SYSTEM_COLUMNS) {
    expectedColumns.add(system.name);
    const actual = columns.get(system.name);
    if (actual === undefined) problems.push(`system column ${system.name} is missing`);
    else if (!sameColumn(actual, system)) {
      problems.push(`system column ${system.name} should be ${describeColumn(system)}`);
    }
  }

  for (const field of fields) {
    if (field.table_id !== table.id) {
      problems.push(`field ${field.id} belongs to table ${field.table_id}`);
      continue;
    }
    const plan = planStoredField(field, table);
    if (plan === null) {
      if (field.db_column_name !== null) problems.push(`field ${field.id} should have no column`);
      continue;
    }
    const canonical = plan.column;
    if (field.deleted_at === null) {
      expectedColumns.add(canonical);
      const actual = columns.get(canonical);
      if (actual === undefined) {
        problems.push(`field ${field.id}: column ${canonical} is missing`);
      } else if (!sameColumn(actual, plan.expected)) {
        problems.push(
          `field ${field.id}: column ${canonical} is ${describeColumn(actual)}, expected ${describeColumn(plan.expected)}`,
        );
      }
    } else if (field.purged_at === null && field.deleted_column_name !== null) {
      expectedColumns.add(field.deleted_column_name);
      if (!columns.has(field.deleted_column_name)) {
        problems.push(`deleted field ${field.id}: column ${field.deleted_column_name} is missing`);
      }
    } else {
      // Purged (or deleted without a column): nothing physical remains.
      continue;
    }
    for (const index of plan.indexes) expectedIndexes.add(index.name);
    if (plan.singleValue) expectedChecks.add(singleValueCheckName(canonical));
  }

  if (parentColumnKept(fields)) {
    expectedColumns.add(PARENT_COLUMN);
    expectedIndexes.add(parentIndexName(name));
    const actual = columns.get(PARENT_COLUMN);
    if (actual === undefined) problems.push(`column ${PARENT_COLUMN} is missing`);
    else if (!sameColumn(actual, PARENT_COLUMN_EXPECTED)) {
      problems.push(`column ${PARENT_COLUMN} should be ${describeColumn(PARENT_COLUMN_EXPECTED)}`);
    }
    const self = (await foreignKeysReferencing(executor, name)).find(
      (fk) => fk.self && fk.column === PARENT_COLUMN,
    );
    if (self?.name !== parentForeignKeyName(name) || self.onDelete !== 'n') {
      problems.push(`foreign key ${parentForeignKeyName(name)} (ON DELETE SET NULL) is missing`);
    }
  }

  for (const old of oldColumns) {
    expectedColumns.add(old.name);
    const actual = columns.get(old.name);
    if (actual === undefined) {
      problems.push(`conversion column ${old.name} is missing`);
    } else if (!sameColumn(actual, old.plan.expected)) {
      problems.push(
        `conversion column ${old.name} is ${describeColumn(actual)}, expected ${describeColumn(old.plan.expected)}`,
      );
    }
  }

  for (const column of columns.keys()) {
    if (!expectedColumns.has(column)) problems.push(`column ${column} has no meta field`);
  }
  for (const index of expectedIndexes) {
    if (!indexes.has(index)) problems.push(`index ${index} is missing`);
  }
  for (const index of indexes) {
    if (expectedIndexes.has(index)) continue;
    // Optional scan index of a date column (T508, `SchemaService.ensureDueIndex`).
    if (isDueIndexOf(name, index, expectedColumns)) continue;
    problems.push(`index ${index} is not expected`);
  }
  for (const check of expectedChecks) {
    if (!checks.has(check)) problems.push(`check constraint ${check} is missing`);
  }
  for (const check of checks) {
    if (!expectedChecks.has(check)) problems.push(`check constraint ${check} is not expected`);
  }
  return problems;
}

/** `<table>_<column>_due` on a column the table is expected to have (BACKLOG T508). */
function isDueIndexOf(table: string, index: string, columns: ReadonlySet<string>): boolean {
  const prefix = `${table}_`;
  if (!index.startsWith(prefix) || !index.endsWith(DUE_INDEX_SUFFIX)) return false;
  return columns.has(index.slice(prefix.length, -DUE_INDEX_SUFFIX.length));
}
