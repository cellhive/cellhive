import { define, p, sig, ex, listOfArgs } from '../catalogue/define.js';
import { combine, uniqueKey } from '../evaluate/helpers.js';

import type { FunctionImpl } from '../evaluate/runtime.js';
import type { Value } from '../evaluate/values.js';

/** UNIQUE (SPEC §9.3, list). */
export const UNIQUE = define({
  name: 'UNIQUE',
  group: 'list',
  signatures: [sig('list<T>', [p('value', 'values')], 1)],
  result: listOfArgs(1),
  styleFrom: 'all',
  description: {
    en: 'The distinct values of the given values and lists, in first-seen order.',
    vi: 'Các giá trị không trùng lặp của các giá trị và danh sách, theo thứ tự xuất hiện.',
  },
  examples: [ex('UNIQUE(1, 2, 2, 4, 5, 5)', '1, 2, 4, 5')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const seen = new Set<string>();
  const out: Value[] = [];
  for (const item of combine(args)) {
    const key = uniqueKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};
