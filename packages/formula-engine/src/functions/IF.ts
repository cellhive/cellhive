import { define, p, sig, ex, exl, unifyArgs } from '../catalogue/define.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** IF (SPEC §9.3, logic). */
export const IF = define({
  name: 'IF',
  group: 'logic',
  signatures: [
    sig('T', [
      p('condition', 'boolean'),
      p('value_if_true', 'value'),
      p('value_if_false', 'value', true),
    ]),
  ],
  result: unifyArgs(() => [1, 2]),
  styleFrom: [1, 2],
  description: {
    en: 'Returns one value when the condition is true and another when it is false (empty when that value is left out).',
    vi: 'Trả về một giá trị khi điều kiện đúng và giá trị khác khi điều kiện sai (rỗng nếu bỏ trống giá trị đó).',
  },
  examples: [
    exl(
      'IF([Status] = "Done", [Amount] * 0.1, 0)',
      'IF([Trạng thái] = "Xong", [Số tiền] * 0.1, 0)',
      '150000',
    ),
    ex('IF(1 = 2, "Same", "Different")', 'Different'),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) =>
  args.value(0) === true ? args.value(1) : args.value(2);
