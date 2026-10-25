import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { numbers, sorted } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** MEDIAN (SPEC §9.3, number). */
export const MEDIAN = define({
  name: 'MEDIAN',
  group: 'number',
  signatures: [sig('number', [p('number', 'numbers')], 1)],
  result: fixed(T.number),
  styleFrom: 'all',
  description: {
    en: 'Middle value of numbers and lists of numbers.',
    vi: 'Giá trị trung vị của các số và danh sách số.',
  },
  examples: [ex('MEDIAN(1, 2, 3, 4)', '2.5'), ex('MEDIAN(LIST(1, 2, 3, 4), 5)', '3')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const values = sorted(numbers(args));
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  const upper = values[middle] as Dec;
  if (values.length % 2 === 1) return upper;
  return (values[middle - 1] as Dec).add(upper).div(Dec.int(2));
};
