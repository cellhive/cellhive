import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { civilFromDays } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { day } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** MONTH (SPEC §9.3, date). */
export const MONTH = define({
  name: 'MONTH',
  group: 'date',
  signatures: [sig('number', [p('date', 'date')])],
  result: fixed(T.number),
  description: { en: 'Month of a date (1–12).', vi: 'Tháng của một ngày (1–12).' },
  examples: [ex('MONTH(DATE(2000, 12, 1))', '12')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = day(args, 0);
  return value === null ? null : Dec.int(civilFromDays(value).month);
};
