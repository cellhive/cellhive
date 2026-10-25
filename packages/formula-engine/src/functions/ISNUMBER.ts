import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** ISNUMBER (SPEC §9.3, logic). */
export const ISNUMBER = define({
  name: 'ISNUMBER',
  group: 'logic',
  signatures: [sig('boolean', [p('value', 'value')])],
  result: fixed(T.boolean),
  description: { en: 'True when the value is a number.', vi: 'Đúng khi giá trị là một số.' },
  examples: [ex('ISNUMBER(12)', 'TRUE'), ex('ISNUMBER("12")', 'FALSE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => args.value(0) instanceof Dec;
