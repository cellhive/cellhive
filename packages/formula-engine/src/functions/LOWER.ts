import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { lowerCase } from '../evaluate/case-fold.js';
import { str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** LOWER (SPEC §9.3, text). */
export const LOWER = define({
  name: 'LOWER',
  group: 'text',
  signatures: [sig('text', [p('text', 'text')])],
  result: fixed(T.text),
  description: { en: 'Converts text to lower case.', vi: 'Chuyển chuỗi thành chữ thường.' },
  notes: {
    en: 'Letter by letter, the same in every language (simple Unicode case mapping, not the column collation): "İ" → "i", "ẞ" → "ß", "Σ" → "σ" (never "ς"); "ı" stays "ı".',
    vi: 'Từng chữ, như nhau với mọi ngôn ngữ (ánh xạ hoa/thường Unicode đơn, không theo collation của cột): "İ" → "i", "ẞ" → "ß", "Σ" → "σ" (không thành "ς"); "ı" giữ nguyên.',
  },
  examples: [ex('LOWER("ABC")', 'abc')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  return text === null ? null : lowerCase(text);
};
