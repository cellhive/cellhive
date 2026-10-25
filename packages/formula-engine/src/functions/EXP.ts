import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { num } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** EXP (SPEC §9.3, number). */
export const EXP = define({
  name: 'EXP',
  group: 'number',
  signatures: [sig('number', [p('number', 'number')])],
  result: fixed(T.number),
  description: { en: 'e raised to the given power.', vi: 'e lũy thừa số đã cho.' },
  examples: [ex('EXP(1)', '2.718281828459045')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = num(args, 0);
  if (value === null) return null;
  // fx.exp: empty beyond e^2302 (≈ 10^1000), 0 below e^-2302.
  if (value.cmp(Dec.int(2302)) > 0) return null;
  if (value.cmp(Dec.int(-2302)) < 0) return Dec.ZERO;
  const x = value.toNumber();
  // Beyond the double range (|x| > 700), through 10^(x / ln 10).
  return Math.abs(x) <= 700 ? Dec.fromDouble(Math.exp(x)) : Dec.pow10Double(x / Math.LN10);
};
