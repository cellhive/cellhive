import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { num, optNum } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** CEILING (SPEC §9.3, number). */
export const CEILING = define({
  name: 'CEILING',
  group: 'number',
  signatures: [sig('number', [p('number', 'number'), p('factor', 'number', true)])],
  result: fixed(T.number),
  styleFrom: [0],
  description: {
    en: 'Rounds a number up to a multiple of the factor (1 when left out).',
    vi: 'Làm tròn lên tới bội số gần nhất của hệ số (mặc định 1).',
  },
  examples: [ex('CEILING(3.21, 0.2)', '3.4')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = num(args, 0);
  const factor = optNum(args, 1, Dec.ONE)?.abs() ?? null;
  if (value === null || factor === null || factor.isZero()) return null;
  return Dec.of(-value.neg().floorDiv(factor)).mul(factor);
};
