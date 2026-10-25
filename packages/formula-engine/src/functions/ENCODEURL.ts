import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** ENCODEURL (SPEC §9.3, text). */
export const ENCODEURL = define({
  name: 'ENCODEURL',
  group: 'text',
  signatures: [sig('text', [p('text', 'text')])],
  result: fixed(T.text),
  description: { en: 'Encodes text for use in a URL.', vi: 'Mã hóa chuỗi để dùng trong URL.' },
  examples: [ex('ENCODEURL("Base formula")', 'Base%20formula')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const text = str(args, 0);
  if (text === null) return null;
  try {
    return encodeURIComponent(text);
  } catch {
    return null; // A lone surrogate is not valid UTF-8.
  }
};
