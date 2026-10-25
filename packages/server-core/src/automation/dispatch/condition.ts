import {
  foldFilter,
  isAutomationOnlyOperator,
  isFilterCondition,
  type FilterCondition,
  type FilterNode,
  type FilterValue,
  type FoldedFilter,
} from '@cellhive/filter-dsl';

/**
 * An automation condition (SPEC §11.3) with its `changed`, `changed_to`
 * and `changed_from` conditions already decided from the event: either a
 * constant, or a Filter DSL tree without automation-only operators that the
 * record query (as `run_as`) can test on the latest record.
 */
export type FoldedCondition = FoldedFilter<FilterValue>;

/** The `changed*` conditions of a validated condition, depth first. */
export function changeConditionsOf(node: FilterNode): FilterCondition[] {
  if (isFilterCondition(node)) return isAutomationOnlyOperator(node.operator) ? [node] : [];
  if (node.op === 'not') return changeConditionsOf(node.item);
  return node.items.flatMap(changeConditionsOf);
}

/**
 * Replaces every `changed*` condition of `node` by `decide(condition)` and
 * simplifies (`foldFilter`): `and` with a false item is false, `or` with a
 * true item is true, constant items are dropped otherwise, `not` of a
 * constant is the other constant. What remains has only standard operators.
 */
export function foldChangeConditions(
  node: FilterNode,
  decide: (condition: FilterCondition) => boolean,
): FoldedCondition {
  return foldFilter(node, (condition) =>
    isAutomationOnlyOperator(condition.operator) ? decide(condition) : undefined,
  );
}
