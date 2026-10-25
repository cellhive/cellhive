import { define, sig, ex, fixed } from '../catalogue/define.js';
import { datetime } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** NOW (SPEC §9.3, date). */
export const NOW = define({
  name: 'NOW',
  group: 'date',
  volatile: true,
  signatures: [sig('datetime', [])],
  result: fixed(T.datetime),
  description: { en: 'The current date and time.', vi: 'Ngày giờ hiện tại.' },
  notes: {
    en: 'Volatile: a formula using NOW is computed when read (virtual), never stored.',
    vi: 'Thay đổi theo thời gian: công thức dùng NOW được tính khi đọc (virtual), không lưu.',
  },
  examples: [ex('NOW()', '2026/09/28 14:30')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => datetime(args.rt.now);
