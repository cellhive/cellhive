import { getFieldType } from '@cellhive/field-types';
import {
  allowedOperators,
  fieldProfile,
  RECORD_ID_REF,
  isAutomationOnlyOperator,
  isDateOnlyField,
  isDateRange,
  isFieldRefValue,
  isFilterCondition,
  isLookupOnlyOperator,
  negatedOperator,
  type DateRange,
  type DslOperator,
  type FilterConditionOf,
  type FilterFieldMeta,
  type ResolvedFilterNode,
  type ResolvedOperand,
  type ResolvedValue,
} from '@cellhive/filter-dsl';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { assertDataTableName, assertJunctionTableName, DATA_SCHEMA } from '../schema/names.js';

/**
 * Where the values of a `link` field live (SPEC §5.6, BACKLOG T402): its
 * junction `data.l_…`, read from the field's side, and the linked table
 * (linked records in the trash are not part of a cell).
 */
export interface SqlLinkFieldMeta {
  /** Junction table name (`l_<shortId>`, meta). */
  readonly junction: string;
  /** Junction column holding records of the field's own table. */
  readonly ownColumn: 'a_id' | 'b_id';
  /** Junction column holding the linked records. */
  readonly otherColumn: 'a_id' | 'b_id';
  /** Data table of the field's own table (`t_…`): qualifies the row when there is no alias. */
  readonly sourceTable: string;
  /** Data table of the linked table; `null` when it is in the trash (every cell is empty). */
  readonly targetTable: string | null;
}

/** A field as the SQL compiler needs it: filter meta plus its physical column. */
export interface SqlFilterFieldMeta extends FilterFieldMeta {
  /**
   * `meta.fields.db_column_name` (`f_<shortId>`, SPEC §5.3). Ignored for
   * `created_at`/`updated_at`/`created_by`/`updated_by`, which read their
   * system column (SPEC §5.4).
   */
  readonly dbColumnName?: string | null;
  /** `link` fields only (T402): the junction their values are read from. */
  readonly link?: SqlLinkFieldMeta;
  /**
   * `formula`/`lookup` fields only (BACKLOG T457): the value over the row
   * aliased `alias`, in the form of a stored computed column (scalar of the
   * result type, array for lists — `NULL` when empty —, `jsonb` for
   * attachments). Built from meta by `records/computed/read`: the stored
   * column, or the formula compiled with the reader's scope. Without it the
   * field reads its `dbColumnName`.
   */
  readonly expression?: (alias: string | undefined) => RawBuilder<unknown>;
}

export interface SqlFilterTableMeta {
  readonly fields: readonly SqlFilterFieldMeta[];
  /**
   * Collation of the table's text columns (the base collation,
   * `meta.bases.settings.collation`, SPEC §5.5). Text operands are lowered
   * under it, so `lower()` treats both sides alike (e.g. final sigma, `İ`);
   * without it they use the database default collation.
   */
  readonly collation?: string;
}

export interface CompileFilterOptions {
  /**
   * Qualifies every column (`"<alias>"."f_…"`), e.g. when the data table is
   * joined. Must come from code or meta, never from a request.
   */
  readonly tableAlias?: string;
  /**
   * Lookup `where` (SPEC §5.8, BACKLOG T455): enables `intersects`/`disjoint`
   * and `{ field_ref }` operands, read on the current record aliased
   * `refAlias` (fields of `refTable`, or `__id`). Without it those conditions
   * throw `FilterCompileError`.
   */
  readonly lookup?: FilterLookupOptions;
}

export interface FilterLookupOptions {
  /** The current table (the one the lookup field belongs to). */
  readonly refTable: SqlFilterTableMeta;
  /** Alias of the current record in the statement (code constant). */
  readonly refAlias: string;
  /** Zone turning a date `field_ref` into instants (the evaluator's `timeZone`); default UTC. */
  readonly timeZone?: string;
}

/**
 * Thrown for filters the SQL compiler must never receive: unvalidated or
 * unresolved ASTs, operators of another mode (automation `changed*`, lookup
 * `intersects`/`disjoint`/`field_ref`) and field types without SQL support
 * yet. Always a programming error, never a user error — user input is
 * rejected earlier by `validateFilter` with `INVALID_FILTER`.
 */
export class FilterCompileError extends Error {
  override readonly name = 'FilterCompileError';
}

/** Physical representation of a filterable column (SPEC §5.4, §5.5). */
type ColumnKind =
  | 'text'
  | 'numeric'
  | 'timestamptz'
  | 'date'
  | 'boolean'
  | 'text_array'
  | 'text_scalar_list'
  | 'jsonb_list';

interface Column {
  readonly kind: ColumnKind;
  readonly ref: RawBuilder<unknown>;
  /**
   * Base collation, for lowering text operands. Text columns (`text` and
   * `auto_number`) already carry it (`pgType` adds `COLLATE`), so the column
   * side is never re-collated: `meta.f_unaccent(lower(col))` stays identical
   * to the trigram index expression `SchemaService` creates.
   */
  readonly collation: string | undefined;
}

const TRUE = sql<SqlBool>`true`;
const FALSE = sql<SqlBool>`false`;

function columnKind(field: SqlFilterFieldMeta): ColumnKind {
  switch (field.type) {
    case 'text':
    case 'auto_number':
      return 'text';
    case 'number':
      return 'numeric';
    case 'datetime':
      return isDateOnlyField(field) ? 'date' : 'timestamptz';
    case 'created_at':
    case 'updated_at':
      return 'timestamptz';
    case 'checkbox':
      return 'boolean';
    case 'select':
    case 'user':
      return 'text_array';
    case 'created_by':
    case 'updated_by':
      // `__created_by`/`__updated_by` are scalar `text`, filtered with the multi-value operators.
      return 'text_scalar_list';
    case 'attachment':
      // `jsonb` array; only `is_empty` / `is_not_empty` (SPEC §6.2).
      return 'jsonb_list';
    case 'formula':
    case 'lookup':
      return computedColumnKind(field);
    default:
      // link: `linkCondition` (T402); parent: S4; lookup/formula SQL in S4b.
      throw new FilterCompileError(`Filtering on ${field.type} fields is not supported in SQL yet`);
  }
}

/**
 * A formula/lookup value (BACKLOG T457, SPEC §6.2: operators of its result
 * type) in the form of its stored column (`computed/definition`): scalars in
 * their PostgreSQL type (a user or a record is its id), lists as arrays
 * (only texts, users and records filter on elements), attachments `jsonb`.
 */
function computedColumnKind(field: SqlFilterFieldMeta): ColumnKind {
  const result = field.resultType;
  if (result === undefined || result === 'formula' || result === 'lookup') {
    throw new FilterCompileError(`Field ${field.id} has no filterable result type`);
  }
  if (result === 'attachment') return 'jsonb_list';
  if (field.resultIsList === true) return 'text_array';
  switch (result) {
    case 'user':
    case 'link':
      return 'text_scalar_list';
    case 'select':
      throw new FilterCompileError(`Field ${field.id}: a select result is compared as text`);
    default:
      return columnKind({ ...field, type: result, options: field.resultOptions });
  }
}

function columnOf(
  field: SqlFilterFieldMeta,
  collation: string | undefined,
  options: CompileFilterOptions,
): Column {
  const kind = columnKind(field);
  if (field.expression !== undefined) {
    return { kind, ref: sql`(${field.expression(options.tableAlias)})`, collation };
  }
  const system = getFieldType(field.type)?.systemColumn ?? null;
  const name = system ?? field.dbColumnName;
  if (typeof name !== 'string' || name === '') {
    throw new FilterCompileError(`Field ${field.id} has no db_column_name`);
  }
  const ref = options.tableAlias === undefined ? sql.id(name) : sql.id(options.tableAlias, name);
  return { kind, ref, collation };
}

// ---------------------------------------------------------------------------
// Operand helpers: every value becomes a bound parameter with an explicit cast.

const textParam = (value: string, collation: string | undefined) =>
  collation === undefined
    ? sql`${sql.val(value)}::text`
    : sql`${sql.val(value)}::text COLLATE ${sql.id(collation)}`;
const textArrayParam = (values: readonly string[]) => sql`${sql.val(values)}::text[]`;

/** `meta.f_unaccent(lower(x))`, the folded form of SPEC §5.5/§7.4 (trigram-indexable for columns). */
const folded = (expression: RawBuilder<unknown>) => sql`meta.f_unaccent(lower(${expression}))`;

/**
 * A LIKE pattern matching the folded value literally: `%`, `_` and `\` are
 * escaped **after** folding, because `unaccent` can produce them (`％` → `%`).
 */
const likeLiteral = (value: string, collation: string | undefined) =>
  sql`replace(replace(replace(${folded(textParam(value, collation))}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

function expectString(value: ResolvedValue, operator: DslOperator): string {
  if (typeof value !== 'string') {
    throw new FilterCompileError(`Operator ${operator} expects a string operand`);
  }
  return value;
}

function expectNumber(value: ResolvedOperand | undefined, operator: DslOperator): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FilterCompileError(`Operator ${operator} expects a finite number operand`);
  }
  // `String` gives the shortest round-trip form (possibly `1e-7`), which `numeric` parses exactly.
  return String(value + 0);
}

function expectRange(value: ResolvedOperand | undefined, operator: DslOperator): DateRange {
  if (!isDateRange(value)) {
    throw new FilterCompileError(`Operator ${operator} expects a resolved date range`);
  }
  return value;
}

function expectPair(
  value: ResolvedValue,
  operator: DslOperator,
): [ResolvedOperand, ResolvedOperand] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new FilterCompileError(`Operator ${operator} expects two operands`);
  }
  return [value[0] as ResolvedOperand, value[1] as ResolvedOperand];
}

function expectStringList(value: ResolvedValue, operator: DslOperator): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((item): item is string => typeof item === 'string')) {
    throw new FilterCompileError(`Operator ${operator} expects a list of ids`);
  }
  return [...new Set(list)];
}

const unsupported = (operator: DslOperator, kind: ColumnKind) =>
  new FilterCompileError(`Operator ${operator} is not supported for ${kind} columns`);

// ---------------------------------------------------------------------------
// Positive operators. Each returns a two-valued expression (never NULL), so
// `NOT` and the negative operators are exact complements, as in `evaluate`.

function textCondition(column: Column, operator: DslOperator, value: ResolvedValue) {
  const { ref: col, collation } = column;
  const foldedColumn = folded(col);
  const pattern = () => likeLiteral(expectString(value, operator), collation);
  switch (operator) {
    case 'is_empty':
      return sql<SqlBool>`(${col} IS NULL OR ${col} = '')`;
    case 'eq':
      return sql<SqlBool>`(${col} IS NOT NULL AND ${foldedColumn} = ${folded(textParam(expectString(value, operator), collation))})`;
    case 'contains':
      return sql<SqlBool>`(${col} IS NOT NULL AND ${foldedColumn} LIKE '%' || ${pattern()} || '%' ESCAPE '\\')`;
    case 'starts_with':
      return sql<SqlBool>`(${col} IS NOT NULL AND ${foldedColumn} LIKE ${pattern()} || '%' ESCAPE '\\')`;
    case 'ends_with':
      return sql<SqlBool>`(${col} IS NOT NULL AND ${foldedColumn} LIKE '%' || ${pattern()} ESCAPE '\\')`;
    default:
      throw unsupported(operator, 'text');
  }
}

function numericCondition(col: RawBuilder<unknown>, operator: DslOperator, value: ResolvedValue) {
  const num = (operand: ResolvedOperand | undefined) =>
    sql`${sql.val(expectNumber(operand, operator))}::numeric`;
  const compare = (op: RawBuilder<unknown>) =>
    sql<SqlBool>`(${col} IS NOT NULL AND ${col} ${op} ${num(value as ResolvedOperand)})`;
  switch (operator) {
    case 'is_empty':
      return sql<SqlBool>`(${col} IS NULL)`;
    case 'eq':
      return compare(sql`=`);
    case 'gt':
      return compare(sql`>`);
    case 'gte':
      return compare(sql`>=`);
    case 'lt':
      return compare(sql`<`);
    case 'lte':
      return compare(sql`<=`);
    case 'between': {
      const [low, high] = expectPair(value, operator);
      return sql<SqlBool>`(${col} IS NOT NULL AND ${col} >= ${num(low)} AND ${col} <= ${num(high)})`;
    }
    default:
      throw unsupported(operator, 'numeric');
  }
}

function rangeCondition(
  col: RawBuilder<unknown>,
  kind: 'timestamptz' | 'date',
  operator: DslOperator,
  value: ResolvedValue,
) {
  const bound = (range: DateRange, edge: 'start' | 'end') =>
    kind === 'date'
      ? sql`${sql.val(range.$range[edge === 'start' ? 'start_date' : 'end_date'])}::date`
      : sql`${sql.val(range.$range[edge])}::timestamptz`;
  const guarded = (expression: RawBuilder<unknown>) =>
    sql<SqlBool>`(${col} IS NOT NULL AND ${expression})`;
  if (operator === 'is_empty') return sql<SqlBool>`(${col} IS NULL)`;
  if (operator === 'between') {
    const [from, to] = expectPair(value, operator);
    return guarded(
      sql`${col} >= ${bound(expectRange(from, operator), 'start')} AND ${col} < ${bound(expectRange(to, operator), 'end')}`,
    );
  }
  const range = expectRange(value as ResolvedOperand, operator);
  switch (operator) {
    case 'is':
      return guarded(sql`${col} >= ${bound(range, 'start')} AND ${col} < ${bound(range, 'end')}`);
    case 'before':
      return guarded(sql`${col} < ${bound(range, 'start')}`);
    case 'after':
      return guarded(sql`${col} >= ${bound(range, 'end')}`);
    case 'on_or_before':
      return guarded(sql`${col} < ${bound(range, 'end')}`);
    case 'on_or_after':
      return guarded(sql`${col} >= ${bound(range, 'start')}`);
    default:
      throw unsupported(operator, kind);
  }
}

function booleanCondition(col: RawBuilder<unknown>, operator: DslOperator, value: ResolvedValue) {
  if (operator !== 'is' || typeof value !== 'boolean') throw unsupported(operator, 'boolean');
  // The value only picks the SQL shape; nothing from it reaches the SQL text.
  return value ? sql<SqlBool>`(${col} IS TRUE)` : sql<SqlBool>`(${col} IS NOT TRUE)`;
}

function arrayCondition(col: RawBuilder<unknown>, operator: DslOperator, value: ResolvedValue) {
  if (operator === 'is_empty') return sql<SqlBool>`(${col} IS NULL OR cardinality(${col}) = 0)`;
  if (operator === 'is') {
    return sql<SqlBool>`(${col} IS NOT NULL AND ${col} @> ${textArrayParam([expectString(value, operator)])})`;
  }
  const list = expectStringList(value, operator);
  // Empty lists (e.g. `current_user` without a user) never match (SPEC §6.1).
  if (list.length === 0) return FALSE;
  switch (operator) {
    case 'is_any_of':
    case 'has_any_of':
      return sql<SqlBool>`(${col} IS NOT NULL AND ${col} && ${textArrayParam(list)})`;
    case 'has_all_of':
      return sql<SqlBool>`(${col} IS NOT NULL AND ${col} @> ${textArrayParam(list)})`;
    case 'is_exactly':
      return sql<SqlBool>`(${col} IS NOT NULL AND ${col} @> ${textArrayParam(list)} AND ${col} <@ ${textArrayParam(list)})`;
    default:
      throw unsupported(operator, 'text_array');
  }
}

/** `created_by`/`updated_by`: a scalar `text` column seen as a list of at most one user id. */
function scalarListCondition(
  col: RawBuilder<unknown>,
  operator: DslOperator,
  value: ResolvedValue,
) {
  if (operator === 'is_empty') return sql<SqlBool>`(${col} IS NULL OR ${col} = '')`;
  const list = expectStringList(value, operator);
  if (list.length === 0) return FALSE;
  switch (operator) {
    case 'has_any_of':
      return sql<SqlBool>`(${col} IS NOT NULL AND ${col} = ANY(${textArrayParam(list)}))`;
    case 'has_all_of':
    case 'is_exactly':
      // {v} ⊇ L and {v} = L both mean: L is non-empty and every element is v.
      return sql<SqlBool>`(${col} IS NOT NULL AND ${col} = ALL(${textArrayParam(list)}))`;
    default:
      throw unsupported(operator, 'text_scalar_list');
  }
}

/** `attachment`: a `jsonb` array, empty when `NULL` or `[]`. */
function jsonbListCondition(col: RawBuilder<unknown>, operator: DslOperator) {
  if (operator === 'is_empty') return sql<SqlBool>`(${col} IS NULL OR ${col} = '[]'::jsonb)`;
  throw unsupported(operator, 'jsonb_list');
}

/** Aliases of the junction and the linked table inside a link condition. Code constants. */
const LINK_JUNCTION_ALIAS = 'lj';
const LINK_TARGET_ALIAS = 'lt';

/**
 * A `link` condition (T402): the cell is the set of **live** linked records
 * (`__deleted_at IS NULL` in the linked table), read through the junction
 * with a correlated subquery on the row's `__id` (junction primary key or
 * `b_id` index). Only record ids are compared, never titles, so a filter
 * tells nothing beyond the ids a cell shows anyway (P20).
 */
function linkCondition(
  link: SqlLinkFieldMeta,
  operator: DslOperator,
  value: ResolvedValue,
  options: CompileFilterOptions,
): RawBuilder<SqlBool> {
  if (operator === 'is_not_empty') {
    return sql<SqlBool>`(NOT ${linkCondition(link, 'is_empty', null, options)})`;
  }
  const targetTable = link.targetTable;
  if (targetTable === null) {
    // A linked table in the trash: every cell reads empty (CONTRACTS §13).
    if (operator === 'is_empty') return TRUE;
    expectStringList(value, operator);
    return FALSE;
  }
  const row =
    options.tableAlias === undefined
      ? sql.id(DATA_SCHEMA, assertDataTableName(link.sourceTable), '__id')
      : sql.id(options.tableAlias, '__id');
  const other = sql.id(LINK_JUNCTION_ALIAS, link.otherColumn);
  const live = (extra: RawBuilder<SqlBool> | null) => sql`
    FROM ${sql.id(DATA_SCHEMA, assertJunctionTableName(link.junction))} AS ${sql.id(LINK_JUNCTION_ALIAS)}
    JOIN ${sql.id(DATA_SCHEMA, assertDataTableName(targetTable))} AS ${sql.id(LINK_TARGET_ALIAS)}
      ON ${sql.id(LINK_TARGET_ALIAS, '__id')} = ${other}
   WHERE ${sql.id(LINK_JUNCTION_ALIAS, link.ownColumn)} = ${row}
     AND ${sql.id(LINK_TARGET_ALIAS, '__deleted_at')} IS NULL
     ${extra === null ? sql`` : sql`AND ${extra}`}`;
  if (operator === 'is_empty') return sql<SqlBool>`(NOT EXISTS (SELECT 1 ${live(null)}))`;
  const list = expectStringList(value, operator);
  // Empty lists never match (SPEC §6.1), as for every list operator.
  if (list.length === 0) return FALSE;
  const inList = sql<SqlBool>`${other} = ANY(${textArrayParam(list)})`;
  // The junction key makes (row, linked record) unique: a count of distinct ids.
  const hasAll = sql<SqlBool>`((SELECT count(*) ${live(inList)}) = ${list.length})`;
  switch (operator) {
    case 'has_any_of':
      return sql<SqlBool>`(EXISTS (SELECT 1 ${live(inList)}))`;
    case 'has_all_of':
      return hasAll;
    case 'is_exactly':
      return sql<SqlBool>`(${hasAll} AND NOT EXISTS (SELECT 1 ${live(sql<SqlBool>`NOT (${inList})`)}))`;
    default:
      throw new FilterCompileError(`Operator ${operator} is not supported for link fields`);
  }
}

/** Alias of the unnested `field_ref` values in a lookup condition. Code constant. */
const REF_VALUE_ALIAS = 'lr';

/** A link condition against a SQL array of record ids (lookup `field_ref`, T455). */
function linkArrayCondition(
  link: SqlLinkFieldMeta,
  operator: DslOperator,
  ids: RawBuilder<unknown>,
  options: CompileFilterOptions,
): RawBuilder<SqlBool> {
  const targetTable = link.targetTable;
  if (targetTable === null) return FALSE;
  const row =
    options.tableAlias === undefined
      ? sql.id(DATA_SCHEMA, assertDataTableName(link.sourceTable), '__id')
      : sql.id(options.tableAlias, '__id');
  const other = sql.id(LINK_JUNCTION_ALIAS, link.otherColumn);
  const live = (extra: RawBuilder<SqlBool>) => sql`
    FROM ${sql.id(DATA_SCHEMA, assertJunctionTableName(link.junction))} AS ${sql.id(LINK_JUNCTION_ALIAS)}
    JOIN ${sql.id(DATA_SCHEMA, assertDataTableName(targetTable))} AS ${sql.id(LINK_TARGET_ALIAS)}
      ON ${sql.id(LINK_TARGET_ALIAS, '__id')} = ${other}
   WHERE ${sql.id(LINK_JUNCTION_ALIAS, link.ownColumn)} = ${row}
     AND ${sql.id(LINK_TARGET_ALIAS, '__deleted_at')} IS NULL
     AND ${extra}`;
  const inList = sql<SqlBool>`${other} = ANY(${ids})`;
  const distinct = sql`(SELECT count(DISTINCT ${sql.id(REF_VALUE_ALIAS, 'v')}) FROM unnest(${ids}) AS ${sql.id(REF_VALUE_ALIAS)}(v))`;
  const hasAll = sql<SqlBool>`(cardinality(${ids}) > 0 AND (SELECT count(*) ${live(inList)}) = ${distinct})`;
  switch (operator) {
    case 'is':
    case 'has_any_of':
    case 'intersects':
      return sql<SqlBool>`(EXISTS (SELECT 1 ${live(inList)}))`;
    case 'has_all_of':
      return hasAll;
    case 'is_exactly':
      return sql<SqlBool>`(${hasAll} AND NOT EXISTS (SELECT 1 ${live(sql<SqlBool>`NOT (${inList})`)}))`;
    default:
      throw new FilterCompileError(`Operator ${operator} is not supported for link fields`);
  }
}

function positiveCondition(
  column: Column,
  operator: DslOperator,
  value: ResolvedValue,
): RawBuilder<SqlBool> {
  const { ref: col, kind } = column;
  if (operator === 'is_not_empty') {
    return sql<SqlBool>`(NOT ${positiveCondition(column, 'is_empty', null)})`;
  }
  switch (kind) {
    case 'text':
      return textCondition(column, operator, value);
    case 'numeric':
      return numericCondition(col, operator, value);
    case 'timestamptz':
    case 'date':
      return rangeCondition(col, kind, operator, value);
    case 'boolean':
      return booleanCondition(col, operator, value);
    case 'text_array':
      return arrayCondition(col, operator, value);
    case 'text_scalar_list':
      return scalarListCondition(col, operator, value);
    case 'jsonb_list':
      return jsonbListCondition(col, operator);
  }
}

class FilterSqlCompiler {
  private readonly fields: ReadonlyMap<string, SqlFilterFieldMeta>;

  constructor(
    private readonly tableMeta: SqlFilterTableMeta,
    private readonly options: CompileFilterOptions,
  ) {
    this.fields = new Map(tableMeta.fields.map((field) => [field.id, field]));
  }

  node(node: ResolvedFilterNode): RawBuilder<SqlBool> {
    if (isFilterCondition(node)) return this.condition(node);
    if (node.op === 'not') return sql<SqlBool>`(NOT ${this.node(node.item)})`;
    if (node.items.length === 0) return node.op === 'and' ? TRUE : FALSE;
    const items = node.items.map((item) => this.node(item));
    return sql<SqlBool>`(${sql.join(items, node.op === 'and' ? sql` AND ` : sql` OR `)})`;
  }

  private condition(condition: FilterConditionOf<ResolvedValue>): RawBuilder<SqlBool> {
    const { operator } = condition;
    if (isAutomationOnlyOperator(operator)) {
      throw new FilterCompileError(`Operator ${operator} exists only in automation conditions`);
    }
    const lookupCondition = isLookupOnlyOperator(operator) || isFieldRefValue(condition.value);
    const lookup = this.options.lookup;
    if (lookupCondition && lookup === undefined) {
      throw new FilterCompileError(
        'Lookup conditions (intersects/disjoint/field_ref) need the lookup options',
      );
    }
    const field = this.fields.get(condition.field);
    if (field === undefined) throw new FilterCompileError(`Unknown field ${condition.field}`);
    const allowed = allowedOperators(fieldProfile(field), lookupCondition ? 'lookup' : 'standard');
    if (!allowed.has(operator)) {
      throw new FilterCompileError(`Operator ${operator} is not allowed for ${field.type}`);
    }
    const value = condition.value ?? null;
    const positive = negatedOperator(operator);
    if (lookupCondition && lookup !== undefined) {
      const test = (op: DslOperator) => this.lookupCondition(field, op, value, lookup);
      return positive === null ? test(operator) : sql<SqlBool>`(NOT ${test(positive)})`;
    }
    if (field.type === 'link') {
      const link = field.link;
      if (link === undefined)
        throw new FilterCompileError(`Link field ${field.id} has no junction`);
      return positive === null
        ? linkCondition(link, operator, value, this.options)
        : sql<SqlBool>`(NOT ${linkCondition(link, positive, value, this.options)})`;
    }
    const column = columnOf(field, this.tableMeta.collation, this.options);
    return positive === null
      ? positiveCondition(column, operator, value)
      : sql<SqlBool>`(NOT ${positiveCondition(column, positive, value)})`;
  }

  /**
   * A positive lookup condition (T455, same semantics as `evaluate` with
   * `refRecord`): `intersects` with constants is "equals one of them" (`is`
   * for dates, `has_any_of` for lists); a `field_ref` operand is the list of
   * the current record's values — list operators take it as their list, the
   * others match when one value does.
   */
  private lookupCondition(
    field: SqlFilterFieldMeta,
    operator: DslOperator,
    value: ResolvedValue,
    lookup: FilterLookupOptions,
  ): RawBuilder<SqlBool> {
    if (isFieldRefValue(value)) {
      return this.fieldRefCondition(field, operator, value.field_ref, lookup);
    }
    if (field.type === 'link') {
      const link = field.link;
      if (link === undefined)
        throw new FilterCompileError(`Link field ${field.id} has no junction`);
      return linkCondition(
        link,
        operator === 'intersects' ? 'has_any_of' : operator,
        value,
        this.options,
      );
    }
    const column = columnOf(field, this.tableMeta.collation, this.options);
    if (operator !== 'intersects') return positiveCondition(column, operator, value);
    switch (column.kind) {
      case 'text_array':
      case 'text_scalar_list':
        return positiveCondition(column, 'has_any_of', value);
      default: {
        const each = column.kind === 'timestamptz' || column.kind === 'date' ? 'is' : 'eq';
        const items = (Array.isArray(value) ? value : [value]).map((item) =>
          positiveCondition(column, each, item),
        );
        return items.length === 0 ? FALSE : sql<SqlBool>`(${sql.join(items, sql` OR `)})`;
      }
    }
  }

  /**
   * `{ field_ref }`: compiles for a referenced field of a compatible kind
   * (text ← text/number/date/ids, number ← number, date ← date/datetime,
   * ids ← text/ids/`__id`); other pairs throw — lookup definitions never
   * reach here with one (`checkLookupFieldRefs`, `computed/definition`, T456).
   */
  private fieldRefCondition(
    field: SqlFilterFieldMeta,
    operator: DslOperator,
    ref: string,
    lookup: FilterLookupOptions,
  ): RawBuilder<SqlBool> {
    let source: { kind: ColumnKind | 'id'; ref: RawBuilder<unknown> };
    if (ref === RECORD_ID_REF) {
      source = { kind: 'id', ref: sql.id(lookup.refAlias, '__id') };
    } else {
      const refField = lookup.refTable.fields.find((item) => item.id === ref);
      if (refField === undefined) throw new FilterCompileError(`Unknown field_ref ${ref}`);
      const column = columnOf(refField, lookup.refTable.collation, {
        tableAlias: lookup.refAlias,
      });
      source = { kind: column.kind, ref: column.ref };
    }
    const unsupported = () =>
      new FilterCompileError(
        `A field_ref to a ${source.kind} value cannot be compared with ${field.type} (${operator})`,
      );
    // Values of the current record as an array; an empty scalar is no value (the evaluator's list).
    const ids = (): RawBuilder<unknown> => {
      switch (source.kind) {
        case 'text_array':
          return sql`coalesce(${source.ref}, '{}'::text[])`;
        case 'text':
        case 'text_scalar_list':
        case 'id':
          return sql`array_remove(ARRAY[NULLIF(${source.ref}, '')]::text[], NULL)`;
        default:
          throw unsupported();
      }
    };
    if (field.type === 'link') {
      const link = field.link;
      if (link === undefined)
        throw new FilterCompileError(`Link field ${field.id} has no junction`);
      return linkArrayCondition(link, operator, ids(), this.options);
    }
    const column = columnOf(field, this.tableMeta.collation, this.options);
    const col = column.ref;
    const some = (
      array: RawBuilder<unknown>,
      test: (value: RawBuilder<unknown>) => RawBuilder<unknown>,
    ) =>
      sql<SqlBool>`(${col} IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(${array}) AS ${sql.id(REF_VALUE_ALIAS)}(v) WHERE ${test(sql.id(REF_VALUE_ALIAS, 'v'))}))`;
    switch (column.kind) {
      case 'text': {
        let values: RawBuilder<unknown>;
        if (source.kind === 'numeric') values = sql`array_remove(ARRAY[${source.ref}::text], NULL)`;
        else if (source.kind === 'date') {
          values = sql`array_remove(ARRAY[fx.date_text(${source.ref})], NULL)`;
        } else values = ids();
        const needle = (v: RawBuilder<unknown>) =>
          folded(
            column.collation === undefined ? v : sql`${v} COLLATE ${sql.id(column.collation)}`,
          );
        const pattern = (v: RawBuilder<unknown>) =>
          sql`replace(replace(replace(${needle(v)}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;
        const foldedColumn = folded(col);
        switch (operator) {
          case 'eq':
          case 'intersects':
            return some(values, (v) => sql`${foldedColumn} = ${needle(v)}`);
          case 'contains':
            return some(
              values,
              (v) => sql`${foldedColumn} LIKE '%' || ${pattern(v)} || '%' ESCAPE '\\'`,
            );
          case 'starts_with':
            return some(values, (v) => sql`${foldedColumn} LIKE ${pattern(v)} || '%' ESCAPE '\\'`);
          case 'ends_with':
            return some(values, (v) => sql`${foldedColumn} LIKE '%' || ${pattern(v)} ESCAPE '\\'`);
          default:
            throw unsupported();
        }
      }
      case 'numeric': {
        if (source.kind !== 'numeric') throw unsupported();
        const comparisons: Partial<Record<DslOperator, RawBuilder<unknown>>> = {
          eq: sql`=`,
          intersects: sql`=`,
          gt: sql`>`,
          gte: sql`>=`,
          lt: sql`<`,
          lte: sql`<=`,
        };
        const op = comparisons[operator];
        if (op === undefined) throw unsupported();
        return some(sql`array_remove(ARRAY[${source.ref}], NULL)`, (v) => sql`${col} ${op} ${v}`);
      }
      case 'date':
      case 'timestamptz':
        return this.dateRefCondition(column.kind, col, operator, source, lookup, unsupported);
      case 'text_array': {
        const values = ids();
        switch (operator) {
          case 'is':
          case 'is_any_of':
          case 'has_any_of':
          case 'intersects':
            return sql<SqlBool>`coalesce(${col} && ${values}, false)`;
          case 'has_all_of':
            return sql<SqlBool>`coalesce(cardinality(${values}) > 0 AND ${col} @> ${values}, false)`;
          case 'is_exactly':
            return sql<SqlBool>`coalesce(cardinality(${values}) > 0 AND ${col} @> ${values} AND ${col} <@ ${values}, false)`;
          default:
            throw unsupported();
        }
      }
      case 'text_scalar_list': {
        const values = ids();
        switch (operator) {
          case 'has_any_of':
          case 'intersects':
            return sql<SqlBool>`coalesce(${col} = ANY(${values}), false)`;
          case 'has_all_of':
          case 'is_exactly':
            return sql<SqlBool>`coalesce(cardinality(${values}) > 0 AND ${col} = ALL(${values}), false)`;
          default:
            throw unsupported();
        }
      }
      default:
        throw unsupported();
    }
  }

  /**
   * A date `field_ref`: a date is that day in the lookup's zone, a datetime
   * that millisecond (`[t, t + 1 ms)`), as the evaluator's ranges.
   */
  private dateRefCondition(
    kind: 'date' | 'timestamptz',
    col: RawBuilder<unknown>,
    operator: DslOperator,
    source: { kind: ColumnKind | 'id'; ref: RawBuilder<unknown> },
    lookup: FilterLookupOptions,
    unsupported: () => FilterCompileError,
  ): RawBuilder<SqlBool> {
    const zone = sql`${sql.val(lookup.timeZone ?? 'UTC')}::text`;
    const ref = source.ref;
    let start: RawBuilder<unknown>;
    let end: RawBuilder<unknown>;
    if (source.kind === 'date') {
      start = kind === 'date' ? ref : sql`fx.date_to_ts(${ref}, ${zone})`;
      end = kind === 'date' ? sql`(${ref} + 1)` : sql`fx.date_to_ts(${ref} + 1, ${zone})`;
    } else if (source.kind === 'timestamptz') {
      const instant = sql`date_trunc('milliseconds', ${ref})`;
      start = kind === 'date' ? sql`fx.local_date(${ref}, ${zone})` : instant;
      end =
        kind === 'date'
          ? sql`(fx.local_date(${ref}, ${zone}) + 1)`
          : sql`(${instant} + interval '1 millisecond')`;
    } else {
      throw unsupported();
    }
    const value = kind === 'timestamptz' ? sql`date_trunc('milliseconds', ${col})` : col;
    let test: RawBuilder<unknown>;
    switch (operator) {
      case 'is':
      case 'intersects':
        test = sql`${value} >= ${start} AND ${value} < ${end}`;
        break;
      case 'before':
        test = sql`${value} < ${start}`;
        break;
      case 'after':
        test = sql`${value} >= ${end}`;
        break;
      case 'on_or_before':
        test = sql`${value} < ${end}`;
        break;
      case 'on_or_after':
        test = sql`${value} >= ${start}`;
        break;
      default:
        throw unsupported();
    }
    return sql<SqlBool>`coalesce(${col} IS NOT NULL AND ${ref} IS NOT NULL AND ${test}, false)`;
  }
}

/**
 * Compiles a validated, resolved filter (`validateFilter` → `resolveVariables`)
 * into a boolean SQL expression over the data table (SPEC §6.3), the only
 * place a record `WHERE` is generated. Same semantics as `evaluate` from
 * `@cellhive/filter-dsl`; the integration harness checks both on one fixture.
 *
 * - Columns come from meta (`dbColumnName` or the system column) through
 *   `sql.id`; every operand is a bound parameter with an explicit cast.
 * - Text `eq`/`contains`/`starts_with`/`ends_with` compare
 *   `meta.f_unaccent(lower(col))` with `meta.f_unaccent(lower($n))`, LIKE
 *   metacharacters escaped (`ESCAPE '\'`).
 * - Each condition is two-valued (NULL-safe), so `not` and the negative
 *   operators are exact complements of the positive ones.
 *
 * Throws {@link FilterCompileError} for automation-only operators, lookup
 * mode and field types without SQL support yet.
 */
export function compileToSql(
  ast: ResolvedFilterNode,
  tableMeta: SqlFilterTableMeta,
  options: CompileFilterOptions = {},
): RawBuilder<SqlBool> {
  return new FilterSqlCompiler(tableMeta, options).node(ast);
}
