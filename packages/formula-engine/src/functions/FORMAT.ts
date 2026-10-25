import { define, p, sig, exl, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** FORMAT (SPEC §9.3, text). */
export const FORMAT = define({
  name: 'FORMAT',
  group: 'text',
  signatures: [sig('text', [p('template', 'text'), p('value', 'text', true)], 1)],
  result: fixed(T.text),
  description: {
    en: 'Fills the placeholders {1}, {2}, … of a template with the values.',
    vi: 'Điền các giá trị vào chỗ trống {1}, {2}, … của mẫu.',
  },
  examples: [
    exl(
      'FORMAT("{1} scored {2}", [Name], [Score])',
      'FORMAT("{1} được {2} điểm", [Tên], [Điểm])',
      'Josh scored 95',
      'Minh được 95 điểm',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const template = str(args, 0);
  if (template === null) return null;
  return template.replace(/\{(\d{1,3})\}/g, (placeholder, digits: string) => {
    const index = Number(digits);
    return index >= 1 && index < args.count ? (str(args, index) ?? '') : placeholder;
  });
};
