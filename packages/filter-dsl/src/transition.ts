import {
  isFilterCondition,
  type FilterConditionOf,
  type FilterNode,
  type FilterNodeOf,
  type FilterValue,
} from './ast.js';
import {
  evaluate,
  FilterEvaluationError,
  type EvaluateRecord,
  type EvaluateContext,
} from './evaluate.js';
import { resolveVariables, type ResolveContext } from './resolve.js';

/**
 * A filter with some conditions already decided: either a constant, or the
 * conditions left undecided (groups simplified around the decided ones).
 */
export type FoldedFilter<V> =
  | { readonly kind: 'constant'; readonly value: boolean }
  | { readonly kind: 'filter'; readonly filter: FilterNodeOf<V> };

const TRUE = { kind: 'constant', value: true } as const;
const FALSE = { kind: 'constant', value: false } as const;

/**
 * Replaces each condition `decide` answers (`true`/`false`; `undefined`
 * leaves it) by that constant and simplifies: `and` with a false item is
 * false, `or` with a true item is true, other constant items are dropped,
 * an empty `and` is true and an empty `or` false, `not` of a constant is
 * the other constant, a group left with one item is that item.
 */
export function foldFilter<V>(
  node: FilterNodeOf<V>,
  decide: (condition: FilterConditionOf<V>) => boolean | undefined,
): FoldedFilter<V> {
  if (isFilterCondition(node)) {
    const decided = decide(node);
    if (decided === undefined) return { kind: 'filter', filter: node };
    return decided ? TRUE : FALSE;
  }
  if (node.op === 'not') {
    const inner = foldFilter(node.item, decide);
    if (inner.kind === 'constant') return inner.value ? FALSE : TRUE;
    return { kind: 'filter', filter: { op: 'not', item: inner.filter } };
  }
  const absorbing = node.op === 'or';
  const kept: FilterNodeOf<V>[] = [];
  for (const item of node.items) {
    const folded = foldFilter(item, decide);
    if (folded.kind === 'constant') {
      // `false` decides an `and`, `true` decides an `or`; the other value is neutral.
      if (folded.value === absorbing) return folded;
      continue;
    }
    kept.push(folded.filter);
  }
  if (kept.length === 0) return absorbing ? FALSE : TRUE;
  const [only] = kept;
  if (kept.length === 1 && only !== undefined) return { kind: 'filter', filter: only };
  return { kind: 'filter', filter: { op: node.op, items: kept } };
}

/** The two sides of one record change, in storage form (see {@link EvaluateRecord}). */
export interface TransitionImages {
  /** Values of the changed fields before the change; `null`: the record did not exist. */
  readonly before: EvaluateRecord | null;
  /** Values of the changed fields after the change (a missing key is an empty cell). */
  readonly after: EvaluateRecord;
  /** The fields the change is known to cover; any other field kept its value. */
  readonly changed: Iterable<string>;
}

export interface TransitionContext {
  /** Fields of the table the filter was validated against. */
  readonly table: EvaluateContext['table'];
  /** How `$var`/`$date` operands resolve (the reader, the time of the change). */
  readonly resolve: ResolveContext;
}

export interface FoldedTransition<V> {
  /** The filter on the record before the change (a constant `false` when it did not exist). */
  readonly before: FoldedFilter<V>;
  /** The filter on the record after the change. */
  readonly after: FoldedFilter<V>;
}

/**
 * A filter on both sides of a change (BACKLOG T510, `record.matches`):
 * conditions on a changed field are evaluated in memory on the before and
 * after images; conditions on other fields are left in both folded
 * filters, since those fields have the same value on both sides (a caller
 * tests what is left on the current record). A condition on a field the
 * table does not know any more is false.
 */
export function foldTransition(
  filter: FilterNode,
  images: TransitionImages,
  context: TransitionContext,
): FoldedTransition<FilterValue> {
  const changed = new Set(images.changed);
  const evaluateContext: EvaluateContext = { table: context.table };
  const side = (record: EvaluateRecord) =>
    foldFilter(filter, (condition) => {
      if (!changed.has(condition.field)) return undefined;
      try {
        return evaluate(resolveVariables(condition, context.resolve), record, evaluateContext);
      } catch (error) {
        if (error instanceof FilterEvaluationError) return false;
        throw error;
      }
    });
  return {
    before: images.before === null ? FALSE : side(images.before),
    after: side(images.after),
  };
}
