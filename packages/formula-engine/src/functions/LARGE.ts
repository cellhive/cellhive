import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { int, numbersOf, sorted } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** LARGE (SPEC §9.3, number). */
export const LARGE = define({
  name: 'LARGE',
  group: 'number',
  signatures: [sig('number', [p('list', 'number_list'), p('k', 'number')])],
  result: fixed(T.number),
  styleFrom: [0],
  description: {
    en: 'The k-th largest number of a list (1 is the largest); empty when k is out of range.',
    vi: 'Số lớn thứ k trong danh sách (1 là lớn nhất); rỗng khi k ngoài phạm vi.',
  },
  examples: [ex('LARGE(LIST(1, 2, 3), 2)', '2')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const values = sorted(numbersOf(args.value(0)));
  const k = int(args, 1);
  if (k === null || k < 1 || k > values.length) return null;
  return values[values.length - k] ?? null;
};
