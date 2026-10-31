import {
  canonicalTimeZone,
  MAX_WIDGET_GROUPS,
  WIDGET_TOO_LARGE,
  type DateBucket,
  type FilterControlKind,
  type Id,
  type WidgetDataColumn,
  type WidgetGroupKey,
  type WidgetGroupValue,
} from '@cellhive/contracts';
import { isDateOnlyFormat, type DatetimeOptions, type SelectOptions } from '@cellhive/field-types';
import { foldText, parseExactDate } from '@cellhive/filter-dsl';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { widgetFieldKindOf, type WidgetFieldKind } from '../../dashboards/widget-config.js';
import { AppError } from '../../errors/app-error.js';
import { assertDataTableName, assertJunctionTableName, DATA_SCHEMA } from '../../schema/names.js';
import { titleOf, titleUserIds } from '../links/link-reader.js';
import {
  dataTableRef,
  relatedAccessContext,
  TARGET_ALIAS,
  targetReadableSql,
  type LinkTarget,
  type LinkTargets,
} from '../links/link-targets.js';

import { periodInterval } from './widget-query.js';

import type { IgnoredLiveFilter } from './live-filters.js';
import type {
  GroupedWidgetQuery,
  KpiWidgetQuery,
  WidgetDimensionSpec,
  WidgetMetricSpec,
} from './widget-query.js';
import type { Tx } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { SqlLinkFieldMeta } from '../../query/index.js';
import type { ComputedField } from '../computed/read/index.js';
import type { LinkFieldModel } from '../links/link-model.js';
import type { MemberDirectoryRepository } from '../member-directory.repository.js';
import type { FieldModel, TableModel } from '../table-model.js';
import type { RecordAccessContext } from '../types.js';
import type { ResolveContext } from '@cellhive/filter-dsl';

/**
 * The aggregate statement of a dashboard widget (BACKLOG T806, CONTRACTS
 * §28.3), next to `summaries/summaries.ts`: `RecordQueryService.widgetData`
 * prepares the read (table access, WHERE of `records/query` with the read
 * rule and the widget's saved filter, the fields the viewer reads) and calls
 * {@link aggregateWidget}, which answers with **one** statement over the
 * matching rows — no record leaves the database:
 *
 * ```sql
 * WITH m AS (SELECT <group key d, s>, <metric values v…> FROM data.t AS t WHERE …),
 *      e AS (SELECT <one row per element of a list key> FROM m),      -- select (multi), user, link
 *      g AS (SELECT d, s, count(*), <aggregates> FROM e GROUP BY d, s),
 *      r AS (SELECT d, row_number() OVER (ORDER BY <sort>) AS rk FROM <groups of d>),
 *      o AS (<aggregates of the rows of the groups past the limit>),  -- "Other"
 *      tot AS (SELECT count(*), <aggregates> FROM m)                  -- each record once
 * SELECT … top `limit` groups, "Other", the total …
 * ```
 *
 * A `count_distinct` of a list (T904) counts `count(DISTINCT element)` over
 * rows spread once more per element (`unnest … WITH ORDINALITY`, in `e`,
 * `tot` and the KPI); the other aggregates keep one row per record
 * (`FILTER (WHERE o = 1)`).
 *
 * Group keys and metric values come from columns of fields the viewer
 * reads (`sql.id` from meta), formula/lookup values are their expression for
 * the viewer (`ComputedField.value`); every literal is a parameter.
 */

/** Alias of the data table in the statement (as in `RecordQueryService`). Code only. */
const ALIAS = 't';
const col = (column: string) => sql.id(ALIAS, column);

/** A field the viewer reads, as the widget uses it. */
export type WidgetSource =
  | { readonly kind: 'column'; readonly field: FieldModel }
  | { readonly kind: 'link'; readonly field: LinkFieldModel }
  | { readonly kind: 'computed'; readonly field: ComputedField };

export interface WidgetAggregateInput {
  readonly scope: OrgScope;
  readonly tx: Tx;
  readonly model: TableModel;
  readonly access: RecordAccessContext;
  readonly context: ResolveContext;
  /** `data.<table> AS t`. */
  readonly from: RawBuilder<unknown>;
  /** WHERE of `records/query`: not deleted, read rule, the widget's saved filter. */
  readonly where: RawBuilder<SqlBool>;
  readonly query: GroupedWidgetQuery | KpiWidgetQuery;
  /** Readable fields by id (`RecordQueryService` checked every field of the widget). */
  readonly sources: ReadonlyMap<string, WidgetSource>;
  /** Zone of date buckets and periods for fields without a zone of their own. */
  readonly timeZone: string;
  /** Clock of KPI comparisons. */
  readonly now: Date;
  readonly linkTargets: LinkTargets;
  readonly members: MemberDirectoryRepository;
}

/** What {@link aggregateWidget} answers (the API adds `computed_at` and `cache`). */
export interface WidgetAggregateResult {
  readonly status: 'ok' | 'no_permission' | 'broken' | 'empty';
  readonly columns: WidgetDataColumn[];
  readonly rows: unknown[][];
  readonly other?: { readonly groups: number; readonly rows: unknown[][] };
  readonly total?: (number | null)[];
  readonly compare?: {
    readonly previous: number | null;
    readonly change: number | null;
    readonly current_period: { readonly from: string; readonly to: string };
    readonly previous_period: { readonly from: string; readonly to: string };
  };
  /** Live filters set aside for this viewer (T808: a field they cannot read, or one gone). */
  readonly ignored?: readonly IgnoredLiveFilter[];
}

/** The values a filter control offers (T808, `POST /widgets/:id/options`). */
export interface ControlOptionsResult {
  readonly status: 'ok' | 'no_permission' | 'broken';
  readonly items: WidgetGroupValue[];
  /** More values match than the limit. */
  readonly hasMore: boolean;
  readonly ignored?: readonly IgnoredLiveFilter[];
}

export const NO_PERMISSION: WidgetAggregateResult = {
  status: 'no_permission',
  columns: [],
  rows: [],
};
export const BROKEN: WidgetAggregateResult = { status: 'broken', columns: [], rows: [] };

// ---------------------------------------------------------------------------
// Fields

function fieldTypeOf(source: WidgetSource): string {
  return source.kind === 'link' ? 'link' : source.field.type;
}

function kindOf(source: WidgetSource): WidgetFieldKind | null {
  if (source.kind === 'link') return 'link';
  return widgetFieldKindOf({
    type: source.field.row.type,
    result_type: source.field.row.result_type,
  });
}

/** Live records linked from the row (as a link cell and its filters, T402). */
function linkValue(meta: SqlLinkFieldMeta | undefined): RawBuilder<unknown> {
  if (meta?.targetTable === null || meta?.targetTable === undefined) return sql`'{}'::text[]`;
  return sql`ARRAY(
    SELECT lj.${sql.id(meta.otherColumn)}
      FROM ${sql.id(DATA_SCHEMA, assertJunctionTableName(meta.junction))} AS lj
      JOIN ${sql.id(DATA_SCHEMA, assertDataTableName(meta.targetTable))} AS lt
        ON lt.__id = lj.${sql.id(meta.otherColumn)}
     WHERE lj.${sql.id(meta.ownColumn)} = ${col('__id')}
       AND lt.__deleted_at IS NULL)`;
}

/** The stored value of a source on the row `t`. */
function rawOf(source: WidgetSource, model: TableModel): RawBuilder<unknown> {
  switch (source.kind) {
    case 'column':
      return col(source.field.column);
    case 'computed':
      return source.field.value(ALIAS);
    case 'link': {
      const meta = model.queryFilterMeta.fields.find((field) => field.id === source.field.id);
      return linkValue(meta?.link);
    }
  }
}

/** Date-only values (`date`), as opposed to instants (`timestamptz`). */
function isDateOnly(source: WidgetSource): boolean {
  if (source.kind === 'computed') return source.field.publicType.kind === 'date';
  if (source.kind === 'column' && source.field.type === 'datetime') {
    return isDateOnlyFormat((source.field.options as DatetimeOptions).style.format);
  }
  return false;
}

/**
 * The field's own zone (`options.timezone` of date fields), else `fallback`
 * — by the IANA primary name PostgreSQL knows (T819: `Asia/Saigon`, as
 * Chrome reports Vietnam, is not in the tzdata of `postgres:18`).
 */
function zoneOf(source: WidgetSource, fallback: string): string {
  const own =
    source.kind === 'column'
      ? canonicalTimeZone((source.field.options as { timezone?: unknown }).timezone)
      : null;
  return own ?? canonicalTimeZone(fallback) ?? fallback;
}

/** Option ids of a select field, in option order. */
function optionsOf(source: WidgetSource): readonly { id: string; name: string }[] {
  if (source.kind !== 'column' || source.field.type !== 'select') return [];
  return (source.field.options as SelectOptions).options;
}

function isMultiple(source: WidgetSource): boolean {
  return (
    source.kind === 'column' && (source.field.options as { multiple?: unknown }).multiple === true
  );
}

/** `date_trunc` unit of a bucket (ISO weeks start on Monday). */
const UNIT: Readonly<Record<DateBucket, string>> = {
  day: 'day',
  week: 'week',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
};

// ---------------------------------------------------------------------------
// Dimensions

interface Dimension {
  readonly spec: WidgetDimensionSpec;
  readonly source: WidgetSource;
  readonly kind: WidgetFieldKind;
  /** The key is a list (one group per element): select (multi), user cells, links. */
  readonly list: boolean;
  /** The group key of the row `t` (before splitting lists). */
  readonly key: RawBuilder<unknown>;
  /** The linked table (link dimensions). */
  readonly target: LinkTarget | null;
}

function dimensionKey(
  spec: WidgetDimensionSpec,
  source: WidgetSource,
  kind: WidgetFieldKind,
  input: Pick<WidgetAggregateInput, 'model' | 'timeZone'>,
): { key: RawBuilder<unknown>; list: boolean } {
  const raw = rawOf(source, input.model);
  switch (kind) {
    case 'text':
      return { key: sql`NULLIF((${raw})::text, '')`, list: false };
    case 'number': {
      const value = sql`(${raw})::numeric`;
      if (spec.bucketWidth === null) return { key: value, list: false };
      const width = sql`${String(spec.bucketWidth)}::numeric`;
      return { key: sql`floor(${value} / ${width}) * ${width}`, list: false };
    }
    case 'select': {
      const ids = optionsOf(source).map((option) => option.id);
      if (isMultiple(source)) {
        // Options removed since are not groups; no current option = empty.
        return {
          key: sql`ARRAY(SELECT x FROM unnest(${raw}) AS x WHERE x = ANY(${sql.val(ids)}::text[]))`,
          list: true,
        };
      }
      return {
        key: sql`CASE WHEN array_position(${sql.val(ids)}::text[], (${raw})[1]) IS NULL THEN NULL ELSE (${raw})[1] END`,
        list: false,
      };
    }
    case 'user':
      return source.kind === 'column' && source.field.type === 'user'
        ? { key: raw, list: true }
        : { key: sql`(${raw})::text`, list: false };
    case 'checkbox':
      return { key: sql`COALESCE((${raw})::boolean, false)`, list: false };
    case 'date': {
      const unit = UNIT[spec.dateBucket ?? 'day'];
      if (isDateOnly(source)) {
        return { key: sql`date_trunc(${unit}, (${raw})::timestamp)::date`, list: false };
      }
      const zone = zoneOf(source, input.timeZone);
      return {
        key: sql`(date_trunc(${unit}, (${raw})::timestamptz, ${zone}) AT TIME ZONE ${zone})::date`,
        list: false,
      };
    }
    case 'link':
      return { key: raw, list: true };
  }
}

/**
 * The natural order of the group values `d` (`dimension_asc`, series):
 * select by option order, user by member name, link by creation of the
 * linked records, others by value (dates by time, text by the table's
 * collation).
 */
function naturalOrder(
  dim: Dimension,
  d: RawBuilder<unknown>,
  orgId: Id<'org'>,
): RawBuilder<unknown> {
  switch (dim.kind) {
    case 'select':
      return sql`array_position(${sql.val(optionsOf(dim.source).map((option) => option.id))}::text[], ${d})`;
    case 'user':
      return sql`(SELECT u.display_name FROM meta.users AS u JOIN meta.org_members AS om ON om.user_id = u.id WHERE om.organization_id = ${orgId} AND u.id = ${d})`;
    case 'link':
      return dim.target === null
        ? d
        : sql`(SELECT lt.__auto FROM ${dataTableRef(dim.target.table)} AS lt WHERE lt.__id = ${d})`;
    default:
      return d;
  }
}

// ---------------------------------------------------------------------------
// Metrics

interface Metric {
  readonly spec: WidgetMetricSpec;
  /** The value aggregated (`null` for `count`). */
  readonly value: RawBuilder<unknown> | null;
  /** `count_distinct` of a list: distinct elements of every list. */
  readonly list: boolean;
}

function metricOf(spec: WidgetMetricSpec, input: WidgetAggregateInput): Metric | null {
  if (spec.field === null)
    return spec.aggregation === 'count' ? { spec, value: null, list: false } : null;
  const source = input.sources.get(spec.field);
  if (source === undefined) return null;
  const kind = kindOf(source);
  if (kind === null) return null;
  const raw = rawOf(source, input.model);
  if (spec.aggregation !== 'count_distinct') {
    if (spec.aggregation === 'count' || kind !== 'number') return null;
    return { spec, value: sql`(${raw})::numeric`, list: false };
  }
  switch (kind) {
    case 'text':
      return { spec, value: sql`NULLIF((${raw})::text, '')`, list: false };
    case 'checkbox':
      return { spec, value: sql`COALESCE((${raw})::boolean, false)`, list: false };
    case 'select':
    case 'link':
      return { spec, value: raw, list: true };
    case 'user':
      return source.kind === 'column' && source.field.type === 'user'
        ? { spec, value: raw, list: true }
        : { spec, value: raw, list: false };
    default:
      return { spec, value: raw, list: false };
  }
}

const vCol = (index: number) => `v${String(index)}`;
const aCol = (index: number) => `a${String(index)}`;

/** `FILTER (WHERE …)` of an aggregate over the conditions given, or nothing. */
function filterOf(...conditions: (RawBuilder<SqlBool> | null)[]): RawBuilder<unknown> {
  const kept = conditions.filter((condition) => condition !== null);
  return kept.length === 0 ? sql`` : sql` FILTER (WHERE ${sql.join(kept, sql` AND `)})`;
}

/**
 * The aggregate of `metric` over rows whose value column is `v`, optionally
 * filtered. Rows spread by {@link spreadLists} hold one element of each list
 * metric (its `v`); `first` keeps one row per record for the other metrics.
 */
function aggregateOf(
  metric: Metric,
  v: RawBuilder<unknown>,
  condition: RawBuilder<SqlBool> | null = null,
  first: RawBuilder<SqlBool> | null = null,
): RawBuilder<unknown> {
  const filter = metric.list ? filterOf(condition) : filterOf(first, condition);
  switch (metric.spec.aggregation) {
    case 'count':
      return sql`count(*)${filter}`;
    case 'count_distinct':
      // List elements are ids in the default (deterministic) collation, whose
      // equality is byte equality: "C" counts the same and sorts faster.
      return metric.list
        ? sql`count(DISTINCT ${v} COLLATE "C")${filter}`
        : sql`count(DISTINCT ${v})${filter}`;
    case 'sum':
      return sql`sum(${v})${filter}`;
    case 'avg':
      return sql`avg(${v})${filter}`;
    case 'min':
      return sql`min(${v})${filter}`;
    case 'max':
      return sql`max(${v})${filter}`;
  }
}

/**
 * The rows of `rows` spread to one row per element of the list metrics
 * (T904): `count(DISTINCT element)` sorts within `work_mem` and spills to
 * disk, where gathering a group's lists (`jsonb_agg`) grew without bound.
 * Lists are zipped, an empty one is one `NULL` (as {@link splitKey}); `mx.o
 * = 1` on one row per row of `rows`. `value(i)`: the element of a list
 * metric, the column of `rows` otherwise.
 */
function spreadLists(
  metrics: readonly Metric[],
  rows: string,
): {
  readonly join: RawBuilder<unknown>;
  readonly first: RawBuilder<SqlBool> | null;
  readonly value: (index: number) => RawBuilder<unknown>;
} {
  const lists = metrics.flatMap((metric, index) => (metric.list ? [index] : []));
  const value = (index: number) => sql.id(metrics[index]?.list ? 'mx' : rows, vCol(index));
  if (lists.length === 0) return { join: sql``, first: null, value };
  const arrays = lists.map(
    (index) =>
      sql`COALESCE(NULLIF(${sql.id(rows, vCol(index))}, '{}'::text[]), ARRAY[NULL]::text[])`,
  );
  const columns = [...lists.map((index) => sql.id(vCol(index))), sql.id('o')];
  return {
    join: sql`CROSS JOIN LATERAL unnest(${sql.join(arrays)}) WITH ORDINALITY AS mx(${sql.join(columns)})`,
    first: sql<SqlBool>`mx.o = 1`,
    value,
  };
}

/** A metric value as returned: a number, `null` when there was nothing to aggregate. */
function numberOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

const metricColumn = (metric: Metric): WidgetDataColumn => ({
  key: metric.spec.id,
  role: 'metric',
  field_id: metric.spec.field,
  field_type: null,
  aggregation: metric.spec.aggregation,
  date_bucket: null,
  bucket_width: null,
});

// ---------------------------------------------------------------------------
// Group values

/** A group key as the API returns it (`YYYY-MM-DD`, numbers, booleans, ids, text). */
function keyOf(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Labels of the group keys of a dimension: option names, member names, record titles. */
async function labelsOf(
  dim: Dimension,
  keys: readonly unknown[],
  input: Pick<
    WidgetAggregateInput,
    'members' | 'scope' | 'access' | 'context' | 'tx' | 'linkTargets'
  >,
): Promise<Map<string, string | null>> {
  const ids = [...new Set(keys.filter((key): key is string => typeof key === 'string'))];
  const labels = new Map<string, string | null>();
  if (ids.length === 0) return labels;
  switch (dim.kind) {
    case 'select':
      for (const option of optionsOf(dim.source)) labels.set(option.id, option.name);
      return labels;
    case 'user':
      for (const member of await input.members.findMembers(input.scope, ids)) {
        labels.set(member.id, member.name);
      }
      return labels;
    case 'link': {
      const target = dim.target;
      if (target?.primary === null || target === null) return labels;
      const primary = target.primary;
      const access = relatedAccessContext(input.access, target.table.id);
      const readableSql = targetReadableSql(target, access, input.context);
      const { rows } = await sql<{ id: string; readable: boolean; title: unknown }>`
        SELECT ${sql.id(TARGET_ALIAS, '__id')} AS id, (${readableSql}) AS readable,
               CASE WHEN ${readableSql} THEN ${sql.id(TARGET_ALIAS, primary.column)} END AS title
          FROM ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
         WHERE ${sql.id(TARGET_ALIAS, '__id')} = ANY(${sql.val(ids)}::text[])
      `.execute(input.tx);
      const readable = rows.filter((row) => row.readable);
      const users = new Map(
        (
          await input.members.findMembers(
            input.scope,
            titleUserIds(
              primary,
              readable.map((row) => row.title),
            ),
          )
        ).map((member) => [member.id as string, member]),
      );
      const locale = { locale: access.locale, timeZone: access.timeZone };
      for (const row of readable) labels.set(row.id, titleOf(primary, row.title, locale, users));
      return labels;
    }
    default:
      return labels;
  }
}

function cellOf(
  dim: Dimension,
  raw: unknown,
  labels: ReadonlyMap<string, string | null>,
): WidgetGroupValue {
  const key = keyOf(raw);
  // `numeric` comes back as text (exact); a group key of a number field is a number.
  const value = dim.kind === 'number' && typeof key === 'string' ? Number(key) : key;
  return { value, label: typeof value === 'string' ? (labels.get(value) ?? null) : null };
}

function dimensionColumn(dim: Dimension, role: 'dimension' | 'series'): WidgetDataColumn {
  return {
    key: role,
    role,
    field_id: dim.spec.field,
    field_type: fieldTypeOf(dim.source),
    aggregation: null,
    date_bucket: dim.kind === 'date' ? dim.spec.dateBucket : null,
    bucket_width: dim.kind === 'number' ? dim.spec.bucketWidth : null,
  };
}

// ---------------------------------------------------------------------------
// Statements

/** Resolves a dimension, or why the widget cannot be computed for this viewer. */
async function dimensionOf(
  spec: WidgetDimensionSpec,
  input: WidgetAggregateInput,
): Promise<Dimension | 'broken' | 'no_permission'> {
  const source = input.sources.get(spec.field);
  if (source === undefined) return 'no_permission';
  const kind = kindOf(source);
  if (kind === null) return 'broken';
  if ((kind === 'date') !== (spec.dateBucket !== null)) return 'broken';
  let target: LinkTarget | null = null;
  if (source.kind === 'link') {
    // Labels are titles of the linked table: the viewer must read it and its
    // primary field (C§1 P20), else the widget has no permission.
    const access = relatedAccessContext(input.access, source.field.targetTableId);
    target = await input.linkTargets.load(input.scope, source.field.targetTableId, access);
    if (target === null) return 'broken';
    if (!target.titleReadable) return 'no_permission';
  }
  const { key, list } = dimensionKey(spec, source, kind, input);
  return { spec, source, kind, list, key, target };
}

interface GroupRow extends Record<string, unknown> {
  readonly kind: number;
  readonly d: unknown;
  readonly s: unknown;
  readonly n: bigint | number | string;
  readonly groups: bigint | number | string | null;
  readonly dims: bigint | number | string | null;
}

/** The element of a group key on a row of `e`: one row per element of a list (empty: one `NULL`). */
function splitKey(
  dim: Dimension,
  column: 'd' | 's',
): {
  readonly value: RawBuilder<unknown>;
  readonly join: RawBuilder<unknown>;
} {
  const ref = sql.id('m', column);
  if (!dim.list) return { value: ref, join: sql`` };
  const alias = sql.id(`${column}x`);
  return {
    value: sql`${alias}.k`,
    join: sql`CROSS JOIN LATERAL unnest(COALESCE(NULLIF(${ref}, '{}'::text[]), ARRAY[NULL]::text[])) AS ${alias}(k)`,
  };
}

async function grouped(
  input: WidgetAggregateInput,
  query: GroupedWidgetQuery,
): Promise<WidgetAggregateResult> {
  const dimension = await dimensionOf(query.dimension, input);
  if (typeof dimension === 'string') return dimension === 'broken' ? BROKEN : NO_PERMISSION;
  let series: Dimension | null = null;
  if (query.series !== null) {
    const resolved = await dimensionOf(query.series, input);
    if (typeof resolved === 'string') return resolved === 'broken' ? BROKEN : NO_PERMISSION;
    series = resolved;
  }
  const metrics: Metric[] = [];
  for (const spec of query.metrics) {
    const metric = metricOf(spec, input);
    if (metric === null) return BROKEN;
    metrics.push(metric);
  }
  const orgId = input.scope.organizationId;
  const valued = metrics.flatMap((metric, index) => (metric.value === null ? [] : [index]));

  const m = sql`SELECT ${sql.join([
    sql`${dimension.key} AS d`,
    ...(series === null ? [] : [sql`${series.key} AS s`]),
    ...valued.map((index) => sql`${(metrics[index] as Metric).value} AS ${sql.id(vCol(index))}`),
  ])} FROM ${input.from} WHERE ${input.where}`;

  const dSplit = splitKey(dimension, 'd');
  const sSplit = series === null ? null : splitKey(series, 's');
  const mSpread = spreadLists(metrics, 'm');
  const e = sql`SELECT ${sql.join([
    sql`${dSplit.value} AS d`,
    sSplit === null ? sql`NULL::text AS s` : sql`${sSplit.value} AS s`,
    ...valued.map((index) => sql`${mSpread.value(index)} AS ${sql.id(vCol(index))}`),
    ...(mSpread.first === null ? [] : [sql`mx.o`]),
  ])} FROM m ${dSplit.join} ${sSplit?.join ?? sql``} ${mSpread.join}`;
  const eFirst = mSpread.first === null ? null : sql<SqlBool>`e.o = 1`;
  const eValue = (index: number) => sql.id('e', vCol(index));

  const aggregates = (
    value: (index: number) => RawBuilder<unknown>,
    first: RawBuilder<SqlBool> | null,
  ) => [
    sql`count(*)${filterOf(first)} AS n`,
    ...metrics.map(
      (metric, index) =>
        sql`${aggregateOf(metric, value(index), null, first)} AS ${sql.id(aCol(index))}`,
    ),
  ];
  const g = sql`SELECT ${sql.join([sql`e.d`, sql`e.s`, ...aggregates(eValue, eFirst)])}
    FROM e GROUP BY e.d, e.s`;

  // Ranking of the dimension groups: by the first metric over every series
  // of the group, or by the dimension; ties and the empty group last.
  const first = metrics[0] as Metric;
  const sortKey = series === null ? sql`r0.${sql.id(aCol(0))}` : sql`r0.k`;
  const rankSource =
    series === null
      ? sql`SELECT g.d, g.${sql.id(aCol(0))} FROM g`
      : sql`SELECT e.d, ${aggregateOf(first, eValue(0), null, eFirst)} AS k FROM e GROUP BY e.d`;
  const natural = naturalOrder(dimension, sql`r0.d`, orgId);
  const byDimension = (direction: RawBuilder<unknown>) =>
    sql`(r0.d IS NULL) ASC, ${natural} ${direction} NULLS LAST, r0.d ${direction}`;
  const ASC = sql`ASC`;
  const DESC = sql`DESC`;
  const order =
    query.sort === 'metric_desc'
      ? sql`${sortKey} DESC NULLS LAST, ${byDimension(ASC)}`
      : query.sort === 'metric_asc'
        ? sql`${sortKey} ASC NULLS LAST, ${byDimension(ASC)}`
        : query.sort === 'dimension_asc'
          ? byDimension(ASC)
          : byDimension(DESC);
  const r = sql`SELECT r0.d, row_number() OVER (ORDER BY ${order}) AS rk FROM (${rankSource}) AS r0`;

  const limit = query.limit;
  const outside = sql<SqlBool>`NOT EXISTS (SELECT 1 FROM r WHERE r.rk <= ${limit} AND r.d IS NOT DISTINCT FROM e.d)`;
  const o = sql`SELECT ${sql.join([sql`e.s`, ...aggregates(eValue, eFirst)])}
    FROM e WHERE ${outside} GROUP BY e.s`;
  const tot = sql`SELECT ${sql.join(aggregates(mSpread.value, mSpread.first))} FROM m ${mSpread.join}`;

  const metricColumns = (rows: string) =>
    metrics.map((_, index) => sql`${sql.id(rows, aCol(index))} AS ${sql.id(aCol(index))}`);
  // `so`: natural order of the series (same type in every branch); the empty series last.
  const seriesOrder = (s: RawBuilder<unknown>) =>
    series === null ? sql`NULL::text` : naturalOrder(series, s, orgId);
  const statement = sql`
    WITH m AS (${m}), e AS (${e}), g AS (${g}), r AS (${r})${
      query.groupOthers ? sql`, o AS (${o})` : sql``
    }, tot AS (${tot})
    SELECT * FROM (
      SELECT 0 AS kind, g.d, g.s, r.rk, g.n, ${sql.join(metricColumns('g'))},
             NULL::bigint AS groups, NULL::bigint AS dims,
             ${seriesOrder(sql`g.s`)} AS so, (g.s IS NULL) AS s_empty
        FROM g JOIN r ON r.d IS NOT DISTINCT FROM g.d
       WHERE r.rk <= ${limit}
      ${
        query.groupOthers
          ? sql`UNION ALL
      SELECT 1, NULL, o.s, NULL, o.n, ${sql.join(metricColumns('o'))}, NULL, NULL,
             ${seriesOrder(sql`o.s`)}, (o.s IS NULL)
        FROM o`
          : sql``
      }
      UNION ALL
      SELECT 2, NULL, NULL, NULL, tot.n, ${sql.join(metricColumns('tot'))},
             (SELECT count(*) FROM g), (SELECT count(*) FROM r), NULL, NULL
        FROM tot
    ) AS out
    ORDER BY kind, rk, s_empty, so NULLS LAST, s`;
  const { rows } = await statement.execute(input.tx);
  const all = rows as readonly GroupRow[];

  const totalRow = all.find((row) => row.kind === 2);
  const groupCount = Number(totalRow?.groups ?? 0);
  if (groupCount > MAX_WIDGET_GROUPS) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `The widget has more than ${String(MAX_WIDGET_GROUPS)} groups.`,
      errors: [
        {
          path: '',
          code: WIDGET_TOO_LARGE,
          message: `The widget has more than ${String(MAX_WIDGET_GROUPS)} groups`,
          params: { groups: groupCount, limit: MAX_WIDGET_GROUPS },
        },
      ],
    });
  }

  const columns = [
    dimensionColumn(dimension, 'dimension'),
    ...(series === null ? [] : [dimensionColumn(series, 'series')]),
    ...metrics.map(metricColumn),
  ];
  const count = Number(totalRow?.n ?? 0);
  if (count === 0) return { status: 'empty', columns, rows: [] };

  const groupRows = all.filter((row) => row.kind === 0);
  const otherRows = all.filter((row) => row.kind === 1);
  const dLabels = await labelsOf(
    dimension,
    groupRows.map((row) => row.d),
    input,
  );
  const sLabels =
    series === null
      ? new Map<string, string | null>()
      : await labelsOf(
          series,
          [...groupRows, ...otherRows].map((row) => row.s),
          input,
        );
  const values = (row: Readonly<Record<string, unknown>>) =>
    metrics.map((_, index) => numberOf(row[aCol(index)]));
  const rowOf = (row: GroupRow, dimensionCell: WidgetGroupValue | null): unknown[] => [
    dimensionCell,
    ...(series === null ? [] : [cellOf(series, row.s, sLabels)]),
    ...values(row),
  ];
  const dims = Number(totalRow?.dims ?? 0);
  return {
    status: 'ok',
    columns,
    rows: groupRows.map((row) => rowOf(row, cellOf(dimension, row.d, dLabels))),
    ...(query.groupOthers && dims > limit && otherRows.length > 0
      ? { other: { groups: dims - limit, rows: otherRows.map((row) => rowOf(row, null)) } }
      : {}),
    total: totalRow === undefined ? metrics.map(() => null) : values(totalRow),
  };
}

async function kpi(
  input: WidgetAggregateInput,
  query: KpiWidgetQuery,
): Promise<WidgetAggregateResult> {
  const metric = metricOf(query.metric, input);
  if (metric === null) return BROKEN;
  const columns = [metricColumn(metric)];
  const values = metric.value === null ? [] : [sql`${metric.value} AS ${sql.id(vCol(0))}`];
  const spread = spreadLists([metric], 'm');
  const v = spread.value(0);

  if (query.compare === null) {
    const m = sql`SELECT ${sql.join([sql`1 AS one`, ...values])} FROM ${input.from} WHERE ${input.where}`;
    const { rows } = await sql<{ n: bigint; a0: unknown }>`
      WITH m AS (${m})
      SELECT count(*)${filterOf(spread.first)} AS n, ${aggregateOf(metric, v, null, spread.first)} AS a0
        FROM m ${spread.join}
    `.execute(input.tx);
    const row = rows[0];
    if (Number(row?.n ?? 0) === 0) return { status: 'empty', columns, rows: [] };
    return { status: 'ok', columns, rows: [[numberOf(row?.a0)]] };
  }

  const dateSource = input.sources.get(query.compare.dateField);
  if (dateSource === undefined) return NO_PERMISSION;
  if (kindOf(dateSource) !== 'date') return BROKEN;
  const raw = rawOf(dateSource, input.model);
  const unit = query.compare.period;
  const interval = periodInterval(unit);
  const now = input.now.toISOString();
  const dateOnly = isDateOnly(dateSource);
  const zone = zoneOf(dateSource, input.timeZone);
  // Current calendar period (in the zone) and the one before it.
  const bounds = dateOnly
    ? sql`SELECT x.cs, (x.cs + ${interval}::interval)::date AS ce, (x.cs - ${interval}::interval)::date AS ps
            FROM (SELECT date_trunc(${unit}, ((${now}::timestamptz AT TIME ZONE ${zone})::date)::timestamp)::date AS cs) AS x`
    : sql`SELECT x.cs, date_add(x.cs, ${interval}::interval, ${zone}) AS ce,
                 date_subtract(x.cs, ${interval}::interval, ${zone}) AS ps
            FROM (SELECT date_trunc(${unit}, ${now}::timestamptz, ${zone}) AS cs) AS x`;
  const c = sql.id('m', 'c');
  const current = sql<SqlBool>`${c} >= (SELECT b.cs FROM b) AND ${c} < (SELECT b.ce FROM b)`;
  const previous = sql<SqlBool>`${c} >= (SELECT b.ps FROM b) AND ${c} < (SELECT b.cs FROM b)`;
  const cast = dateOnly ? sql`date` : sql`timestamptz`;
  const m = sql`SELECT ${sql.join([sql`(${raw})::${cast} AS c`, ...values])}
    FROM ${input.from} WHERE ${input.where}`;
  const { rows } = await sql<{
    n: bigint;
    pn: bigint;
    a0: unknown;
    p0: unknown;
    cs: unknown;
    ce: unknown;
    ps: unknown;
  }>`
    WITH b AS (${bounds}), m AS (${m})
    SELECT count(*)${filterOf(spread.first, current)} AS n,
           count(*)${filterOf(spread.first, previous)} AS pn,
           ${aggregateOf(metric, v, current, spread.first)} AS a0,
           ${aggregateOf(metric, v, previous, spread.first)} AS p0,
           (SELECT b.cs FROM b) AS cs, (SELECT b.ce FROM b) AS ce, (SELECT b.ps FROM b) AS ps
      FROM m ${spread.join}
  `.execute(input.tx);
  const row = rows[0];
  if (row === undefined || Number(row.n) + Number(row.pn) === 0) {
    return { status: 'empty', columns, rows: [] };
  }
  const value = numberOf(row.a0);
  const before = numberOf(row.p0);
  const text = (bound: unknown) =>
    bound instanceof Date ? bound.toISOString() : String(bound).slice(0, 10);
  return {
    status: 'ok',
    columns,
    rows: [[value]],
    compare: {
      previous: before,
      change:
        value === null || before === null || before === 0
          ? null
          : (value - before) / Math.abs(before),
      current_period: { from: text(row.cs), to: text(row.ce) },
      previous_period: { from: text(row.ps), to: text(row.cs) },
    },
  };
}

/** The widget's numbers for the prepared read (see the module comment). */
export function aggregateWidget(input: WidgetAggregateInput): Promise<WidgetAggregateResult> {
  return input.query.kind === 'kpi' ? kpi(input, input.query) : grouped(input, input.query);
}

// ---------------------------------------------------------------------------
// Live filters, click-through and filter control values (T808)

/**
 * Whether the viewer may see the groups of a dimension: `no_permission`
 * when they cannot read its field (or, for a link, the linked table's
 * title), `broken` when it no longer groups — as the widget itself answers.
 */
export async function dimensionStatus(
  spec: WidgetDimensionSpec,
  input: WidgetAggregateInput,
): Promise<'ok' | 'broken' | 'no_permission'> {
  const dimension = await dimensionOf(spec, input);
  return typeof dimension === 'string' ? dimension : 'ok';
}

/**
 * The rows of one group of a dimension (a cross-filter or a click-through
 * segment): the same group key as {@link aggregateWidget}, so the rows are
 * exactly the ones counted in that group — `value` is a group `value` as
 * returned (`null`: the empty group; a list key matches when it holds the
 * value). `'invalid'` when the value cannot be a group of this dimension
 * (wrong type, not a day); `'broken'` when the field no longer groups.
 */
export function segmentCondition(
  spec: WidgetDimensionSpec,
  source: WidgetSource,
  value: WidgetGroupKey,
  input: Pick<WidgetAggregateInput, 'model' | 'timeZone'>,
): RawBuilder<SqlBool> | 'invalid' | 'broken' {
  const kind = kindOf(source);
  if (kind === null || (kind === 'date') !== (spec.dateBucket !== null)) return 'broken';
  const { key, list } = dimensionKey(spec, source, kind, input);
  if (value === null) {
    return list
      ? sql<SqlBool>`cardinality(COALESCE(${key}, '{}'::text[])) = 0`
      : sql<SqlBool>`(${key}) IS NULL`;
  }
  const matches = (cast: RawBuilder<unknown>) =>
    list ? sql<SqlBool>`${cast} = ANY(${key})` : sql<SqlBool>`(${key}) = ${cast}`;
  switch (kind) {
    case 'text':
    case 'select':
    case 'user':
    case 'link':
      return typeof value === 'string' ? matches(sql`${value}::text`) : 'invalid';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? matches(sql`${String(value)}::numeric`)
        : 'invalid';
    case 'checkbox':
      return typeof value === 'boolean' ? matches(sql`${value}::boolean`) : 'invalid';
    case 'date':
      return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
        parseExactDate(value) !== null
        ? matches(sql`${value}::date`)
        : 'invalid';
  }
}

/** The field kind each filter control reads. */
const CONTROL_KINDS: Readonly<Record<FilterControlKind, WidgetFieldKind>> = {
  select: 'select',
  user: 'user',
  text: 'text',
  date_range: 'date',
  number_range: 'number',
};

/** Members scanned when a user control is searched by name (the rest are not offered). */
const MAX_SEARCHED_USERS = 1000;

export interface ControlOptionsInput extends Omit<WidgetAggregateInput, 'query' | 'now'> {
  readonly field: Id<'fld'>;
  /** `select`, `user` or `text`. */
  readonly control: FilterControlKind;
  /** Part of the option or member name (a text control's search is in `where`). */
  readonly search: string | null;
  readonly limit: number;
}

/**
 * Distinct non-empty values of a filter control's field among the rows of
 * `where` (the viewer's read rule, parent controls, a text search), in the
 * natural order of the field (options, member names, text) — one statement,
 * values only, at most `limit` (`hasMore` when there are more). A select is
 * searched by option name, a user by member name. The viewer must read the
 * field (`no_permission` otherwise); a field that no longer fits the control
 * is `broken`.
 */
export async function controlOptions(input: ControlOptionsInput): Promise<ControlOptionsResult> {
  const source = input.sources.get(input.field);
  if (source === undefined) return { status: 'no_permission', items: [], hasMore: false };
  const kind = kindOf(source);
  if (kind === null || kind !== CONTROL_KINDS[input.control]) {
    return { status: 'broken', items: [], hasMore: false };
  }
  const spec: WidgetDimensionSpec = { field: input.field, dateBucket: null, bucketWidth: null };
  const { key, list } = dimensionKey(spec, source, kind, input);
  const dimension: Dimension = { spec, source, kind, list, key, target: null };
  const search = input.search === null || input.search === '' ? null : foldText(input.search);
  const conditions: RawBuilder<SqlBool>[] = [sql<SqlBool>`e.d IS NOT NULL`];
  if (search !== null && kind === 'select') {
    const ids = optionsOf(source)
      .filter((option) => foldText(option.name).includes(search))
      .map((option) => option.id);
    conditions.push(sql<SqlBool>`e.d = ANY(${sql.val(ids)}::text[])`);
  }
  const scan = search !== null && kind === 'user' ? MAX_SEARCHED_USERS : input.limit + 1;
  const split = splitKey(dimension, 'd');
  const { rows } = await sql<{ d: unknown }>`
    WITH m AS (SELECT ${key} AS d FROM ${input.from} WHERE ${input.where}),
         e AS (SELECT ${split.value} AS d FROM m ${split.join})
    SELECT e.d FROM e
     WHERE ${sql.join(conditions, sql` AND `)}
     GROUP BY e.d
     ORDER BY ${naturalOrder(dimension, sql`e.d`, input.scope.organizationId)} ASC NULLS LAST, e.d ASC
     LIMIT ${scan}
  `.execute(input.tx);
  const labels = await labelsOf(
    dimension,
    rows.map((row) => row.d),
    input,
  );
  let items = rows.map((row) => cellOf(dimension, row.d, labels));
  if (search !== null && kind === 'user') {
    items = items.filter((item) => foldText(item.label ?? '').includes(search));
  }
  return {
    status: 'ok',
    items: items.slice(0, input.limit),
    hasMore: items.length > input.limit,
  };
}
