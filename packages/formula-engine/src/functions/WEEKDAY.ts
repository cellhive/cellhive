import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { weekday } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { day, optInt } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** WEEKDAY (SPEC §9.3, date). */
export const WEEKDAY = define({
  name: 'WEEKDAY',
  group: 'date',
  signatures: [sig('number', [p('date', 'date'), p('type', 'number', true)])],
  result: fixed(T.number),
  description: {
    en: 'Day of the week as a number: with type 1 (default) Sunday is 1, with type 2 Monday is 1.',
    vi: 'Thứ trong tuần dạng số: type 1 (mặc định) Chủ nhật là 1, type 2 thứ Hai là 1.',
  },
  examples: [ex('WEEKDAY(DATE(2000, 1, 1))', '7')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = day(args, 0);
  const type = optInt(args, 1, 1);
  if (value === null || type === null) return null;
  const result = weekday(value, type);
  return result === null ? null : Dec.int(result);
};
