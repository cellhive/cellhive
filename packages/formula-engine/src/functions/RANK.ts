import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { num, numbersOf, optBool } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** RANK (SPEC §9.3, number). */
export const RANK = define({
  name: 'RANK',
  group: 'number',
  signatures: [
    sig('number', [
      p('value', 'number'),
      p('list', 'number_list'),
      p('ascending', 'boolean', true),
    ]),
  ],
  result: fixed(T.number),
  description: {
    en: 'Rank of a value in a list of numbers: 1 for the largest (the smallest when ascending is TRUE); -1 when the value is not in the list.',
    vi: 'Thứ hạng của giá trị trong danh sách số: 1 là lớn nhất (nhỏ nhất khi ascending là TRUE); -1 nếu giá trị không có trong danh sách.',
  },
  examples: [ex('RANK(3, LIST(4, 3, 2, 1), TRUE)', '3'), ex('RANK(3, LIST(4, 3, 2, 1))', '2')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = num(args, 0);
  if (value === null) return null;
  const list = numbersOf(args.value(1));
  const ascending = optBool(args, 2, false);
  if (!list.some((item) => item.eq(value))) return Dec.int(-1);
  const before = list.filter((item) => (ascending ? item.cmp(value) < 0 : item.cmp(value) > 0));
  return Dec.int(before.length + 1);
};
