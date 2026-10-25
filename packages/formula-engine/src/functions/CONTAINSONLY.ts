import { define, p, sig, exl, checkMembers } from '../catalogue/define.js';
import { combine, foldsCase } from '../evaluate/helpers.js';
import { elements } from '../evaluate/values.js';
import { elementOf, T, type FormulaType } from '../types/formula-type.js';

import type { CallContext } from '../catalogue/types.js';
import type { FunctionImpl } from '../evaluate/runtime.js';

function members(ctx: CallContext): FormulaType {
  checkMembers(ctx, 1);
  return T.boolean;
}

/** CONTAINSONLY (SPEC §9.3, logic). */
export const CONTAINSONLY = define({
  name: 'CONTAINSONLY',
  group: 'logic',
  signatures: [sig('boolean', [p('range', 'values'), p('value', 'values')], 1)],
  result: members,
  description: {
    en: 'True when the range holds nothing but the given values (texts ignoring case, as CONTAIN). An empty range is FALSE.',
    vi: 'Đúng khi phạm vi chỉ chứa các giá trị đã cho (chuỗi không phân biệt hoa thường, như CONTAIN). Phạm vi rỗng là FALSE.',
  },
  examples: [
    exl('CONTAINSONLY([Answers], "A", "B", "C")', 'CONTAINSONLY([Đáp án], "A", "B", "C")', 'TRUE'),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  // SQL: cardinality(range) > 0 AND values @> range.
  const range = rangeOf(args);
  const allowed = combine(args, 1);
  const rangeType = elementOf(args.type(0));
  const type = elementOf(args.type(1));
  const fold = foldsCase(args);
  return (
    range.length > 0 && range.every((item) => args.rt.member(item, allowed, rangeType, type, fold))
  );
};

/** The range as an array: a list's elements, or the value itself (even empty). */
function rangeOf(args: Parameters<FunctionImpl>[0]) {
  const value = args.value(0);
  if (Array.isArray(value) || args.type(0).kind === 'list') return elements(value);
  return [value];
}
