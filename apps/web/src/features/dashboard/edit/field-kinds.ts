import type { FieldDto, FilterControlKind, MetricAggregation } from '@cellhive/contracts';

/**
 * How a field can be used by a widget (CONTRACTS §28.2, the web mirror of
 * `widgetFieldKindOf` in `@cellhive/server-core`): the group it falls in, or
 * `null` when records cannot be grouped or aggregated by it (attachment,
 * button, parent, list or record results). The editor only offers fields
 * that fit; the server checks again on save.
 */
export type WidgetFieldKind = 'text' | 'number' | 'select' | 'user' | 'checkbox' | 'date' | 'link';

export function widgetFieldKind(
  field: Pick<FieldDto, 'type' | 'result_type'>,
): WidgetFieldKind | null {
  switch (field.type) {
    case 'text':
    case 'auto_number':
      return 'text';
    case 'number':
      return 'number';
    case 'select':
      return 'select';
    case 'user':
    case 'created_by':
    case 'updated_by':
      return 'user';
    case 'checkbox':
      return 'checkbox';
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return 'date';
    case 'link':
      return 'link';
    case 'formula':
    case 'lookup': {
      const result = field.result_type;
      if (result === undefined || result.list) return null;
      switch (result.kind) {
        case 'text':
          return 'text';
        case 'number':
          return 'number';
        case 'boolean':
          return 'checkbox';
        case 'date':
        case 'datetime':
          return 'date';
        case 'user':
          return 'user';
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

const NUMERIC: ReadonlySet<MetricAggregation> = new Set(['sum', 'avg', 'min', 'max']);

/** Fields records can be grouped by (dimension, series, `count_distinct`). */
export function groupableFields(fields: readonly FieldDto[]): FieldDto[] {
  return fields.filter((field) => widgetFieldKind(field) !== null);
}

/** Fields an aggregation takes: none for `count`, numbers for sum/avg/min/max. */
export function metricFields(
  fields: readonly FieldDto[],
  aggregation: MetricAggregation,
): FieldDto[] {
  if (aggregation === 'count') return [];
  if (NUMERIC.has(aggregation)) {
    return fields.filter((field) => widgetFieldKind(field) === 'number');
  }
  return groupableFields(fields);
}

/** Date fields (date dimension needs a bucket; KPI comparison field). */
export function dateFields(fields: readonly FieldDto[]): FieldDto[] {
  return fields.filter((field) => widgetFieldKind(field) === 'date');
}

/** The field kind each filter control takes (CONTRACTS §28.2). */
export const CONTROL_FIELD_KIND: Readonly<Record<FilterControlKind, WidgetFieldKind>> = {
  date_range: 'date',
  select: 'select',
  user: 'user',
  text: 'text',
  number_range: 'number',
};

/** Fields a filter control of `kind` can filter on. */
export function controlFields(fields: readonly FieldDto[], kind: FilterControlKind): FieldDto[] {
  return fields.filter((field) => widgetFieldKind(field) === CONTROL_FIELD_KIND[kind]);
}
