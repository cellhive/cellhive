import { FieldsRepository } from '../../schema/fields.repository.js';
import { analysisOfField } from '../definition/compute-model.js';
import { isComputedRow, prepareComputedDefinition } from '../definition/definition.js';
import { loadBaseSchemaRows, type BaseSchemaRows } from '../definition/schema-rows.js';
import {
  FieldDependenciesRepository,
  type FieldDependencyEdge,
} from '../graph/field-dependencies.repository.js';

import {
  definitionReferenceIds,
  desiredFieldErrors,
  newlyFailing,
  type FieldError,
} from './field-errors.js';

import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { ComputeMode, FieldRow, JsonValue } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * The meta of a base the field-level errors are computed from (BACKLOG
 * T460): active tables and fields, every dependency edge, and the fields
 * named by computed definitions or edges that are no longer active (their
 * table tells a deleted field from a table gone).
 */
export interface FieldErrorsState {
  readonly rows: BaseSchemaRows;
  readonly edges: readonly FieldDependencyEdge[];
  /** Named fields outside `rows` (trash, purged, or of a table outside the base's active ones). */
  readonly others: ReadonlyMap<string, FieldRow>;
}

/** Loads {@link FieldErrorsState}; honours a transaction in `scope`. */
export async function loadFieldErrorsState(
  db: Db,
  scope: OrgScope,
  baseId: Id<'bse'>,
): Promise<FieldErrorsState> {
  const rows = await loadBaseSchemaRows(db, scope, baseId);
  const edges = await new FieldDependenciesRepository(db).listByBase(scope, baseId);
  const active = new Set<string>(rows.fields.map((field) => field.id));
  const named = new Set<string>();
  for (const edge of edges) named.add(edge.dependsOnFieldId);
  for (const field of rows.fields) {
    if (!isComputedRow(field)) continue;
    definitionReferenceIds(field).fields.forEach((id) => named.add(id));
  }
  const missing = [...named].filter((id) => !active.has(id));
  const others = new Map<string, FieldRow>();
  for (const field of await new FieldsRepository(db).listByIds(scope, missing)) {
    others.set(field.id, field);
  }
  return { rows, edges, others };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether the saved definition of a computed field would still be accepted
 * as it is (T460 `INVALID_CONFIG`): the same checks as saving it — typecheck
 * and compile of the expression; for a lookup also its `where` (operators of
 * the source fields' types, `field_ref` pairs) and `select`.
 */
export function definitionStillValid(field: FieldRow, rows: BaseSchemaRows): boolean {
  if (analysisOfField(field, rows) === null) return false;
  const options = isRecord(field.options) ? field.options : {};
  try {
    prepareComputedDefinition(
      field.type === 'formula'
        ? {
            type: 'formula',
            options: { expression: options['expression'] },
            expressionForm: 'stored',
            style: { mode: 'default' },
          }
        : {
            type: 'lookup',
            options: {
              from: options['from'],
              select: options['select'],
              where: options['where'],
              ...(options['aggregate'] === undefined ? {} : { aggregate: options['aggregate'] }),
            },
            style: { mode: 'default' },
          },
      { rows, tableId: field.table_id, timeZone: 'UTC' },
    );
    return true;
  } catch {
    return false;
  }
}

/** The desired error of every active computed field of the state (see `desiredFieldErrors`). */
export function fieldErrorsOf(
  state: FieldErrorsState,
  causes?: ReadonlySet<string>,
): Map<string, FieldError | null> {
  const analyses = new Map<string, boolean>();
  const tables = new Map<string, string>(state.rows.fields.map((f) => [f.id, f.table_id]));
  return desiredFieldErrors({
    rows: state.rows,
    edges: state.edges,
    tableOfField: (id) => tables.get(id) ?? state.others.get(id)?.table_id,
    analyses: (field) => {
      let ok = analyses.get(field.id);
      if (ok === undefined) {
        ok = definitionStillValid(field, state.rows);
        analyses.set(field.id, ok);
      }
      return ok;
    },
    ...(causes === undefined ? {} : { causes }),
  });
}

/** A schema change whose consequences on computed fields a preview lists. */
export type ComputedImpactChange =
  | { readonly kind: 'delete_fields'; readonly fieldIds: readonly string[] }
  | { readonly kind: 'delete_table'; readonly tableId: string }
  | {
      readonly kind: 'retype_field';
      readonly fieldId: string;
      readonly type: string;
      readonly options: JsonValue;
      /**
       * A conversion to a formula/lookup (T463): its result type and mode.
       * Any other type clears the computed part of the field.
       */
      readonly computed?: { readonly resultType: JsonValue; readonly computeMode: ComputeMode };
    };

/**
 * Formula/lookup fields that are fine now and would be in error after
 * `change` (`dependents` of `convert-preview` and of the delete previews,
 * CONTRACTS §4.4, §13): `REF` for a deletion (directly or through another
 * computed field), `INVALID_CONFIG` for a type that no longer fits. The
 * fields of a deleted table are not listed (they go with it).
 */
export function computedImpactOf(
  state: FieldErrorsState,
  change: ComputedImpactChange,
): FieldRow[] {
  const before = fieldErrorsOf(state);
  const others = new Map(state.others);
  let rows: BaseSchemaRows;
  if (change.kind === 'delete_fields') {
    const removed = new Set(change.fieldIds);
    for (const field of state.rows.fields) if (removed.has(field.id)) others.set(field.id, field);
    rows = { ...state.rows, fields: state.rows.fields.filter((field) => !removed.has(field.id)) };
  } else if (change.kind === 'delete_table') {
    for (const field of state.rows.fields) {
      if (field.table_id === change.tableId) others.set(field.id, field);
    }
    rows = {
      ...state.rows,
      tables: state.rows.tables.filter((table) => table.id !== change.tableId),
      fields: state.rows.fields.filter((field) => field.table_id !== change.tableId),
    };
  } else {
    rows = {
      ...state.rows,
      fields: state.rows.fields.map((field) =>
        field.id === change.fieldId
          ? {
              ...field,
              type: change.type,
              options: change.options,
              result_type: change.computed?.resultType ?? null,
              compute_mode: change.computed?.computeMode ?? null,
              compute_state: change.computed === undefined ? null : ('ready' as const),
              compute_error: null,
            }
          : field,
      ),
    };
  }
  const after = fieldErrorsOf({ rows, edges: state.edges, others });
  const byId = new Map(rows.fields.map((field) => [field.id as string, field]));
  return newlyFailing(before, after).flatMap((id) => {
    const field = byId.get(id);
    return field === undefined ? [] : [field];
  });
}
