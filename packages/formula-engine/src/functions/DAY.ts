import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { civilFromDays } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { day } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** DAY (SPEC §9.3, date). */
export const DAY = define({
  name: 'DAY',
  group: 'date',
  signatures: [sig('number', [p('date', 'date')])],
  result: fixed(T.number),
  description: { en: 'Day of the month of a date (1–31).', vi: 'Ngày trong tháng (1–31).' },
  examples: [ex('DAY(DATE(2000, 1, 3))', '3')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = day(args, 0);
  return value === null ? null : Dec.int(civilFromDays(value).day);
};
