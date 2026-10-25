import { define, p, sig, ex, listOfArgs } from '../catalogue/define.js';

import type { FunctionImpl } from '../evaluate/runtime.js';
import type { Value } from '../evaluate/values.js';

/** LIST (SPEC §9.3, list). */
export const LIST = define({
  name: 'LIST',
  group: 'list',
  signatures: [sig('list<T>', [p('value', 'single', true)], 1)],
  result: listOfArgs(1),
  styleFrom: 'all',
  description: {
    en: 'A list of the values (all of one type).',
    vi: 'Danh sách các giá trị (cùng một kiểu).',
  },
  examples: [ex('LIST(1, 2, 3)', '1, 2, 3')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const out: Value[] = [];
  for (let index = 0; index < args.count; index += 1) out.push(args.value(index));
  return out;
};
