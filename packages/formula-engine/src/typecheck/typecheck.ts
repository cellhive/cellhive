import { leftSpine } from '../ast.js';
import { getFunction } from '../catalogue/index.js';
import {
  DependencyCollector,
  RECORD_ID_CONDITION_REF,
  type RowsOrigin,
} from '../deps/collector.js';
import { FormulaError, type FormulaTypeIssueCode, type SourceSpan } from '../errors.js';
import { MAX_CROSS_TABLE_FILTERS } from '../limits.js';
import { fieldStyle, fieldValueType } from '../types/field-type.js';
import {
  elementOf,
  equalityComparable,
  formatType,
  isDateLike,
  isNestedList,
  isOpen,
  listOf,
  orderComparable,
  rowOf,
  rowsTable,
  T,
  tableOf,
  type FormulaType,
} from '../types/formula-type.js';

import { checkArgument } from './arguments.js';

import type { Binary, Call, Expr, Member, Reference } from '../ast.js';
import type {
  CallContext,
  FunctionDefinition,
  Param,
  Signature,
  TypedArg,
} from '../catalogue/types.js';
import type { SchemaSnapshot, SnapshotField } from '../resolve.js';

export type Style = Readonly<Record<string, unknown>>;

/** A typed argument with the records it stands for. */
type Arg = TypedArg & { origin: RowsOrigin | null };

/** A typed expression; `origin` is set when it stands for records (for dependencies). */
interface Typed {
  type: FormulaType;
  style: Style | null;
  origin: RowsOrigin | null;
}

interface Scope {
  /** `CurrentValue` inside an iteration; `null` outside any. */
  current: Typed | null;
  variables: ReadonlyMap<string, Typed>;
  /** The iterating function whose condition/mapping is being checked (no nesting). */
  iterating: string | null;
  /** LOOKUP: `[T]` in `[T].[Field]` stands for the records its condition selects. */
  lookupTable?: { tableId: string; origin: RowsOrigin };
}

export interface TypecheckResult {
  /** Type of the whole formula (`any` when it has errors). */
  type: FormulaType;
  /** `style` the result inherits from the fields it carries (number/date results only). */
  style: Style | null;
  /** Type of every node, for the evaluator and SQL compiler. */
  types: ReadonlyMap<Expr, FormulaType>;
  /** Every type error found (the checker goes on after one, typing the node `any`). */
  errors: FormulaError[];
  /** Volatile functions used (`NOW`, `TODAY`). */
  volatileFunctions: string[];
  /** Iterations over another table (FILTER/COUNTIF/SUMIF/MAP/SORTBY over `[Table]`, LOOKUP). */
  crossTableIterations: number;
  dependencies: DependencyCollector;
}

const ANY: Typed = { type: T.any, style: null, origin: null };

function typed(
  type: FormulaType,
  style: Style | null = null,
  origin: RowsOrigin | null = null,
): Typed {
  return { type, style, origin };
}

/** Type of a field read on many records at once (a table column, a link): flat for links. */
function column(type: FormulaType): FormulaType {
  if (type.kind === 'list' && type.element.kind === 'row') return type;
  return listOf(type);
}

/** Keeps a style only on results it can format (numbers and dates, or lists of them). */
function styleFits(type: FormulaType, style: Style | null): Style | null {
  if (style === null) return null;
  const element = elementOf(type);
  return element.kind === 'number' || isDateLike(element) || isOpen(element) ? style : null;
}

/** Table of the records a field value stands for: a link (`list<row>`) or a single link (`row`). */
function linkedTable(type: FormulaType): string | null {
  if (type.kind === 'row') return type.tableId;
  return type.kind === 'list' && type.element.kind === 'row' ? type.element.tableId : null;
}

function spanOf(node: SourceSpan): SourceSpan {
  return { start: node.start, length: node.length };
}

class Checker {
  readonly types = new Map<Expr, FormulaType>();
  readonly errors: FormulaError[] = [];
  readonly volatile = new Set<string>();
  readonly deps = new DependencyCollector();
  crossTable = 0;
  private readonly fields = new Map<string, SnapshotField>();
  private readonly fieldTable = new Map<string, string>();
  private readonly primaryFields = new Map<string, string>();

  constructor(private readonly snapshot: SchemaSnapshot) {
    for (const table of snapshot.tables) {
      if (table.primaryFieldId !== undefined && table.primaryFieldId !== null) {
        this.primaryFields.set(table.id, table.primaryFieldId);
      }
      for (const field of table.fields) {
        this.fields.set(field.id, field);
        this.fieldTable.set(field.id, table.id);
      }
    }
  }

  error(
    node: SourceSpan,
    code: FormulaTypeIssueCode,
    message: string,
    params: Record<string, unknown> = {},
  ): Typed {
    this.errors.push(new FormulaError(code, message, spanOf(node), params));
    return ANY;
  }

  /**
   * Records used as text (compared with a text, joined with `&`, passed to a
   * text function): their value is the title, the primary field of their
   * table (SPEC §9.2), so the formula depends on it too, reached like the
   * records themselves (T456).
   */
  titleUse(value: Typed): void {
    const tableId = rowsTable(value.type);
    if (tableId === null || value.type.kind === 'table' || value.origin === null) return;
    const primary = this.primaryFields.get(tableId);
    if (primary !== undefined) this.deps.add(primary, value.origin);
  }

  /** Results of the left spine of a binary chain, checked ahead ({@link checkSpine}). */
  private readonly spine = new Map<Expr, Typed>();

  /**
   * A chain of one precedence level (`1 + 1 + … + 1`, up to ~2,000 terms in
   * 4,000 characters, SPEC §9.5) is a left-deep tree as deep as it is long:
   * checking it recursively overflows the stack (T470). Its left spine is
   * checked bottom-up first, in the same order as the recursion would.
   */
  private checkSpine(node: Expr, scope: Scope): void {
    const chain = leftSpine(node, (link) => this.spine.has(link));
    try {
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const link = chain[index] as Expr;
        this.spine.set(link, this.check(link, scope));
      }
    } catch (error) {
      for (const link of chain) this.spine.delete(link);
      throw error;
    }
  }

  check(node: Expr, scope: Scope): Typed {
    const ahead = this.spine.get(node);
    if (ahead !== undefined) {
      this.spine.delete(node);
      return ahead;
    }
    if (node.type === 'binary') this.checkSpine(node, scope);
    const result = this.expr(node, scope);
    this.types.set(node, result.type);
    return result;
  }

  private expr(node: Expr, scope: Scope): Typed {
    switch (node.type) {
      case 'number':
        return typed(T.number);
      case 'string':
        return typed(T.text);
      case 'boolean':
        return typed(T.boolean);
      case 'reference':
        return this.reference(node, scope);
      case 'member':
        return this.member(node, scope);
      case 'current_value':
        if (scope.current === null) {
          return this.error(
            node,
            'CURRENT_VALUE_OUTSIDE_ITERATION',
            'CurrentValue can only be used inside FILTER, MAP, COUNTIF, SUMIF or SORTBY.',
          );
        }
        return scope.current;
      case 'variable':
        return scope.variables.get(node.name.toUpperCase()) ?? ANY;
      case 'let': {
        const variables = new Map(scope.variables);
        for (const binding of node.bindings) {
          variables.set(
            binding.name.toUpperCase(),
            this.check(binding.value, { ...scope, variables }),
          );
        }
        return this.check(node.body, { ...scope, variables });
      }
      case 'unary': {
        const operand = this.check(node.operand, scope);
        const issue = checkArgument('number', operand.type);
        if (issue !== null)
          return this.error(node.operand, issue.code, issue.message, issue.params);
        return typed(T.number, operand.style);
      }
      case 'binary':
        return this.binary(node, scope);
      case 'call':
        return this.call(node, scope);
    }
  }

  private reference(node: Reference, scope: Scope): Typed {
    if (node.kind === 'table' && node.id !== null) {
      const origin =
        scope.lookupTable?.tableId === node.id
          ? scope.lookupTable.origin
          : this.deps.table(node.id);
      return typed(tableOf(node.id), null, origin);
    }
    const field = node.id === null ? undefined : this.fields.get(node.id);
    if (field === undefined) return ANY;
    this.deps.add(field.id, null);
    const type = fieldValueType(field);
    const target = linkedTable(type);
    const origin = target === null ? null : this.deps.follow(null, field.id, target);
    return typed(type, fieldStyle(field), origin);
  }

  private member(node: Member, scope: Scope): Typed {
    const object = this.check(node.object, scope);
    const field = node.property.id === null ? undefined : this.fields.get(node.property.id);
    if (field === undefined || object.type.kind === 'any') return ANY;
    this.types.set(node.property, fieldValueType(field));
    this.deps.add(field.id, object.origin);
    const type = fieldValueType(field);
    const target = linkedTable(type);
    const origin = target === null ? null : this.deps.follow(object.origin, field.id, target);
    const style = fieldStyle(field);
    switch (object.type.kind) {
      case 'row':
        return typed(type, style, origin);
      case 'table':
        return typed(column(type), style, origin);
      case 'list':
        if (object.type.element.kind === 'row') return typed(column(type), style, origin);
        break;
      default:
        break;
    }
    // Name resolution only lets `.[Field]` follow records; keep going if it did not.
    return ANY;
  }

  private binary(node: Binary, scope: Scope): Typed {
    const left = this.check(node.left, scope);
    const right = this.check(node.right, scope);
    const style = left.style ?? right.style;
    switch (node.operator) {
      case '&&':
      case '||':
        return this.operands(node, left, right, 'boolean') ?? typed(T.boolean);
      case '&': {
        const failed = this.operands(node, left, right, 'text');
        this.titleUse(left);
        this.titleUse(right);
        return failed ?? typed(T.text);
      }
      case '=':
      case '!=':
        for (const [side, other] of [
          [node.left, left],
          [node.right, right],
        ] as const) {
          if (other.type.kind === 'table') {
            return this.error(side, 'TABLE_NEEDS_FIELD', 'Select a field of the table: .[Field].');
          }
        }
        if (!equalityComparable(left.type, right.type)) {
          return this.mismatch(node.right, left.type, right.type);
        }
        this.titleComparison(left, right);
        return typed(T.boolean);
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const failed = this.operands(node, left, right, 'single');
        if (failed !== null) return failed;
        if (!orderComparable(left.type, right.type))
          return this.mismatch(node.right, left.type, right.type);
        return typed(T.boolean);
      }
      default:
        return this.arithmetic(node, left, right, style);
    }
  }

  /** `record = "text"`: the record is compared by its title unless the text is its `RECORD_ID()`. */
  private titleComparison(left: Typed, right: Typed): void {
    for (const [rows, other] of [
      [left, right],
      [right, left],
    ] as const) {
      const tableId = rowsTable(rows.type);
      if (tableId === null || rowsTable(other.type) !== null) continue;
      const element = elementOf(other.type);
      if (element.kind === 'text' && element.recordIdOf === tableId) continue;
      if (isOpen(element)) continue;
      this.titleUse(rows);
    }
  }

  /** Both operands must fit `kind`; returns the error, or `null` when they do. */
  private operands(node: Binary, left: Typed, right: Typed, kind: Param['kind']): Typed | null {
    for (const [side, value] of [
      [node.left, left],
      [node.right, right],
    ] as const) {
      const issue = checkArgument(kind, value.type);
      if (issue !== null) return this.error(side, issue.code, issue.message, issue.params);
    }
    return null;
  }

  private mismatch(node: Expr, expected: FormulaType, actual: FormulaType): Typed {
    return this.error(
      node,
      'TYPE_MISMATCH',
      `Cannot compare ${formatType(expected)} with ${formatType(actual)}.`,
      { expected: formatType(expected), actual: formatType(actual) },
    );
  }

  /**
   * `+ - * / %`: numbers; a date plus/minus a number of days stays a date;
   * a date minus a date is a number of days.
   */
  private arithmetic(node: Binary, left: Typed, right: Typed, style: Style | null): Typed {
    const failed = this.operands(node, left, right, 'single');
    if (failed !== null) return failed;
    const [a, b] = [left.type, right.type];
    const numberLike = (type: FormulaType) => isOpen(type) || type.kind === 'number';
    if (node.operator === '+' || node.operator === '-') {
      if (isDateLike(a) && numberLike(b)) return typed(a, left.style);
      if (node.operator === '+' && numberLike(a) && isDateLike(b)) return typed(b, right.style);
      if (node.operator === '-' && isDateLike(a) && isDateLike(b)) return typed(T.number);
    }
    for (const [side, type] of [
      [node.left, a],
      [node.right, b],
    ] as const) {
      if (!numberLike(type)) {
        return this.error(side, 'TYPE_MISMATCH', `Expected number, got ${formatType(type)}.`, {
          expected: 'number',
          actual: formatType(type),
        });
      }
    }
    return typed(T.number, style);
  }

  private call(node: Call, scope: Scope): Typed {
    const definition = getFunction(node.name);
    if (definition === undefined) return ANY; // The parser only lets catalogue names through.
    if (definition.volatile) this.volatile.add(definition.name);
    const iterating = definition.iterates || definition.name === 'LOOKUP';
    if (iterating && scope.iterating !== null) {
      this.error(
        node,
        'NESTED_ITERATION',
        `${definition.name} cannot be used inside the condition of ${scope.iterating}.`,
        { function: definition.name, outer: scope.iterating },
      );
    }
    const args =
      definition.name === 'LOOKUP'
        ? this.lookupArgs(node, scope)
        : this.args(node, definition, scope);
    const signature = this.matchSignature(node, definition, args);
    if (signature === null) return ANY;
    const failures = this.errors.length;
    const context: CallContext = {
      args,
      tableId: this.snapshot.tableId,
      fail: (index, code, message, params) => {
        const target = index === null ? node : (args[index]?.node ?? node);
        this.error(target, code, message, params);
        return T.any;
      },
    };
    const type = definition.result(context);
    if (this.errors.length > failures) return ANY;
    if (!STRUCTURAL_FUNCTIONS.has(definition.name)) {
      const mixed = args.some((arg) => rowsTable(arg.type) === null);
      const idOnly = CONTAIN_FUNCTIONS.has(definition.name) && !mixed;
      if (!idOnly) for (const arg of args) this.titleUse(arg);
    }
    const origin = this.rowsOrigin(definition, args);
    return typed(type, styleFits(type, this.style(definition, args)), origin);
  }

  /** Arguments of an ordinary call; an iterating one scopes `CurrentValue` over its first. */
  private args(node: Call, definition: FunctionDefinition, scope: Scope): Arg[] {
    const [first, ...rest] = node.args;
    if (first === undefined) return [];
    let subject = this.check(first, scope);
    let inner = scope;
    if (definition.iterates) {
      if (subject.type.kind === 'table') {
        this.countCrossTable(node);
        // The keys of the condition tell which formula records a change of a
        // record of that table touches (`condition_refs`). Iterating over the
        // whole table starts a selection of its own (the table may also be
        // read without condition, e.g. through a LET variable); chained
        // conditions share it, since a record must pass all of them.
        if (subject.origin !== null) {
          if (!subject.origin.selected) {
            const origin = { ...subject.origin, selected: true, conditionRefs: new Set<string>() };
            subject = { ...subject, origin };
          }
          const condition = CONDITION_FUNCTIONS.has(definition.name) ? rest[0] : undefined;
          if (condition !== undefined) {
            for (const key of conditionKeys(condition)) subject.origin?.conditionRefs.add(key);
          }
        }
      }
      inner = { ...scope, current: this.currentValue(subject), iterating: definition.name };
    }
    return [
      { node: first, ...subject },
      ...rest.map((arg) => ({ node: arg, ...this.check(arg, inner) })),
    ];
  }

  /**
   * LOOKUP(value, [T].[M], [T].[R], mode) ≡ `[T].FILTER(CurrentValue.[M] = value).[R]`:
   * the value is the condition (no nested iteration; a plain `[Field]` is the key)
   * and `[T].[M]`, `[T].[R]` read the records it selects.
   */
  private lookupArgs(node: Call, scope: Scope): Arg[] {
    this.countCrossTable(node);
    const match = node.args[1];
    const table =
      match?.type === 'member' && match.object.type === 'reference' ? match.object : null;
    const lookupTable =
      table?.kind === 'table' && table.id !== null
        ? { tableId: table.id, origin: this.deps.table(table.id) }
        : null;
    return node.args.map((arg, index) => {
      let inner = scope;
      if (index === 0) {
        inner = { ...scope, iterating: 'LOOKUP' };
        const key = keyRef(arg);
        if (key !== null) lookupTable?.origin.conditionRefs.add(key);
      } else if ((index === 1 || index === 2) && lookupTable !== null) {
        inner = { ...scope, lookupTable };
      }
      return { node: arg, ...this.check(arg, inner) };
    });
  }

  private currentValue(subject: Typed): Typed {
    const type = subject.type;
    if (type.kind === 'table') return typed(rowOf(type.tableId), null, subject.origin);
    if (type.kind === 'list') {
      return typed(
        type.element,
        subject.style,
        type.element.kind === 'row' ? subject.origin : null,
      );
    }
    return ANY;
  }

  private countCrossTable(node: Call): void {
    this.crossTable += 1;
    if (this.crossTable === MAX_CROSS_TABLE_FILTERS + 1) {
      this.errors.push(
        new FormulaError(
          'MAX_CROSS_TABLE_FILTERS',
          `A formula can query other tables at most ${String(MAX_CROSS_TABLE_FILTERS)} times.`,
          spanOf(node),
          { limit: MAX_CROSS_TABLE_FILTERS },
        ),
      );
    }
  }

  /** Records a row-preserving call stands for (FILTER/SORTBY/FIRST… keep their subject's). */
  private rowsOrigin(definition: FunctionDefinition, args: readonly Arg[]): RowsOrigin | null {
    if (!ROW_PRESERVING.has(definition.name)) return null;
    return args[0]?.origin ?? null;
  }

  private style(definition: FunctionDefinition, args: readonly TypedArg[]): Style | null {
    const from = definition.styleFrom;
    if (from === undefined) return null;
    const indices = from === 'all' ? args.map((_, index) => index) : from;
    for (const index of indices) {
      const style = args[index]?.style ?? null;
      if (style !== null) return style;
    }
    return null;
  }

  /** The first signature the arguments fit; reports why none does. */
  private matchSignature(
    node: Call,
    definition: FunctionDefinition,
    args: readonly TypedArg[],
  ): Signature | null {
    const byArity = definition.signatures.filter(
      (signature) => paramsFor(signature, args.length) !== null,
    );
    if (byArity.length === 0) {
      const { min, max } = arity(definition.signatures);
      const expected =
        max === null
          ? `at least ${String(min)}`
          : min === max
            ? String(min)
            : `${String(min)} to ${String(max)}`;
      this.error(
        node,
        'WRONG_ARGUMENT_COUNT',
        `${definition.name} takes ${expected} argument${max === 1 ? '' : 's'}, got ${String(args.length)}.`,
        { function: definition.name, min, max, actual: args.length },
      );
      return null;
    }
    let firstIssues: { index: number; issue: ReturnType<typeof checkArgument> }[] | null = null;
    for (const signature of byArity) {
      const params = paramsFor(signature, args.length) ?? [];
      const issues = args
        .map((arg, index) => ({
          index,
          issue: checkArgument(params[index]?.kind ?? 'value', arg.type),
        }))
        .filter((item) => item.issue !== null);
      if (issues.length === 0) return signature;
      firstIssues ??= issues;
    }
    for (const { index, issue } of firstIssues ?? []) {
      if (issue === null) continue;
      const arg = args[index];
      if (arg !== undefined) this.error(arg.node, issue.code, issue.message, issue.params);
    }
    return null;
  }
}

/** Iterating functions whose second argument is a condition (not a mapping). */
const CONDITION_FUNCTIONS: ReadonlySet<string> = new Set(['FILTER', 'COUNTIF', 'SUMIF']);

/** `[Field]` of the formula's table or `RECORD_ID()`: the value a key conjunct matches. */
function keyRef(node: Expr): string | null {
  if (node.type === 'reference' && node.kind === 'field' && node.id !== null) return node.id;
  if (node.type === 'call' && node.name === 'RECORD_ID' && node.args.length === 0) {
    return RECORD_ID_CONDITION_REF;
  }
  return null;
}

/** `CurrentValue.[Field]`: the record side of a key conjunct. */
function isRecordSide(node: Expr): boolean {
  return node.type === 'member' && node.object.type === 'current_value';
}

function conjuncts(node: Expr): Expr[] {
  if (node.type === 'binary' && node.operator === '&&') {
    return [...conjuncts(node.left), ...conjuncts(node.right)];
  }
  if (node.type === 'call' && node.name === 'AND') return node.args.flatMap(conjuncts);
  return [node];
}

/**
 * Formula-table fields a cross-table condition matches records on: the
 * `[Field]`/`RECORD_ID()` of top-level conjuncts `CurrentValue.[X] = [Field]`
 * (either side), `CONTAIN(CurrentValue.[X], [Field], …)` or
 * `CONTAINSALL(…)` with only such values. A change of `X` on a record then
 * touches only formula records whose `Field` equals its old or new value.
 * No key → every formula record (empty set).
 */
export function conditionKeys(condition: Expr): Set<string> {
  const keys = new Set<string>();
  for (const conjunct of conjuncts(condition)) {
    if (conjunct.type === 'binary' && conjunct.operator === '=') {
      const key = isRecordSide(conjunct.left)
        ? keyRef(conjunct.right)
        : isRecordSide(conjunct.right)
          ? keyRef(conjunct.left)
          : null;
      if (key !== null) keys.add(key);
      continue;
    }
    if (
      conjunct.type === 'call' &&
      (conjunct.name === 'CONTAIN' || conjunct.name === 'CONTAINSALL')
    ) {
      const [range, ...values] = conjunct.args;
      if (range === undefined || !isRecordSide(range) || values.length === 0) continue;
      const refs = values.map(keyRef).filter((ref): ref is string => ref !== null);
      if (refs.length === values.length) for (const ref of refs) keys.add(ref);
    }
  }
  return keys;
}

/**
 * Functions that take records as records (iterate, pick, count, pass them
 * through): everything else reads records as their titles (T456).
 */
const STRUCTURAL_FUNCTIONS: ReadonlySet<string> = new Set([
  'FILTER',
  'MAP',
  'COUNTIF',
  'SUMIF',
  'SORTBY',
  'FIRST',
  'LAST',
  'NTH',
  'UNIQUE',
  'COUNTA',
  'ISBLANK',
  'LISTCOMBINE',
  'LOOKUP',
  'LIST',
  'IF',
  'IFS',
  'SWITCH',
  'IFERROR',
  'IFBLANK',
  'RECORD_ID',
]);

/** Records found among records match by id; among other values, by title. */
const CONTAIN_FUNCTIONS: ReadonlySet<string> = new Set(['CONTAIN', 'CONTAINSALL', 'CONTAINSONLY']);

/** Functions whose result is some of their first argument's records. */
const ROW_PRESERVING: ReadonlySet<string> = new Set([
  'FILTER',
  'SORTBY',
  'SORT',
  'UNIQUE',
  'FIRST',
  'LAST',
  'NTH',
]);

/** The param each of `count` arguments matches, or `null` when the count does not fit. */
export function paramsFor(signature: Signature, count: number): Param[] | null {
  const repeat = signature.repeat ?? 0;
  const fixed = signature.params.slice(0, signature.params.length - repeat);
  const group = signature.params.slice(signature.params.length - repeat);
  const required = fixed.filter((param) => param.optional !== true).length;
  if (count < required) return null;
  if (repeat === 0) {
    const max = fixed.length + (signature.trailing === undefined ? 0 : 1);
    if (count > max) return null;
    const out = fixed.slice(0, count);
    if (count > fixed.length && signature.trailing !== undefined) out.push(signature.trailing);
    return out;
  }
  if (count < fixed.length) return null;
  let rest = count - fixed.length;
  const trailing =
    signature.trailing !== undefined && rest % repeat === 1 ? signature.trailing : null;
  if (trailing !== null) rest -= 1;
  if (rest % repeat !== 0) return null;
  const groupOptional = group.every((param) => param.optional === true);
  if (rest === 0 && !groupOptional) return null;
  const out = [...fixed];
  for (let index = 0; index < rest; index += 1) out.push(group[index % repeat] as Param);
  if (trailing !== null) out.push(trailing);
  return out;
}

/** Fewest and most arguments over the overloads (`max` null when variadic). */
export function arity(signatures: readonly Signature[]): { min: number; max: number | null } {
  let min = Number.POSITIVE_INFINITY;
  let max: number | null = 0;
  for (const signature of signatures) {
    const repeat = signature.repeat ?? 0;
    const fixed = signature.params.slice(0, signature.params.length - repeat);
    const group = signature.params.slice(signature.params.length - repeat);
    const groupRequired = repeat > 0 && !group.every((param) => param.optional === true);
    min = Math.min(
      min,
      fixed.filter((param) => param.optional !== true).length + (groupRequired ? repeat : 0),
    );
    if (repeat > 0) max = null;
    else if (max !== null) {
      max = Math.max(max, fixed.length + (signature.trailing === undefined ? 0 : 1));
    }
  }
  return { min: Number.isFinite(min) ? min : 0, max };
}

/**
 * Typechecks a resolved AST (after `resolveNames`) against the snapshot
 * (SPEC §9.2): operand and argument types, lists used as one value, FILTER
 * over a table without `.[Field]`, lists of lists without `LISTCOMBINE`,
 * nested FILTER/MAP/COUNTIF/SUMIF/SORTBY/LOOKUP, `CurrentValue` outside an
 * iteration, `LET` scopes (handled by the parser and resolver) and the
 * storable result. Collects dependencies on the way. Never throws.
 */
export function typecheck(ast: Expr, snapshot: SchemaSnapshot): TypecheckResult {
  const checker = new Checker(snapshot);
  const root = checker.check(ast, { current: null, variables: new Map(), iterating: null });
  let type = root.type;
  if (type.kind === 'table') {
    checker.error(
      ast,
      'TABLE_NEEDS_FIELD',
      'The formula must end with .[Field] to return a value of the records.',
    );
    type = T.any;
  } else if (isNestedList(type)) {
    checker.error(
      ast,
      'NESTED_LIST',
      'The result is a list of lists: combine it with LISTCOMBINE().',
      {
        suggestions: ['LISTCOMBINE'],
      },
    );
    type = T.any;
  }
  const failed = checker.errors.length > 0;
  return {
    type: failed ? T.any : type,
    style: failed ? null : styleFits(type, root.style),
    types: checker.types,
    errors: checker.errors,
    volatileFunctions: [...checker.volatile],
    crossTableIterations: checker.crossTable,
    dependencies: checker.deps,
  };
}
