import { FieldsRepository } from '../../schema/fields.repository.js';
import { TablesRepository } from '../../schema/tables.repository.js';

import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { ComputeMode, FieldRow, TableRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';
import type {
  FormulaType,
  SchemaSnapshot,
  SnapshotField,
  SnapshotTable,
} from '@cellhive/formula-engine';

/**
 * The meta of a base as the computed-field code reads it (BACKLOG T456):
 * its tables outside the trash and their active fields, every type
 * included (links, parent, formula, lookup).
 */
export interface BaseSchemaRows {
  readonly baseId: Id<'bse'>;
  readonly tables: readonly TableRow[];
  readonly fields: readonly FieldRow[];
}

/** Two queries; honours a transaction in `scope`. */
export async function loadBaseSchemaRows(
  db: Db,
  scope: OrgScope,
  baseId: Id<'bse'>,
): Promise<BaseSchemaRows> {
  const tables = await new TablesRepository(db).listByBase(scope, baseId);
  const fields = await new FieldsRepository(db).listByTables(
    scope,
    tables.map((table) => table.id),
  );
  return { baseId, tables, fields };
}

/**
 * What a person may reference (SPEC §9.5): tables they see and fields that
 * are not `no_perm`. Absent = everything (the system: backfill, re-analysis
 * of dependents).
 */
export interface SchemaReadability {
  table(tableId: Id<'tbl'>): boolean;
  field(tableId: Id<'tbl'>, fieldId: Id<'fld'>): boolean;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A `FormulaType` read back from `meta.fields.result_type` (`null` when malformed). */
export function formulaTypeOf(value: unknown): FormulaType | null {
  if (!isRecord(value) || typeof value['kind'] !== 'string') return null;
  switch (value['kind']) {
    case 'any':
    case 'null':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'user':
    case 'attachment':
      return { kind: value['kind'] };
    case 'text':
      return typeof value['recordIdOf'] === 'string'
        ? { kind: 'text', recordIdOf: value['recordIdOf'] }
        : { kind: 'text' };
    case 'row':
    case 'table':
      return typeof value['tableId'] === 'string'
        ? { kind: value['kind'], tableId: value['tableId'] }
        : null;
    case 'list': {
      const element = formulaTypeOf(value['element']);
      return element === null ? null : { kind: 'list', element };
    }
    default:
      return null;
  }
}

/** Changes of a computed field not yet in meta (the definition being saved). */
export interface ComputedOverride {
  readonly resultType: FormulaType | null;
  readonly computeMode: ComputeMode | null;
}

/** The formula-engine view of a field row. */
export function snapshotFieldOf(field: FieldRow, override?: ComputedOverride): SnapshotField {
  const options = isRecord(field.options) ? field.options : null;
  const base: SnapshotField = { id: field.id, name: field.name, type: field.type, options };
  switch (field.type) {
    case 'link': {
      const target = options?.['link_table'];
      return { ...base, linkTableId: typeof target === 'string' ? target : null };
    }
    case 'parent':
      return { ...base, linkTableId: field.table_id };
    case 'formula':
    case 'lookup':
      return {
        ...base,
        resultType: override?.resultType ?? formulaTypeOf(field.result_type),
        computeMode: override?.computeMode ?? field.compute_mode,
      };
    default:
      return base;
  }
}

/**
 * The formula-engine snapshot of a base for a formula of `tableId`: the
 * tables and active fields `readable` lets through (all without it), each
 * table with its primary field (record titles). `overrides` replace the
 * result type and mode of computed fields being saved.
 */
export function snapshotOfBase(
  rows: BaseSchemaRows,
  tableId: Id<'tbl'>,
  readable?: SchemaReadability,
  overrides?: ReadonlyMap<string, ComputedOverride>,
): SchemaSnapshot {
  const tables: SnapshotTable[] = rows.tables
    .filter((table) => readable === undefined || readable.table(table.id))
    .map((table) => ({
      id: table.id,
      name: table.name,
      primaryFieldId: table.primary_field_id,
      fields: rows.fields
        .filter(
          (field) =>
            field.table_id === table.id &&
            field.deleted_at === null &&
            // A button holds no value a formula could read (T517): unknown to formulas.
            field.type !== 'button' &&
            (readable === undefined || readable.field(table.id, field.id)),
        )
        .map((field) => snapshotFieldOf(field, overrides?.get(field.id))),
    }));
  return { tableId, tables };
}
