import {
  MAX_GROUP_COUNT_GROUPS,
  summaryFunctionsOf,
  type Id,
  type ProblemErrorItem,
  type SummaryFunction,
} from '@cellhive/contracts';
import {
  formatComputedText,
  numberFieldType,
  type ComputedStyle,
  type LocaleContext,
  type NumberOptions,
  type ReadContext,
} from '@cellhive/field-types';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { AppError } from '../../errors/app-error.js';
import { assertDataTableName, assertJunctionTableName, DATA_SCHEMA } from '../../schema/names.js';
import {
  computedCellValue,
  EMPTY_COMPUTED_CELL_DATA,
  type ComputedField,
} from '../computed/read/index.js';

import type { Tx } from '../../db/create-db.js';
import type { SqlLinkFieldMeta } from '../../query/index.js';
import type { LinkFieldModel } from '../links/link-model.js';
import type { FieldModel, TableModel } from '../table-model.js';
import type { ParentFieldModel } from '../tree/parent-model.js';
import type {
  CellFormat,
  FieldKeyType,
  RecordSummariesOutput,
  RecordSummary,
  RecordSummaryGroup,
  RecordViewScope,
} from '../types.js';
import type { OrderField, QueryView, ViewOrderItem } from '../view-scope.js';

/**
 * The summary bar of a grid and the summaries of its group headers (BACKLOG
 * T472, CONTRACTS §1.4 `records/summaries`, §15). `RecordQueryService`
 * builds the read (table access, view, WHERE of `records/query`, group
 * levels) and calls {@link summarize}, which answers with **one** aggregate
 * statement over the matching rows — no record is loaded:
 *
 * ```sql
 * WITH m AS (SELECT <group values g…>, <field values v…> FROM data.t WHERE …),
 *      a AS (SELECT g…, GROUPING(g…), count(*), <aggregates> FROM m GROUP BY ROLLUP (g…)),
 *      u… AS (<distinct elements of a list field per group>)
 * SELECT … FROM a LEFT JOIN u… ORDER BY <rows order of records/query> LIMIT …
 * ```
 *
 * `ROLLUP` gives the whole set (first row) and every group of every level
 * in one pass; a list field's `unique` counts the distinct elements of the
 * flattened lists (empty cells ignored, BACKLOG S4b decision 8), joined per
 * group. Only fields the reader reads are summarised: a field locked for
 * them (T457) is treated as one they do not see (`UNKNOWN_FIELD` in the
 * request, skipped in the view's saved entries — T501), and a formula/lookup
 * value is its expression for the reader (`ComputedField.value`, the
 * viewer's source scope).
 */

/** Alias of the data table in the statement (as in `RecordQueryService`). Code only. */
const ALIAS = 't';
const col = (column: string) => sql.id(ALIAS, column);

/** How a summarised value is stored in the statement. */
type ValueKind =
  /** `text` (empty: `NULL` or `''`). */
  | 'text'
  /** A scalar of another type (numbers, dates, ids): empty is `NULL`. */
  | 'scalar'
  /** `boolean` (check boxes): `checked` is `true`. */
  | 'boolean'
  /** An array (select, user, link, lists): empty is `NULL` or `{}`; elements are unique. */
  | 'array'
  /** A `jsonb` array of attachments: empty is `NULL` or `[]`; unique by attachment id. */
  | 'jsonb';

/** A readable field with what it summarises as. */
type SummaryField =
  | { readonly kind: 'column'; readonly field: FieldModel }
  | { readonly kind: 'link'; readonly field: LinkFieldModel }
  | { readonly kind: 'parent'; readonly field: ParentFieldModel }
  | { readonly kind: 'computed'; readonly field: ComputedField };

interface SummaryTarget {
  readonly source: SummaryField;
  /** Key of the result (field id or name per `field_key_type`). */
  readonly key: string;
  readonly fn: SummaryFunction;
  readonly valueKind: ValueKind;
  readonly value: RawBuilder<unknown>;
}

/** What the read plan of `RecordQueryService` gives this module. */
export interface SummaryPlan {
  readonly model: TableModel;
  /** Formula/lookup fields the reader reads (maybe locked). */
  readonly visibleComputed: readonly ComputedField[];
  readonly fieldKeyType: FieldKeyType;
  readonly cellFormat: CellFormat;
  readonly view: QueryView | null;
  readonly viewScope: RecordViewScope;
}

export interface SummarizeInput {
  readonly tx: Tx;
  readonly organizationId: Id<'org'>;
  readonly plan: SummaryPlan;
  /** `data.<table> AS t`. */
  readonly from: RawBuilder<unknown>;
  /** The WHERE of `records/query` (view, filter, search, read rule, not deleted). */
  readonly where: RawBuilder<SqlBool>;
  /** Group levels on fields the reader reads (as `records/group-counts`). */
  readonly group: readonly ViewOrderItem[];
  /** Summaries of the request (`null`/absent: the view's saved ones). */
  readonly requested: Readonly<Record<string, SummaryFunction>> | null | undefined;
  readonly locale: LocaleContext;
  /** The stored value a group level groups on (`groupValue` of the query service). */
  readonly groupValue: (field: OrderField) => RawBuilder<unknown>;
  /** ORDER BY terms of a group level (`groupTerms` of the query service), rendered. */
  readonly groupOrder: (item: ViewOrderItem) => readonly RawBuilder<unknown>[];
  /**
   * Group values as `records/group-counts` returns them: `rows[i]['c' + level]`
   * holds the raw value of each level (computed values as `to_jsonb`).
   */
  readonly groupValues: (
    fields: readonly OrderField[],
    rows: readonly Readonly<Record<string, unknown>>[],
  ) => Promise<unknown[][]>;
}

const unknownField = (path: string): ProblemErrorItem => ({
  path,
  code: 'UNKNOWN_FIELD',
  // Same message for a hidden field and a missing one (CONTRACTS §6).
  message: 'Field does not exist',
});

// ---------------------------------------------------------------------------
// Fields

function readableFields(plan: SummaryPlan): SummaryField[] {
  const { model } = plan;
  return [
    ...model.visible.map((field) => ({ kind: 'column' as const, field })),
    ...model.visibleLinks.map((field) => ({ kind: 'link' as const, field })),
    ...(model.visibleParent === null
      ? []
      : [{ kind: 'parent' as const, field: model.visibleParent }]),
    ...plan.visibleComputed.map((field) => ({ kind: 'computed' as const, field })),
  ];
}

/** Type and result type of a field, as `summaryFunctionsOf` takes them. */
function functionsOf(source: SummaryField): readonly SummaryFunction[] {
  switch (source.kind) {
    case 'column':
      return summaryFunctionsOf(source.field.type);
    case 'link':
      return summaryFunctionsOf('link');
    case 'parent':
      return summaryFunctionsOf('parent');
    case 'computed':
      return summaryFunctionsOf(source.field.type, source.field.publicType);
  }
}

function valueKindOf(source: SummaryField): ValueKind {
  switch (source.kind) {
    case 'link':
      return 'array';
    case 'parent':
      return 'scalar';
    case 'computed': {
      const type = source.field.publicType;
      if (type.kind === 'attachment') return 'jsonb';
      if (type.list) return 'array';
      if (type.kind === 'boolean') return 'boolean';
      return type.kind === 'text' ? 'text' : 'scalar';
    }
    case 'column':
      switch (source.field.type) {
        case 'text':
        case 'auto_number':
          return 'text';
        case 'checkbox':
          return 'boolean';
        case 'select':
        case 'user':
          return 'array';
        case 'attachment':
          return 'jsonb';
        default:
          return 'scalar';
      }
  }
}

/** Live records linked from the row (like a link cell and its filters, T402). */
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

function valueOf(source: SummaryField, model: TableModel): RawBuilder<unknown> {
  switch (source.kind) {
    case 'column':
      return col(source.field.column);
    case 'parent':
      return col('__parent_id');
    case 'computed':
      return source.field.value(ALIAS);
    case 'link': {
      const meta = model.queryFilterMeta.fields.find((field) => field.id === source.field.id);
      return linkValue(meta?.link);
    }
  }
}

/**
 * The summaries to compute: the request's (a field the reader cannot read
 * or that is locked for them is `UNKNOWN_FIELD`, as in filter/sort/group —
 * CONTRACTS §1.4, P34/P36; a function its type does not take
 * `INVALID_FIELD_TYPE`), else the view's saved ones (entries on fields gone,
 * unreadable, locked or with a function no longer valid are skipped: a
 * permission change after saving must not break other readers' bar).
 */
function targetsOf(input: SummarizeInput): SummaryTarget[] {
  const { plan } = input;
  const fields = readableFields(plan);
  const byId = new Map(fields.map((source) => [source.field.id as string, source]));
  const keyOf = (source: SummaryField) =>
    plan.fieldKeyType === 'id' ? source.field.id : source.field.name;
  const target = (source: SummaryField, fn: SummaryFunction): SummaryTarget => ({
    source,
    key: keyOf(source),
    fn,
    valueKind: valueKindOf(source),
    value: valueOf(source, plan.model),
  });
  const locked = (source: SummaryField) => source.kind === 'computed' && source.field.locked;

  if (input.requested !== undefined && input.requested !== null) {
    const byKey = new Map(fields.map((source) => [keyOf(source), source]));
    const errors: ProblemErrorItem[] = [];
    const targets: SummaryTarget[] = [];
    for (const [key, fn] of Object.entries(input.requested)) {
      const path = `summaries.${key}`;
      const source = byKey.get(key);
      if (source === undefined || locked(source)) {
        errors.push(unknownField(path));
      } else if (!functionsOf(source).includes(fn)) {
        errors.push({
          path,
          code: 'INVALID_FIELD_TYPE',
          message: `The field type does not take the summary ${fn}`,
          params: { fn, type: source.kind === 'column' ? source.field.type : source.kind },
        });
      } else {
        targets.push(target(source, fn));
      }
    }
    if (errors.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The summaries are invalid.',
        errors,
      });
    }
    return targets;
  }

  const saved = plan.view?.config.summaries ?? {};
  return Object.entries(saved).flatMap(([id, fn]) => {
    const source = byId.get(id);
    if (source === undefined || locked(source) || !functionsOf(source).includes(fn)) return [];
    return [target(source, fn)];
  });
}

// ---------------------------------------------------------------------------
// SQL

const vCol = (index: number) => `v${String(index)}`;
const gCol = (level: number) => `g${String(level)}`;
const rCol = (level: number) => `r${String(level)}`;
const sCol = (index: number) => `s${String(index)}`;
const xCol = (index: number) => `x${String(index)}`;
const uCte = (index: number) => `u${String(index)}`;

/** `v` is empty (CONTRACTS §15, the `is_empty` of filters). */
function isEmpty(kind: ValueKind, v: RawBuilder<unknown>): RawBuilder<SqlBool> {
  switch (kind) {
    case 'text':
      return sql<SqlBool>`(${v} IS NULL OR ${v} = '')`;
    case 'array':
      return sql<SqlBool>`(${v} IS NULL OR cardinality(${v}) = 0)`;
    case 'jsonb':
      return sql<SqlBool>`(${v} IS NULL OR ${v} = '[]'::jsonb)`;
    case 'boolean':
      return sql<SqlBool>`(${v} IS NOT TRUE)`;
    case 'scalar':
      return sql<SqlBool>`(${v} IS NULL)`;
  }
}

/**
 * `unique` is counted by a CTE of its own: the distinct (group, value)
 * pairs first (a hash aggregate, far fewer rows than records), then their
 * count per group of every level — `count(DISTINCT …)` over `ROLLUP` on
 * every row would sort the whole set once per level. A list counts its
 * elements (flattened, S4b decision 8).
 */
function countsDistinct(target: SummaryTarget): boolean {
  return target.fn === 'unique';
}

/** The aggregates of one target over `m` (`s<i>`, and `x<i>` for the upper bound of ranges). */
function aggregatesOf(target: SummaryTarget, index: number): RawBuilder<unknown>[] {
  const v = sql.id('m', vCol(index));
  const s = sql.id(sCol(index));
  const x = sql.id(xCol(index));
  // Computed values leave the statement as JSON, like their cells.
  const raw = (expr: RawBuilder<unknown>) =>
    target.source.kind === 'computed' ? sql`to_jsonb(${expr})` : expr;
  const empty = isEmpty(target.valueKind, v);
  switch (target.fn) {
    case 'count_all':
      return [sql`count(*) AS ${s}`];
    case 'filled':
    case 'percent_filled':
      return [sql`count(*) FILTER (WHERE NOT ${empty}) AS ${s}`];
    case 'empty':
    case 'percent_empty':
      return [sql`count(*) FILTER (WHERE ${empty}) AS ${s}`];
    case 'checked':
    case 'percent_checked':
      return [sql`count(*) FILTER (WHERE ${v} IS TRUE) AS ${s}`];
    case 'unchecked':
      return [sql`count(*) FILTER (WHERE ${v} IS NOT TRUE) AS ${s}`];
    case 'unique':
      return [];
    case 'sum':
      return [sql`${raw(sql`sum(${v})`)} AS ${s}`];
    case 'avg':
      return [sql`${raw(sql`avg(${v})`)} AS ${s}`];
    case 'min':
    case 'earliest':
      return [sql`${raw(sql`min(${v})`)} AS ${s}`];
    case 'max':
    case 'latest':
      return [sql`${raw(sql`max(${v})`)} AS ${s}`];
    case 'range':
    case 'date_range':
      return [sql`${raw(sql`min(${v})`)} AS ${s}`, sql`${raw(sql`max(${v})`)} AS ${x}`];
  }
}

/** What `unique` counts over `m`: the rows it reads and the value of each (`NULL`: not counted). */
function distinctSource(
  target: SummaryTarget,
  index: number,
): { readonly from: RawBuilder<unknown>; readonly item: RawBuilder<unknown> } {
  const v = sql.id('m', vCol(index));
  switch (target.valueKind) {
    case 'array':
      return { from: sql`m CROSS JOIN LATERAL unnest(${v}) AS e(item)`, item: sql`e.item` };
    case 'jsonb':
      return {
        from: sql`m CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(${v}) = 'array' THEN ${v} ELSE '[]'::jsonb END) AS e(item)`,
        item: sql`e.item ->> 'id'`,
      };
    case 'text':
      return { from: sql`m`, item: sql`NULLIF(${v}, '')` };
    default:
      return { from: sql`m`, item: v };
  }
}

interface SummaryRow extends Record<string, unknown> {
  readonly n: bigint | string | number;
}

function statement(input: SummarizeInput, targets: readonly SummaryTarget[]): RawBuilder<unknown> {
  const levels = input.group.map((_, level) => level);
  const gIds = levels.map((level) => sql.id(gCol(level)));
  const grouping =
    levels.length === 0 ? sql`` : sql`GROUP BY ROLLUP (${sql.join(gIds.map((g) => sql`${g}`))})`;
  const flags = levels.map(
    (level) => sql`GROUPING(${sql.id(gCol(level))}) AS ${sql.id(rCol(level))}`,
  );
  const groupColumns = [...gIds.map((g) => sql`${g}`), ...flags];

  const m = sql`SELECT ${sql.join([
    sql`1 AS __one`,
    ...input.group.map(
      (item, level) => sql`${input.groupValue(item.field)} AS ${sql.id(gCol(level))}`,
    ),
    ...targets.map((target, index) => sql`${target.value} AS ${sql.id(vCol(index))}`),
  ])} FROM ${input.from} WHERE ${input.where}`;

  const a = sql`SELECT ${sql.join([
    ...groupColumns,
    sql`count(*) AS n`,
    ...targets.flatMap((target, index) => aggregatesOf(target, index)),
  ])} FROM m ${grouping}`;

  const lists = targets.flatMap((target, index) => (countsDistinct(target) ? [index] : []));
  const ctes = [
    sql`m AS (${m})`,
    sql`a AS (${a})`,
    ...lists.map((index) => {
      const source = distinctSource(targets[index] as SummaryTarget, index);
      const pairs = sql.join([...gIds.map((g) => sql`m.${g}`), source.item]);
      // Each (group, value) once: exact per leaf group; outer levels merge leaves.
      return sql`${sql.id(uCte(index))} AS (
        SELECT ${sql.join([...groupColumns, sql`count(DISTINCT d.item) AS u`])}
          FROM (SELECT ${sql.join([...gIds.map((g) => sql`m.${g}`), sql`${source.item} AS item`])}
                  FROM ${source.from}
                 GROUP BY ${pairs}) AS d
         WHERE d.item IS NOT NULL
         ${grouping})`;
    }),
  ];
  const joins = lists.map((index) => {
    const u = sql.id(uCte(index));
    const on =
      levels.length === 0
        ? sql`true`
        : sql.join(
            levels.flatMap((level) => [
              sql`${u}.${sql.id(rCol(level))} = ${col(rCol(level))}`,
              sql`${u}.${sql.id(gCol(level))} IS NOT DISTINCT FROM ${col(gCol(level))}`,
            ]),
            sql` AND `,
          );
    return sql`LEFT JOIN ${u} ON ${on}`;
  });

  // Output: the group values (computed ones as JSON, like group counts) as
  // `c<level>`, and the list uniques as `s<i>`.
  const outputs = [
    sql`${col('n')} AS n`,
    ...levels.flatMap((level) => {
      const item = input.group[level] as ViewOrderItem;
      const g = col(gCol(level));
      return [
        sql`${col(rCol(level))} AS ${sql.id(rCol(level))}`,
        'computed' in item.field
          ? sql`to_jsonb(${g}) AS ${sql.id(`c${String(level)}`)}`
          : sql`${g} AS ${sql.id(`c${String(level)}`)}`,
      ];
    }),
    ...targets.flatMap((target, index) => {
      if (countsDistinct(target)) {
        return [sql`COALESCE(${sql.id(uCte(index))}.u, 0) AS ${sql.id(sCol(index))}`];
      }
      const columns = aggregatesOf(target, index).length;
      return [
        sql`${col(sCol(index))} AS ${sql.id(sCol(index))}`,
        ...(columns > 1 ? [sql`${col(xCol(index))} AS ${sql.id(xCol(index))}`] : []),
      ];
    }),
  ];
  // Row order of `records/query`: the whole set first, then each group
  // before its inner groups (rolled-up rows first), groups in sort order.
  const order = levels.flatMap((level) => {
    const item = input.group[level] as ViewOrderItem;
    const outer: OrderField =
      'computed' in item.field
        ? { ...item.field, value: () => col(gCol(level)) }
        : { ...item.field, column: gCol(level) };
    return [
      sql`${col(rCol(level))} DESC`,
      ...input.groupOrder({ field: outer, direction: item.direction }),
    ];
  });
  return sql`
    WITH ${sql.join(ctes)}
    SELECT ${sql.join(outputs)}
      FROM a AS ${sql.id(ALIAS)}
      ${sql.join(joins, sql` `)}
     ${order.length === 0 ? sql`` : sql`ORDER BY ${sql.join(order)}`}
     LIMIT ${MAX_GROUP_COUNT_GROUPS + 2}`;
}

// ---------------------------------------------------------------------------
// Values

const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

/** Days between two dates or date-times (`YYYY-MM-DD`, ISO strings, `Date`). */
function daysBetween(min: unknown, max: unknown): number | null {
  const time = (value: unknown): number => {
    if (value instanceof Date) return value.getTime();
    if (typeof value !== 'string') return Number.NaN;
    return /^\d{4}-\d{2}-\d{2}$/u.test(value)
      ? Date.parse(`${value}T00:00:00Z`)
      : Date.parse(value);
  };
  const from = time(min);
  const to = time(max);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

/** A rating shows stars in a cell; a sum or an average of ratings is a plain number. */
function plainRatingStyle(style: ComputedStyle | null, fn: SummaryFunction): ComputedStyle | null {
  if (style === null || !('type' in style) || style.type !== 'rating') return style;
  return {
    type: 'plain',
    precision: fn === 'avg' ? 2 : 0,
    percentage: false,
    thousands_separator: true,
  };
}

const EMPTY_READ_CONTEXT: ReadContext = { resolveUser: () => undefined };

/**
 * One aggregated value (`sum`, `min`, `earliest`…) as the API returns it:
 * the cell form of the field's type (`json`), or formatted with the field's
 * style (`text`).
 */
function valueOfField(
  target: SummaryTarget,
  raw: unknown,
  format: CellFormat,
  input: SummarizeInput,
): unknown {
  const { source, fn } = target;
  const { locale } = input;
  if (raw === null || raw === undefined) return null;
  if (source.kind === 'computed') {
    const field = source.field;
    const json = computedCellValue(
      field,
      raw,
      EMPTY_COMPUTED_CELL_DATA,
      'json',
      locale,
      input.plan.viewScope,
    );
    if (format === 'json' || json === null) return json;
    return formatComputedText(json, field.publicType, plainRatingStyle(field.style, fn), locale);
  }
  if (source.kind !== 'column') return null;
  const { definition, options } = source.field;
  const json = definition.fromStorage(raw, options, EMPTY_READ_CONTEXT);
  if (format === 'json' || json === null) return json;
  if (source.field.type === 'number') {
    const style = plainRatingStyle((options as NumberOptions).style, fn);
    return numberFieldType.formatText(
      json as number,
      { ...(options as NumberOptions), style } as NumberOptions,
      locale,
    );
  }
  return definition.formatText(json, options, locale);
}

function summaryOf(
  target: SummaryTarget,
  index: number,
  row: Readonly<Record<string, unknown>>,
  count: number,
  input: SummarizeInput,
): RecordSummary {
  const { fn } = target;
  const format = input.plan.cellFormat;
  const s = row[sCol(index)];
  const x = row[xCol(index)];
  switch (fn) {
    case 'count_all':
    case 'filled':
    case 'empty':
    case 'unique':
    case 'checked':
    case 'unchecked':
      return { fn, value: toNumber(s ?? 0) };
    case 'percent_filled':
    case 'percent_empty':
    case 'percent_checked': {
      const part = toNumber(s ?? 0);
      return { fn, value: count === 0 ? null : part / count, count: part };
    }
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
    case 'earliest':
    case 'latest':
      return { fn, value: valueOfField(target, s, format, input) };
    case 'range': {
      const min = valueOfField(target, s, format, input);
      const max = valueOfField(target, x, format, input);
      return { fn, value: min === null || max === null ? null : { min, max } };
    }
    case 'date_range': {
      const min = valueOfField(target, s, format, input);
      const max = valueOfField(target, x, format, input);
      if (min === null || max === null) return { fn, value: null };
      // Days from the JSON form (text values are formatted for display).
      const days =
        format === 'json'
          ? daysBetween(min, max)
          : daysBetween(
              valueOfField(target, s, 'json', input),
              valueOfField(target, x, 'json', input),
            );
      return { fn, value: { min, max, days } };
    }
  }
}

function summariesOf(
  targets: readonly SummaryTarget[],
  row: Readonly<Record<string, unknown>>,
  count: number,
  input: SummarizeInput,
): Record<string, RecordSummary> {
  const out: Record<string, RecordSummary> = {};
  targets.forEach((target, index) => {
    // A field named `__proto__` stays data.
    Object.defineProperty(out, target.key, {
      value: summaryOf(target, index, row, count, input),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return out;
}

/** Level of a rolled-up row: how many group levels it has (0 = the whole set). */
function depthOf(row: Readonly<Record<string, unknown>>, levels: number): number {
  let depth = 0;
  while (depth < levels && Number(row[rCol(depth)] ?? 0) === 0) depth += 1;
  return depth;
}

/**
 * `records/summaries` over a prepared read (see the module comment). Called
 * by `RecordQueryService.summaries` inside its read transaction.
 */
export async function summarize(input: SummarizeInput): Promise<RecordSummariesOutput> {
  const targets = targetsOf(input);
  const { rows } = await statement(input, targets).execute(input.tx);
  const summaryRows = rows as readonly SummaryRow[];
  const levels = input.group.length;
  const [total, ...rest] = summaryRows;
  const count = Number(total?.n ?? 0);
  const groupRows = levels === 0 ? [] : rest.slice(0, MAX_GROUP_COUNT_GROUPS);
  const fields = input.group.map((item) => item.field);
  const values = groupRows.length === 0 ? [] : await input.groupValues(fields, groupRows);
  const groups: RecordSummaryGroup[] = groupRows.map((row, index) => {
    const depth = depthOf(row, levels);
    const n = Number(row.n);
    return {
      values: (values[index] ?? []).slice(0, depth),
      count: n,
      summaries: summariesOf(targets, row, n, input),
    };
  });
  const keyType = input.plan.fieldKeyType;
  return {
    count,
    summaries: total === undefined ? {} : summariesOf(targets, total, count, input),
    group: input.group.map((item) => ({
      field: keyType === 'id' ? item.field.id : item.field.name,
      direction: item.direction,
    })),
    groups,
    truncated: levels > 0 && rest.length > MAX_GROUP_COUNT_GROUPS,
  };
}
