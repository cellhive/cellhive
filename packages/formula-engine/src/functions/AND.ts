import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** AND (SPEC §9.3, logic). */
export const AND = define({
  name: 'AND',
  group: 'logic',
  signatures: [sig('boolean', [p('condition', 'boolean')], 1)],
  result: fixed(T.boolean),
  description: { en: 'True when every condition is true.', vi: 'Đúng khi mọi điều kiện đều đúng.' },
  examples: [ex('AND(1 = 1, 1 = 2)', 'FALSE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  for (let index = 0; index < args.count; index += 1) if (args.value(index) !== true) return false;
  return true;
};
