import { define, p, sig, ex, numbersOrDates } from '../catalogue/define.js';
import { extreme } from '../evaluate/helpers.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** MIN (SPEC §9.3, number). */
export const MIN = define({
  name: 'MIN',
  group: 'number',
  signatures: [sig('number | date', [p('value', 'values')], 1)],
  result: numbersOrDates,
  styleFrom: 'all',
  description: {
    en: 'Smallest of numbers (or dates) and lists of them.',
    vi: 'Giá trị nhỏ nhất trong các số (hoặc ngày) và danh sách của chúng.',
  },
  examples: [ex('MIN(2, 100)', '2')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => extreme(args, -1);
