import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { compileRegex, regexInput } from '../evaluate/regex.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** REGEXEXTRACT (SPEC §9.3, text). */
export const REGEXEXTRACT = define({
  name: 'REGEXEXTRACT',
  group: 'text',
  signatures: [sig('text', [p('text', 'text'), p('pattern', 'text')])],
  result: fixed(T.text),
  description: {
    en: 'The first part of the text that matches the regular expression.',
    vi: 'Phần đầu tiên của chuỗi khớp biểu thức chính quy.',
  },
  notes: {
    en: 'Patterns use the syntax PostgreSQL and JavaScript share; at most 500 characters, applied to at most 10,000 characters of text.',
    vi: 'Mẫu dùng phần cú pháp chung của PostgreSQL và JavaScript; tối đa 500 ký tự, áp trên tối đa 10.000 ký tự của chuỗi.',
  },
  examples: [ex('REGEXEXTRACT("abc123", "[0-9]+")', '123')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const pattern = str(args, 1);
  if (text === null || pattern === null) return null;
  // The whole first match (PostgreSQL regexp_substr).
  return compileRegex(pattern, false)?.exec(regexInput(text))?.[0] ?? null;
};
