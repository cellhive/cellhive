import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** VALUE (SPEC §9.3, number). */
export const VALUE = define({
  name: 'VALUE',
  group: 'number',
  signatures: [sig('number', [p('text', 'text')])],
  result: fixed(T.number),
  description: {
    en: 'Converts text to a number (empty when the text is not a number).',
    vi: 'Chuyển chuỗi thành số (rỗng nếu chuỗi không phải số).',
  },
  examples: [ex('VALUE("50")', '50'), ex('VALUE("abc")', '')],
});

/** A plain decimal (`fx.value`): sign, digits, one point, an exponent of 1–3 digits, spaces around. */
const PLAIN_DECIMAL =
  /^[ \t\n\r]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]{1,3})?[ \t\n\r]*$/;

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = args.value(0);
  if (value instanceof Dec) return value;
  if (typeof value !== 'string' || !PLAIN_DECIMAL.test(value)) return null;
  return Dec.parse(value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, ''));
};
