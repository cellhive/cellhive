import {
  computedImpactOf,
  displayExpression,
  fieldErrorOf,
  loadFieldErrorsState,
  type ComputedImpactChange,
  type Db,
  formulaReferenceIds,
  formulaTypeOf,
  isComputedFieldLocked,
  isComputedRow,
  publicResultType,
  snapshotOfBase,
  type BaseSchemaRows,
  type FieldRow,
  type FieldsRepository,
  type OrgScope,
  type SchemaReadability,
  type TableRow,
  type TablesRepository,
} from '@cellhive/server-core';

import { firstTimeZone, settingOf } from '../../common/access/time-zone.js';
import { canManageTable } from '../../common/schema/schema-access.js';

import type { BaseAccess } from '../../common/access/access.service.js';
import type {
  ComputeErrorDto,
  ComputedResultTypeDto,
  ComputeModeName,
  ComputeStateName,
  EffectiveAccess,
  FieldDependent,
  Id,
} from '@cellhive/contracts';

/**
 * Computed fields in the field API (BACKLOG T456, CONTRACTS §13): what the
 * caller may reference (SPEC §9.5) and how a formula/lookup field shows to
 * each reader — the definition (expression / lookup parts) only to readers
 * with schema rights on the table who read every table and field it names
 * (BACKLOG S4b open question #1c), everyone else gets `{ style }`.
 */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Tables the caller sees and fields that are not `no_perm` (like P08). */
export function readabilityOf(access: EffectiveAccess): SchemaReadability {
  return {
    table: (tableId) => access.tables[tableId] !== undefined,
    field: (tableId, fieldId) => {
      const perm: string | undefined = access.tables[tableId]?.fields[fieldId];
      return perm !== undefined && perm !== 'no_perm';
    },
  };
}

/** Zone of computed values (ADR-21): the organization's, else the instance default. */
export function organizationTimeZone(base: BaseAccess, fallback: string): string {
  return firstTimeZone([settingOf(base.org.membership.settings, 'timezone')], fallback);
}

/** The computed part of a field DTO (CONTRACTS §13). */
export interface ComputedDtoPart {
  readonly options: Record<string, unknown>;
  readonly result_type: ComputedResultTypeDto;
  readonly compute_mode: ComputeModeName;
  readonly compute_state: ComputeStateName;
  readonly compute_error: ComputeErrorDto | null;
  readonly locked: boolean;
}

/** Field ids a lookup `where` names (conditions and `field_ref`s). */
function whereFields(where: unknown, out: Set<string>): void {
  if (Array.isArray(where)) {
    for (const item of where) whereFields(item, out);
    return;
  }
  if (!isRecord(where)) return;
  for (const [key, value] of Object.entries(where)) {
    if ((key === 'field' || key === 'field_ref') && typeof value === 'string') out.add(value);
    else whereFields(value, out);
  }
}

/**
 * Whether `reader` may see the definition of `field`: schema rights on its
 * table, and every **active** table and field it names readable (deleted
 * ones show as `#REF[…]`, T460).
 */
export function definitionVisible(
  field: FieldRow,
  rows: BaseSchemaRows,
  access: EffectiveAccess,
): boolean {
  if (!canManageTable(access, field.table_id)) return false;
  const readable = readabilityOf(access);
  const options = isRecord(field.options) ? field.options : {};
  const fieldIds = new Set<string>();
  const tableIds = new Set<string>();
  if (field.type === 'formula') {
    const refs = formulaReferenceIds(
      typeof options.expression === 'string' ? options.expression : '',
    );
    if (refs === null) return false;
    refs.fields.forEach((id) => fieldIds.add(id));
    refs.tables.forEach((id) => tableIds.add(id));
  } else {
    if (typeof options.from === 'string') tableIds.add(options.from);
    if (typeof options.select === 'string') fieldIds.add(options.select);
    whereFields(options.where, fieldIds);
  }
  fieldIds.delete('__id');
  for (const id of tableIds) {
    const active = rows.tables.some((table) => table.id === id);
    if (active && !readable.table(id as Id<'tbl'>)) return false;
  }
  for (const id of fieldIds) {
    const active = rows.fields.find((row) => row.id === id);
    if (active === undefined) continue;
    if (!readable.field(active.table_id, active.id)) return false;
  }
  return true;
}

/**
 * `dependents` entries (CONTRACTS §4.4, §13; T460) for the formula/lookup
 * fields that `change` would put in error (`REF` / `INVALID_CONFIG`),
 * limited to those the caller can read (never a name or id they cannot see).
 */
export async function computedDependentsOf(
  db: Db,
  base: BaseAccess,
  change: ComputedImpactChange,
): Promise<FieldDependent[]> {
  const scope = base.org.scope;
  const state = await loadFieldErrorsState(db, scope, base.base.id);
  if (!state.rows.fields.some(isComputedRow)) return [];
  const readable = readabilityOf(base.access);
  return computedImpactOf(state, change)
    .filter((field) => readable.field(field.table_id, field.id))
    .map((field) => ({ type: 'field', id: field.id, table_id: field.table_id, name: field.name }));
}

/**
 * Fields and tables named by `compute_error.refs` that are not active (the
 * trash, purged): {@link loadErrorRefs} loads them for {@link computedDtoPart}.
 */
export interface ErrorRefRows {
  readonly fields: ReadonlyMap<string, FieldRow>;
  readonly tables: ReadonlyMap<string, TableRow>;
}

export const NO_ERROR_REFS: ErrorRefRows = { fields: new Map(), tables: new Map() };

/** The inactive objects the errors of `fields` name (two queries at most). */
export async function loadErrorRefs(
  scope: OrgScope,
  rows: BaseSchemaRows,
  fields: readonly FieldRow[],
  repositories: {
    readonly fields: Pick<FieldsRepository, 'listByIds'>;
    readonly tables: Pick<TablesRepository, 'listByIds'>;
  },
): Promise<ErrorRefRows> {
  const fieldIds = new Set<string>();
  const tableIds = new Set<string>();
  for (const field of fields) {
    for (const ref of fieldErrorOf(field.compute_error)?.refs ?? []) {
      if (ref.kind === 'table' && !rows.tables.some((table) => table.id === ref.id)) {
        tableIds.add(ref.id);
      } else if (ref.kind === 'field' && !rows.fields.some((row) => row.id === ref.id)) {
        fieldIds.add(ref.id);
      }
    }
  }
  if (fieldIds.size === 0 && tableIds.size === 0) return NO_ERROR_REFS;
  const inactiveFields = await repositories.fields.listByIds(scope, [...fieldIds]);
  const inactiveTables = await repositories.tables.listByIds(scope, [...tableIds]);
  return {
    fields: new Map(inactiveFields.map((row) => [row.id, row])),
    tables: new Map(inactiveTables.map((row) => [row.id, row])),
  };
}

/**
 * `compute_error` for a reader (T460): `refs` name only what the reader may
 * see — an active table they read, an active field that is not `no_perm`,
 * a field in the trash of an active table they manage (they see its trash),
 * a table in the trash for base admins; anything else (purged, another
 * base, no access) is `{ id: null, name: null }`.
 */
function errorOf(
  value: FieldRow['compute_error'],
  rows: BaseSchemaRows,
  access: EffectiveAccess,
  inactive: ErrorRefRows,
): ComputeErrorDto | null {
  const error = fieldErrorOf(value);
  if (error === null) return null;
  const readable = readabilityOf(access);
  const refs: ComputeErrorDto['refs'] = error.refs.map((ref) => {
    if (ref.kind === 'table') {
      const table = rows.tables.find((row) => row.id === ref.id);
      if (table !== undefined) {
        return readable.table(table.id)
          ? { kind: 'table', id: table.id, name: table.name }
          : { kind: 'table', id: null, name: null };
      }
      const trashed = inactive.tables.get(ref.id);
      return trashed !== undefined &&
        trashed.base_id === rows.baseId &&
        trashed.deleted_at !== null &&
        trashed.purged_at === null &&
        access.is_admin
        ? { kind: 'table', id: trashed.id, name: trashed.name }
        : { kind: 'table', id: null, name: null };
    }
    const field = rows.fields.find((row) => row.id === ref.id);
    if (field !== undefined) {
      return readable.field(field.table_id, field.id)
        ? { kind: 'field', id: field.id, name: field.name }
        : { kind: 'field', id: null, name: null };
    }
    const trashed = inactive.fields.get(ref.id);
    return trashed !== undefined &&
      trashed.deleted_at !== null &&
      trashed.purged_at === null &&
      rows.tables.some((table) => table.id === trashed.table_id) &&
      canManageTable(access, trashed.table_id)
      ? { kind: 'field', id: trashed.id, name: trashed.name }
      : { kind: 'field', id: null, name: null };
  });
  return { code: error.code, refs };
}

/**
 * The computed part of the DTO of `field` for a reader (`undefined` for
 * other types): the definition in display form (current names) when
 * visible, else `{ style }`; `result_type`, mode, state and error; `locked`
 * for a reader who cannot read what it is computed from (T457, `strict`:
 * the base setting `strict_computed_permissions`).
 */
export function computedDtoPart(
  field: FieldRow,
  rows: BaseSchemaRows,
  access: EffectiveAccess,
  strict: boolean,
  inactive: ErrorRefRows = NO_ERROR_REFS,
): ComputedDtoPart | undefined {
  if (!isComputedRow(field)) return undefined;
  const options = isRecord(field.options) ? field.options : {};
  const style = options.style ?? null;
  let shown: Record<string, unknown> = { style };
  if (definitionVisible(field, rows, access)) {
    if (field.type === 'formula' && typeof options.expression === 'string') {
      const snapshot = snapshotOfBase(rows, field.table_id, readabilityOf(access));
      const expression = displayExpression(options.expression, snapshot);
      if (expression !== null) shown = { expression, style };
    } else if (field.type === 'lookup') {
      shown = { ...options };
    }
  }
  const type = formulaTypeOf(field.result_type);
  return {
    options: shown,
    result_type: type === null ? { kind: 'null', list: false } : publicResultType(type),
    compute_mode: field.compute_mode ?? 'stored',
    compute_state: field.compute_state ?? 'ready',
    compute_error: errorOf(field.compute_error, rows, access, inactive),
    locked: isComputedFieldLocked(field, rows, readabilityOf(access), strict),
  };
}
