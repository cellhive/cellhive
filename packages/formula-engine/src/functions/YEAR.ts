import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { civilFromDays } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { day } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** YEAR (SPEC §9.3, date). */
export const YEAR = define({
  name: 'YEAR',
  group: 'date',
  signatures: [sig('number', [p('date', 'date')])],
  result: fixed(T.number),
  description: { en: 'Year of a date.', vi: 'Năm của một ngày.' },
  examples: [ex('YEAR(DATE(2000, 1, 1))', '2000')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = day(args, 0);
  return value === null ? null : Dec.int(civilFromDays(value).year);
};
