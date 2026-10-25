import { define, p, sig, exl, unifyArgs, every } from '../catalogue/define.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** IFS (SPEC §9.3, logic). */
export const IFS = define({
  name: 'IFS',
  group: 'logic',
  signatures: [sig('T', [p('condition', 'boolean'), p('value', 'value')], 2)],
  result: unifyArgs(every(1, 2)),
  styleFrom: 'all',
  description: {
    en: 'Checks the conditions in order and returns the value paired with the first true one (empty when none is true).',
    vi: 'Kiểm tra lần lượt các điều kiện, trả về giá trị đi kèm điều kiện đúng đầu tiên (rỗng nếu không điều kiện nào đúng).',
  },
  examples: [
    exl(
      'IFS([Score] >= 80, "Excellent", [Score] >= 60, "Pass", TRUE, "Fail")',
      'IFS([Điểm] >= 80, "Giỏi", [Điểm] >= 60, "Đạt", TRUE, "Chưa đạt")',
      'Pass',
      'Đạt',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  for (let index = 0; index + 1 < args.count; index += 2) {
    if (args.value(index) === true) return args.value(index + 1);
  }
  return null;
};
