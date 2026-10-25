import { define, p, sig, ex, exl, numbersOrDates } from '../catalogue/define.js';
import { extreme } from '../evaluate/helpers.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** MAX (SPEC §9.3, number). */
export const MAX = define({
  name: 'MAX',
  group: 'number',
  signatures: [sig('number | date', [p('value', 'values')], 1)],
  result: numbersOrDates,
  styleFrom: 'all',
  description: {
    en: 'Largest of numbers (or dates) and lists of them.',
    vi: 'Giá trị lớn nhất trong các số (hoặc ngày) và danh sách của chúng.',
  },
  examples: [
    ex('MAX(2, 100)', '100'),
    exl('[Orders].[Order date].MAX()', '[Đơn hàng].[Ngày đặt].MAX()', '2026-09-28'),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => extreme(args, 1);
