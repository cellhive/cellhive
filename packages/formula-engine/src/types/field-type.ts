import { DATETIME_FORMATS, isDateOnlyFormat, type DatetimeFormat } from '@cellhive/field-types';

import { listOf, rowOf, T, type FormulaType } from './formula-type.js';

import type { SnapshotField } from '../resolve.js';

/** How a computed field is kept (SPEC §5.9). */
export type ComputeMode = 'stored' | 'virtual';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function styleOf(field: SnapshotField): Readonly<Record<string, unknown>> | null {
  const style = field.options?.['style'];
  return isRecord(style) ? style : null;
}

function isDatetimeFormat(value: unknown): value is DatetimeFormat {
  return typeof value === 'string' && (DATETIME_FORMATS as readonly string[]).includes(value);
}

/**
 * Formula type of a field's value (SPEC §5.5, §9.2):
 *
 * | Field type | Formula type |
 * |---|---|
 * | `text`, `auto_number` | `text` |
 * | `number` | `number` |
 * | `checkbox` | `boolean` |
 * | `select` | `text` (single) / `list<text>` (`multiple`) — option **names** (BACKLOG S4b #10) |
 * | `datetime` | `date` for a date-only `style.format`, else `datetime` |
 * | `created_at`, `updated_at` | `datetime` |
 * | `user`, `created_by`, `updated_by` | `list<user>` |
 * | `attachment` | `list<attachment>` |
 * | `link`, `parent` | `list<row<target table>>` (`row<target table>` when `single`) |
 * | `formula`, `lookup` | the field's `resultType` |
 * | unknown / absent | `any` |
 */
export function fieldValueType(field: SnapshotField): FormulaType {
  if (field.linkTableId !== undefined && field.linkTableId !== null) {
    return field.single === true ? rowOf(field.linkTableId) : listOf(rowOf(field.linkTableId));
  }
  switch (field.type) {
    case 'text':
    case 'auto_number':
      return T.text;
    case 'number':
      return T.number;
    case 'checkbox':
      return T.boolean;
    case 'select':
      return field.options?.['multiple'] === true ? listOf(T.text) : T.text;
    case 'datetime': {
      const format = styleOf(field)?.['format'];
      return isDatetimeFormat(format) && isDateOnlyFormat(format) ? T.date : T.datetime;
    }
    case 'created_at':
    case 'updated_at':
      return T.datetime;
    case 'user':
    case 'created_by':
    case 'updated_by':
      return listOf(T.user);
    case 'attachment':
      return listOf(T.attachment);
    case 'formula':
    case 'lookup':
      return field.resultType ?? T.any;
    default:
      return T.any;
  }
}

/**
 * Style a field lends to a computed result that carries its value
 * (`number` style — currency, percentage…; `datetime` style — format): the
 * default `style` of the result (the field API takes another one, T456).
 */
export function fieldStyle(field: SnapshotField): Readonly<Record<string, unknown>> | null {
  switch (field.type) {
    case 'number':
    case 'datetime':
    case 'created_at':
    case 'updated_at':
    case 'formula':
    case 'lookup':
      return styleOf(field);
    default:
      return null;
  }
}
