import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { chars, optInt, str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** FIND (SPEC §9.3, text). */
export const FIND = define({
  name: 'FIND',
  group: 'text',
  signatures: [
    sig('number', [p('search', 'text'), p('within', 'text'), p('start', 'number', true)]),
  ],
  result: fixed(T.number),
  description: {
    en: 'Position of the first occurrence of a text in another (from `start`), or -1 when not found. Case-sensitive.',
    vi: 'Vị trí xuất hiện đầu tiên của chuỗi cần tìm trong chuỗi khác (từ vị trí `start`), -1 nếu không thấy. Phân biệt hoa thường.',
  },
  examples: [ex('FIND("a", "Base")', '2')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const search = str(args, 0);
  const within = str(args, 1);
  const start = optInt(args, 2, 1);
  if (search === null || within === null || start === null || start < 1) return null;
  const haystack = chars(within);
  const needle = chars(search);
  for (let index = start - 1; index + needle.length <= haystack.length; index += 1) {
    if (needle.every((char, offset) => haystack[index + offset] === char))
      return Dec.int(index + 1);
  }
  return Dec.int(-1);
};
