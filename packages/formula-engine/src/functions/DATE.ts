import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { makeDate } from '../evaluate/dates.js';
import { int } from '../evaluate/helpers.js';
import { date } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** DATE (SPEC §9.3, date). */
export const DATE = define({
  name: 'DATE',
  group: 'date',
  signatures: [sig('date', [p('year', 'number'), p('month', 'number'), p('day', 'number')])],
  result: fixed(T.date),
  description: { en: 'A date from a year, month and day.', vi: 'Tạo ngày từ năm, tháng, ngày.' },
  examples: [ex('DATE(2000, 1, 1)', '2000/01/01')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const year = int(args, 0);
  const month = int(args, 1);
  const day = int(args, 2);
  if (year === null || month === null || day === null) return null;
  const result = makeDate(year, month, day);
  return result === null ? null : date(result);
};
