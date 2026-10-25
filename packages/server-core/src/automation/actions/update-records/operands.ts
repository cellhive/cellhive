import { toWallTime } from '@cellhive/field-types';
import { fieldProfile, isDateOnlyField, type FilterFieldMeta } from '@cellhive/filter-dsl';

import { computedFilterResultOf } from '../../../records/computed/read/computed-fields.js';

import type { AutomationFieldMeta } from '../../definition/validate.js';
import type { FieldType } from '@cellhive/field-types';

/**
 * A resolved value of SPEC §11.4 as a filter operand (BACKLOG T506). Values
 * come from cells in `cell_format=json`, step outputs or template text, so:
 * `{ id, … }` items (options, users, records) become their id; for a
 * date field an ISO instant becomes the wall time of `timeZone`
 * (`YYYY-MM-DDTHH:mm`, or `YYYY-MM-DD` for a date-only field) — the forms
 * the filter accepts; for a number field a numeric text becomes a number.
 * `undefined` when the value is empty (`null`, `""`, `[]`): the step fails.
 */
export function filterOperandOf(
  value: unknown,
  field: AutomationFieldMeta | undefined,
  timeZone: string,
): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value)) {
    const items = (value as unknown[])
      .map((item) => scalarOf(item, field, timeZone))
      .filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  return scalarOf(value, field, timeZone);
}

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

function scalarOf(value: unknown, field: AutomationFieldMeta | undefined, timeZone: string) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>)['id'];
    return typeof id === 'string' && id !== '' ? id : undefined;
  }
  if (field === undefined || typeof value !== 'string') return value;
  const meta = filterMetaOf(field);
  if (isDateKind(meta) && ISO_INSTANT.test(value)) {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return value;
    const wall = toWallTime(at, timeZone);
    const day = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
    return dateOnly(meta) ? day : `${day}T${pad(wall.hour)}:${pad(wall.minute)}`;
  }
  if (isNumberKind(meta)) {
    const number = Number(value.trim());
    return value.trim() !== '' && Number.isFinite(number) ? number : value;
  }
  return value;
}

function filterMetaOf(field: AutomationFieldMeta): FilterFieldMeta {
  return {
    id: field.id,
    name: field.name,
    type: field.type as FieldType,
    options: field.options,
    ...(field.type === 'formula' || field.type === 'lookup'
      ? computedFilterResultOf(field.result_type)
      : {}),
  };
}

function groupOf(meta: FilterFieldMeta): string | null {
  try {
    return fieldProfile(meta).group;
  } catch {
    return null;
  }
}

function isDateKind(meta: FilterFieldMeta): boolean {
  return groupOf(meta) === 'datetime';
}

function dateOnly(meta: FilterFieldMeta): boolean {
  try {
    return isDateOnlyField(meta);
  } catch {
    return false;
  }
}

function isNumberKind(meta: FilterFieldMeta): boolean {
  return groupOf(meta) === 'number';
}
