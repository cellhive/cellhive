import { isId } from '@cellhive/contracts';
import {
  FIELD_TYPE_REGISTRY,
  isS1FieldType,
  type FieldDefinitionRef,
  type S1FieldType,
} from '@cellhive/field-types';
import { sql, type RawBuilder } from 'kysely';

import {
  assertDataTableName,
  assertFieldColumnName,
  assertOldColumnName,
  assertShadowColumnName,
  DATA_SCHEMA,
  OLD_COLUMN_NAME_PATTERN,
} from './names.js';
import {
  addColumnSql,
  createIndexSql,
  dropIndexSql,
  dropSingleValueCheckSql,
  planColumn,
  planComputedColumn,
  singleValueCheckSql,
  type ColumnPlan,
} from './physical.js';

import type { AuditContext } from '../audit/audit-entry.js';
import type {
  ComputeMode,
  FieldConversionRow,
  JsonObject,
  JsonValue,
  TableRow,
} from '../db/schema.js';

/**
 * DDL and definitions of field type conversions (SPEC §5.5, T403), used by
 * `SchemaService` only (AGENTS.md rule 1). Identifiers come from meta and
 * pass their pattern before `sql.id`; column types come from `planColumn`.
 *
 * Life of the columns (BACKLOG S4 design decision #8: while the job runs,
 * the field keeps showing its old values, read-only):
 * 1. start: `ADD COLUMN f_x__new_<ms>` (the shadow, new type, no
 *    constraint); the field keeps its definition and its column `f_x`;
 * 2. the job fills the shadow from `f_x` (or from the system column a
 *    computed source reads);
 * 3. end: `f_x` loses its CHECK/indexes and becomes `f_x__old_<ms>`, the
 *    shadow becomes `f_x` with the new CHECK/indexes, meta switches — one
 *    transaction; a failed job drops the shadow instead;
 * 4. revert (7 days): drop `f_x`, rename `f_x__old_<ms>` back with its
 *    CHECK/indexes; cleanup: drop `f_x__old_<ms>`.
 */

/** What a conversion stores of a definition (`from_definition` / `to_definition`). */
export interface StoredDefinition {
  readonly type: S1FieldType;
  /** Options parsed by the type's schema. */
  readonly options: JsonObject;
  readonly unique_values: boolean;
}

export function definitionJson(definition: StoredDefinition): JsonObject {
  return {
    type: definition.type,
    options: definition.options,
    unique_values: definition.unique_values,
  };
}

/** A stored definition read back from `meta.field_conversions`; throws on corrupt meta. */
export function storedDefinitionOf(json: JsonValue): StoredDefinition {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new TypeError('field conversion: definition is not an object');
  }
  const type = json.type;
  if (typeof type !== 'string' || !isS1FieldType(type)) {
    throw new TypeError('field conversion: unknown type in definition');
  }
  const options = FIELD_TYPE_REGISTRY[type].optionsSchema.parse(json.options ?? {}) as JsonObject;
  return { type, options, unique_values: json.unique_values === true };
}

/**
 * The type named by a stored definition, for any conversion (link
 * conversions of T404 store `link` definitions, which
 * {@link storedDefinitionOf} does not parse).
 */
export function definitionTypeOf(json: JsonValue): string {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new TypeError('field conversion: definition is not an object');
  }
  if (typeof json.type !== 'string') throw new TypeError('field conversion: no type');
  return json.type;
}

/**
 * What a conversion stores of a formula/lookup definition (T463, CONTRACTS
 * §4.1): its options (stored form), result type and mode, and the
 * dependency edges it had (restored by a revert when the definition no
 * longer analyses; `REF`/`CIRCLE` are then worked out from them, T460).
 */
export interface ComputedStoredDefinition {
  readonly type: 'formula' | 'lookup';
  readonly options: JsonObject;
  readonly unique_values: false;
  readonly result_type: JsonValue;
  readonly compute_mode: ComputeMode;
  /** `meta.field_dependencies` of the field as `{ depends_on, kind, paths }`. */
  readonly dependencies: JsonValue;
}

/** Whether a stored definition is a formula/lookup one. */
export function isComputedDefinitionJson(json: JsonValue): boolean {
  const type = definitionTypeOf(json);
  return type === 'formula' || type === 'lookup';
}

/** A formula/lookup definition read back (`null` for any other type); throws on corrupt meta. */
export function computedDefinitionOf(json: JsonValue): ComputedStoredDefinition | null {
  if (!isComputedDefinitionJson(json)) return null;
  const value = json as JsonObject;
  const options = value.options;
  const mode = value.compute_mode;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('field conversion: computed definition without options');
  }
  if (mode !== 'stored' && mode !== 'virtual') {
    throw new TypeError('field conversion: computed definition without mode');
  }
  return {
    type: value.type as 'formula' | 'lookup',
    options,
    unique_values: false,
    result_type: value.result_type ?? null,
    compute_mode: mode,
    dependencies: value.dependencies ?? [],
  };
}

export function computedDefinitionJson(definition: ComputedStoredDefinition): JsonObject {
  return {
    type: definition.type,
    options: definition.options,
    unique_values: false,
    result_type: definition.result_type,
    compute_mode: definition.compute_mode,
    dependencies: definition.dependencies,
  };
}

/**
 * Column plan of a computed definition on `column` (`null` for `virtual`):
 * the column of its result type, without CHECK or index (T456).
 */
export function planComputedDefinition(
  definition: ComputedStoredDefinition,
  column: string,
  table: Pick<TableRow, 'collation'>,
): ColumnPlan | null {
  if (definition.compute_mode !== 'stored') return null;
  return planComputedColumn(column, definition.result_type, table.collation);
}

/**
 * The column plan of either kind of stored definition on `column` (the
 * old column of a revert, the shadow of a conversion), `null` without one.
 */
export function planAnyDefinition(
  json: JsonValue,
  column: string,
  table: Pick<TableRow, 'db_table_name' | 'collation'>,
  isPrimary: boolean,
): ColumnPlan | null {
  const computed = computedDefinitionOf(json);
  if (computed !== null) return planComputedDefinition(computed, column, table);
  return planDefinition(storedDefinitionOf(json), column, table, isPrimary);
}

export function definitionRefOf(definition: StoredDefinition): FieldDefinitionRef {
  return { type: definition.type, options: definition.options };
}

const tableRef = (table: string) => sql.id(DATA_SCHEMA, assertDataTableName(table));

/** Column plan of a definition on `column` (canonical `f_…`); `null` without a column. */
export function planDefinition(
  definition: StoredDefinition,
  column: string,
  table: Pick<TableRow, 'db_table_name' | 'collation'>,
  isPrimary: boolean,
): ColumnPlan | null {
  return planColumn(
    {
      type: definition.type,
      options: definition.options,
      column,
      isPrimary,
      uniqueValues: definition.unique_values,
    },
    table.db_table_name,
    table.collation,
  );
}

/** A plan with its CHECK and indexes left out (shadow and old columns carry the type only). */
function bare(plan: ColumnPlan): ColumnPlan {
  return { ...plan, singleValue: false, indexes: [] };
}

/** Step 1: the shadow column, typed as the new definition, without constraint. */
export function addShadowColumnSql(
  table: string,
  newPlan: ColumnPlan,
  shadow: string,
): RawBuilder<unknown> {
  return addColumnSql(table, bare(newPlan), assertShadowColumnName(shadow));
}

/**
 * Step 3: the swap. The old column (when the field had one) drops its CHECK
 * and indexes (their names belong to the canonical column) and becomes
 * `f_x__old_<ms>`; the shadow becomes the canonical column and gets the new
 * CHECK and indexes.
 */
export function swapColumnsSql(
  table: string,
  oldPlan: ColumnPlan | null,
  oldColumn: string | null,
  newPlan: ColumnPlan,
  shadow: string,
): readonly RawBuilder<unknown>[] {
  const statements: RawBuilder<unknown>[] = [];
  if (oldPlan !== null && oldColumn !== null) {
    if (oldPlan.singleValue) statements.push(dropSingleValueCheckSql(table, oldPlan.column));
    for (const index of oldPlan.indexes) statements.push(dropIndexSql(index));
    statements.push(
      sql`ALTER TABLE ${tableRef(table)} RENAME COLUMN ${sql.id(assertFieldColumnName(oldPlan.column))} TO ${sql.id(assertOldColumnName(oldColumn))}`,
    );
  }
  statements.push(
    sql`ALTER TABLE ${tableRef(table)} RENAME COLUMN ${sql.id(assertShadowColumnName(shadow))} TO ${sql.id(assertFieldColumnName(newPlan.column))}`,
  );
  if (newPlan.singleValue) statements.push(singleValueCheckSql(table, newPlan.column));
  for (const index of newPlan.indexes)
    statements.push(createIndexSql(table, newPlan.column, index));
  return statements;
}

/**
 * The swap of a conversion to a `virtual` formula/lookup (T463): no shadow
 * (nothing is stored); the old column only loses its CHECK and indexes and
 * becomes `f_x__old_<ms>`.
 */
export function retireColumnSql(
  table: string,
  oldPlan: ColumnPlan,
  oldColumn: string,
): readonly RawBuilder<unknown>[] {
  return [
    ...(oldPlan.singleValue ? [dropSingleValueCheckSql(table, oldPlan.column)] : []),
    ...oldPlan.indexes.map((index) => dropIndexSql(index)),
    sql`ALTER TABLE ${tableRef(table)} RENAME COLUMN ${sql.id(assertFieldColumnName(oldPlan.column))} TO ${sql.id(assertOldColumnName(oldColumn))}`,
  ];
}

/**
 * The revert of a conversion from or to a formula/lookup (T463): the
 * current column goes when there is one (`virtual` fields have none), the
 * old one (when the field had one) is renamed back with its CHECK and
 * indexes (none for a computed column).
 */
export function revertAnyColumnSql(
  table: string,
  currentColumn: string | null,
  oldColumn: string | null,
  oldPlan: ColumnPlan | null,
): readonly RawBuilder<unknown>[] {
  const statements: RawBuilder<unknown>[] = [];
  if (currentColumn !== null) {
    statements.push(
      sql`ALTER TABLE ${tableRef(table)} DROP COLUMN IF EXISTS ${sql.id(assertFieldColumnName(currentColumn))}`,
    );
  }
  if (oldColumn === null || oldPlan === null) return statements;
  statements.push(
    sql`ALTER TABLE ${tableRef(table)} RENAME COLUMN ${sql.id(assertOldColumnName(oldColumn))} TO ${sql.id(assertFieldColumnName(oldPlan.column))}`,
  );
  if (oldPlan.singleValue) statements.push(singleValueCheckSql(table, oldPlan.column));
  for (const index of oldPlan.indexes)
    statements.push(createIndexSql(table, oldPlan.column, index));
  return statements;
}

/** A failed or abandoned conversion: its shadow column goes. */
export function dropShadowColumnSql(table: string, shadow: string): RawBuilder<unknown> {
  return sql`ALTER TABLE ${tableRef(table)} DROP COLUMN IF EXISTS ${sql.id(assertShadowColumnName(shadow))}`;
}

/**
 * Step 4, the revert (ADR-23 §3): drops the converted column, renames the
 * old one back and restores its CHECK and indexes. Without an old column
 * (the field read a system column) only the drop.
 */
export function revertColumnSql(
  table: string,
  newColumn: string,
  oldColumn: string | null,
  oldPlan: ColumnPlan | null,
): readonly RawBuilder<unknown>[] {
  const statements: RawBuilder<unknown>[] = [
    sql`ALTER TABLE ${tableRef(table)} DROP COLUMN ${sql.id(assertFieldColumnName(newColumn))}`,
  ];
  if (oldColumn === null || oldPlan === null) return statements;
  statements.push(
    sql`ALTER TABLE ${tableRef(table)} RENAME COLUMN ${sql.id(assertOldColumnName(oldColumn))} TO ${sql.id(assertFieldColumnName(oldPlan.column))}`,
  );
  if (oldPlan.singleValue) statements.push(singleValueCheckSql(table, oldPlan.column));
  for (const index of oldPlan.indexes)
    statements.push(createIndexSql(table, oldPlan.column, index));
  return statements;
}

/**
 * "Restore as a new field": the old column becomes the column of a new
 * field (`plan`, on its own canonical name) with its CHECK and indexes.
 */
export function restoreOldColumnAsSql(
  table: string,
  oldColumn: string,
  plan: ColumnPlan,
): readonly RawBuilder<unknown>[] {
  return [
    sql`ALTER TABLE ${tableRef(table)} RENAME COLUMN ${sql.id(assertOldColumnName(oldColumn))} TO ${sql.id(assertFieldColumnName(plan.column))}`,
    ...(plan.singleValue ? [singleValueCheckSql(table, plan.column)] : []),
    ...plan.indexes.map((index) => createIndexSql(table, plan.column, index)),
  ];
}

/** `DROP COLUMN f_x__old_<ms>` (cleanup after 7 days). */
export function dropOldColumnSql(table: string, oldColumn: string): RawBuilder<unknown> {
  return sql`ALTER TABLE ${tableRef(table)} DROP COLUMN IF EXISTS ${sql.id(assertOldColumnName(oldColumn))}`;
}

/** `f_x` of `f_x__old_<ms>`. */
export function canonicalOfOldColumn(oldColumn: string): string {
  const match = OLD_COLUMN_NAME_PATTERN.exec(oldColumn);
  if (match?.[1] === undefined) throw new TypeError(`Invalid old column name: ${oldColumn}`);
  return match[1];
}

/** A column of a conversion kept by compaction and checked by the consistency checker. */
export interface ConversionColumn {
  readonly name: string;
  /** Plan of its definition on the canonical column, without constraints. */
  readonly plan: ColumnPlan;
}

/**
 * Columns of the conversions of a table that exist besides the fields'
 * own: the shadow of a `running` conversion (new definition) and the old
 * column of a `succeeded` one (old definition), both without constraints.
 */
export function conversionColumnsOf(
  conversions: readonly FieldConversionRow[],
  table: Pick<TableRow, 'db_table_name' | 'collation'>,
): ConversionColumn[] {
  return conversions.flatMap((conversion): ConversionColumn[] => {
    // Link conversions (T404) have no column in the data table.
    if (
      conversion.kind !== 'column' ||
      conversion.new_column_name === null ||
      conversion.shadow_column_name === null
    ) {
      return [];
    }
    // T463: a formula/lookup definition plans the column of its result type
    // (a `virtual` target has no shadow, a `virtual` source no old column).
    if (conversion.status === 'running') {
      const plan = planAnyDefinition(
        withoutUnique(conversion.to_definition),
        conversion.new_column_name,
        table,
        false,
      );
      return plan === null ? [] : [{ name: conversion.shadow_column_name, plan: bare(plan) }];
    }
    if (conversion.status !== 'succeeded' || conversion.old_column_name === null) return [];
    const plan = planAnyDefinition(
      withoutUnique(conversion.from_definition),
      canonicalOfOldColumn(conversion.old_column_name),
      table,
      false,
    );
    return plan === null ? [] : [{ name: conversion.old_column_name, plan: bare(plan) }];
  });
}

/** A stored definition with `unique_values` off (shadow and old columns carry no index). */
function withoutUnique(json: JsonValue): JsonValue {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  return { ...json, unique_values: false };
}

/**
 * Audit context of the end of a backfill: the person who started the
 * conversion (system when unknown), `batch_id` = the job, the request that
 * started it, and `via.api_token_id` when it was started through an API
 * token (T705; contexts stored before T705 have none).
 */
export function conversionAuditContext(conversion: FieldConversionRow): AuditContext {
  const context = conversion.context;
  const stored =
    typeof context === 'object' && context !== null && !Array.isArray(context) ? context : {};
  const requestId = stored['request_id'];
  const tokenId = stored['api_token_id'];
  return {
    actor:
      conversion.created_by === null
        ? { type: 'system', id: null }
        : { type: 'user', id: conversion.created_by },
    via:
      conversion.created_by !== null && typeof tokenId === 'string' && isId('tok', tokenId)
        ? { api_token_id: tokenId }
        : null,
    batch_id: conversion.job_id,
    request_id: typeof requestId === 'string' && isId('req', requestId) ? requestId : null,
    ip: null,
    user_agent: null,
  };
}
