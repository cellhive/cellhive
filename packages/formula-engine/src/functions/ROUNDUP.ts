import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { num, optInt } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** ROUNDUP (SPEC §9.3, number). */
export const ROUNDUP = define({
  name: 'ROUNDUP',
  group: 'number',
  signatures: [sig('number', [p('number', 'number'), p('digits', 'number', true)])],
  result: fixed(T.number),
  styleFrom: [0],
  description: {
    en: 'Rounds a number away from zero to the given number of decimal places.',
    vi: 'Làm tròn số ra xa số 0 tới số chữ số thập phân cho trước.',
  },
  examples: [ex('ROUNDUP(99.44, 1)', '99.5')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = num(args, 0);
  const places = optInt(args, 1, 0);
  if (value === null || places === null) return null;
  // fx.digits: places clamped to ±1000.
  return value.round(Math.max(-1000, Math.min(1000, places)), 'up');
};
