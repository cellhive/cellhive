import { define, p, sig, exl, unifyArgs } from '../catalogue/define.js';
import { isBlank } from '../evaluate/values.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** IFBLANK (SPEC §9.3, logic). */
export const IFBLANK = define({
  name: 'IFBLANK',
  group: 'logic',
  signatures: [sig('T', [p('value', 'value'), p('value_if_blank', 'value')])],
  result: unifyArgs(() => [0, 1]),
  styleFrom: [0, 1],
  description: {
    en: 'Returns the value, or the fallback when the value is empty.',
    vi: 'Trả về giá trị, hoặc giá trị thay thế khi giá trị rỗng.',
  },
  examples: [
    exl(
      'IFBLANK([Owner name], "Unassigned")',
      'IFBLANK([Tên người phụ trách], "Chưa giao")',
      'Unassigned',
      'Chưa giao',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = args.value(0);
  return isBlank(value) ? args.value(1) : value;
};
