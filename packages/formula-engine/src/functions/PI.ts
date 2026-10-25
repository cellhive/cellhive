import { define, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** PI (SPEC §9.3, number). */
export const PI = define({
  name: 'PI',
  group: 'number',
  signatures: [sig('number', [])],
  result: fixed(T.number),
  description: { en: 'The number π.', vi: 'Hằng số π.' },
  examples: [ex('PI()', '3.141592653589793')],
});

/** π to 50 decimals (`fx.pi`). */
const PI_VALUE = Dec.parse('3.14159265358979323846264338327950288419716939937510');

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = () => PI_VALUE;
