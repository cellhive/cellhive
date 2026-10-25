import {
  getFieldType,
  isImplementedFieldType,
  type AnyFieldTypeDefinition,
  type ImplementedFieldType,
} from '@cellhive/field-types';
import {
  resolveVariables,
  validateFilter,
  type FilterNode,
  type ResolveContext,
  type ResolvedFilterNode,
} from '@cellhive/filter-dsl';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { compileToSql, type SqlFilterFieldMeta, type SqlFilterTableMeta } from '../query/index.js';
import { assertFieldColumnName } from '../schema/names.js';

import { toLinkFieldModel, type LinkFieldModel } from './links/link-model.js';
import { toParentFieldModel, type ParentFieldModel } from './tree/parent-model.js';

import type { FieldRow, TableRow } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';
import type { TableAccess } from '@cellhive/permissions';

/**
 * The record services' view of a table: the fields the query engine and the
 * write path support (implemented types), with their parsed options and physical
 * column. Shared by `RecordQueryService` and `RecordMutationService` so both
 * resolve fields, visibility and record rules identically.
 */

/** A field of the table with everything the record pipelines need. */
export interface FieldModel {
  readonly id: Id<'fld'>;
  readonly name: string;
  readonly type: ImplementedFieldType;
  readonly isPrimary: boolean;
  readonly definition: AnyFieldTypeDefinition;
  /** Options parsed by the type's schema. */
  readonly options: unknown;
  /** Physical column: `f_…`, or the system column of created/updated at/by. */
  readonly column: string;
  /** The field owns its column (`f_…`); `false` for created/updated at/by. */
  readonly ownsColumn: boolean;
  readonly filterMeta: SqlFilterFieldMeta;
  readonly row: FieldRow;
}

export interface TableModel {
  readonly table: TableRow;
  /** Every field the record services support, in display order. */
  readonly fields: readonly FieldModel[];
  /** Fields the principal may read (field perm ≠ `no_perm`), in display order. */
  readonly visible: readonly FieldModel[];
  readonly filterMeta: SqlFilterTableMeta;
  /**
   * `filterMeta` plus the table's link fields (T402) once `LinkFilterMeta`
   * added them: request filters, saved view filters and record rules (SQL)
   * use it. A record rule naming a link field (T710) needs it, else it
   * fails closed (`LinkFilterMeta.forRules`).
   */
  readonly queryFilterMeta: SqlFilterTableMeta;
  /**
   * `link` fields (S4, T401): no column of their own, so they are not in
   * `fields` (nor in `filterMeta`); `records/links/**` reads and writes them.
   */
  readonly links: readonly LinkFieldModel[];
  /** Link fields the principal may read, in display order. */
  readonly visibleLinks: readonly LinkFieldModel[];
  /**
   * The active `parent` field of a table with sub-records (T405; values in
   * `__parent_id`, read and written by `records/tree/**`), else `null`.
   */
  readonly parent: ParentFieldModel | null;
  /** `parent` when the principal may read it, else `null`. */
  readonly visibleParent: ParentFieldModel | null;
}

/** The model of one field row, or `null` for types the record services do not support yet. */
export function toFieldModel(row: FieldRow): FieldModel | null {
  // Link, lookup, formula, parent: later S4 tasks. Not selectable before that.
  if (!isImplementedFieldType(row.type)) return null;
  const definition = getFieldType(row.type);
  if (definition === undefined) return null;
  const column =
    definition.systemColumn ??
    (row.db_column_name === null ? null : assertFieldColumnName(row.db_column_name));
  if (column === null) return null;
  // Meta is trusted and written through the same schemas: a parse error is a bug.
  const options = definition.optionsSchema.parse(row.options ?? {});
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    isPrimary: row.is_primary,
    definition,
    options,
    column,
    ownsColumn: definition.systemColumn === null,
    filterMeta: {
      id: row.id,
      name: row.name,
      type: row.type,
      options: row.options,
      dbColumnName: row.db_column_name,
    },
    row,
  };
}

/** Field perm other than `no_perm`; fields missing from the access (e.g. added since) are hidden. */
export function readable(tableAccess: TableAccess | null, fieldId: Id<'fld'>): boolean {
  if (tableAccess === null || !Object.hasOwn(tableAccess.fields, fieldId)) return false;
  const perm: string = tableAccess.fields[fieldId] ?? 'no_perm';
  return perm !== 'no_perm';
}

/**
 * Builds the model of `table` from its active field rows for a principal
 * (`null`: a principal without access to the table, who reads no field).
 */
export function buildTableModel(
  table: TableRow,
  rows: readonly FieldRow[],
  tableAccess: TableAccess | null,
): TableModel {
  const fields = rows.map(toFieldModel).filter((field) => field !== null);
  const links = rows.map(toLinkFieldModel).filter((field) => field !== null);
  const parent = rows.map(toParentFieldModel).find((field) => field !== null) ?? null;
  const filterMeta = {
    collation: table.collation,
    fields: fields.map((field) => field.filterMeta),
  };
  return {
    table,
    fields,
    visible: fields.filter((field) => readable(tableAccess, field.id)),
    filterMeta,
    queryFilterMeta: filterMeta,
    links,
    visibleLinks: links.filter((field) => readable(tableAccess, field.id)),
    parent,
    visibleParent: parent !== null && readable(tableAccess, parent.id) ? parent : null,
  };
}

/**
 * A record rule of the principal on `model`'s table (`internal.readFilters`
 * or `internal.editFilters`, already OR-combined across roles by
 * `resolveBaseAccess`), validated and with its variables resolved:
 *
 * - `'all'`: no restriction (`null` in the access);
 * - `'none'`: no record matches — the table is missing from the rules, or
 *   the rule no longer validates against the table (e.g. it names a deleted
 *   field). Fails closed until the role is saved again;
 * - otherwise the resolved AST.
 */
export type ResolvedRule = 'all' | 'none' | ResolvedFilterNode;

export function resolveRule(
  rules: Readonly<Record<string, FilterNode | null>>,
  model: TableModel,
  context: ResolveContext,
): ResolvedRule {
  const tableId = model.table.id;
  if (!Object.hasOwn(rules, tableId)) return 'none';
  const rule: FilterNode | null | undefined = rules[tableId];
  if (rule === null) return 'all';
  if (rule === undefined) return 'none';
  // `queryFilterMeta`: role rules (T710) and the view filter a share link's
  // read rule holds (T409) may name link fields. Without link meta
  // (`LinkFilterMeta`) such a rule fails closed.
  const validated = validateFilter(
    rule,
    model.queryFilterMeta,
    model.queryFilterMeta.fields.map((field) => field.id),
  );
  if (!validated.ok) return 'none';
  return resolveVariables(validated.ast, context);
}

/** SQL condition of a resolved rule over the data table aliased `alias`. */
export function ruleSql(rule: ResolvedRule, model: TableModel, alias: string): RawBuilder<SqlBool> {
  if (rule === 'all') return sql<SqlBool>`true`;
  if (rule === 'none') return sql<SqlBool>`false`;
  return compileToSql(rule, model.queryFilterMeta, { tableAlias: alias });
}
