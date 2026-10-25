import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { chars, optInt, str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** RIGHT (SPEC §9.3, text). */
export const RIGHT = define({
  name: 'RIGHT',
  group: 'text',
  signatures: [sig('text', [p('text', 'text'), p('count', 'number', true)])],
  result: fixed(T.text),
  description: {
    en: 'The last characters of a text (1 when the count is left out).',
    vi: 'Các ký tự cuối của chuỗi (mặc định 1 ký tự).',
  },
  examples: [ex('RIGHT("Base", 2)', 'se')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const count = optInt(args, 1, 1);
  if (text === null || count === null || count < 0) return null;
  const all = chars(text);
  return count === 0 ? '' : all.slice(Math.max(0, all.length - count)).join('');
};
