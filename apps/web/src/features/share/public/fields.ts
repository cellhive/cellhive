import { orderFields, toGridField, type GridField } from '../../../grid/types';

import type { FieldDto, ShareMeta, SharedFieldDto } from '@cellhive/contracts';
import type { LinkOptions } from '@cellhive/field-types';

/** Timestamp given to shared fields, which carry none (never shown). */
const NO_DATE = '1970-01-01T00:00:00.000Z';

const asFieldDto = new WeakMap<SharedFieldDto, FieldDto>();

/**
 * Formula/lookup keys of a shared field (T468; `SharedField.result_type`,
 * `locked` and the `compute_error` code — never `refs` or the definition,
 * CONTRACTS §16A, T462): the shared grid draws values by result type, the
 * lock and the error token.
 */
function computedKeys(
  field: SharedFieldDto,
): Pick<Partial<FieldDto>, 'result_type' | 'compute_error' | 'locked'> {
  if (field.type !== 'formula' && field.type !== 'lookup') return {};
  return {
    ...(field.result_type === undefined ? {} : { result_type: field.result_type }),
    ...(field.compute_error == null
      ? {}
      : { compute_error: { code: field.compute_error.code, refs: [] } }),
    ...(field.locked === true ? { locked: true } : {}),
  };
}

/**
 * A field of a share link (`SharedField`, CONTRACTS §16A) in the shape the
 * grid adapter and the cell formatters read (`FieldDto`). Shared fields
 * come in the order of the table: `position` is that order. Nothing is
 * editable through a link, so `required`/`unique_values` do not matter.
 */
export function toFieldDto(field: SharedFieldDto, tableId: string, position: number): FieldDto {
  const cached = asFieldDto.get(field);
  if (cached !== undefined) return cached;
  const dto: FieldDto = {
    id: field.id,
    table_id: tableId as FieldDto['table_id'],
    name: field.name,
    type: field.type,
    options: field.options,
    is_primary: field.is_primary,
    required: false,
    unique_values: false,
    description: field.description,
    position,
    created_at: NO_DATE,
    updated_at: NO_DATE,
    ...computedKeys(field),
  };
  asFieldDto.set(field, dto);
  return dto;
}

const asGridField = new WeakMap<FieldDto, GridField>();

/**
 * A shared field as a grid column. A link field comes with `allow_multiple`
 * only (no linked table, CONTRACTS §16A, T409): its cells still draw chips
 * (read-only; the page never opens the picker, so the linked table stays
 * unknown).
 */
export function sharedGridField(field: FieldDto): GridField {
  const cached = asGridField.get(field);
  if (cached !== undefined) return cached;
  let grid = toGridField(field);
  if (field.type === 'link' && grid.link === undefined) {
    const link: LinkOptions = {
      link_table: '' as LinkOptions['link_table'],
      bidirectional: false,
      allow_multiple: field.options['allow_multiple'] !== false,
      record_filter: null,
      symmetric_field_id: null,
    };
    grid = { ...grid, link };
  }
  asGridField.set(field, grid);
  return grid;
}

/** Every field of the link as `FieldDto`, in table order. */
export function sharedFieldDtos(meta: ShareMeta): FieldDto[] {
  return meta.fields.map((field, index) => toFieldDto(field, meta.table.id, index));
}

/**
 * Columns of the shared grid: the primary field first, then the view's
 * column order (`field_order`); fields hidden in the view are left out
 * (the server already drops fields hidden in the view from the link's
 * scope, CONTRACTS §16A — this also covers a stale `hidden_fields`).
 */
export function sharedColumns(meta: ShareMeta): GridField[] {
  const hidden = new Set(meta.view.config.hidden_fields);
  const all = sharedFieldDtos(meta)
    .filter((field) => field.is_primary || !hidden.has(field.id))
    .sort((a, b) =>
      a.is_primary === b.is_primary ? a.position - b.position : a.is_primary ? -1 : 1,
    )
    .map(sharedGridField);
  return orderFields(all, meta.view.config.field_order);
}
