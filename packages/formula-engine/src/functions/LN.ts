import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { num } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** LN (SPEC §9.3, number). */
export const LN = define({
  name: 'LN',
  group: 'number',
  signatures: [sig('number', [p('number', 'number')])],
  result: fixed(T.number),
  description: {
    en: 'Natural logarithm of a positive number; empty otherwise.',
    vi: 'Logarit tự nhiên của một số dương; rỗng nếu không dương.',
  },
  examples: [ex('LN(EXP(1))', '1')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = num(args, 0);
  if (value === null || value.sign <= 0) return null;
  return Dec.fromDouble(Math.log(value.toNumber()));
};
