import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { numbers } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** PRODUCT (SPEC §9.3, number). */
export const PRODUCT = define({
  name: 'PRODUCT',
  group: 'number',
  signatures: [sig('number', [p('number', 'numbers')], 1)],
  result: fixed(T.number),
  description: {
    en: 'Multiplies numbers and lists of numbers.',
    vi: 'Nhân các số và danh sách số.',
  },
  examples: [ex('PRODUCT(2, 3, 4)', '24')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const values = numbers(args);
  if (values.length === 0) return Dec.ZERO;
  let product = Dec.ONE;
  for (const value of values) {
    product = product.mul(value);
    // fx.product: empty from 10^1000 on.
    if (product.log10Abs() >= 1000) return null;
  }
  return product;
};
