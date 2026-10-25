import {
  DATE_BUCKET_REQUIRED,
  dashboardGlobalFiltersSchema,
  INVALID_DIMENSION,
  INVALID_FILTER_CONTROL,
  INVALID_METRIC,
  UNKNOWN_WIDGET,
  WIDGET_CONFIG_SCHEMAS,
  type DashboardGlobalFilter,
  type ErrorCode,
  type FilterControlKind,
  type MetricAggregation,
  type ProblemErrorItem,
  type WidgetConfig,
  type WidgetDimension,
  type WidgetMetric,
  type WidgetType,
} from '@cellhive/contracts';
import {
  MAX_FILTER_CONDITIONS,
  parseFilterInput,
  type FilterFieldMeta,
} from '@cellhive/filter-dsl';

import { publicResultType } from '../computed/definition/definition.js';
import { formulaTypeOf } from '../computed/definition/schema-rows.js';
import { AppError } from '../errors/app-error.js';
import { zodIssuesToProblemErrors } from '../errors/zod-issues.js';
import { computedFilterResultOf } from '../records/computed/read/computed-fields.js';
import { controlValueIssue } from '../records/dashboard-aggregate/live-filters.js';

import type { FieldType } from '@cellhive/field-types';

/**
 * Widget configs (SPEC §10.2–§10.3, CONTRACTS §28.2; BACKLOG T805): parsing
 * by type and the checks against the base made on every save. Pure: the
 * caller loads the tables, fields and sibling widgets.
 */

/** What a widget check needs to know about one active field. */
export interface WidgetFieldMeta {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly options: unknown;
  /** `meta.fields.result_type` of a formula/lookup field. */
  readonly result_type?: unknown;
}

/** An active table of the base and its active fields. */
export interface WidgetTableMeta {
  readonly id: string;
  readonly fields: readonly WidgetFieldMeta[];
}

/** Another widget of the same dashboard. */
export interface SiblingWidget {
  readonly type: WidgetType;
  readonly config: unknown;
}

export interface WidgetCheckContext {
  /** Active tables of the base, by id. */
  readonly tables: ReadonlyMap<string, WidgetTableMeta>;
  /** The other widgets of the dashboard, by id (the one being saved excluded). */
  readonly siblings: ReadonlyMap<string, SiblingWidget>;
  /** Id of the widget being saved (new ones get theirs before the check). */
  readonly widgetId: string;
}

/**
 * How a field can be used by a widget: the group of SPEC §10.3 it falls
 * in, `null` when it cannot be grouped or aggregated (attachment, button,
 * parent, list results, record results).
 */
export type WidgetFieldKind = 'text' | 'number' | 'select' | 'user' | 'checkbox' | 'date' | 'link';

export function widgetFieldKindOf(
  field: Pick<WidgetFieldMeta, 'type' | 'result_type'>,
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
      const type = formulaTypeOf(field.result_type);
      if (type === null || type.kind === 'any') return null;
      const result = publicResultType(type);
      if (result.list) return null;
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

/** The field kind a filter control (or global filter) of `kind` needs. */
const CONTROL_FIELD_KINDS: Record<FilterControlKind, readonly WidgetFieldKind[]> = {
  date_range: ['date'],
  select: ['select'],
  user: ['user'],
  text: ['text'],
  number_range: ['number'],
};

const NUMERIC_AGGREGATIONS: ReadonlySet<MetricAggregation> = new Set(['sum', 'avg', 'min', 'max']);

class Issues {
  private readonly byCode = new Map<ErrorCode, ProblemErrorItem[]>();

  add(code: ErrorCode, item: ProblemErrorItem): void {
    const list = this.byCode.get(code) ?? [];
    list.push(item);
    this.byCode.set(code, list);
  }

  /** Throws the first error class that has issues (shape and references, then the filter). */
  throwIfAny(detail: string): void {
    for (const code of ['VALIDATION_FAILED', 'INVALID_FILTER'] as const) {
      const errors = this.byCode.get(code);
      if (errors !== undefined) throw new AppError(code, { detail, errors });
    }
  }
}

function joinPath(prefix: string, path: string): string {
  if (path === '') return prefix;
  return path.startsWith('[') ? `${prefix}${path}` : `${prefix}.${path}`;
}

function filterMetaOf(field: WidgetFieldMeta): FilterFieldMeta {
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

/** Checks of one table's references, collecting issues. */
class TableChecker {
  private readonly fields: ReadonlyMap<string, WidgetFieldMeta>;

  constructor(
    readonly table: WidgetTableMeta,
    private readonly issues: Issues,
  ) {
    this.fields = new Map(table.fields.map((field) => [field.id, field]));
  }

  /** The field, or an `UNKNOWN_FIELD` issue (deleted, or of another table). */
  field(id: string, path: string): WidgetFieldMeta | undefined {
    const field = this.fields.get(id);
    if (field === undefined) {
      this.issues.add('VALIDATION_FAILED', {
        path,
        code: 'UNKNOWN_FIELD',
        message: 'The field does not exist in the widget’s table',
      });
    }
    return field;
  }

  dimension(dimension: WidgetDimension, path: string): void {
    const field = this.field(dimension.field, `${path}.field`);
    if (field === undefined) return;
    const kind = widgetFieldKindOf(field);
    if (kind === null) {
      this.issues.add('VALIDATION_FAILED', {
        path: `${path}.field`,
        code: INVALID_DIMENSION,
        message: 'Records cannot be grouped by this field',
        params: { type: field.type },
      });
      return;
    }
    if (kind === 'date' && dimension.date_bucket === null) {
      this.issues.add('VALIDATION_FAILED', {
        path: `${path}.date_bucket`,
        code: DATE_BUCKET_REQUIRED,
        message: 'A date dimension needs a bucket',
      });
    }
    if (kind !== 'date' && dimension.date_bucket !== null) {
      this.issues.add('VALIDATION_FAILED', {
        path: `${path}.date_bucket`,
        code: INVALID_DIMENSION,
        message: 'Only date fields take a bucket',
        params: { type: field.type },
      });
    }
    if (kind !== 'number' && dimension.bucket_width !== null) {
      this.issues.add('VALIDATION_FAILED', {
        path: `${path}.bucket_width`,
        code: INVALID_DIMENSION,
        message: 'Only number fields take a bucket width',
        params: { type: field.type },
      });
    }
  }

  metrics(metrics: readonly WidgetMetric[], path: string): void {
    for (const [index, metric] of metrics.entries()) {
      if (metric.field === null) continue;
      const fieldPath = `${path}[${String(index)}].field`;
      const field = this.field(metric.field, fieldPath);
      if (field === undefined) continue;
      const kind = widgetFieldKindOf(field);
      const fits = NUMERIC_AGGREGATIONS.has(metric.aggregation) ? kind === 'number' : kind !== null;
      if (!fits) {
        this.issues.add('VALIDATION_FAILED', {
          path: fieldPath,
          code: INVALID_METRIC,
          message: `\`${metric.aggregation}\` does not fit this field`,
          params: { aggregation: metric.aggregation, type: field.type },
        });
      }
    }
  }

  /** A field of one of `kinds`, or `code` at `path`. */
  fieldOfKind(id: string, kinds: readonly WidgetFieldKind[], path: string, code: string): void {
    const field = this.field(id, path);
    if (field === undefined) return;
    const kind = widgetFieldKindOf(field);
    if (kind === null || !kinds.includes(kind)) {
      this.issues.add('VALIDATION_FAILED', {
        path,
        code,
        message: 'This field cannot be used here',
        params: { type: field.type },
      });
    }
  }

  /** The saved filter in DSL form (stored as such), or `null`. */
  filter(filter: Record<string, unknown> | null, path: string): Record<string, unknown> | null {
    if (filter === null) return null;
    const result = parseFilterInput(
      filter,
      { fields: this.table.fields.map(filterMetaOf) },
      this.table.fields.map((field) => field.id),
      { fieldKeyType: 'id' },
    );
    if (!result.ok) {
      for (const issue of result.errors) {
        this.issues.add('INVALID_FILTER', { ...issue, path: joinPath(path, issue.path) });
      }
      return null;
    }
    const ast = result.ast as unknown as Record<string, unknown>;
    const count = countConditions(ast);
    if (count > MAX_FILTER_CONDITIONS) {
      this.issues.add('INVALID_FILTER', {
        path,
        code: 'MAX_CONDITIONS_EXCEEDED',
        message: `Filter has more than ${String(MAX_FILTER_CONDITIONS)} conditions`,
        params: { max: MAX_FILTER_CONDITIONS, count },
      });
    }
    return ast;
  }
}

function countConditions(node: unknown): number {
  if (typeof node !== 'object' || node === null) return 0;
  const items = (node as { items?: unknown }).items;
  if (!Array.isArray(items)) return 1;
  return items.reduce<number>((sum, item) => sum + countConditions(item), 0);
}

function tableOf(
  context: WidgetCheckContext,
  tableId: string,
  issues: Issues,
  path: string,
): TableChecker | undefined {
  const table = context.tables.get(tableId);
  if (table === undefined) {
    issues.add('VALIDATION_FAILED', {
      path,
      code: 'UNKNOWN_TABLE',
      message: 'The table does not exist in the base',
    });
    return undefined;
  }
  return new TableChecker(table, issues);
}

function unknownWidget(path: string, message: string): ProblemErrorItem {
  return { path, code: UNKNOWN_WIDGET, message };
}

/** `filter_bindings`: distinct `filter_control` widgets of the dashboard. */
function checkBindings(
  bindings: readonly string[],
  context: WidgetCheckContext,
  issues: Issues,
): string[] {
  const unique = [...new Set(bindings)];
  for (const [index, id] of unique.entries()) {
    if (context.siblings.get(id)?.type !== 'filter_control') {
      issues.add(
        'VALIDATION_FAILED',
        unknownWidget(
          `config.filter_bindings[${String(index)}]`,
          'Not a filter control of this dashboard',
        ),
      );
    }
  }
  return unique;
}

function parentOf(widget: SiblingWidget | undefined): string | null {
  if (widget?.type !== 'filter_control') return null;
  const parent = (widget.config as { parent_control_id?: unknown }).parent_control_id;
  return typeof parent === 'string' ? parent : null;
}

/** Parses `input` as the config of a `type` widget, or the `VALIDATION_FAILED` problem. */
function parseConfig(type: WidgetType, input: unknown): WidgetConfig {
  const parsed = WIDGET_CONFIG_SCHEMAS[type].safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The widget config does not match its type.',
      errors: zodIssuesToProblemErrors(parsed.error.issues).map((item) => ({
        ...item,
        path: joinPath('config', item.path),
      })),
    });
  }
  return parsed.data;
}

/**
 * Validates `input` as the config of a `type` widget against the base and
 * returns the config to store (defaults filled, filter in DSL form):
 *
 * - shape by type (`VALIDATION_FAILED`, paths under `config`);
 * - `table_id` is an active table of the base (`UNKNOWN_TABLE`), every
 *   field an active field of that table (`UNKNOWN_FIELD`: a field of
 *   another table is unknown too);
 * - a dimension groups text, select, user, checkbox, date (bucket required —
 *   `DATE_BUCKET_REQUIRED`), number or link fields (`INVALID_DIMENSION`);
 *   `sum`/`avg`/`min`/`max` take a number field, `count_distinct` any
 *   groupable field (`INVALID_METRIC`); the KPI comparison a date field;
 * - the saved filter validates in mode `standard` (`INVALID_FILTER`);
 * - `filter_bindings` name `filter_control` widgets of the dashboard, a
 *   control's parent is another control of the same table without a loop
 *   (`UNKNOWN_WIDGET`, `INVALID_FILTER_CONTROL`), its field fits its kind.
 */
export function buildWidgetConfig(
  type: WidgetType,
  input: unknown,
  context: WidgetCheckContext,
): WidgetConfig {
  const config = parseConfig(type, input);
  const issues = new Issues();
  const result = checkByType(type, config, context, issues);
  issues.throwIfAny('The widget config is invalid.');
  return result;
}

function checkByType(
  type: WidgetType,
  config: WidgetConfig,
  context: WidgetCheckContext,
  issues: Issues,
): WidgetConfig {
  if (type === 'text') return config;
  if (type === 'filter_control') {
    const control = config as Extract<WidgetConfig, { control: unknown }>;
    const table = tableOf(context, control.table_id, issues, 'config.table_id');
    table?.fieldOfKind(
      control.field,
      CONTROL_FIELD_KINDS[control.control],
      'config.field',
      INVALID_FILTER_CONTROL,
    );
    // The default is a value of the control's kind (T808: fixed or relative).
    const defaultIssue =
      control.default === null ? null : controlValueIssue(control.control, control.default);
    if (defaultIssue !== null) {
      issues.add('VALIDATION_FAILED', {
        path: 'config.default',
        code: INVALID_FILTER_CONTROL,
        message: defaultIssue,
      });
    }
    if (control.parent_control_id !== null) {
      const parent = context.siblings.get(control.parent_control_id);
      if (parent?.type !== 'filter_control') {
        issues.add(
          'VALIDATION_FAILED',
          unknownWidget('config.parent_control_id', 'Not a filter control of this dashboard'),
        );
      } else if ((parent.config as { table_id?: unknown }).table_id !== control.table_id) {
        issues.add('VALIDATION_FAILED', {
          path: 'config.parent_control_id',
          code: INVALID_FILTER_CONTROL,
          message: 'A parent control filters the same table',
        });
      } else {
        // Walk up the parents: reaching this widget again is a loop.
        const seen = new Set<string>([context.widgetId]);
        let current: string | null = control.parent_control_id;
        while (current !== null) {
          if (seen.has(current)) {
            issues.add('VALIDATION_FAILED', {
              path: 'config.parent_control_id',
              code: INVALID_FILTER_CONTROL,
              message: 'The parent controls form a loop',
            });
            break;
          }
          seen.add(current);
          current = parentOf(context.siblings.get(current));
        }
      }
    }
    return control;
  }

  const data = config as Extract<WidgetConfig, { filter_bindings: unknown }>;
  const table = tableOf(context, data.table_id, issues, 'config.table_id');
  const bindings = checkBindings(data.filter_bindings, context, issues);
  if (table === undefined) return { ...data, filter_bindings: bindings } as WidgetConfig;
  const filter = table.filter(data.filter, 'config.filter');
  if ('dimension' in data) table.dimension(data.dimension, 'config.dimension');
  if ('series_dimension' in data && data.series_dimension !== null) {
    table.dimension(data.series_dimension, 'config.series_dimension');
  }
  if ('metrics' in data) table.metrics(data.metrics, 'config.metrics');
  if ('compare' in data && data.compare !== null) {
    table.fieldOfKind(
      data.compare.date_field,
      ['date'],
      'config.compare.date_field',
      INVALID_DIMENSION,
    );
  }
  if ('table' in data) {
    if (data.table.mode === 'pivot') {
      table.dimension(data.table.dimension, 'config.table.dimension');
      table.metrics(data.table.metrics, 'config.table.metrics');
    } else {
      const seen = new Set<string>();
      for (const [index, id] of data.table.fields.entries()) {
        const path = `config.table.fields[${String(index)}]`;
        if (seen.has(id)) {
          issues.add('VALIDATION_FAILED', {
            path,
            code: 'DUPLICATE_FIELD',
            message: 'The field is listed more than once',
          });
        }
        seen.add(id);
        table.field(id, path);
      }
      if (data.table.sort !== null) table.field(data.table.sort.field, 'config.table.sort.field');
    }
  }
  return { ...data, filter, filter_bindings: bindings } as WidgetConfig;
}

/**
 * Validates the global filters of a dashboard against the base: each
 * target is an active table and field of that table fitting the filter's
 * kind (`UNKNOWN_TABLE`, `UNKNOWN_FIELD`, `INVALID_FILTER_CONTROL`, paths
 * under `global_filters`). Returns the parsed filters.
 */
export function checkGlobalFilters(
  input: unknown,
  tables: ReadonlyMap<string, WidgetTableMeta>,
): DashboardGlobalFilter[] {
  const parsed = dashboardGlobalFiltersSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The global filters are invalid.',
      errors: zodIssuesToProblemErrors(parsed.error.issues).map((item) => ({
        ...item,
        path: joinPath('global_filters', item.path),
      })),
    });
  }
  const issues = new Issues();
  for (const [index, filter] of parsed.data.entries()) {
    for (const [target, item] of filter.targets.entries()) {
      const path = `global_filters[${String(index)}].targets[${String(target)}]`;
      const table = tableOf(
        { tables, siblings: new Map(), widgetId: '' },
        item.table_id,
        issues,
        `${path}.table_id`,
      );
      table?.fieldOfKind(
        item.field,
        CONTROL_FIELD_KINDS[filter.kind],
        `${path}.field`,
        INVALID_FILTER_CONTROL,
      );
    }
  }
  issues.throwIfAny('The global filters are invalid.');
  return parsed.data;
}

/** Table and field ids a widget config names (to tell whether it is broken). */
export function widgetReferencesOf(
  type: WidgetType,
  config: unknown,
): { readonly tableId: string | null; readonly fieldIds: readonly string[] } {
  if (type === 'text' || typeof config !== 'object' || config === null) {
    return { tableId: null, fieldIds: [] };
  }
  const value = config as Record<string, unknown>;
  const tableId = typeof value['table_id'] === 'string' ? value['table_id'] : null;
  const fields = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string') fields.add(id);
  };
  const addDimension = (dimension: unknown) => {
    if (typeof dimension === 'object' && dimension !== null) {
      add((dimension as { field?: unknown }).field);
    }
  };
  const addMetrics = (metrics: unknown) => {
    if (Array.isArray(metrics)) for (const metric of metrics) addDimension(metric);
  };
  add(value['field']);
  addDimension(value['dimension']);
  addDimension(value['series_dimension']);
  addMetrics(value['metrics']);
  const compare = value['compare'];
  if (typeof compare === 'object' && compare !== null) {
    add((compare as { date_field?: unknown }).date_field);
  }
  const table = value['table'];
  if (typeof table === 'object' && table !== null) {
    const spec = table as Record<string, unknown>;
    addDimension(spec['dimension']);
    addMetrics(spec['metrics']);
    if (Array.isArray(spec['fields'])) for (const id of spec['fields']) add(id);
    addDimension(spec['sort']);
  }
  collectFilterFields(value['filter'], fields);
  return { tableId, fieldIds: [...fields] };
}

function collectFilterFields(node: unknown, into: Set<string>): void {
  if (typeof node !== 'object' || node === null) return;
  const value = node as Record<string, unknown>;
  if (typeof value['field'] === 'string') into.add(value['field']);
  if (Array.isArray(value['items'])) {
    for (const item of value['items']) collectFilterFields(item, into);
  }
}

/** Why a widget can no longer be computed, or `null` when every reference is active. */
export function widgetBrokenReasonOf(
  type: WidgetType,
  config: unknown,
  tables: ReadonlyMap<string, WidgetTableMeta>,
): 'table_deleted' | 'field_deleted' | null {
  const { tableId, fieldIds } = widgetReferencesOf(type, config);
  if (tableId === null) return null;
  const table = tables.get(tableId);
  if (table === undefined) return 'table_deleted';
  const active = new Set(table.fields.map((field) => field.id));
  return fieldIds.every((id) => active.has(id)) ? null : 'field_deleted';
}

/**
 * The config of a copied widget with its widget ids replaced by `mapping`
 * (duplicating a dashboard): `filter_bindings` and `parent_control_id`;
 * ids without a mapping are dropped.
 */
export function remapWidgetIds(
  type: WidgetType,
  config: Record<string, unknown>,
  mapping: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const next = { ...config };
  if (Array.isArray(next['filter_bindings'])) {
    next['filter_bindings'] = (next['filter_bindings'] as unknown[])
      .map((id) => (typeof id === 'string' ? mapping.get(id) : undefined))
      .filter((id): id is string => id !== undefined);
  }
  if (type === 'filter_control' && typeof next['parent_control_id'] === 'string') {
    next['parent_control_id'] = mapping.get(next['parent_control_id']) ?? null;
  }
  return next;
}
