import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { day } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** DAYS (SPEC §9.3, date). */
export const DAYS = define({
  name: 'DAYS',
  group: 'date',
  signatures: [sig('number', [p('end_date', 'date'), p('start_date', 'date')])],
  result: fixed(T.number),
  description: {
    en: 'Number of days from the start date to the end date.',
    vi: 'Số ngày từ ngày bắt đầu tới ngày kết thúc.',
  },
  examples: [ex('DAYS(DATE(2000, 1, 8), DATE(2000, 1, 1))', '7')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const end = day(args, 0);
  const start = day(args, 1);
  return end === null || start === null ? null : Dec.int(end - start);
};
