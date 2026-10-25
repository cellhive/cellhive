import { formulaTypeOf } from '../../computed/definition/schema-rows.js';

import { recordReferenceFields, sourceFields, type TemplateSources } from './references.js';

import type { AutomationFieldMeta, AutomationValidationContext } from '../definition/validate.js';
import type { SchemaSnapshot, SnapshotField, SnapshotTable } from '@cellhive/formula-engine';

/**
 * Formula-engine snapshots for automation templates (BACKLOG T504): what the
 * person the automation runs as may reference — tables they read, fields
 * they read (not `no_perm`), computed fields locked for them left out
 * (T457: their value is hidden, so a template would only ever show empty).
 * The same snapshot checks a template when it is saved (the saver becomes
 * `run_as`) and resolves it at run time (`run_as` now), so a field deleted
 * or no longer readable resolves like a missing one.
 */

/** Table id used for a template whose trigger has no record (`schedule`). */
export const NO_RECORD_TABLE = '';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function snapshotFieldOf(field: AutomationFieldMeta): SnapshotField {
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
        resultType: formulaTypeOf(field.result_type),
        computeMode: field.compute_mode === 'virtual' ? 'virtual' : 'stored',
      };
    default:
      return base;
  }
}

/**
 * The snapshot for a template on records of `tableId` (`null`: no record).
 * `onlyFields` restricts the fields of `tableId` itself (a `digest` row has
 * only the fields its `find_records` step returns). Every table also has
 * `[@id]`/`[@url]`; with `sources`, the row the template runs on also has
 * the trigger data and the earlier step records (T505, `references.ts`) —
 * for a trigger without record, on an empty table of id `NO_RECORD_TABLE`.
 */
export function automationSnapshot(
  context: AutomationValidationContext,
  tableId: string | null,
  onlyFields: ReadonlySet<string> | null = null,
  sources: TemplateSources | null = null,
): SchemaSnapshot {
  const tableIds = new Set(context.tables.map((table) => table.id));
  const extra = sources === null ? [] : sourceFields(sources);
  const tables: SnapshotTable[] = [];
  for (const table of context.tables) {
    const access = context.access.tables[table.id];
    if (access === undefined || !tableIds.has(table.id)) continue;
    const fields = context.fields
      .filter(
        (field) =>
          field.table_id === table.id &&
          access.fields[field.id] !== undefined &&
          context.lockedFieldIds?.has(field.id) !== true &&
          (onlyFields === null || field.table_id !== tableId || onlyFields.has(field.id)),
      )
      .map(snapshotFieldOf);
    // Real fields first: a field named like a reference keeps its name.
    fields.push(...recordReferenceFields(), ...(table.id === tableId ? extra : []));
    tables.push({
      id: table.id,
      name: table.name ?? table.id,
      fields,
      primaryFieldId: table.primary_field_id ?? null,
    });
  }
  if (tableId === null && extra.length > 0) {
    tables.push({
      id: NO_RECORD_TABLE,
      name: NO_RECORD_TABLE,
      fields: extra,
      primaryFieldId: null,
    });
  }
  return { tableId: tableId ?? NO_RECORD_TABLE, tables };
}

/** Fields of a `find_records` step's records: its `fields`, else the primary field. */
export function stepFieldsOf(
  context: AutomationValidationContext,
  tableId: string,
  fields: readonly string[],
): ReadonlySet<string> {
  if (fields.length > 0) return new Set(fields);
  const primary = context.tables.find((table) => table.id === tableId)?.primary_field_id;
  return new Set(primary === undefined || primary === null ? [] : [primary]);
}
