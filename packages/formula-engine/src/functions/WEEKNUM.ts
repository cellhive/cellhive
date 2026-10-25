import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { weeknum } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { day, optInt } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** WEEKNUM (SPEC §9.3, date). */
export const WEEKNUM = define({
  name: 'WEEKNUM',
  group: 'date',
  signatures: [sig('number', [p('date', 'date'), p('type', 'number', true)])],
  result: fixed(T.number),
  description: {
    en: 'Week number of the year: with type 1 (default) weeks start on Sunday, with type 2 on Monday.',
    vi: 'Số thứ tự tuần trong năm: type 1 (mặc định) tuần bắt đầu Chủ nhật, type 2 bắt đầu thứ Hai.',
  },
  examples: [ex('WEEKNUM(DATE(2000, 1, 1))', '1')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = day(args, 0);
  const type = optInt(args, 1, 1);
  if (value === null || type === null) return null;
  const result = weeknum(value, type);
  return result === null ? null : Dec.int(result);
};
