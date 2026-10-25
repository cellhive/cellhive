import { define, p, sig, ex, elementOfArg } from '../catalogue/define.js';
import { elements } from '../evaluate/values.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** LAST (SPEC §9.3, list). */
export const LAST = define({
  name: 'LAST',
  group: 'list',
  signatures: [sig('T', [p('list', 'items')])],
  result: elementOfArg(0),
  styleFrom: [0],
  description: { en: 'Last element of a list.', vi: 'Phần tử cuối cùng của danh sách.' },
  examples: [ex('LIST(1, 3, 5, 7).LAST()', '7')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const items = elements(args.value(0));
  return items[items.length - 1] ?? null;
};
