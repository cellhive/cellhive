import { define, p, sig, ex, elementOfArg } from '../catalogue/define.js';
import { elements } from '../evaluate/values.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** FIRST (SPEC §9.3, list). */
export const FIRST = define({
  name: 'FIRST',
  group: 'list',
  signatures: [sig('T', [p('list', 'items')])],
  result: elementOfArg(0),
  styleFrom: [0],
  description: { en: 'First element of a list.', vi: 'Phần tử đầu tiên của danh sách.' },
  examples: [ex('LIST(1, 3, 5, 7).FIRST()', '1')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => elements(args.value(0))[0] ?? null;
