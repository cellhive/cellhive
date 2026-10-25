import { define, sig, ex, fixed } from '../catalogue/define.js';
import { localDay } from '../evaluate/dates.js';
import { date } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** TODAY (SPEC §9.3, date). */
export const TODAY = define({
  name: 'TODAY',
  group: 'date',
  volatile: true,
  signatures: [sig('date', [])],
  result: fixed(T.date),
  description: {
    en: "Today's date in the field or organization time zone.",
    vi: 'Ngày hôm nay theo múi giờ của field hoặc tổ chức.',
  },
  notes: {
    en: 'Volatile: a formula using TODAY is computed when read (virtual), never stored.',
    vi: 'Thay đổi theo thời gian: công thức dùng TODAY được tính khi đọc (virtual), không lưu.',
  },
  examples: [ex('TODAY()', '2026/09/28')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => date(localDay(args.rt.now, args.rt.timeZone));
