import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** NOT (SPEC §9.3, logic). */
export const NOT = define({
  name: 'NOT',
  group: 'logic',
  signatures: [sig('boolean', [p('condition', 'boolean')])],
  result: fixed(T.boolean),
  description: {
    en: 'Reverses a condition: true becomes false and false becomes true.',
    vi: 'Đảo điều kiện: đúng thành sai, sai thành đúng.',
  },
  examples: [ex('NOT(TRUE)', 'FALSE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => args.value(0) !== true;
