import { unaccent } from '@cellhive/filter-dsl';

import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** UNACCENT (SPEC §9.3, text). */
export const UNACCENT = define({
  name: 'UNACCENT',
  group: 'text',
  signatures: [sig('text', [p('text', 'text')])],
  result: fixed(T.text),
  description: {
    en: 'Removes accents (diacritics) from text.',
    vi: 'Bỏ dấu tiếng Việt (dấu phụ) khỏi chuỗi.',
  },
  examples: [ex('UNACCENT("Tiếng Việt")', 'Tieng Viet')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  return text === null ? null : unaccent(text);
};
