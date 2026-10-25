import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** TRIM (SPEC §9.3, text). */
export const TRIM = define({
  name: 'TRIM',
  group: 'text',
  signatures: [sig('text', [p('text', 'text')])],
  result: fixed(T.text),
  description: {
    en: 'Removes spaces at both ends and collapses inner runs of spaces.',
    vi: 'Bỏ khoảng trắng ở hai đầu và gộp các khoảng trắng liên tiếp bên trong.',
  },
  examples: [ex('TRIM("  abc   abc ")', 'abc abc')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) =>
  str(args, 0)
    ?.replace(/^ +| +$/g, '')
    .replace(/ {2,}/g, ' ') ?? null;
