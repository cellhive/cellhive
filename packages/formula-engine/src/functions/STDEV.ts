import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { numbers, sum } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** STDEV (SPEC §9.3, number). */
export const STDEV = define({
  name: 'STDEV',
  group: 'number',
  signatures: [sig('number', [p('number', 'numbers')], 1)],
  result: fixed(T.number),
  styleFrom: 'all',
  description: {
    en: 'Sample standard deviation (n − 1) of numbers and lists of numbers; empty for fewer than two numbers.',
    vi: 'Độ lệch chuẩn mẫu (n − 1) của các số và danh sách số; rỗng khi ít hơn hai số.',
  },
  examples: [ex('STDEV(1, 2, 3)', '1')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  // PostgreSQL stddev_samp(numeric): variance rounded at the division scale, then its root.
  const values = numbers(args);
  if (values.length < 2) return null;
  const count = Dec.int(values.length);
  const total = sum(values);
  const numerator = count.mul(sum(values.map((value) => value.mul(value)))).sub(total.mul(total));
  if (numerator.sign <= 0) return Dec.ZERO;
  const variance = numerator.div(count.mul(Dec.int(values.length - 1)));
  return variance === null ? null : variance.sqrtAt(variance.scale);
};
