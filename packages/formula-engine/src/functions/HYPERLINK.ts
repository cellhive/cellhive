import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** HYPERLINK (SPEC §9.3, text). */
export const HYPERLINK = define({
  name: 'HYPERLINK',
  group: 'text',
  signatures: [sig('text', [p('url', 'text'), p('label', 'text', true)])],
  result: fixed(T.text),
  description: {
    en: 'A link to a web address, shown with the label (the address when left out). Only http, https and mailto links are clickable.',
    vi: 'Liên kết tới địa chỉ web, hiển thị bằng nhãn (mặc định là địa chỉ). Chỉ link http, https, mailto bấm được.',
  },
  examples: [ex('HYPERLINK("https://cellhive.io", "Cellhive")', 'Cellhive')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const url = str(args, 0);
  if (url === null) return null;
  const label = args.count > 1 ? str(args, 1) : null;
  return label === null || label === '' ? url : `[${label}](${url})`;
};
