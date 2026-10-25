import { isDateOnlyFormat, type DatetimeFormat } from '@cellhive/field-types';
import { FormulaError } from '@cellhive/formula-engine';

import { formulaTypeOf } from './schema-rows.js';

import type { FieldRow } from '../../db/schema.js';
import type { FilterFieldMeta } from '@cellhive/filter-dsl';

/**
 * Lookup `where` checks the Filter DSL validation does not make (BACKLOG
 * T456): the pairs `source field` × `field_ref` the SQL of a lookup
 * condition compiles (`query/filter-sql.ts` `fieldRefCondition`: text ←
 * text/number/date/ids, number ← number, date ← date/datetime, ids ←
 * text/ids/`__id`); any other pair is refused here with
 * `FORMULA_TYPE_ERROR` / `INVALID_LOOKUP` instead of failing later.
 */

type SourceKind = 'text' | 'numeric' | 'date' | 'ids' | 'none';
type RefKind = 'text' | 'numeric' | 'date' | 'timestamptz' | 'ids' | 'id' | 'none';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function datetimeKind(field: Pick<FieldRow, 'options'>): 'date' | 'timestamptz' {
  const style = isRecord(field.options) ? field.options['style'] : undefined;
  const format = isRecord(style) ? style['format'] : undefined;
  return typeof format === 'string' && isDateOnlyFormat(format as DatetimeFormat)
    ? 'date'
    : 'timestamptz';
}

function sourceKind(field: FieldRow): SourceKind {
  switch (field.type) {
    case 'text':
    case 'auto_number':
      return 'text';
    case 'number':
      return 'numeric';
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return 'date';
    case 'select':
    case 'user':
    case 'created_by':
    case 'updated_by':
    case 'link':
      return 'ids';
    default:
      return 'none';
  }
}

function refKind(field: FieldRow): RefKind {
  switch (field.type) {
    case 'text':
    case 'auto_number':
      return 'text';
    case 'number':
      return 'numeric';
    case 'datetime':
      return datetimeKind(field);
    case 'created_at':
    case 'updated_at':
      return 'timestamptz';
    case 'select':
    case 'user':
    case 'created_by':
    case 'updated_by':
      return 'ids';
    default:
      return 'none';
  }
}

const ALLOWED: Readonly<Record<SourceKind, ReadonlySet<RefKind>>> = {
  text: new Set(['text', 'numeric', 'date', 'ids', 'id']),
  numeric: new Set(['numeric']),
  date: new Set(['date', 'timestamptz']),
  ids: new Set(['text', 'ids', 'id']),
  none: new Set(),
};

function fail(path: string, message: string): FormulaError {
  return new FormulaError('INVALID_LOOKUP', message, { start: 0, length: 0 }, { path });
}

/**
 * Walks a validated lookup `where` (Filter DSL AST) and throws
 * `FormulaError('INVALID_LOOKUP')` (`params.path` relative to `options`)
 * for a `field_ref` that cannot be compared with its source field.
 */
export function checkLookupFieldRefs(
  where: unknown,
  source: ReadonlyMap<string, FieldRow>,
  current: ReadonlyMap<string, FieldRow>,
  path = 'where',
): void {
  if (!isRecord(where)) return;
  if (Array.isArray(where['items'])) {
    (where['items'] as unknown[]).forEach((item, index) => {
      checkLookupFieldRefs(item, source, current, `${path}.items.${String(index)}`);
    });
    return;
  }
  if (isRecord(where['item'])) {
    checkLookupFieldRefs(where['item'], source, current, `${path}.item`);
    return;
  }
  const fieldId = where['field'];
  if (typeof fieldId !== 'string') return;
  if (fieldId === '__id') {
    checkRecordIdRef(where, source, current, path);
    return;
  }
  const values = Array.isArray(where['value']) ? (where['value'] as unknown[]) : [where['value']];
  values.forEach((value, index) => {
    if (!isRecord(value) || typeof value['field_ref'] !== 'string') return;
    const at = Array.isArray(where['value'])
      ? `${path}.value.${String(index)}.field_ref`
      : `${path}.value.field_ref`;
    const field = source.get(fieldId);
    const kind = field === undefined ? 'none' : sourceKind(field);
    const ref = value['field_ref'];
    const refField = ref === '__id' ? undefined : current.get(ref);
    const other: RefKind =
      ref === '__id' ? 'id' : refField === undefined ? 'none' : refKind(refField);
    if (!ALLOWED[kind].has(other)) {
      throw fail(
        at,
        `A field_ref to this field cannot be compared with the source field (${field?.type ?? 'unknown'}).`,
      );
    }
  });
}

/**
 * `__id is_any_of / is_none_of { field_ref }` (CONTRACTS §13): the field of
 * the current table must be a link to the source table (one-way or not).
 */
function checkRecordIdRef(
  where: Readonly<Record<string, unknown>>,
  source: ReadonlyMap<string, FieldRow>,
  current: ReadonlyMap<string, FieldRow>,
  path: string,
): void {
  const value = where['value'];
  const ref = isRecord(value) ? value['field_ref'] : undefined;
  const link = typeof ref === 'string' ? current.get(ref) : undefined;
  const sourceTable = source.values().next().value?.table_id;
  const target = isRecord(link?.options) ? link.options['link_table'] : undefined;
  if (link?.type !== 'link' || sourceTable === undefined || target !== sourceTable) {
    throw fail(
      `${path}.value.field_ref`,
      'The record ID compares with a link field of the current table to the source table.',
    );
  }
}

/** Filter meta of a field for a lookup `where` (computed fields by their scalar result). */
export function lookupFilterFieldMeta(field: FieldRow): FilterFieldMeta {
  const meta: FilterFieldMeta = {
    id: field.id,
    name: field.name,
    type: field.type as FilterFieldMeta['type'],
    options: field.options,
  };
  if (field.type !== 'formula' && field.type !== 'lookup') return meta;
  const type = formulaTypeOf(field.result_type);
  const scalar =
    type?.kind === 'number'
      ? 'number'
      : type?.kind === 'text'
        ? 'text'
        : type?.kind === 'boolean'
          ? 'checkbox'
          : type?.kind === 'date' || type?.kind === 'datetime'
            ? 'datetime'
            : undefined;
  return scalar === undefined ? meta : { ...meta, resultType: scalar };
}
