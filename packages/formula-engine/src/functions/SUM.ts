import { define, p, sig, ex, exl, fixed } from '../catalogue/define.js';
import { numbers, sum } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** SUM (SPEC §9.3, number). */
export const SUM = define({
  name: 'SUM',
  group: 'number',
  signatures: [sig('number', [p('number', 'numbers')], 1)],
  result: fixed(T.number),
  styleFrom: 'all',
  description: { en: 'Adds numbers and lists of numbers.', vi: 'Cộng các số và danh sách số.' },
  examples: [
    ex('SUM(1, 2, 3)', '6'),
    exl('[Orders].[Amount].SUM()', '[Đơn hàng].[Số tiền].SUM()', '1500000'),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => sum(numbers(args));
