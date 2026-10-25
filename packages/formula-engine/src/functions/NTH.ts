import { define, p, sig, ex, elementOfArg } from '../catalogue/define.js';
import { int } from '../evaluate/helpers.js';
import { elements } from '../evaluate/values.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** NTH (SPEC §9.3, list). */
export const NTH = define({
  name: 'NTH',
  group: 'list',
  signatures: [sig('T', [p('list', 'items'), p('position', 'number')])],
  result: elementOfArg(0),
  styleFrom: [0],
  description: {
    en: 'The element at a position of a list (1 is the first); empty when out of range.',
    vi: 'Phần tử ở vị trí cho trước của danh sách (1 là đầu tiên); rỗng khi ngoài phạm vi.',
  },
  examples: [ex('LIST(1, 3, 5, 7).NTH(2)', '3')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const items = elements(args.value(0));
  const position = int(args, 1);
  if (position === null || position < 1 || position > items.length) return null;
  return items[position - 1] ?? null;
};
