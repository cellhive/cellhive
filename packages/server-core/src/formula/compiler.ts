import { canonicalTimeZone } from '@cellhive/contracts';
import {
  formatType,
  listOf,
  rowsTable,
  T,
  unify,
  type Binary,
  type Call,
  type Expr,
  type FormulaType,
  type Let,
  type Reference,
} from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { checkSqlBudget } from './budget.js';
import { FormulaCompileError } from './errors.js';
import { getSqlFunction } from './functions.js';
import {
  emptyOf,
  isList,
  nonNullList,
  nullOf,
  numberParam,
  param,
  sqlTypeOf,
  textParam,
  truthy,
  type Compiled,
  type Sql,
} from './values.js';

import type { SqlCall } from './call.js';
import type { FormulaSqlContext } from './context.js';
import type { FieldModel } from '../records/table-model.js';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` once it fits the SQL size budget (`budget.ts`). */
function checked(value: Compiled): Compiled {
  checkSqlBudget(value.sql);
  return value;
}

const isDateLike = (type: FormulaType): boolean => type.kind === 'date' || type.kind === 'datetime';

const isTextLike = (type: FormulaType): boolean => type.kind === 'text' || type.kind === 'user';

/** Option ids and names of a select field, in the same order (bound as two arrays). */
function selectOptions(field: FieldModel): { ids: string[]; names: string[] } {
  const ids: string[] = [];
  const names: string[] = [];
  const options = isRecord(field.options) ? field.options['options'] : undefined;
  if (Array.isArray(options)) {
    for (const option of options as unknown[]) {
      if (!isRecord(option)) continue;
      const { id, name } = option;
      if (typeof id === 'string' && typeof name === 'string') {
        ids.push(id);
        names.push(name);
      }
    }
  }
  return { ids, names };
}

/**
 * `fx.*` take the zone as SQL text: the IANA primary name PostgreSQL knows
 * (`Asia/Saigon` → `Asia/Ho_Chi_Minh`, QA S7 H1), whatever meta stored.
 */
const sqlZone = (zone: string): string => canonicalTimeZone(zone) ?? zone;

function fieldZone(field: FieldModel): string | undefined {
  const zone = isRecord(field.options) ? field.options['timezone'] : undefined;
  return typeof zone === 'string' && zone !== '' ? sqlZone(zone) : undefined;
}

/**
 * Same-row formula compiler (SPEC §9.4, BACKLOG T454): a typechecked AST
 * becomes one Kysely SQL expression over the row of the formula's table.
 *
 * - Literals are always bound parameters with an explicit cast; columns come
 *   from the table model (meta) through `sql.id`; SQL function names come
 *   from the code (`fx.*` or built-ins), never from the formula text.
 * - Operations that can fail on a row's data call the `fx.*` safe variants
 *   (migration 0021), which return NULL, so one bad row never fails a
 *   whole `SELECT`/`UPDATE`.
 * - Calendar operations take the time zone as a parameter (ADR-21).
 * - `LET` variables are inlined (each use repeats the value's SQL); every
 *   compiled node is checked against the size budget (`budget.ts`), so
 *   repeated operands cannot expand the SQL exponentially.
 *
 * Cross-table nodes go to `ctx.extension` (T455).
 */
export class FormulaCompiler {
  private readonly fields = new Map<string, FieldModel>();
  private variables = new Map<string, Compiled>();
  private current: Compiled | null = null;
  /** `ctx.timeZone` as {@link sqlZone}, once. */
  private zone: string | undefined;

  constructor(readonly ctx: FormulaSqlContext) {
    for (const field of ctx.fields) this.fields.set(field.id, field);
  }

  /** Type of a node from the typecheck; `any` means the analysis had errors. */
  typeOf(node: Expr): FormulaType {
    const type = this.ctx.types.get(node);
    if (type === undefined || type.kind === 'any') {
      throw new FormulaCompileError(
        'UNTYPED',
        `The ${node.type} node at ${String(node.start)} has no type: compile only analysed, error-free formulas.`,
      );
    }
    return type;
  }

  /**
   * Every node that builds SQL from other SQL is checked against the size
   * budget as soon as it is built (literals are small; variables and
   * `CurrentValue` were checked when compiled). No wrapper frame: the
   * recursion depth of long flat chains stays as it is.
   */
  compile(node: Expr): Compiled {
    const extended = this.ctx.extension?.compile(node, this);
    if (extended !== undefined) return checked(extended);
    switch (node.type) {
      case 'number':
        return { sql: numberParam(node.value), type: T.number };
      case 'string':
        return { sql: textParam(node.value), type: T.text };
      case 'boolean':
        return { sql: param(node.value, sql`boolean`), type: T.boolean };
      case 'reference':
        return checked(this.reference(node));
      case 'member':
        return this.crossTable('Reading fields of linked records or other tables');
      case 'current_value':
        if (this.current === null) {
          throw new FormulaCompileError('UNTYPED', 'CurrentValue outside of an iteration.');
        }
        return this.current;
      case 'variable': {
        const value = this.variables.get(node.name.toUpperCase());
        if (value === undefined) {
          throw new FormulaCompileError('UNTYPED', `Unknown variable ${node.name}.`);
        }
        return value;
      }
      case 'let':
        return checked(this.let(node));
      case 'unary': {
        const operand = this.as(this.compile(node.operand), T.number);
        return checked({
          sql: node.operator === '-' ? sql`(- ${operand})` : operand,
          type: T.number,
        });
      }
      case 'binary':
        return checked(this.binary(node));
      case 'call':
        return checked(this.call(node));
    }
  }

  /**
   * Refuses what the same-row compiler leaves to T455 (`ctx.extension`,
   * consulted first by `compile`, did not take the node).
   */
  crossTable(what: string): never {
    throw new FormulaCompileError(
      'CROSS_TABLE',
      `${what} is compiled by the cross-table compiler (T455).`,
    );
  }

  /** `CurrentValue` is `value` while `fn` compiles the body of an iteration over a value list. */
  withCurrent<R>(value: Compiled, fn: () => R): R {
    const saved = this.current;
    this.current = value;
    try {
      return fn();
    } finally {
      this.current = saved;
    }
  }

  // ---------------------------------------------------------------------------
  // Parameters and columns

  /** The zone of `value` (its field's own zone) or of the formula, as a parameter. */
  tz(value?: Compiled): Sql {
    return textParam(value?.zone ?? (this.zone ??= sqlZone(this.ctx.timeZone)));
  }

  /** `NOW()`: the fixed instant of the context, else the statement's `now()`. */
  now(): Sql {
    const now = this.ctx.now;
    return now === undefined ? sql`now()` : param(now.toISOString(), sql`timestamptz`);
  }

  column(name: string): Sql {
    const alias = this.ctx.tableAlias;
    return alias === undefined ? sql.id(name) : sql.id(alias, name);
  }

  // ---------------------------------------------------------------------------
  // Conversions

  /**
   * `value` as `target`: NULL-typed values get the target's SQL type, dates
   * widen to datetimes (midnight in the zone), date lists to datetime lists.
   */
  as(value: Compiled, target: FormulaType): Sql {
    return this.coerce(value, target).sql;
  }

  coerce(value: Compiled, target: FormulaType): Compiled {
    const from = value.type;
    if (target.kind === 'any' || target.kind === 'null') return value;
    if (from.kind === 'null' || from.kind === 'any') {
      return { sql: nullOf(target), type: target };
    }
    if (target.kind === 'list') {
      if (from.kind !== 'list') return value;
      const element = from.element;
      if (element.kind === 'null' || element.kind === 'any') {
        return { sql: sql`CAST(${value.sql} AS ${sqlTypeOf(target)})`, type: target };
      }
      if (element.kind === 'date' && target.element.kind === 'datetime') {
        return {
          sql: sql`CASE WHEN ${value.sql} IS NULL THEN NULL ELSE ARRAY(SELECT fx.date_to_ts(u.v, ${this.tz(value)}) FROM unnest(${value.sql}) WITH ORDINALITY AS u(v, i) ORDER BY u.i) END`,
          type: target,
        };
      }
      return value;
    }
    if (from.kind === 'date' && target.kind === 'datetime') {
      return { sql: this.asDatetime(value), type: T.datetime };
    }
    return value;
  }

  /** A date or datetime as an instant (a date is midnight in its zone). */
  asDatetime(value: Compiled): Sql {
    if (value.type.kind === 'date') return sql`fx.date_to_ts(${value.sql}, ${this.tz(value)})`;
    return value.sql;
  }

  /** A date or datetime as the calendar day in its zone. */
  localDate(value: Compiled): Sql {
    if (value.type.kind === 'datetime') return sql`fx.local_date(${value.sql}, ${this.tz(value)})`;
    return this.as(value, T.date);
  }

  /** A date or datetime as wall-clock time in its zone. */
  localTimestamp(value: Compiled): Sql {
    if (value.type.kind === 'datetime') return sql`fx.local(${value.sql}, ${this.tz(value)})`;
    return sql`CAST(${this.as(value, T.date)} AS timestamp)`;
  }

  /**
   * Text of a single value (`&`, CONCATENATE, text arguments): numbers without
   * trailing zeros, `TRUE`/`FALSE`, dates `YYYY-MM-DD`, datetimes
   * `YYYY-MM-DD HH:mm:ss` in the zone, users by id, attachments by name.
   */
  toText(value: Compiled): Sql {
    const extended = this.ctx.extension?.toText?.(value, this);
    if (extended !== undefined) return extended;
    switch (value.type.kind) {
      case 'text':
      case 'user':
        return value.sql;
      case 'number':
        return sql`fx.num_text(${value.sql})`;
      case 'boolean':
        return sql`(CASE WHEN ${value.sql} THEN 'TRUE' WHEN NOT ${value.sql} THEN 'FALSE' END)`;
      case 'date':
        return sql`fx.date_text(${value.sql})`;
      case 'datetime':
        return sql`fx.datetime_text(${value.sql}, ${this.tz(value)})`;
      case 'attachment':
        return sql`(${value.sql} ->> 'name')`;
      case 'null':
      case 'any':
        return nullOf(T.text);
      default:
        throw new FormulaCompileError(
          'UNSUPPORTED_TYPE',
          `Cannot turn ${formatType(value.type)} into text in SQL.`,
        );
    }
  }

  /** A single value or a list, as a non-NULL array of `element`. */
  asArray(value: Compiled, element: FormulaType): Sql {
    const target = listOf(element);
    if (isList(value.type)) return nonNullList(this.coerce(value, target));
    return sql`ARRAY[${this.as(value, element)}]::${sqlTypeOf(target)}`;
  }

  /** Values and lists combined into one array of `element` (LISTCOMBINE, SUM…). */
  combine(values: readonly Compiled[], element: FormulaType): Sql {
    if (values.length === 0) return emptyOf(listOf(element));
    const arrays = values.map((value) => this.asArray(value, element));
    return sql`(${sql.join(arrays, sql` || `)})`;
  }

  /** Empty: NULL, empty text or empty list (ISBLANK, IFBLANK, COUNTA). */
  blank(value: Compiled): Sql {
    if (value.type.kind === 'text') return sql`(${value.sql} IS NULL OR ${value.sql} = '')`;
    if (isList(value.type)) {
      return sql`(${value.sql} IS NULL OR cardinality(${value.sql}) = 0)`;
    }
    return sql`(${value.sql} IS NULL)`;
  }

  /**
   * `=`, two-valued: empty text equals `""`, other empty values only equal
   * empty values; dates compare with datetimes as instants; users with texts
   * by id; lists element by element.
   */
  equals(left: Compiled, right: Compiled): Sql {
    const extended = this.ctx.extension?.equals?.(left, right, this);
    if (extended !== undefined) return extended;
    if (left.type.kind === 'row' || right.type.kind === 'row') this.crossTable('Comparing records');
    if (isList(left.type) || isList(right.type)) {
      const common = this.common(left.type, right.type);
      return sql`(${nonNullList(this.coerce(left, common))} = ${nonNullList(this.coerce(right, common))})`;
    }
    if (isTextLike(left.type) || isTextLike(right.type)) {
      return sql`(coalesce(${this.as(left, T.text)}, '') = coalesce(${this.as(right, T.text)}, ''))`;
    }
    const common = this.common(left.type, right.type);
    return sql`(${this.as(left, common)} IS NOT DISTINCT FROM ${this.as(right, common)})`;
  }

  /** The type both values fit (`date` widens to `datetime`, `user` to `text`). */
  common(a: FormulaType, b: FormulaType): FormulaType {
    const unified = unify(a, b);
    if (unified !== null) return unified;
    if (a.kind === 'list' && b.kind === 'list') return listOf(this.common(a.element, b.element));
    if ((isTextLike(a) || a.kind === 'null') && (isTextLike(b) || b.kind === 'null')) return T.text;
    throw new FormulaCompileError(
      'UNSUPPORTED_TYPE',
      `No common SQL type for ${formatType(a)} and ${formatType(b)}.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Nodes

  private reference(node: Reference): Compiled {
    if (node.kind === 'table') return this.crossTable('A table reference');
    const type = this.typeOf(node);
    if (rowsTable(type) !== null) return this.crossTable('A link field');
    const field = node.id === null ? undefined : this.fields.get(node.id);
    const computed = node.id === null ? undefined : this.ctx.computed?.get(node.id);
    if (field === undefined && computed !== undefined) {
      return computed.read(this.ctx.tableAlias, this);
    }
    if (field === undefined) {
      throw new FormulaCompileError(
        'UNKNOWN_FIELD',
        `Field ${String(node.id)} is not in the table model.`,
      );
    }
    return this.field(field, type);
  }

  /** The value of a field of the formula's row, as its formula type (T452 type map). */
  private field(field: FieldModel, type: FormulaType): Compiled {
    const column = this.column(field.column);
    const fieldType: string = field.type;
    switch (fieldType) {
      case 'text':
      case 'auto_number':
      case 'number':
      case 'checkbox':
      case 'user':
        return { sql: column, type };
      case 'datetime':
      case 'created_at':
      case 'updated_at': {
        const zone = fieldZone(field);
        return zone === undefined ? { sql: column, type } : { sql: column, type, zone };
      }
      case 'created_by':
      case 'updated_by':
        // Scalar `__created_by` text, a list of one user in formulas.
        return {
          sql: sql`(CASE WHEN ${column} IS NULL THEN CAST(ARRAY[] AS text[]) ELSE ARRAY[${column}] END)`,
          type,
        };
      case 'select': {
        // Formulas see option names (BACKLOG S4b #10): id → name through bound arrays.
        const { ids, names } = selectOptions(field);
        const mapping = sql`unnest(${param(ids, sql`text[]`)}, ${param(names, sql`text[]`)}) AS m(id, name)`;
        if (type.kind === 'list') {
          return {
            sql: sql`(CASE WHEN ${column} IS NULL THEN NULL ELSE ARRAY(SELECT m.name FROM unnest(${column}) WITH ORDINALITY AS c(id, i) JOIN ${mapping} ON m.id = c.id ORDER BY c.i) END)`,
            type,
          };
        }
        return {
          sql: sql`(SELECT m.name FROM ${mapping} WHERE m.id = (${column})[1])`,
          type,
        };
      }
      case 'attachment':
        return {
          sql: sql`(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ARRAY(SELECT a.e FROM jsonb_array_elements(${column}) WITH ORDINALITY AS a(e, i) ORDER BY a.i) END)`,
          type,
        };
      default:
        throw new FormulaCompileError(
          'UNSUPPORTED_FIELD',
          `Formulas cannot read ${fieldType} fields in SQL yet.`,
        );
    }
  }

  private let(node: Let): Compiled {
    const saved = this.variables;
    this.variables = new Map(saved);
    try {
      for (const binding of node.bindings) {
        this.variables.set(binding.name.toUpperCase(), this.compile(binding.value));
      }
      return this.compile(node.body);
    } finally {
      this.variables = saved;
    }
  }

  private binary(node: Binary): Compiled {
    const left = this.compile(node.left);
    const right = this.compile(node.right);
    const type = this.typeOf(node);
    switch (node.operator) {
      case '&&':
        return {
          sql: sql`(${truthy(this.as(left, T.boolean))} AND ${truthy(this.as(right, T.boolean))})`,
          type,
        };
      case '||':
        return {
          sql: sql`(${truthy(this.as(left, T.boolean))} OR ${truthy(this.as(right, T.boolean))})`,
          type,
        };
      case '&':
        return {
          sql: sql`(coalesce(${this.toText(left)}, '') || coalesce(${this.toText(right)}, ''))`,
          type,
        };
      case '=':
        return { sql: this.equals(left, right), type };
      case '!=':
        return { sql: sql`(NOT ${this.equals(left, right)})`, type };
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const common = this.common(left.type, right.type);
        const op = { '<': sql`<`, '<=': sql`<=`, '>': sql`>`, '>=': sql`>=` }[node.operator];
        return {
          sql: truthy(sql`(${this.as(left, common)} ${op} ${this.as(right, common)})`),
          type,
        };
      }
      default:
        return this.arithmetic(node, left, right, type);
    }
  }

  /** `+ - * / %`; dates ± days, date − date in days (SPEC §9.2). */
  private arithmetic(node: Binary, left: Compiled, right: Compiled, type: FormulaType): Compiled {
    const number = (value: Compiled) => this.as(value, T.number);
    if (node.operator === '+' || node.operator === '-') {
      if (isDateLike(left.type) && !isDateLike(right.type)) {
        const days = node.operator === '-' ? sql`(- ${number(right)})` : number(right);
        return this.addDays(left, days);
      }
      if (node.operator === '+' && isDateLike(right.type) && !isDateLike(left.type)) {
        return this.addDays(right, number(left));
      }
      if (node.operator === '-' && isDateLike(left.type) && isDateLike(right.type)) {
        if (left.type.kind === 'date' && right.type.kind === 'date') {
          return { sql: sql`CAST(${left.sql} - ${right.sql} AS numeric)`, type: T.number };
        }
        return {
          sql: sql`fx.ts_diff_days(${this.asDatetime(left)}, ${this.asDatetime(right)})`,
          type: T.number,
        };
      }
    }
    const a = number(left);
    const b = number(right);
    switch (node.operator) {
      case '+':
        return { sql: sql`(${a} + ${b})`, type };
      case '-':
        return { sql: sql`(${a} - ${b})`, type };
      case '*':
        return { sql: sql`(${a} * ${b})`, type };
      case '/':
        return { sql: sql`fx.div(${a}, ${b})`, type };
      default:
        return { sql: sql`fx.mod(${a}, ${b})`, type };
    }
  }

  /** A date/datetime plus a number of days (whole days for a date, exact seconds for a datetime). */
  addDays(value: Compiled, days: Sql): Compiled {
    const out =
      value.type.kind === 'date'
        ? sql`fx.date_add(${value.sql}, ${days})`
        : sql`fx.ts_add(${value.sql}, ${days})`;
    return value.zone === undefined
      ? { sql: out, type: value.type }
      : { sql: out, type: value.type, zone: value.zone };
  }

  private call(node: Call): Compiled {
    const implementation = getSqlFunction(node.name);
    if (implementation === undefined) {
      throw new FormulaCompileError('UNKNOWN_FUNCTION', `No SQL implementation of ${node.name}.`);
    }
    const type = this.typeOf(node);
    const compiled = new Map<number, Compiled>();
    const call: SqlCall = {
      node,
      type,
      compiler: this,
      count: node.args.length,
      arg: (index) => {
        const done = compiled.get(index);
        if (done !== undefined) return done;
        const arg = node.args[index];
        if (arg === undefined) {
          throw new FormulaCompileError(
            'UNTYPED',
            `${node.name} has no argument ${String(index + 1)}.`,
          );
        }
        const value = this.compile(arg);
        compiled.set(index, value);
        return value;
      },
    };
    return { sql: implementation(call), type };
  }
}
