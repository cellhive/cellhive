import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { num, optInt } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** ROUND (SPEC §9.3, number). */
export const ROUND = define({
  name: 'ROUND',
  group: 'number',
  signatures: [sig('number', [p('number', 'number'), p('digits', 'number', true)])],
  result: fixed(T.number),
  styleFrom: [0],
  description: {
    en: 'Rounds a number to the given number of decimal places (0 when left out); negative places round left of the decimal point. Halves round away from zero.',
    vi: 'Làm tròn số tới số chữ số thập phân cho trước (mặc định 0); số âm làm tròn phía trước dấu thập phân. Nửa làm tròn ra xa số 0.',
  },
  examples: [ex('ROUND(99.45, 1)', '99.5'), ex('ROUND(1234, -2)', '1200')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = num(args, 0);
  const places = optInt(args, 1, 0);
  if (value === null || places === null) return null;
  // fx.digits: places clamped to ±1000.
  return value.round(Math.max(-1000, Math.min(1000, places)), 'half');
};
