import { define, p, sig, exl, fixed } from '../catalogue/define.js';
import { isBlank } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** ISNULL (SPEC §9.3, logic). */
export const ISNULL = define({
  name: 'ISNULL',
  group: 'logic',
  signatures: [sig('boolean', [p('value', 'value')])],
  result: fixed(T.boolean),
  description: {
    en: 'Same as ISBLANK: true when the value is empty.',
    vi: 'Giống ISBLANK: đúng khi giá trị rỗng.',
  },
  examples: [exl('ISNULL([Customer])', 'ISNULL([Khách hàng])', 'FALSE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => isBlank(args.value(0));
