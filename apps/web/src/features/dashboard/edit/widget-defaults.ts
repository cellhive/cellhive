import {
  FILTER_CONTROL_KINDS,
  type FieldDto,
  type FilterControlKind,
  type WidgetDimension,
  type WidgetType,
} from '@cellhive/contracts';

import {
  controlFields,
  groupableFields,
  metricFields,
  widgetFieldKind,
  type WidgetFieldKind,
} from './field-kinds';

/**
 * Settings of a new widget (T812): a config the server accepts for the
 * chosen table (CONTRACTS §28.2), refined afterwards in the settings panel.
 * `null` when the table has no field the widget can use.
 */

/** Size of a new widget by type (columns × rows). */
export function defaultSize(type: WidgetType): { readonly w: number; readonly h: number } {
  switch (type) {
    case 'kpi':
      return { w: 3, h: 4 };
    case 'text':
      return { w: 4, h: 4 };
    case 'filter_control':
      return { w: 3, h: 2 };
    default:
      return { w: 6, h: 6 };
  }
}

/** Grouping kinds preferred for a new chart, best first. */
const DIMENSION_ORDER: readonly WidgetFieldKind[] = [
  'select',
  'user',
  'date',
  'checkbox',
  'link',
  'text',
  'number',
];

/** The dimension of a field: dates by month, numbers without ranges. */
export function dimensionOf(field: FieldDto): WidgetDimension {
  return {
    field: field.id,
    date_bucket: widgetFieldKind(field) === 'date' ? 'month' : null,
    bucket_width: null,
  };
}

function firstDimension(fields: readonly FieldDto[]): WidgetDimension | null {
  const groupable = groupableFields(fields);
  for (const kind of DIMENSION_ORDER) {
    const field = groupable.find((candidate) => widgetFieldKind(candidate) === kind);
    if (field !== undefined) return dimensionOf(field);
  }
  return null;
}

const COUNT = { id: 'm1', aggregation: 'count', field: null, label: null, color: null } as const;

/** Control kinds in the order a new filter control tries them. */
const CONTROL_ORDER: readonly FilterControlKind[] = [
  'select',
  'date_range',
  'user',
  'text',
  'number_range',
];

export function defaultConfig(
  type: WidgetType,
  tableId: string,
  fields: readonly FieldDto[],
): Record<string, unknown> | null {
  if (type === 'text') return { markdown: '' };
  if (type === 'filter_control') {
    for (const control of CONTROL_ORDER) {
      const field = controlFields(fields, control)[0];
      if (field !== undefined) {
        return { table_id: tableId, field: field.id, control, parent_control_id: null };
      }
    }
    return null;
  }
  const data = { table_id: tableId, filter: null, filter_bindings: [] };
  if (type === 'kpi') return { ...data, metrics: [COUNT], compare: null, display: {} };
  if (type === 'table') {
    const shown = fields.slice(0, 5).map((field) => field.id);
    if (shown.length === 0) return null;
    return { ...data, table: { mode: 'records', fields: shown, sort: null, limit: 10 } };
  }
  const dimension = firstDimension(fields);
  if (dimension === null) return null;
  if (type === 'combo') {
    const number = metricFields(fields, 'sum')[0];
    return {
      ...data,
      dimension,
      metrics: [
        { ...COUNT, chart: 'bar', axis: 'left' },
        number === undefined
          ? { ...COUNT, id: 'm2', chart: 'line', axis: 'right' }
          : {
              ...COUNT,
              id: 'm2',
              aggregation: 'sum',
              field: number.id,
              chart: 'line',
              axis: 'right',
            },
      ],
      display: {},
    };
  }
  if (type === 'pie')
    return { ...data, dimension, metrics: [COUNT], group_others: true, display: {} };
  return { ...data, dimension, series_dimension: null, metrics: [COUNT], display: {} };
}

/** Whether the table has a field for a control of each kind. */
export function availableControls(fields: readonly FieldDto[]): FilterControlKind[] {
  return FILTER_CONTROL_KINDS.filter((kind) => controlFields(fields, kind).length > 0);
}

/** The next free metric id (`m1`…). */
export function nextMetricId(metrics: readonly { readonly id: string }[]): string {
  const used = new Set(metrics.map((metric) => metric.id));
  let index = 1;
  while (used.has(`m${String(index)}`)) index += 1;
  return `m${String(index)}`;
}
