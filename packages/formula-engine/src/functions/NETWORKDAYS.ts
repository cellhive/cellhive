import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { inRange, networkdays } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { day, holidays } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** NETWORKDAYS (SPEC §9.3, date). */
export const NETWORKDAYS = define({
  name: 'NETWORKDAYS',
  group: 'date',
  signatures: [
    sig('number', [p('start_date', 'date'), p('end_date', 'date'), p('holidays', 'dates', true)]),
  ],
  result: fixed(T.number),
  description: {
    en: 'Number of working days between two dates (both included), skipping weekends and holidays.',
    vi: 'Số ngày làm việc giữa hai ngày (tính cả hai đầu), bỏ qua cuối tuần và ngày nghỉ.',
  },
  examples: [ex('NETWORKDAYS(DATE(2000, 1, 1), DATE(2000, 1, 12))', '8')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const start = day(args, 0);
  const end = day(args, 1);
  if (start === null || end === null || !inRange(start) || !inRange(end)) return null;
  return Dec.int(networkdays(start, end, holidays(args, 2)));
};
