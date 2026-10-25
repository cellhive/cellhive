import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** CONTAINTEXT (SPEC §9.3, text). */
export const CONTAINTEXT = define({
  name: 'CONTAINTEXT',
  group: 'text',
  signatures: [sig('boolean', [p('text', 'text'), p('search', 'text')])],
  result: fixed(T.boolean),
  description: {
    en: 'True when a text contains another. Case-sensitive.',
    vi: 'Đúng khi chuỗi chứa chuỗi con. Phân biệt hoa thường.',
  },
  examples: [ex('CONTAINTEXT("Base", "se")', 'TRUE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  const search = str(args, 1);
  return text !== null && search !== null && text.includes(search);
};
