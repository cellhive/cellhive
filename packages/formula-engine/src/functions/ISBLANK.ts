import { define, p, sig, exl, fixed } from '../catalogue/define.js';
import { isBlank } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** ISBLANK (SPEC §9.3, logic). */
export const ISBLANK = define({
  name: 'ISBLANK',
  group: 'logic',
  signatures: [sig('boolean', [p('value', 'value')])],
  result: fixed(T.boolean),
  description: {
    en: 'True when the value is empty: no value, empty text or an empty list.',
    vi: 'Đúng khi giá trị rỗng: không có giá trị, chuỗi rỗng hoặc danh sách rỗng.',
  },
  examples: [exl('ISBLANK([Due date])', 'ISBLANK([Hạn])', 'TRUE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => isBlank(args.value(0));
