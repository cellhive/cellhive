import { define, sig, ex, fixed } from '../catalogue/define.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** FALSE (SPEC §9.3, logic). */
export const FALSE = define({
  name: 'FALSE',
  group: 'logic',
  signatures: [sig('boolean', [])],
  result: fixed(T.boolean),
  description: { en: 'The logical value false.', vi: 'Giá trị logic sai.' },
  examples: [ex('FALSE()', 'FALSE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = () => false;
