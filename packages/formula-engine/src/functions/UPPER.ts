import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { upperCase } from '../evaluate/case-fold.js';
import { str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** UPPER (SPEC §9.3, text). */
export const UPPER = define({
  name: 'UPPER',
  group: 'text',
  signatures: [sig('text', [p('text', 'text')])],
  result: fixed(T.text),
  description: { en: 'Converts text to upper case.', vi: 'Chuyển chuỗi thành chữ hoa.' },
  notes: {
    en: 'Letter by letter, the same in every language (simple Unicode case mapping, not the column collation): "ı" → "I", "ß" stays "ß" (never "SS"), "ς" → "Σ", "ǆ" → "Ǆ".',
    vi: 'Từng chữ, như nhau với mọi ngôn ngữ (ánh xạ hoa/thường Unicode đơn, không theo collation của cột): "ı" → "I", "ß" giữ nguyên (không thành "SS"), "ς" → "Σ", "ǆ" → "Ǆ".',
  },
  examples: [ex('UPPER("abc")', 'ABC')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  return text === null ? null : upperCase(text);
};
