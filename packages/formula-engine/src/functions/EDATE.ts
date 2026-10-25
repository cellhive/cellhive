import { define, p, sig, ex, argType } from '../catalogue/define.js';
import { addMonths, addMonthsToInstant, parseTodate } from '../evaluate/dates.js';
import { int } from '../evaluate/helpers.js';
import { date, datetime, isDate, isDateTime } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** EDATE (SPEC §9.3, date). */
export const EDATE = define({
  name: 'EDATE',
  group: 'date',
  signatures: [sig('date', [p('start_date', 'date'), p('months', 'number')])],
  // The argument's type (datetime keeps its wall-clock time); text at the
  // date parameter (M4) is read with the TODATE rule, so a datetime result.
  result: (ctx) => {
    const type = argType(0)(ctx);
    return type.kind === 'text' ? T.datetime : type;
  },
  styleFrom: [0],
  description: {
    en: 'The same day a number of months before (negative) or after the start date, clamped to the end of the month.',
    vi: 'Cùng ngày sau (hoặc trước, khi âm) một số tháng so với ngày bắt đầu, lùi về cuối tháng nếu tháng đó ngắn hơn.',
  },
  examples: [ex('EDATE(DATE(2011, 1, 31), 1)', '2011/02/28')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const start = args.value(0);
  const months = int(args, 1);
  if (months === null) return null;
  // Text at a date parameter (M4): the TODATE rule, read in the formula zone.
  if (typeof start === 'string') {
    const instant = parseTodate(start, args.rt.timeZone);
    if (instant === null) return null;
    const moved = addMonthsToInstant(instant, months, args.rt.timeZone);
    return moved === null ? null : datetime(moved);
  }
  if (isDateTime(start)) {
    // A datetime keeps its wall-clock time (in its zone).
    const result = addMonthsToInstant(start.ms, months, start.zone ?? args.rt.timeZone);
    return result === null ? null : datetime(result);
  }
  if (!isDate(start)) return null;
  const result = addMonths(start.day, months);
  return result === null ? null : date(result);
};
