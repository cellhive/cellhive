import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { T, listOf } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** SPLIT (SPEC §9.3, text). */
export const SPLIT = define({
  name: 'SPLIT',
  group: 'text',
  signatures: [sig('list<text>', [p('text', 'text'), p('separator', 'text')])],
  result: fixed(listOf(T.text)),
  description: {
    en: 'Splits a text into a list at each separator.',
    vi: 'Tách chuỗi thành danh sách theo dấu phân cách.',
  },
  examples: [ex('SPLIT("a,b,c", ",")', 'a, b, c')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const separator = str(args, 1);
  if (text === null || separator === null) return null;
  if (text === '') return [];
  return separator === '' ? [text] : text.split(separator);
};
