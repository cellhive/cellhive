import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { mod, num } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** MOD (SPEC §9.3, number). */
export const MOD = define({
  name: 'MOD',
  group: 'number',
  signatures: [sig('number', [p('dividend', 'number'), p('divisor', 'number')])],
  result: fixed(T.number),
  description: {
    en: 'Remainder of a division, with the sign of the divisor; empty when dividing by zero.',
    vi: 'Số dư của phép chia, cùng dấu với số chia; rỗng khi chia cho 0.',
  },
  examples: [ex('MOD(3, 2)', '1'), ex('MOD(-3, 2)', '1')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const dividend = num(args, 0);
  const divisor = num(args, 1);
  return dividend === null || divisor === null ? null : mod(dividend, divisor);
};
