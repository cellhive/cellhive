import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** CONCATENATE (SPEC §9.3, text). */
export const CONCATENATE = define({
  name: 'CONCATENATE',
  group: 'text',
  signatures: [sig('text', [p('text', 'text')], 1)],
  result: fixed(T.text),
  description: { en: 'Joins values into one text.', vi: 'Nối các giá trị thành một chuỗi.' },
  examples: [ex('CONCATENATE("Ba", "se")', 'Base')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  let out = '';
  for (let index = 0; index < args.count; index += 1) out += str(args, index) ?? '';
  return out;
};
