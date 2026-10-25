import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { int, str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** SUBSTITUTE (SPEC §9.3, text). */
export const SUBSTITUTE = define({
  name: 'SUBSTITUTE',
  group: 'text',
  signatures: [
    sig('text', [
      p('text', 'text'),
      p('search', 'text'),
      p('replacement', 'text'),
      p('occurrence', 'number', true),
    ]),
  ],
  result: fixed(T.text),
  description: {
    en: 'Replaces occurrences of a text with another: every one, or only the n-th when `occurrence` is given.',
    vi: 'Thay chuỗi con bằng chuỗi khác: mọi lần xuất hiện, hoặc chỉ lần thứ n khi có `occurrence`.',
  },
  examples: [ex('SUBSTITUTE("abcdefg", "cde", "xyz")', 'abxyzfg')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const search = str(args, 1);
  const replacement = str(args, 2);
  if (text === null || search === null || replacement === null) return null;
  if (search === '') return text;
  if (args.value(3) === null) return text.split(search).join(replacement);
  const occurrence = int(args, 3);
  if (occurrence === null || occurrence < 1) return null;
  let index = -1;
  let from = 0;
  for (let seen = 0; seen < occurrence; seen += 1) {
    index = text.indexOf(search, from);
    if (index === -1) return text;
    from = index + search.length;
  }
  return text.slice(0, index) + replacement + text.slice(index + search.length);
};
