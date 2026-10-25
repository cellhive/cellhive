import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { numbers, sum } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** AVERAGE (SPEC §9.3, number). */
export const AVERAGE = define({
  name: 'AVERAGE',
  group: 'number',
  signatures: [sig('number', [p('number', 'numbers')], 1)],
  result: fixed(T.number),
  styleFrom: 'all',
  description: {
    en: 'Average of numbers and lists of numbers (empty values are skipped).',
    vi: 'Trung bình cộng của các số và danh sách số (bỏ qua giá trị rỗng).',
  },
  examples: [ex('AVERAGE(2, 100)', '51')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const values = numbers(args);
  return values.length === 0 ? null : sum(values).div(Dec.int(values.length));
};
