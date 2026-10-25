import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { compileRegex, regexInput } from '../evaluate/regex.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** REGEXMATCH (SPEC §9.3, text). */
export const REGEXMATCH = define({
  name: 'REGEXMATCH',
  group: 'text',
  signatures: [sig('boolean', [p('text', 'text'), p('pattern', 'text')])],
  result: fixed(T.boolean),
  description: {
    en: 'True when the text matches the regular expression.',
    vi: 'Đúng khi chuỗi khớp biểu thức chính quy.',
  },
  notes: {
    en: 'Patterns use the syntax PostgreSQL and JavaScript share; at most 500 characters, applied to at most 10,000 characters of text.',
    vi: 'Mẫu dùng phần cú pháp chung của PostgreSQL và JavaScript; tối đa 500 ký tự, áp trên tối đa 10.000 ký tự của chuỗi.',
  },
  examples: [ex('REGEXMATCH("abc123", "[0-9]+")', 'TRUE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const pattern = str(args, 1);
  if (text === null || pattern === null) return null;
  return compileRegex(pattern, false)?.test(regexInput(text)) ?? null;
};
