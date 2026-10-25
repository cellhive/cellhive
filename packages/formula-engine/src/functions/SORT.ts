import { define, p, sig, ex } from '../catalogue/define.js';
import { optBool, sortBy } from '../evaluate/helpers.js';
import { elements } from '../evaluate/values.js';
import { T, formatType, elementOf, isOrderable, type FormulaType } from '../types/formula-type.js';

import type { CallContext } from '../catalogue/types.js';
import type { FunctionImpl } from '../evaluate/runtime.js';

function sortResult(ctx: CallContext): FormulaType {
  const list = ctx.args[0]?.type ?? T.any;
  const element = elementOf(list);
  if (!isOrderable(element)) {
    return ctx.fail(0, 'TYPE_MISMATCH', `Cannot sort ${formatType(element)} values.`, {
      expected: 'list<number | text | date>',
      actual: formatType(list),
    });
  }
  return list;
}

/** SORT (SPEC §9.3, list). */
export const SORT = define({
  name: 'SORT',
  group: 'list',
  signatures: [sig('list<T>', [p('list', 'list'), p('ascending', 'boolean', true)])],
  result: sortResult,
  styleFrom: [0],
  description: {
    en: 'Sorts a list of numbers, texts or dates, ascending unless the second argument is FALSE.',
    vi: 'Sắp xếp danh sách số, chuỗi hoặc ngày, tăng dần trừ khi đối số thứ hai là FALSE.',
  },
  examples: [ex('SORT(LIST(5, 2, 3, 1, 4), FALSE)', '5, 4, 3, 2, 1')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) =>
  sortBy(elements(args.value(0)), (item) => item, optBool(args, 1, true), args.rt);
