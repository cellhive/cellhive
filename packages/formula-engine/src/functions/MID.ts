import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { chars, int, str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** MID (SPEC §9.3, text). */
export const MID = define({
  name: 'MID',
  group: 'text',
  signatures: [sig('text', [p('text', 'text'), p('start', 'number'), p('count', 'number')])],
  result: fixed(T.text),
  description: {
    en: 'Part of a text: `count` characters from position `start` (1 is the first character).',
    vi: 'Một đoạn của chuỗi: `count` ký tự bắt đầu từ vị trí `start` (1 là ký tự đầu).',
  },
  examples: [ex('MID("Base", 1, 2)', 'Ba')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const start = int(args, 1);
  const count = int(args, 2);
  if (text === null || start === null || count === null || start < 1 || count < 0) return null;
  return chars(text)
    .slice(start - 1, start - 1 + count)
    .join('');
};
