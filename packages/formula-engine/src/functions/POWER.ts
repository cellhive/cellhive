import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { num } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** POWER (SPEC §9.3, number). */
export const POWER = define({
  name: 'POWER',
  group: 'number',
  signatures: [sig('number', [p('base', 'number'), p('exponent', 'number')])],
  result: fixed(T.number),
  description: { en: 'A number raised to a power.', vi: 'Lũy thừa của một số.' },
  examples: [ex('POWER(5, 2)', '25')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const base = num(args, 0);
  const exponent = num(args, 1);
  if (base === null || exponent === null) return null;
  if (base.isZero()) {
    if (exponent.sign < 0) return null;
    return exponent.isZero() ? Dec.ONE : Dec.ZERO;
  }
  if (base.sign < 0 && !exponent.isInteger()) return null;
  // Results beyond 10^±1000 are empty (fx.power).
  const magnitude = exponent.toNumber() * base.log10Abs();
  if (Math.abs(magnitude) > 1000) return null;
  if (exponent.isInteger()) return base.powInt(exponent.toInt() ?? 0);
  return Dec.pow10Double(magnitude);
};
