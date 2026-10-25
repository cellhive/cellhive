import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { num } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** INT (SPEC §9.3, number). */
export const INT = define({
  name: 'INT',
  group: 'number',
  signatures: [sig('number', [p('number', 'number')])],
  result: fixed(T.number),
  styleFrom: [0],
  description: {
    en: 'Rounds a number down to the nearest integer.',
    vi: 'Làm tròn xuống số nguyên gần nhất.',
  },
  examples: [ex('INT(8.9)', '8'), ex('INT(-8.9)', '-9')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => num(args, 0)?.round(0, 'floor') ?? null;
