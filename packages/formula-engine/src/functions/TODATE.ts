import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { parseTodate } from '../evaluate/dates.js';
import { datetime } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** TODATE (SPEC §9.3, text). */
export const TODATE = define({
  name: 'TODATE',
  group: 'text',
  signatures: [sig('datetime', [p('text', 'text')])],
  result: fixed(T.datetime),
  description: {
    en: 'Converts text such as "2023-06-05" or "2023/06/05 14:30" to a date and time (empty when the text is not a date).',
    vi: 'Chuyển chuỗi như "2023-06-05" hoặc "2023/06/05 14:30" thành ngày giờ (rỗng nếu chuỗi không phải ngày).',
  },
  examples: [ex('TODATE("2023-6-5")', '2023/06/05 00:00')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  // fx.todate(text of the value, formula zone).
  const text = args.rt.text(args.value(0));
  const instant = text === null ? null : parseTodate(text, args.rt.timeZone);
  return instant === null ? null : datetime(instant);
};
