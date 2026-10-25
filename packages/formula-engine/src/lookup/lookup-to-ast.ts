import { FormulaError, type FormulaIssueCode, type SourceSpan } from '../errors.js';
import { lookupParts } from '../functions/LOOKUP.js';
import { fieldValueType } from '../types/field-type.js';

import type { BinaryOperator, Call, Expr, Member, Reference } from '../ast.js';
import type { SchemaSnapshot, SnapshotField, SnapshotTable } from '../resolve.js';

/** Aggregations of a lookup field (SPEC §5.8). */
export const LOOKUP_AGGREGATES = [
  'raw_value',
  'unique',
  'sum',
  'average',
  'max',
  'min',
  'counta',
  'unique_counta',
] as const;
export type LookupAggregate = (typeof LOOKUP_AGGREGATES)[number];

/**
 * Operand of a lookup `where` condition — the Filter DSL of
 * `@cellhive/filter-dsl` (SPEC §6.1), repeated structurally so this package
 * stays free of it: a constant, `{ $var }`, `{ $date }` or `{ field_ref }`.
 */
export type LookupOperand =
  | string
  | number
  | boolean
  | null
  | { $var: string }
  | { $date: { relative: string; amount?: number | undefined } | { exact: string } }
  | { field_ref: string };

export interface LookupCondition {
  field: string;
  operator: string;
  value?: LookupOperand | LookupOperand[] | undefined;
}
export interface LookupGroup {
  op: 'and' | 'or';
  items: LookupWhere[];
}
export interface LookupNot {
  op: 'not';
  item: LookupWhere;
}
export type LookupWhere = LookupCondition | LookupGroup | LookupNot;

/** The four parts of a lookup field (SPEC §5.8). */
export interface LookupOptions {
  /** Source table (same base). */
  from: string;
  /** Field of the source table whose values are taken. */
  select: string;
  /** Filter DSL on source-table fields; `field_ref` compares with the current record. */
  where: LookupWhere;
  aggregate?: LookupAggregate;
}

const AT: SourceSpan = { start: 0, length: 0 };
/** The record ID in a lookup `where` (Filter DSL `RECORD_ID_REF`). */
const RECORD_ID = '__id';

function fail(code: FormulaIssueCode, message: string, path: string): FormulaError {
  return new FormulaError(code, message, AT, { path });
}

// ---------------------------------------------------------------------------
// AST builders (synthetic nodes have an empty span at 0).

function fieldRef(field: SnapshotField): Reference {
  return { type: 'reference', name: field.name, id: field.id, kind: 'field', ...AT };
}

function tableRef(table: SnapshotTable): Reference {
  return { type: 'reference', name: table.name, id: table.id, kind: 'table', ...AT };
}

function member(object: Expr, field: SnapshotField): Member {
  return { type: 'member', object, property: fieldRef(field), ...AT };
}

function call(name: string, args: Expr[], chained = false): Call {
  return { type: 'call', name, args, chained, ...AT };
}

/** `CONTAIN*` of a lookup `where`: exact comparison, no case folding (Filter DSL). */
function exactCall(name: string, args: Expr[]): Call {
  return { ...call(name, args), exact: true };
}

function binary(operator: BinaryOperator, left: Expr, right: Expr): Expr {
  return { type: 'binary', operator, left, right, ...AT };
}

function all(terms: Expr[]): Expr {
  return terms.reduce((left, right) => binary('&&', left, right));
}

function any(terms: Expr[]): Expr {
  return terms.reduce((left, right) => binary('||', left, right));
}

function bool(value: boolean): Expr {
  return { type: 'boolean', value, ...AT };
}

function text(value: string): Expr {
  return { type: 'string', value, ...AT };
}

/** Decimal text of a finite number, never in exponent notation. */
function decimal(value: number): string {
  if (Number.isInteger(value)) return BigInt(value).toString();
  const plain = String(value);
  return plain.includes('e') ? value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : plain;
}

function number(value: number): Expr {
  const literal: Expr = { type: 'number', value: decimal(Math.abs(value)), ...AT };
  return value < 0 ? { type: 'unary', operator: '-', operand: literal, ...AT } : literal;
}

/** Not `condition`, where an empty value counts as false (Filter DSL complements). */
function complement(condition: Expr): Expr {
  return call('NOT', [call('IFERROR', [condition, bool(false)])]);
}

/** `LOWER(UNACCENT(x))`: text comparison of the Filter DSL (case and accent insensitive). */
function fold(value: Expr): Expr {
  return call('LOWER', [call('UNACCENT', [value])]);
}

// ---------------------------------------------------------------------------

type Category = 'text' | 'number' | 'datetime' | 'checkbox' | 'single_select' | 'multi' | 'link';

function categoryOf(field: SnapshotField, path: string): Category {
  const type = fieldValueType(field);
  if (type.kind === 'list') return type.element.kind === 'row' ? 'link' : 'multi';
  if (field.type === 'select') return 'single_select';
  switch (type.kind) {
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'date':
    case 'datetime':
      return 'datetime';
    default:
      throw fail('INVALID_LOOKUP', 'This field cannot be used in a lookup condition.', path);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Range {
  start: Expr;
  end: Expr;
}

class LookupBuilder {
  private readonly current: SnapshotTable;
  private readonly source: SnapshotTable;

  constructor(
    snapshot: SchemaSnapshot,
    private readonly options: LookupOptions,
  ) {
    const current = snapshot.tables.find((table) => table.id === snapshot.tableId);
    const source = snapshot.tables.find((table) => table.id === options.from);
    if (current === undefined) throw fail('UNKNOWN_TABLE', 'Unknown current table.', 'table');
    if (source === undefined) throw fail('UNKNOWN_TABLE', 'Unknown source table.', 'from');
    this.current = current;
    this.source = source;
  }

  build(): Expr {
    const select = this.sourceField(this.options.select, 'select');
    // "Records this record links to" as the range: the linked rows (junction), not the table.
    const scope = this.linkScope(this.options.where);
    let filtered: Expr;
    if (scope === null) {
      filtered = call(
        'FILTER',
        [tableRef(this.source), this.node(this.options.where, 'where')],
        true,
      );
    } else if (scope.rest.length === 0) {
      filtered = fieldRef(scope.link);
    } else {
      const terms = scope.rest.map(([item, path]) => this.node(item, path));
      filtered = call('FILTER', [fieldRef(scope.link), all(terms)], true);
    }
    let values: Expr = member(filtered, select);
    const type = fieldValueType(select);
    if (type.kind === 'list' && type.element.kind !== 'row') {
      // A multi-value field over many records: one flat list (SPEC §9.2).
      values = call('LISTCOMBINE', [values], true);
    }
    switch (this.options.aggregate ?? 'raw_value') {
      case 'raw_value':
        return values;
      case 'unique':
        return call('UNIQUE', [values], true);
      case 'sum':
        return call('SUM', [values], true);
      case 'average':
        return call('AVERAGE', [values], true);
      case 'max':
        return call('MAX', [values], true);
      case 'min':
        return call('MIN', [values], true);
      case 'counta':
        return call('COUNTA', [values], true);
      case 'unique_counta':
        return call('COUNTA', [call('UNIQUE', [values], true)], true);
    }
  }

  /**
   * `where` is `__id is_any_of { field_ref: <link> }` alone or as an item of a
   * top-level `and`: the lookup ranges over the records the current record
   * links to (a `via_link` dependency, the junction), the other items filter
   * them. `null` otherwise.
   */
  private linkScope(
    where: LookupWhere,
  ): { link: SnapshotField; rest: [LookupWhere, string][] } | null {
    const isScope = (node: LookupWhere): node is LookupCondition =>
      'field' in node && node.field === RECORD_ID && node.operator === 'is_any_of';
    if (isScope(where)) return { link: this.linkOf(where, 'where'), rest: [] };
    if ('field' in where || where.op !== 'and') return null;
    const index = where.items.findIndex(isScope);
    const found = where.items[index];
    if (found === undefined || !isScope(found)) return null;
    const rest = where.items.flatMap((item, position): [LookupWhere, string][] =>
      position === index ? [] : [[item, `where.items.${String(position)}`]],
    );
    return { link: this.linkOf(found, `where.items.${String(index)}`), rest };
  }

  /** The link field of the current table a record ID condition names (to the source table). */
  private linkOf(node: LookupCondition, path: string): SnapshotField {
    const value = node.value;
    const ref = isObject(value) && 'field_ref' in value ? value.field_ref : undefined;
    const link = this.current.fields.find((candidate) => candidate.id === ref);
    if (ref === undefined || ref === RECORD_ID) {
      throw fail('INVALID_LOOKUP', 'Compare the record ID with a link field.', `${path}.value`);
    }
    if (link === undefined) {
      throw fail('UNKNOWN_FIELD', 'Unknown field of the current table.', `${path}.value`);
    }
    if (link.linkTableId !== this.source.id) {
      throw fail(
        'INVALID_LOOKUP',
        'The field is not a link to the source table.',
        `${path}.value.field_ref`,
      );
    }
    return link;
  }

  /** `__id is_any_of / is_none_of { field_ref: <link> }` inside any group. */
  private recordIdCondition(node: LookupCondition, path: string): Expr {
    if (node.operator !== 'is_any_of' && node.operator !== 'is_none_of') {
      throw fail(
        'INVALID_LOOKUP',
        `The operator ${node.operator} does not apply to the record ID.`,
        `${path}.operator`,
      );
    }
    const link = this.linkOf(node, path);
    const current: Expr = { type: 'current_value', ...AT };
    const test = exactCall('CONTAIN', [fieldRef(link), current]);
    return node.operator === 'is_any_of' ? test : complement(test);
  }

  private sourceField(id: string, path: string): SnapshotField {
    const field = this.source.fields.find((item) => item.id === id);
    if (field === undefined)
      throw fail('UNKNOWN_FIELD', 'Unknown field of the source table.', path);
    return field;
  }

  private node(node: LookupWhere, path: string): Expr {
    if ('field' in node) return this.condition(node, path);
    if (node.op === 'not') return complement(this.node(node.item, `${path}.item`));
    if (node.items.length === 0) {
      throw fail('INVALID_LOOKUP', 'A lookup condition group needs at least one condition.', path);
    }
    const terms = node.items.map((item, index) =>
      this.node(item, `${path}.items.${String(index)}`),
    );
    return node.op === 'and' ? all(terms) : any(terms);
  }

  private condition(node: LookupCondition, path: string): Expr {
    if (node.field === RECORD_ID) return this.recordIdCondition(node, path);
    const field = this.sourceField(node.field, `${path}.field`);
    const category = categoryOf(field, `${path}.field`);
    const value: Expr = {
      type: 'member',
      object: { type: 'current_value', ...AT },
      property: fieldRef(field),
      ...AT,
    };
    const { operator } = node;
    const at = `${path}.value`;
    if (operator === 'is_empty') return call('ISBLANK', [value]);
    if (operator === 'is_not_empty') return call('NOT', [call('ISBLANK', [value])]);
    const operands = (): LookupOperand[] =>
      node.value === undefined ? [] : Array.isArray(node.value) ? node.value : [node.value];
    const one = (): LookupOperand => {
      const [first, ...rest] = operands();
      if (first === undefined || rest.length > 0) {
        throw fail('INVALID_LOOKUP', `The operator ${operator} needs one value.`, at);
      }
      return first;
    };
    const operand = (item: LookupOperand) => this.operand(item, field, category, at);
    const set = (positive: boolean) => {
      const items = operands().map(operand);
      if (items.length === 0) return bool(!positive);
      const test = exactCall('CONTAIN', [value, ...items]);
      return positive ? test : complement(test);
    };
    switch (category) {
      case 'text': {
        switch (operator) {
          case 'eq':
            return binary('=', fold(value), fold(operand(one())));
          case 'neq':
            return complement(binary('=', fold(value), fold(operand(one()))));
          case 'contains':
            return call('CONTAINTEXT', [fold(value), fold(operand(one()))]);
          case 'not_contains':
            return complement(call('CONTAINTEXT', [fold(value), fold(operand(one()))]));
          case 'starts_with':
          case 'ends_with': {
            const needle = fold(operand(one()));
            const side = operator === 'starts_with' ? 'LEFT' : 'RIGHT';
            return binary('=', call(side, [fold(value), call('LEN', [needle])]), needle);
          }
          default:
            break;
        }
        break;
      }
      case 'number': {
        const comparisons: Record<string, BinaryOperator> = {
          eq: '=',
          gt: '>',
          gte: '>=',
          lt: '<',
          lte: '<=',
        };
        const comparison = comparisons[operator];
        if (comparison !== undefined) return binary(comparison, value, operand(one()));
        if (operator === 'neq') return complement(binary('=', value, operand(one())));
        if (operator === 'between') {
          const [low, high, ...rest] = operands();
          if (low === undefined || high === undefined || rest.length > 0) {
            throw fail('INVALID_LOOKUP', 'between needs two values.', at);
          }
          return all([binary('>=', value, operand(low)), binary('<=', value, operand(high))]);
        }
        break;
      }
      case 'datetime':
        return this.dateCondition(operator, value, operands(), at);
      case 'checkbox':
        if (operator === 'is') return binary('=', value, operand(one()));
        break;
      case 'single_select':
        switch (operator) {
          case 'is':
            return binary('=', value, operand(one()));
          case 'is_not':
            return complement(binary('=', value, operand(one())));
          case 'is_any_of':
            return set(true);
          case 'is_none_of':
            return set(false);
          default:
            break;
        }
        break;
      case 'multi':
      case 'link':
        switch (operator) {
          case 'is':
          case 'has_any_of':
            return set(true);
          case 'has_none_of':
            return set(false);
          case 'has_all_of':
          case 'is_exactly': {
            const items = operands().map(operand);
            if (items.length === 0) return bool(false);
            const every = exactCall('CONTAINSALL', [value, ...items]);
            return operator === 'has_all_of'
              ? every
              : all([every, exactCall('CONTAINSONLY', [value, ...items])]);
          }
          default:
            break;
        }
        break;
    }
    if (operator === 'intersects') return set(true);
    if (operator === 'disjoint') return set(false);
    throw fail(
      'INVALID_LOOKUP',
      `The operator ${operator} does not apply to this field.`,
      `${path}.operator`,
    );
  }

  /** A constant or `field_ref` operand as an expression comparable with the source field. */
  private operand(
    item: LookupOperand,
    field: SnapshotField,
    category: Category,
    path: string,
  ): Expr {
    if (isObject(item) && 'field_ref' in item) {
      if (item.field_ref === '__id') return call('RECORD_ID', []);
      const ref = this.current.fields.find((candidate) => candidate.id === item.field_ref);
      if (ref === undefined)
        throw fail('UNKNOWN_FIELD', 'Unknown field of the current table.', path);
      return fieldRef(ref);
    }
    if (isObject(item)) {
      throw fail('INVALID_LOOKUP', 'Variables and dates are not allowed here.', path);
    }
    switch (category) {
      case 'number':
        if (typeof item === 'number' && Number.isFinite(item)) return number(item);
        break;
      case 'checkbox':
        if (typeof item === 'boolean') return bool(item);
        break;
      case 'text':
        if (typeof item === 'string') return text(item);
        break;
      case 'single_select':
      case 'multi':
        if (typeof item === 'string') {
          if (field.type !== 'select') return text(item); // user IDs
          // Formulas see select options by name (BACKLOG S4b #10).
          const options = field.options?.['options'];
          const option = Array.isArray(options)
            ? (options as unknown[]).find(
                (candidate) => isObject(candidate) && candidate['id'] === item,
              )
            : undefined;
          if (isObject(option) && typeof option['name'] === 'string') return text(option['name']);
          throw fail('INVALID_LOOKUP', 'Unknown select option.', path);
        }
        break;
      case 'link':
        // Records are matched by title in formulas; IDs only through field_ref/__id.
        throw fail(
          'INVALID_LOOKUP',
          'Compare a link field with a field of the current record.',
          path,
        );
      default:
        break;
    }
    throw fail('INVALID_LOOKUP', 'The value does not fit the field.', path);
  }

  private dateCondition(
    operator: string,
    value: Expr,
    operands: LookupOperand[],
    path: string,
  ): Expr {
    const ranges = operands.map((item) => this.range(item, path));
    const [first, second] = ranges;
    const isIn = (range: Range) =>
      all([binary('>=', value, range.start), binary('<', value, range.end)]);
    if (operator === 'between') {
      if (first === undefined || second === undefined || ranges.length !== 2) {
        throw fail('INVALID_LOOKUP', 'between needs two dates.', path);
      }
      return all([binary('>=', value, first.start), binary('<', value, second.end)]);
    }
    if (operator === 'intersects' || operator === 'disjoint') {
      const test = ranges.length === 0 ? bool(false) : any(ranges.map(isIn));
      return operator === 'intersects' ? test : complement(test);
    }
    if (first === undefined || ranges.length !== 1) {
      throw fail('INVALID_LOOKUP', `The operator ${operator} needs one date.`, path);
    }
    switch (operator) {
      case 'is':
        return isIn(first);
      case 'before':
        return binary('<', value, first.start);
      case 'after':
        return binary('>=', value, first.end);
      case 'on_or_before':
        return binary('<', value, first.end);
      case 'on_or_after':
        return binary('>=', value, first.start);
      default:
        throw fail('INVALID_LOOKUP', `The operator ${operator} does not apply to dates.`, path);
    }
  }

  /**
   * A date operand as a half-open range `[start, end)` (Filter DSL, SPEC
   * §6.1): a day, a minute (exact time), or a relative period ending with
   * the week starting Monday. Relative ranges use TODAY(): the lookup is
   * then `virtual`.
   */
  private range(item: LookupOperand, path: string): Range {
    const today = call('TODAY', []);
    const days = (offset: number): Expr =>
      offset === 0
        ? today
        : binary(offset > 0 ? '+' : '-', call('TODAY', []), number(Math.abs(offset)));
    const day = (start: Expr): Range => ({ start, end: binary('+', start, number(1)) });
    if (isObject(item) && 'field_ref' in item) {
      // A date field of the current record is that day; a date and time is that instant.
      const ref = this.current.fields.find((candidate) => candidate.id === item.field_ref);
      if (ref === undefined)
        throw fail('UNKNOWN_FIELD', 'Unknown field of the current table.', path);
      const kind = fieldValueType(ref).kind;
      if (kind === 'date') return day(fieldRef(ref));
      if (kind === 'datetime') return { start: fieldRef(ref), end: fieldRef(ref) };
      throw fail('INVALID_LOOKUP', 'Compare a date with a date field.', path);
    }
    if (isObject(item) && '$var' in item) {
      if (item.$var === 'today') return day(today);
      if (item.$var === 'now') return { start: call('NOW', []), end: call('NOW', []) };
      throw fail(
        'INVALID_LOOKUP',
        'Only today and now can be used in a lookup date condition.',
        path,
      );
    }
    if (!isObject(item) || !('$date' in item)) {
      throw fail('INVALID_LOOKUP', 'Expected a date value.', path);
    }
    const spec = item.$date;
    if ('exact' in spec) {
      const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(spec.exact);
      if (match === null)
        throw fail('INVALID_LOOKUP', 'Expected YYYY-MM-DD or YYYY-MM-DDTHH:mm.', path);
      const [, year, month, dayOfMonth, hour, minute] = match;
      if (hour === undefined || minute === undefined) {
        return day(
          call(
            'DATE',
            [year, month, dayOfMonth].map((part) => number(Number(part))),
          ),
        );
      }
      const start = call('TODATE', [
        text(`${year ?? ''}-${month ?? ''}-${dayOfMonth ?? ''} ${hour}:${minute}`),
      ]);
      return {
        start,
        end: binary('+', start, call('DURATION', [number(0), number(0), number(1)])),
      };
    }
    const amount = spec.amount ?? 0;
    switch (spec.relative) {
      case 'today':
        return day(days(0));
      case 'tomorrow':
        return day(days(1));
      case 'yesterday':
        return day(days(-1));
      case 'days_ago':
        return day(days(-amount));
      case 'days_from_now':
        return day(days(amount));
      case 'this_week': {
        const monday = binary(
          '-',
          call('TODAY', []),
          binary('-', call('WEEKDAY', [call('TODAY', []), number(2)]), number(1)),
        );
        return { start: monday, end: binary('+', monday, number(7)) };
      }
      case 'this_month':
      case 'last_month': {
        const back = spec.relative === 'this_month' ? 0 : 1;
        const monthEnd = (offset: number) =>
          binary('+', call('EOMONTH', [call('TODAY', []), number(offset)]), number(1));
        return { start: monthEnd(-1 - back), end: monthEnd(-back) };
      }
      case 'this_year': {
        const year = (offset: number): Expr =>
          call('DATE', [
            offset === 0
              ? call('YEAR', [call('TODAY', [])])
              : binary('+', call('YEAR', [call('TODAY', [])]), number(offset)),
            number(1),
            number(1),
          ]);
        return { start: year(0), end: year(1) };
      }
      default:
        throw fail('INVALID_LOOKUP', 'Unknown relative date.', path);
    }
  }
}

/**
 * The formula equivalent of a lookup field (SPEC §5.8, T452):
 * `[from].FILTER(<where>).[select]` (flattened with LISTCOMBINE for a
 * multi-value field) followed by the aggregation — so lookups and formulas
 * share one typecheck, dependency analysis and compiler. `where` follows
 * the Filter DSL semantics: text compares case- and accent-insensitively,
 * complements (`neq`, `is_none_of`, `disjoint`…) match empty cells, dates
 * are half-open ranges, `field_ref` compares with the current record
 * (`__id` → `RECORD_ID()`). The AST is resolved (IDs and names): pass it to
 * `analyzeAst`. Throws `FormulaError` (`UNKNOWN_TABLE`, `UNKNOWN_FIELD`,
 * `INVALID_LOOKUP`) with `params.path` naming the lookup option at fault.
 */
export function lookupToAst(options: LookupOptions, snapshot: SchemaSnapshot): Expr {
  return new LookupBuilder(snapshot, options).build();
}

/**
 * `LOOKUP(value, [T].[M], [T].[R], mode)` as the FILTER it abbreviates
 * (BACKLOG S4b #6): `[T].FILTER(CurrentValue.[M] = value).[R]`, or
 * `CONTAIN(CurrentValue.[M], value)` for a multi-value `M` in mode 1.
 * Spans are the call's. Returns `null` for a malformed call (typecheck
 * reports it).
 */
export function desugarLookup(node: Call, snapshot: SchemaSnapshot): Expr | null {
  const parts = lookupParts(node.args);
  const [value, match, result] = node.args;
  if (
    parts === null ||
    value === undefined ||
    match?.type !== 'member' ||
    result?.type !== 'member'
  ) {
    return null;
  }
  const span = { start: node.start, length: node.length };
  const table = snapshot.tables.find((item) => item.id === parts.tableId);
  const field = table?.fields.find((item) => item.id === parts.matchFieldId);
  const multi = field !== undefined && fieldValueType(field).kind === 'list';
  const current: Member = {
    type: 'member',
    object: { type: 'current_value', ...span },
    property: match.property,
    ...span,
  };
  const condition: Expr =
    multi && parts.mode === 1
      ? { type: 'call', name: 'CONTAIN', args: [current, value], chained: false, ...span }
      : { type: 'binary', operator: '=', left: current, right: value, ...span };
  const filtered: Call = {
    type: 'call',
    name: 'FILTER',
    args: [match.object, condition],
    chained: true,
    ...span,
  };
  return { type: 'member', object: filtered, property: result.property, ...span };
}
