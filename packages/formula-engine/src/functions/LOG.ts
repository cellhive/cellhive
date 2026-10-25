import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { num, optNum } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** LOG (SPEC §9.3, number). */
export const LOG = define({
  name: 'LOG',
  group: 'number',
  signatures: [sig('number', [p('number', 'number'), p('base', 'number', true)])],
  result: fixed(T.number),
  description: {
    en: 'Logarithm of a positive number in the given base (10 when left out); empty for a number or base out of range.',
    vi: 'Logarit của một số dương theo cơ số cho trước (mặc định 10); rỗng khi số hoặc cơ số không hợp lệ.',
  },
  examples: [ex('LOG(100)', '2'), ex('LOG(8, 2)', '3')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = num(args, 0);
  const base = optNum(args, 1, Dec.int(10));
  if (value === null || base === null || value.sign <= 0 || base.sign <= 0 || base.eq(Dec.ONE)) {
    return null;
  }
  const x = value.toNumber();
  const b = base.toNumber();
  const result = b === 10 ? Math.log10(x) : b === 2 ? Math.log2(x) : Math.log(x) / Math.log(b);
  return Dec.fromDouble(result);
};
