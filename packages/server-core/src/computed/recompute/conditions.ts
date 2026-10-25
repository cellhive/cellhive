import type { Call, Expr, Member, Reference } from '@cellhive/formula-engine';

/**
 * Which records of a table a computed field selects, for the incremental
 * recompute of `cross_table` dependencies (SPEC §5.9, BACKLOG T458): the
 * conditions of every FILTER/COUNTIF/SUMIF over `[Table]` and every LOOKUP
 * on it in the field's (analysed) formula. A record of the table matters to
 * a formula row when one of the conditions holds for them.
 */

/** Functions iterating over a table with a condition as second argument. */
const CONDITION_CALLS: ReadonlySet<string> = new Set(['FILTER', 'COUNTIF', 'SUMIF']);
const CONTAIN_CALLS: ReadonlySet<string> = new Set(['CONTAIN', 'CONTAINSALL']);

const AT = { start: 0, length: 0 } as const;

export interface TableCondition {
  /** A boolean over `CurrentValue` (a record of the table) and the formula row. */
  readonly condition: Expr;
  /**
   * Link fields `L` of the table with a top-level conjunct
   * `CONTAIN(CurrentValue.[L], RECORD_ID())` (or `CONTAINSALL`, or
   * `CurrentValue.[L] = RECORD_ID()`): the condition can only hold for
   * formula rows `L` links the record to — the rows are found through the
   * junction (a lookup through a link, SPEC §5.8).
   */
  readonly linkKeys: readonly string[];
}

const isTableRef = (node: Expr | undefined, tableId: string): node is Reference =>
  node?.type === 'reference' && node.kind === 'table' && node.id === tableId;

const isRecordId = (node: Expr | undefined): boolean =>
  node?.type === 'call' && node.name === 'RECORD_ID' && node.args.length === 0;

/** `CurrentValue.[Field]` → the field id. */
function currentField(node: Expr | undefined): string | null {
  if (node?.type !== 'member' || node.object.type !== 'current_value') return null;
  return node.property.id;
}

function conjuncts(node: Expr): Expr[] {
  if (node.type === 'binary' && node.operator === '&&') {
    return [...conjuncts(node.left), ...conjuncts(node.right)];
  }
  if (node.type === 'call' && node.name === 'AND') return node.args.flatMap(conjuncts);
  return [node];
}

/** Link-key conjuncts of a condition (see {@link TableCondition.linkKeys}). */
export function linkKeysOf(condition: Expr): string[] {
  const keys = new Set<string>();
  for (const term of conjuncts(condition)) {
    if (term.type === 'call' && CONTAIN_CALLS.has(term.name) && term.args.length === 2) {
      const field = currentField(term.args[0]);
      if (field !== null && isRecordId(term.args[1])) keys.add(field);
    } else if (term.type === 'binary' && term.operator === '=') {
      const field = currentField(term.left) ?? currentField(term.right);
      const other = currentField(term.left) === null ? term.left : term.right;
      if (field !== null && isRecordId(other)) keys.add(field);
    }
  }
  return [...keys].sort();
}

/** `[Table].[Field]` → its table and field ids (arguments 2 and 3 of LOOKUP). */
function tableField(node: Expr | undefined): { tableId: string; fieldId: string } | null {
  if (node?.type !== 'member' || node.object.type !== 'reference') return null;
  const { object, property } = node;
  if (object.kind !== 'table' || object.id === null || property.id === null) return null;
  return { tableId: object.id, fieldId: property.id };
}

/**
 * The condition of `LOOKUP(value, [T].[M], [T].[R], mode)`, which reads as
 * `[T].FILTER(CurrentValue.[M] = value)` — `CONTAIN(CurrentValue.[M],
 * value)` when `M` holds several values and the mode is 1 (SPEC §9.3).
 */
function lookupCondition(call: Call, multiValue: (fieldId: string) => boolean): Expr | null {
  const match = tableField(call.args[1]);
  const value = call.args[0];
  if (match === null || value === undefined) return null;
  const modeNode = call.args[3];
  const mode =
    modeNode === undefined ? 1 : modeNode.type === 'number' ? Number(modeNode.value) : NaN;
  if (mode !== 0 && mode !== 1) return null;
  const property: Reference = {
    type: 'reference',
    name: null,
    id: match.fieldId,
    kind: 'field',
    ...AT,
  };
  const record: Member = {
    type: 'member',
    object: { type: 'current_value', ...AT },
    property,
    ...AT,
  };
  if (mode === 1 && multiValue(match.fieldId)) {
    return { type: 'call', name: 'CONTAIN', args: [record, value], chained: false, ...AT };
  }
  return { type: 'binary', operator: '=', left: record, right: value, ...AT };
}

/**
 * The conditions under which a formula reads records of `tableId`, or
 * `null` when it reads them some other way too (the whole table, a `LET`
 * variable, MAP/SORTBY over it…): then any change of those records may
 * touch every formula row. `multiValue` tells whether a field of the table
 * holds several values (LOOKUP mode 1).
 */
export function conditionsOver(
  ast: Expr,
  tableId: string,
  multiValue: (fieldId: string) => boolean,
): TableCondition[] | null {
  const found: Expr[] = [];
  const walk = (node: Expr): boolean => {
    switch (node.type) {
      case 'reference':
        return !(node.kind === 'table' && node.id === tableId);
      case 'member':
        return walk(node.object);
      case 'unary':
        return walk(node.operand);
      case 'binary':
        return walk(node.left) && walk(node.right);
      case 'let':
        return node.bindings.every((binding) => walk(binding.value)) && walk(node.body);
      case 'call': {
        const [first, second, ...rest] = node.args;
        if (CONDITION_CALLS.has(node.name) && isTableRef(first, tableId)) {
          if (second === undefined) return false;
          found.push(second);
          return walk(second) && rest.every(walk);
        }
        if (node.name === 'LOOKUP' && tableField(second)?.tableId === tableId) {
          if (tableField(node.args[2])?.tableId !== tableId) return false;
          const condition = lookupCondition(node, multiValue);
          if (condition === null) return false;
          found.push(condition);
          const value = node.args[0];
          const mode = node.args[3];
          return (value === undefined || walk(value)) && (mode === undefined || walk(mode));
        }
        return node.args.every(walk);
      }
      default:
        return true;
    }
  };
  if (!walk(ast)) return null;
  return found.map((condition) => ({ condition, linkKeys: linkKeysOf(condition) }));
}

/** One boolean expression true when any of `conditions` holds (`a || b || …`). */
export function anyOf(conditions: readonly Expr[]): Expr | null {
  if (conditions.length === 0) return null;
  return conditions.reduce((left, right) => ({
    type: 'binary',
    operator: '||',
    left,
    right,
    ...AT,
  }));
}

/** `COUNTIF([Table], condition)`: how many records of the table the condition selects. */
export function countOver(tableId: string, condition: Expr): Expr {
  return {
    type: 'call',
    name: 'COUNTIF',
    chained: false,
    args: [{ type: 'reference', name: null, id: tableId, kind: 'table', ...AT }, condition],
    ...AT,
  };
}

/** Table ids read as `[Table]` anywhere in the formula. */
export function tableReferences(ast: Expr): Set<string> {
  const out = new Set<string>();
  const walk = (node: Expr): void => {
    switch (node.type) {
      case 'reference':
        if (node.kind === 'table' && node.id !== null) out.add(node.id);
        return;
      case 'member':
        walk(node.object);
        return;
      case 'unary':
        walk(node.operand);
        return;
      case 'binary':
        walk(node.left);
        walk(node.right);
        return;
      case 'let':
        for (const binding of node.bindings) walk(binding.value);
        walk(node.body);
        return;
      case 'call':
        for (const arg of node.args) walk(arg);
        return;
      default:
        return;
    }
  };
  walk(ast);
  return out;
}
