import { analysisOfField } from '../../../computed/definition/compute-model.js';
import { isComputedRow } from '../../../computed/definition/definition.js';

import type {
  BaseSchemaRows,
  SchemaReadability,
} from '../../../computed/definition/schema-rows.js';
import type { FieldRow } from '../../../db/schema.js';
import type { Id } from '@cellhive/contracts';
import type { FormulaAnalysis } from '@cellhive/formula-engine';

/**
 * What a formula/lookup field reads, followed through the computed fields it
 * reads (BACKLOG T457, S4b open question #1): the base of the permission
 * rules of computed values.
 *
 * - `tables`: every table whose records it reads (`[Table]`, links, lookups;
 *   the own table too through a self-link), at any depth;
 * - `crossFields`: fields read on **other** records (through a link, a
 *   self-link, `[Table]`, a lookup, including their conditions), at any
 *   depth — a same-row field of a computed field read on other records is
 *   read on other records too;
 * - `sameRowFields`: fields of the field's own record (links it walks
 *   through included), at any depth through same-row computed fields.
 *
 * Deleted fields and tables are not listed (T460 marks the field `#REF`).
 */
export interface ComputedReferences {
  readonly tables: ReadonlySet<string>;
  readonly crossFields: ReadonlySet<string>;
  readonly sameRowFields: ReadonlySet<string>;
}

/** The analysis of a saved computed field (`null` when it no longer analyses). */
export type AnalysisOf = (field: FieldRow) => FormulaAnalysis | null;

export function computedReferences(
  field: FieldRow,
  rows: BaseSchemaRows,
  analysisOf: AnalysisOf,
): ComputedReferences {
  const byId = new Map(rows.fields.map((row) => [row.id as string, row]));
  const tables = new Set<string>();
  const crossFields = new Set<string>();
  const sameRowFields = new Set<string>();
  const visited = new Set<string>();

  const walk = (current: FieldRow, cross: boolean): void => {
    const key = `${current.id}:${cross ? 'x' : 's'}`;
    if (visited.has(key)) return;
    visited.add(key);
    const analysis = analysisOf(current);
    if (analysis === null) return;
    for (const table of analysis.referenced_tables) tables.add(table);
    for (const dependency of analysis.dependencies) {
      const row = byId.get(dependency.field_id);
      if (row === undefined || row.deleted_at !== null) continue;
      const other = cross || dependency.kind !== 'same_row';
      (other ? crossFields : sameRowFields).add(row.id);
      if (isComputedRow(row)) walk(row, other);
    }
  };
  walk(field, false);
  return { tables, crossFields, sameRowFields };
}

/**
 * Whether a reader sees `null` and a lock in place of the values of a
 * computed field (S4b open question #1a, SPEC §5.8, §9.5): it reads a table
 * the reader cannot read, or a field of other records the reader cannot
 * read (`no_perm`); with the base setting `strict_computed_permissions`,
 * also a field of the same record the reader cannot read. Otherwise the
 * value shows, like in Lark.
 */
export function isComputedLocked(
  references: ComputedReferences,
  rows: BaseSchemaRows,
  readable: SchemaReadability,
  strict: boolean,
): boolean {
  const tableOf = new Map(rows.fields.map((row) => [row.id as string, row.table_id]));
  for (const table of references.tables) {
    if (!readable.table(table as Id<'tbl'>)) return true;
  }
  const unreadable = (fieldId: string): boolean => {
    const tableId = tableOf.get(fieldId);
    if (tableId === undefined) return false;
    return !readable.table(tableId) || !readable.field(tableId, fieldId as Id<'fld'>);
  };
  for (const field of references.crossFields) if (unreadable(field)) return true;
  if (strict) {
    for (const field of references.sameRowFields) if (unreadable(field)) return true;
  }
  return false;
}

/** `meta.bases.settings.strict_computed_permissions` (SPEC §9.5, CONTRACTS §5A); default `false`. */
export function strictComputedPermissionsOf(settings: unknown): boolean {
  return (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    (settings as Record<string, unknown>)['strict_computed_permissions'] === true
  );
}

/** A cache of saved analyses of a base (one parse per field). */
function analysesOf(rows: BaseSchemaRows): AnalysisOf {
  const analyses = new Map<string, FormulaAnalysis | null>();
  return (field) => {
    if (!analyses.has(field.id)) analyses.set(field.id, analysisOfField(field, rows));
    return analyses.get(field.id) ?? null;
  };
}

/** {@link isComputedLocked} of one saved formula/lookup field (field API `locked`). */
export function isComputedFieldLocked(
  field: FieldRow,
  rows: BaseSchemaRows,
  readable: SchemaReadability,
  strict: boolean,
): boolean {
  if (!isComputedRow(field)) return false;
  return isComputedLocked(
    computedReferences(field, rows, analysesOf(rows)),
    rows,
    readable,
    strict,
  );
}

/**
 * Formula/lookup fields of `tableId` locked for a reader (view configs):
 * {@link isComputedLocked} of each active one.
 */
export function lockedComputedFieldIds(
  rows: BaseSchemaRows,
  tableId: Id<'tbl'>,
  readable: SchemaReadability,
  strict: boolean,
): Set<Id<'fld'>> {
  const analysisOf = analysesOf(rows);
  const out = new Set<Id<'fld'>>();
  for (const field of rows.fields) {
    if (field.table_id !== tableId || field.deleted_at !== null || !isComputedRow(field)) continue;
    if (isComputedLocked(computedReferences(field, rows, analysisOf), rows, readable, strict)) {
      out.add(field.id);
    }
  }
  return out;
}
