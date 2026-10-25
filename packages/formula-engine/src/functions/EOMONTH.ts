import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { endOfMonth } from '../evaluate/dates.js';
import { day, int } from '../evaluate/helpers.js';
import { date } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** EOMONTH (SPEC §9.3, date). */
export const EOMONTH = define({
  name: 'EOMONTH',
  group: 'date',
  signatures: [sig('date', [p('start_date', 'date'), p('months', 'number')])],
  result: fixed(T.date),
  description: {
    en: 'Last day of the month a number of months before or after the start date.',
    vi: 'Ngày cuối tháng cách ngày bắt đầu một số tháng (trước hoặc sau).',
  },
  examples: [ex('EOMONTH(DATE(2000, 1, 1), 1)', '2000/02/29')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const start = day(args, 0);
  const months = int(args, 1);
  if (start === null || months === null) return null;
  const result = endOfMonth(start, months);
  return result === null ? null : date(result);
};
