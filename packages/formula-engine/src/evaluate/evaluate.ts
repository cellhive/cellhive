import { isValidTimeZone } from '@cellhive/field-types';

import { leftSpine } from '../ast.js';
import { FormulaError } from '../errors.js';
import { typecheck } from '../typecheck/typecheck.js';

import { DAY_MS, inRange, instantInRange, parseDateText, startOfDay } from './dates.js';
import { Dec } from './decimal.js';
import { mod } from './helpers.js';
import { IMPLEMENTATIONS } from './registry.js';
import { Runtime, type Args, type FunctionImpl } from './runtime.js';
import {
  date,
  datetime,
  isDate,
  isDateTime,
  isRow,
  isTable,
  toDec,
  toJson,
  withoutZone,
  type FormulaDataSource,
  type FormulaJsonValue,
  type FormulaRecord,
  type Value,
} from './values.js';

import type { Binary, Call, Expr } from '../ast.js';
import type { SchemaSnapshot } from '../resolve.js';
import type { FormulaType } from '../types/formula-type.js';

/**
 * TS evaluator (SPEC §9.4, T453): an interpreter walking the typechecked
 * AST — no code generation, no `eval`/`Function`/`vm`. Used for the
 * editor preview, automation templates and the TS ≡ SQL equivalence
 * fixture; stored values are always computed by the SQL compiler (T454).
 */
export interface EvaluateContext {
  /** Schema the AST was resolved against; `tableId` is the formula's table. */
  snapshot: SchemaSnapshot;
  /** The record the formula runs on (a record of `snapshot.tableId`). */
  row: FormulaRecord;
  /** Sample data for links and `[Table]`; without it links have no fields and tables no rows. */
  resolve?: FormulaDataSource | null;
  /**
   * IANA time zone of every calendar operation (ADR-21): the formula
   * field's `timezone`, else the organization's. The machine's zone is
   * never read.
   */
  tz: string;
  /** The instant `NOW()`/`TODAY()` read (a `Date`, epoch ms or ISO text with offset). */
  now: Date | number | string;
  /** ICU locale ordering text (`<`, SORT, MAX): the base collation, default `und` (root). */
  locale?: string;
  /** Node types from `typecheck`/`analyze` of this AST; computed (and cached) when absent. */
  types?: ReadonlyMap<Expr, FormulaType>;
  /**
   * Functions this evaluation refuses (upper case), e.g. `REGEX*` in
   * automations (S4b-followup §1.4): calling one throws `FormulaError`
   * `UNSUPPORTED_FUNCTION` before any of its arguments runs, so its
   * implementation (and `RegExp`) is never reached.
   */
  disallow?: ReadonlySet<string> | null;
  /**
   * Asked every `INTERRUPT_CHECK_INTERVAL` nodes; `true` stops the
   * evaluation with `EvaluationInterrupted` (time budgets, BACKLOG T504).
   */
  interrupt?: (() => boolean) | null;
}

/** Nodes evaluated between two calls of `EvaluateContext.interrupt`. */
export const INTERRUPT_CHECK_INTERVAL = 64;

/** Thrown when `EvaluateContext.interrupt` answers `true`. */
export class EvaluationInterrupted extends Error {
  override readonly name = 'EvaluationInterrupted';

  constructor() {
    super('The evaluation was interrupted.');
  }
}

interface Scope {
  current: Value;
  variables: ReadonlyMap<string, Value> | null;
}

const ROOT: Scope = { current: null, variables: null };

const TYPES = new WeakMap<
  Expr,
  { snapshot: SchemaSnapshot; types: ReadonlyMap<Expr, FormulaType> }
>();

function typesOf(ast: Expr, snapshot: SchemaSnapshot): ReadonlyMap<Expr, FormulaType> {
  const cached = TYPES.get(ast);
  if (cached?.snapshot === snapshot) return cached.types;
  const checked = typecheck(ast, snapshot);
  const [error] = checked.errors;
  if (error !== undefined) throw error;
  TYPES.set(ast, { snapshot, types: checked.types });
  return checked.types;
}

function instantOf(now: Date | number | string, timeZone: string): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const parsed = parseDateText(now, timeZone);
  if (parsed === null) throw new RangeError(`Invalid "now": ${now}`);
  return parsed.kind === 'datetime' ? parsed.ms : startOfDay(parsed.day, timeZone);
}

const LITERALS = new WeakMap<Expr, Dec | null>();

function literal(node: Expr & { type: 'number' }): Dec | null {
  let value = LITERALS.get(node);
  if (value === undefined) {
    value = Dec.parse(node.value);
    LITERALS.set(node, value);
  }
  return value;
}

class CallArgs implements Args {
  private readonly values: (Value | undefined)[] = [];

  constructor(
    readonly call: Call,
    private readonly scope: Scope,
    private readonly interpreter: Interpreter,
  ) {}

  get count(): number {
    return this.call.args.length;
  }

  get rt(): Runtime {
    return this.interpreter.rt;
  }

  node(index: number): Expr {
    const node = this.call.args[index];
    if (node === undefined)
      throw new RangeError(`${this.call.name} has no argument ${String(index)}`);
    return node;
  }

  type(index: number): FormulaType {
    const node = this.call.args[index];
    return node === undefined ? { kind: 'any' } : this.rt.typeOf(node);
  }

  value(index: number): Value {
    if (index >= this.call.args.length) return null;
    let value = this.values[index];
    if (value === undefined) {
      value = this.interpreter.run(this.node(index), this.scope);
      this.values[index] = value;
    }
    return value;
  }

  with(index: number, current: Value): Value {
    return this.interpreter.run(this.node(index), { ...this.scope, current });
  }

  evaluate(node: Expr): Value {
    return this.interpreter.run(node, this.scope);
  }
}

interface Guards {
  readonly disallow: ReadonlySet<string> | null;
  readonly interrupt: (() => boolean) | null;
}

const NO_GUARDS: Guards = { disallow: null, interrupt: null };

class Interpreter {
  private steps = 0;

  constructor(
    readonly rt: Runtime,
    private readonly guards: Guards = NO_GUARDS,
  ) {}

  /** Values of the left spine of a binary chain, run ahead ({@link runSpine}). */
  private readonly spine = new Map<Expr, Value>();

  /**
   * A long chain of one precedence level (`1 + 1 + … + 1`, SPEC §9.5) is a
   * left-deep tree: its left spine is run bottom-up in a loop first, in the
   * order the recursion would (left operands before right ones), so the
   * stack does not overflow (T470). Each value is taken once.
   */
  private runSpine(node: Expr, scope: Scope): void {
    const chain = leftSpine(node, (link) => this.spine.has(link));
    try {
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const link = chain[index] as Expr;
        this.spine.set(link, this.run(link, scope));
      }
    } catch (error) {
      for (const link of chain) this.spine.delete(link);
      throw error;
    }
  }

  run(node: Expr, scope: Scope): Value {
    if (this.guards.interrupt !== null) {
      this.steps += 1;
      if (this.steps % INTERRUPT_CHECK_INTERVAL === 0 && this.guards.interrupt()) {
        throw new EvaluationInterrupted();
      }
    }
    if (this.spine.has(node)) {
      const ahead = this.spine.get(node) as Value;
      this.spine.delete(node);
      return ahead;
    }
    if (node.type === 'binary') this.runSpine(node, scope);
    switch (node.type) {
      case 'number':
        return literal(node);
      case 'string':
      case 'boolean':
        return node.value;
      case 'reference':
        if (node.id === null) return null;
        return node.kind === 'table' ? this.rt.table(node.id) : this.rt.read(this.rt.row, node.id);
      case 'member': {
        const object = this.run(node.object, scope);
        const fieldId = node.property.id;
        if (fieldId === null) return null;
        if (isRow(object)) return this.rt.field(object, fieldId);
        if (isTable(object)) return this.rt.column(object.rows, fieldId);
        if (Array.isArray(object)) return this.rt.column(object as readonly Value[], fieldId);
        return this.rt.typeOf(node.object).kind === 'row' ? null : [];
      }
      case 'current_value':
        return scope.current;
      case 'variable':
        return scope.variables?.get(node.name.toUpperCase()) ?? null;
      case 'let': {
        const variables = new Map(scope.variables ?? []);
        const inner: Scope = { ...scope, variables };
        for (const binding of node.bindings) {
          variables.set(binding.name.toUpperCase(), this.run(binding.value, inner));
        }
        return this.run(node.body, inner);
      }
      case 'unary': {
        const operand = toDec(this.run(node.operand, scope));
        if (operand === null) return null;
        return node.operator === '-' ? operand.neg() : operand;
      }
      case 'binary':
        return this.binary(node, scope);
      case 'call': {
        if (this.guards.disallow?.has(node.name) === true) {
          throw new FormulaError(
            'UNSUPPORTED_FUNCTION',
            `The function ${node.name} cannot be used here.`,
            node,
            { function: node.name, name: node.name },
          );
        }
        const implementation: FunctionImpl | undefined = (
          IMPLEMENTATIONS as Readonly<Record<string, FunctionImpl>>
        )[node.name];
        if (implementation === undefined) return null;
        const result = implementation(new CallArgs(node, scope, this));
        // Like the SQL compiler: a call's value has the call's type (a date
        // widens to a datetime at midnight in its zone) and no field zone.
        return withoutZone(conform(result, this.rt.typeOf(node), this.rt));
      }
    }
  }

  private binary(node: Binary, scope: Scope): Value {
    switch (node.operator) {
      case '&&':
        return this.run(node.left, scope) === true && this.run(node.right, scope) === true;
      case '||':
        return this.run(node.left, scope) === true || this.run(node.right, scope) === true;
      default:
        break;
    }
    const left = this.run(node.left, scope);
    const right = this.run(node.right, scope);
    switch (node.operator) {
      case '=':
      case '!=': {
        const equal = this.rt.equal(
          left,
          right,
          this.rt.typeOf(node.left),
          this.rt.typeOf(node.right),
        );
        return node.operator === '=' ? equal : !equal;
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        // An empty side makes the comparison FALSE (SPEC §9.4).
        const order = this.rt.order(left, right);
        if (order === null) return false;
        if (node.operator === '<') return order < 0;
        if (node.operator === '<=') return order <= 0;
        if (node.operator === '>') return order > 0;
        return order >= 0;
      }
      case '&':
        return (this.rt.text(left) ?? '') + (this.rt.text(right) ?? '');
      default:
        return arithmetic(node.operator, left, right, this.rt);
    }
  }
}

/** Largest number of days added to a date or datetime (`fx.date_add`, `fx.ts_add`). */
const MAX_SHIFT_DAYS = Dec.int(1_000_000);

/**
 * Date ± days (`fx.date_add`): whole days, the fraction dropped toward −∞.
 * Datetime ± days (`fx.ts_add`): exact 86,400-second days. Empty beyond a
 * million days or from a value outside years 1–9999; the field zone stays.
 */
function shift(value: Value, days: Dec): Value {
  if (days.abs().cmp(MAX_SHIFT_DAYS) > 0) return null;
  if (isDate(value)) {
    if (!inRange(value.day)) return null;
    return date(value.day + (days.round(0, 'floor').toInt() ?? 0), value.zone);
  }
  if (isDateTime(value)) {
    if (!instantInRange(value.ms)) return null;
    const delta = days
      .mul(Dec.of(BigInt(DAY_MS)))
      .round(0, 'half')
      .toInt();
    return datetime(value.ms + (delta ?? 0), value.zone);
  }
  return null;
}

/** `value` as the static `type`: dates in a datetime (or list of datetimes) become instants. */
function conform(value: Value, type: FormulaType, rt: Runtime): Value {
  if (type.kind === 'datetime' && isDate(value)) {
    const instant = rt.instant(value);
    return instant === null ? null : datetime(instant);
  }
  if (type.kind === 'list' && type.element.kind === 'datetime' && Array.isArray(value)) {
    const items = value as readonly Value[];
    return items.some(isDate) ? items.map((item) => conform(item, type.element, rt)) : items;
  }
  return value;
}

/**
 * `+ - * / %` (SPEC §9.2, §9.4): exact decimals, `/` rounds like
 * PostgreSQL `numeric`, division by zero is empty, `%` is MOD (sign of the
 * divisor). A date ± a number of days stays a date; date − date is the
 * number of days (a datetime difference is fractional).
 */
function arithmetic(operator: string, left: Value, right: Value, rt: Runtime): Value {
  if (left === null || right === null) return null;
  const leftDate = isDate(left) || isDateTime(left);
  const rightDate = isDate(right) || isDateTime(right);
  if (leftDate && rightDate && operator === '-') {
    if (isDate(left) && isDate(right)) return Dec.int(left.day - right.day);
    const a = rt.instant(left);
    const b = rt.instant(right);
    if (a === null || b === null) return null;
    // `extract(epoch FROM a - b) / 86400` (`fx.ts_diff_days`): seconds with 6 decimals.
    return Dec.of(BigInt(a - b) * 1000n, 6).div(Dec.int(86_400));
  }
  if (leftDate && (operator === '+' || operator === '-')) {
    const days = toDec(right);
    return days === null ? null : shift(left, operator === '-' ? days.neg() : days);
  }
  if (rightDate && operator === '+') {
    const days = toDec(left);
    return days === null ? null : shift(right, days);
  }
  const a = toDec(left);
  const b = toDec(right);
  if (a === null || b === null) return null;
  switch (operator) {
    case '+':
      return a.add(b);
    case '-':
      return a.sub(b);
    case '*':
      return a.mul(b);
    case '/':
      return a.div(b);
    default:
      return mod(a, b);
  }
}

/**
 * Evaluates a resolved, typechecked AST on one record; the result as a
 * runtime value (see `evaluate` for JSON).
 */
export function evaluateValue(ast: Expr, context: EvaluateContext): Value {
  if (!isValidTimeZone(context.tz)) throw new RangeError(`Unknown time zone: ${context.tz}`);
  const runtime = new Runtime({
    snapshot: context.snapshot,
    row: context.row,
    resolve: context.resolve ?? null,
    timeZone: context.tz,
    now: instantOf(context.now, context.tz),
    locale: context.locale ?? 'und',
    types: context.types ?? typesOf(ast, context.snapshot),
  });
  return new Interpreter(runtime, {
    disallow: context.disallow ?? null,
    interrupt: context.interrupt ?? null,
  }).run(ast, ROOT);
}

/**
 * `evaluate(ast, { snapshot, row, resolve, tz, now })` (T453): the value of
 * a formula on one record, as JSON — numbers as exact decimal text
 * (`"0.1"`), dates `YYYY-MM-DD`, datetimes ISO in UTC, users their ID,
 * records `{ id, title }`, an empty list `null`. Operations that fail
 * (division by zero, `VALUE("abc")`, `SQRT(-1)`…) give `null` (SPEC §9.4).
 * Throws the first `FormulaError` when the AST does not typecheck.
 */
export function evaluate(ast: Expr, context: EvaluateContext): FormulaJsonValue {
  return toJson(evaluateValue(ast, context));
}
