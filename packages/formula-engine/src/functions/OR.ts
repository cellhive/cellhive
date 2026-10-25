import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** OR (SPEC §9.3, logic). */
export const OR = define({
  name: 'OR',
  group: 'logic',
  signatures: [sig('boolean', [p('condition', 'boolean')], 1)],
  result: fixed(T.boolean),
  description: {
    en: 'True when at least one condition is true.',
    vi: 'Đúng khi có ít nhất một điều kiện đúng.',
  },
  examples: [ex('OR(1 = 2, 1 = 1)', 'TRUE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  for (let index = 0; index < args.count; index += 1) if (args.value(index) === true) return true;
  return false;
};
