import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { chars, str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** LEN (SPEC §9.3, text). */
export const LEN = define({
  name: 'LEN',
  group: 'text',
  signatures: [sig('number', [p('text', 'text')])],
  result: fixed(T.number),
  description: { en: 'Number of characters of a text.', vi: 'Số ký tự của chuỗi.' },
  examples: [ex('LEN("Base")', '4')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  return text === null ? null : Dec.int(chars(text).length);
};
