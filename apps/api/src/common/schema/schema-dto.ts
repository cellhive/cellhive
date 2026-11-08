import { iso } from '../dto.js';

import type {
  ButtonFieldSummary,
  FieldConversionState,
  FieldDto,
  FieldTypeName,
  Id,
  TableDto,
} from '@cellhive/contracts';
import type { FieldRow, TableRow } from '@cellhive/server-core';

/** `Table` (T103) of a `meta.tables` row. */
export function tableDtoOf(table: TableRow): TableDto {
  return {
    id: table.id,
    base_id: table.base_id,
    name: table.name,
    description: table.description,
    // Set in the transaction that creates the table.
    primary_field_id: table.primary_field_id as Id<'fld'>,
    position: table.position,
    schema_state: table.schema_state,
    created_at: iso(table.created_at),
    updated_at: iso(table.updated_at),
  };
}

/**
 * `Field` (T103) of a `meta.fields` row. `linkTargetsDeleted`: linked tables
 * in the trash (or gone), which flag their link fields (T401, CONTRACTS §13).
 * `conversion` (T403) is given by the field endpoints, which look it up.
 */
export function fieldDtoOf(
  field: FieldRow,
  linkTargetsDeleted?: ReadonlySet<string>,
  conversion?: FieldConversionState | null,
  /**
   * Formula/lookup fields (T456): options as the reader may see them and the
   * computed state, from `computedDtoPart` of the field module. AI fields
   * (T910): options with `ai` for the reader (whole with the prompt in names,
   * or `{ task }` — T1006), `locked`, `ai_state` (whole only).
   */
  computed?: Pick<
    FieldDto,
    'result_type' | 'compute_mode' | 'compute_state' | 'compute_error' | 'locked' | 'ai_state'
  > & {
    readonly options: FieldDto['options'];
  },
  /** Button fields (T517): the attached automation, from the field module. */
  button?: ButtonFieldSummary,
): FieldDto {
  const options = field.options;
  const linkTable =
    field.type === 'link' &&
    typeof options === 'object' &&
    options !== null &&
    !Array.isArray(options)
      ? options.link_table
      : undefined;
  return {
    id: field.id,
    table_id: field.table_id,
    name: field.name,
    type: field.type as FieldTypeName,
    options:
      typeof options === 'object' && options !== null && !Array.isArray(options)
        ? // A formula/lookup definition is only given through `computed` (T456), an AI
          // configuration too (T1006: whole or `{ task }` per reader); `ai: null` stays.
          field.type === 'formula' || field.type === 'lookup'
          ? { style: options.style ?? null }
          : withoutAiConfig(options)
        : {},
    is_primary: field.is_primary,
    required: field.required,
    unique_values: field.unique_values,
    description: field.description,
    position: field.position,
    created_at: iso(field.created_at),
    updated_at: iso(field.updated_at),
    // Only fields in the trash carry it (listed with `include_deleted=true`).
    ...(field.deleted_at === null ? {} : { deleted_at: iso(field.deleted_at) }),
    ...(typeof linkTable === 'string' && linkTargetsDeleted?.has(linkTable) === true
      ? { link_target_deleted: true }
      : {}),
    // T461: in the trash for good, its linked table was purged.
    ...(field.link_table_purged_at === null ? {} : { link_table_purged: true }),
    ...(conversion === undefined ? {} : { conversion }),
    ...(computed === undefined ? {} : computed),
    ...(button === undefined || field.type !== 'button' ? {} : { button }),
  };
}

/** `options` without an `ai` configuration (`ai: null` — AI removed — is kept). */
function withoutAiConfig(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).filter(([key, value]) => key !== 'ai' || value === null),
  );
}

/** One page of an in-memory list (CONTRACTS §1.1). */
export function pageOf<T, U>(
  items: readonly T[],
  query: { readonly offset: number; readonly limit: number },
  map: (item: T) => U,
): { items: U[]; total: number; offset: number; limit: number } {
  return {
    items: items.slice(query.offset, query.offset + query.limit).map(map),
    total: items.length,
    offset: query.offset,
    limit: query.limit,
  };
}
