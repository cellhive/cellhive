import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { chars, int, str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** REPLACE (SPEC §9.3, text). */
export const REPLACE = define({
  name: 'REPLACE',
  group: 'text',
  signatures: [
    sig('text', [
      p('text', 'text'),
      p('start', 'number'),
      p('count', 'number'),
      p('new_text', 'text'),
    ]),
  ],
  result: fixed(T.text),
  description: {
    en: 'Replaces `count` characters from position `start` with new text.',
    vi: 'Thay `count` ký tự bắt đầu từ vị trí `start` bằng chuỗi mới.',
  },
  examples: [ex('REPLACE("abcdefg", 1, 6, "xyz")', 'xyzg')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const start = int(args, 1);
  const count = int(args, 2);
  const replacement = str(args, 3);
  if (text === null || start === null || count === null || replacement === null) return null;
  if (start < 1 || count < 0) return null;
  const all = chars(text);
  return all.slice(0, start - 1).join('') + replacement + all.slice(start - 1 + count).join('');
};
