import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { num } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** ABS (SPEC §9.3, number). */
export const ABS = define({
  name: 'ABS',
  group: 'number',
  signatures: [sig('number', [p('number', 'number')])],
  result: fixed(T.number),
  styleFrom: [0],
  description: { en: 'Absolute value of a number.', vi: 'Giá trị tuyệt đối của một số.' },
  examples: [ex('ABS(-2)', '2')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => num(args, 0)?.abs() ?? null;
