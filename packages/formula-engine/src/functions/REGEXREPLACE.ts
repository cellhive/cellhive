import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { compileRegex, regexInput, replacementOf } from '../evaluate/regex.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** REGEXREPLACE (SPEC §9.3, text). */
export const REGEXREPLACE = define({
  name: 'REGEXREPLACE',
  group: 'text',
  signatures: [sig('text', [p('text', 'text'), p('pattern', 'text'), p('replacement', 'text')])],
  result: fixed(T.text),
  description: {
    en: 'Replaces every part of the text that matches the regular expression.',
    vi: 'Thay mọi phần của chuỗi khớp biểu thức chính quy.',
  },
  notes: {
    en: 'Patterns use the syntax PostgreSQL and JavaScript share; at most 500 characters, applied to at most 10,000 characters of text.',
    vi: 'Mẫu dùng phần cú pháp chung của PostgreSQL và JavaScript; tối đa 500 ký tự, áp trên tối đa 10.000 ký tự của chuỗi.',
  },
  examples: [ex('REGEXREPLACE("a1b2", "[0-9]", "#")', 'a#b#')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const pattern = str(args, 1);
  const replacement = str(args, 2);
  if (text === null || pattern === null || replacement === null) return null;
  const regex = compileRegex(pattern, true);
  return regex === null ? null : regexInput(text).replace(regex, replacementOf(replacement));
};
