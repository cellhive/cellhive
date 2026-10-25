import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { chars, optInt, str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** LEFT (SPEC §9.3, text). */
export const LEFT = define({
  name: 'LEFT',
  group: 'text',
  signatures: [sig('text', [p('text', 'text'), p('count', 'number', true)])],
  result: fixed(T.text),
  description: {
    en: 'The first characters of a text (1 when the count is left out).',
    vi: 'Các ký tự đầu của chuỗi (mặc định 1 ký tự).',
  },
  examples: [ex('LEFT("Base", 2)', 'Ba')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const count = optInt(args, 1, 1);
  if (text === null || count === null || count < 0) return null;
  return chars(text).slice(0, count).join('');
};
