import { analysisOfField } from '../../computed/definition/compute-model.js';
import { isComputedRow } from '../../computed/definition/definition.js';
import { loadBaseSchemaRows } from '../../computed/definition/schema-rows.js';
import { computedReferences, type AnalysisOf } from '../../records/computed/read/references.js';

import { aiOptionsOf, aiSourceFieldIds, isAiField } from './options.js';

import type { BaseSchemaRows, SchemaReadability } from '../../computed/definition/schema-rows.js';
import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { FieldRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';
import type { FormulaAnalysis } from '@cellhive/formula-engine';

/**
 * What flows into the prompt of an AI field (BACKLOG T910, coordinator rule
 * on Quyết định S8 #9): the fields it names and, for a formula/lookup it
 * names, every field of the same record that one reads, transitively. One
 * rule for every read path (query, export, history, field API, realtime).
 */

/** Analyses of a base's computed fields, one parse per field. */
export function aiAnalysisOf(rows: BaseSchemaRows): AnalysisOf {
  const analyses = new Map<string, FormulaAnalysis | null>();
  return (field) => {
    if (!analyses.has(field.id)) analyses.set(field.id, analysisOfField(field, rows));
    return analyses.get(field.id) ?? null;
  };
}

/**
 * Every field whose value flows into the prompt of `field` (`[]` for a
 * field that is not an AI field): its sources, plus the same-record fields
 * computed sources read, transitively, whatever `strict_computed_permissions`.
 */
export function aiReadFieldIds(
  field: { readonly type: string; readonly options: unknown },
  rows: BaseSchemaRows,
  analysisOf: AnalysisOf = aiAnalysisOf(rows),
): Id<'fld'>[] {
  const ai = aiOptionsOf(field);
  if (ai === null) return [];
  const byId = new Map<string, FieldRow>(rows.fields.map((row) => [row.id, row]));
  const out = new Set<string>();
  for (const id of aiSourceFieldIds(ai.prompt)) {
    out.add(id);
    const source = byId.get(id);
    if (source === undefined || !isComputedRow(source)) continue;
    const references = computedReferences(source, rows, analysisOf);
    for (const read of references.sameRowFields) out.add(read);
    for (const read of references.strictFields) out.add(read);
  }
  return [...out].sort() as Id<'fld'>[];
}

/**
 * Field types whose cell shows other records: a link (titles of the linked
 * table) and a tree parent (the title of another record of the table).
 */
const RECORD_REFERENCE_TYPES: ReadonlySet<string> = new Set(['link', 'parent']);

/**
 * Of `sourceIds`, the fields that read another record or table: a link or
 * a parent field (rendered as the titles of the records it points to), and
 * formulas/lookups reading a link, a lookup or `[Table]` at any depth. An
 * AI field may not read them (`CROSS_TABLE_NOT_SUPPORTED`) — the worker
 * reads every record, a reader under a record or table rule would learn
 * records they cannot read.
 */
export function aiCrossRecordSources(
  sourceIds: readonly string[],
  rows: BaseSchemaRows,
  analysisOf: AnalysisOf = aiAnalysisOf(rows),
): Id<'fld'>[] {
  const byId = new Map<string, FieldRow>(rows.fields.map((row) => [row.id, row]));
  return sourceIds.filter((id) => {
    const source = byId.get(id);
    if (source === undefined) return false;
    if (RECORD_REFERENCE_TYPES.has(source.type)) return true;
    if (!isComputedRow(source)) return false;
    const references = computedReferences(source, rows, analysisOf);
    return references.tables.size > 0 || references.crossFields.size > 0;
  }) as Id<'fld'>[];
}

/**
 * Whether a reader sees `null` and a lock instead of the values of an AI
 * field (always strict): they cannot read one of {@link aiReadFieldIds}.
 * `isReadable` answers for fields of the field's own table.
 */
export function aiFieldLockedFor(
  field: { readonly type: string; readonly options: unknown },
  rows: BaseSchemaRows,
  isReadable: (fieldId: Id<'fld'>) => boolean,
): boolean {
  return aiReadFieldIds(field, rows).some((id) => !isReadable(id));
}

/** Whether a reader is locked out of an AI field (see {@link aiFieldLockedFor}). */
export type AiLockRule = (
  field: { readonly type: string; readonly options: unknown },
  isReadable: (fieldId: Id<'fld'>) => boolean,
) => boolean;

/**
 * {@link aiFieldLockedFor} for the fields of one table (`tableRows`, its
 * active fields), loading the base's rows only when an AI field of it names
 * a formula/lookup (whose same-record reads count too).
 */
export async function loadAiLockRule(
  db: Db,
  scope: OrgScope,
  baseId: BaseSchemaRows['baseId'],
  tableRows: readonly FieldRow[],
): Promise<AiLockRule> {
  const computed = new Set<string>(tableRows.filter(isComputedRow).map((row) => row.id));
  const needsBase = tableRows.some((row) => {
    const ai = aiOptionsOf(row);
    return ai !== null && aiSourceFieldIds(ai.prompt).some((id) => computed.has(id));
  });
  const rows: BaseSchemaRows = needsBase
    ? await loadBaseSchemaRows(db, scope, baseId)
    : { baseId, tables: [], fields: tableRows };
  const analysisOf = aiAnalysisOf(rows);
  return (field, isReadable) =>
    aiReadFieldIds(field, rows, analysisOf).some((id) => !isReadable(id));
}

/**
 * `readable` without the AI fields its reader is locked out of, nor the
 * formulas/lookups of the same record built on one (QA S8): a formula or
 * lookup checked for them (save, preview, AI formula) treats such a field
 * like one they cannot read — a field that does not exist (`UNKNOWN_FIELD`)
 * — so AI values never reach them through a formula, whatever
 * `strict_computed_permissions` (AI values are always strict).
 */
export function withoutLockedAiFields(
  readable: SchemaReadability,
  rows: BaseSchemaRows,
): SchemaReadability {
  const byId = new Map<string, FieldRow>(rows.fields.map((row) => [row.id, row]));
  const analysisOf = aiAnalysisOf(rows);
  const unreadable = (owner: FieldRow) => (id: string) =>
    !readable.field(byId.get(id)?.table_id ?? owner.table_id, id as Id<'fld'>);
  const locked = new Map<string, boolean>();
  const lockedOut = (field: FieldRow): boolean => {
    let found = locked.get(field.id);
    if (found === undefined) {
      if (isAiField(field)) {
        found = aiReadFieldIds(field, rows, analysisOf).some(unreadable(field));
      } else if (isComputedRow(field)) {
        found = [...computedReferences(field, rows, analysisOf).strictFields].some(
          unreadable(field),
        );
      } else {
        found = false;
      }
      locked.set(field.id, found);
    }
    return found;
  };
  return {
    table: (tableId) => readable.table(tableId),
    field: (tableId, fieldId) => {
      if (!readable.field(tableId, fieldId)) return false;
      const field = byId.get(fieldId);
      return field === undefined || !lockedOut(field);
    },
  };
}
