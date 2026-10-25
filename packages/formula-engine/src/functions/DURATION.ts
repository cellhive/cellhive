import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { num } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** DURATION (SPEC §9.3, date). */
export const DURATION = define({
  name: 'DURATION',
  group: 'date',
  signatures: [
    sig('number', [
      p('days', 'number'),
      p('hours', 'number', true),
      p('minutes', 'number', true),
      p('seconds', 'number', true),
    ]),
  ],
  result: fixed(T.number),
  description: {
    en: 'A duration in days (fractions for hours, minutes, seconds), to add to or subtract from a date.',
    vi: 'Một khoảng thời gian tính bằng ngày (phần lẻ cho giờ, phút, giây), dùng để cộng/trừ với ngày.',
  },
  notes: {
    en: 'Returns a number of days: date + DURATION(…) moves the date.',
    vi: 'Trả về số ngày: ngày + DURATION(…) dời ngày đó.',
  },
  examples: [ex('NOW() + DURATION(0, 12)', '2026/09/29 02:30')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  // days + hours / 24 + minutes / 1440 + seconds / 86400; empty parts count as 0.
  const days = num(args, 0);
  if (days === null) return null;
  let total = days;
  for (const [index, per] of [
    [1, 24],
    [2, 1440],
    [3, 86_400],
  ] as const) {
    if (index >= args.count) break;
    total = total.add(num(args, index)?.div(Dec.int(per)) ?? Dec.ZERO);
  }
  return total;
};
