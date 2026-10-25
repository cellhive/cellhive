import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { num } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** SQRT (SPEC §9.3, number). */
export const SQRT = define({
  name: 'SQRT',
  group: 'number',
  signatures: [sig('number', [p('number', 'number')])],
  result: fixed(T.number),
  description: {
    en: 'Square root of a number; empty for a negative number.',
    vi: 'Căn bậc hai của một số; rỗng với số âm.',
  },
  examples: [ex('SQRT(16)', '4')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => num(args, 0)?.sqrt() ?? null;
