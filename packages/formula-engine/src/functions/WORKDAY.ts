import { define, p, sig, ex, exl, fixed } from '../catalogue/define.js';
import { MAX_WORKDAYS, workday } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { day, holidays, num } from '../evaluate/helpers.js';
import { date } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** WORKDAY (SPEC §9.3, date). */
export const WORKDAY = define({
  name: 'WORKDAY',
  group: 'date',
  signatures: [
    sig('date', [p('start_date', 'date'), p('days', 'number'), p('holidays', 'dates', true)]),
  ],
  result: fixed(T.date),
  description: {
    en: 'The working day a number of working days after (or before) the start date, skipping weekends and holidays.',
    vi: 'Ngày làm việc cách ngày bắt đầu một số ngày làm việc (trước hoặc sau), bỏ qua cuối tuần và ngày nghỉ.',
  },
  examples: [
    exl('WORKDAY([Received], 3)', 'WORKDAY([Ngày nhận], 3)', '2026/10/01'),
    ex('WORKDAY(DATE(2000, 1, 1), 7)', '2000/01/11'),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const start = day(args, 0);
  const days = num(args, 1);
  if (start === null || days === null) return null;
  if (days.abs().cmp(Dec.int(MAX_WORKDAYS)) > 0) return null;
  const result = workday(start, days.toInt() ?? 0, holidays(args, 2));
  return result === null ? null : date(result);
};
