import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { num } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** QUOTIENT (SPEC §9.3, number). */
export const QUOTIENT = define({
  name: 'QUOTIENT',
  group: 'number',
  signatures: [sig('number', [p('dividend', 'number'), p('divisor', 'number')])],
  result: fixed(T.number),
  description: {
    en: 'Integer part of a division; empty when dividing by zero.',
    vi: 'Phần nguyên của phép chia; rỗng khi chia cho 0.',
  },
  examples: [ex('QUOTIENT(5, 2)', '2')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const dividend = num(args, 0);
  const divisor = num(args, 1);
  if (dividend === null || divisor === null || divisor.isZero()) return null;
  return Dec.of(dividend.truncDiv(divisor));
};
