import { define, sig, ex, fixed } from '../catalogue/define.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** TRUE (SPEC §9.3, logic). */
export const TRUE = define({
  name: 'TRUE',
  group: 'logic',
  signatures: [sig('boolean', [])],
  result: fixed(T.boolean),
  description: { en: 'The logical value true.', vi: 'Giá trị logic đúng.' },
  examples: [ex('TRUE()', 'TRUE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = () => true;
