import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { civilFromDays, localWall, parseTodateWall } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { str } from '../evaluate/helpers.js';
import { formatDate, formatNumber, hasDateToken } from '../evaluate/text-format.js';
import { isDate, isDateTime } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** TEXT (SPEC §9.3, text). */
export const TEXT = define({
  name: 'TEXT',
  group: 'text',
  signatures: [sig('text', [p('value', 'single'), p('format', 'text')])],
  result: fixed(T.text),
  description: {
    en: 'Formats a number or date as text with a fixed pattern, as in Lark. Numbers: 0 (digit), # (optional digit), "," (thousands), "." (decimals), % — "0.00", "#,##0", "000", "0%". Dates (letters in any case): YYYY YY MMMM MMM MM M DDDD DDD DD D hh h mm ss — "YYYY/MM/DD", "hh:mm", "DDDD, D MMMM". Dates use the field or organization time zone.',
    vi: 'Định dạng số hoặc ngày thành chuỗi theo mẫu cố định, như Lark. Số: 0 (chữ số), # (chữ số tuỳ chọn), "," (nhóm nghìn), "." (thập phân), % — "0.00", "#,##0", "000", "0%". Ngày (chữ hoa hay thường đều được): YYYY YY MMMM MMM MM M DDDD DDD DD D hh h mm ss — "YYYY/MM/DD", "hh:mm", "DDDD, D MMMM". Ngày theo múi giờ của field hoặc tổ chức.',
  },
  notes: {
    en: 'hh is the 24-hour clock; MM right after an hour or right before ss is minutes (as in Excel), otherwise the month. Month and weekday names are English (MMMM = April, MMM = Apr, DDDD = Friday, DDD = Fri), whatever the language. A number pattern with other text, and elapsed time such as [h], give an empty result.',
    vi: 'hh là giờ 24; MM ngay sau giờ hoặc ngay trước ss là phút (như Excel), còn lại là tháng. Tên tháng và thứ bằng tiếng Anh (MMMM = April, MMM = Apr, DDDD = Friday, DDD = Fri), không theo ngôn ngữ. Mẫu số có chữ khác, và thời lượng như [h], cho kết quả rỗng.',
  },
  examples: [
    ex('TEXT(DATE(2021, 1, 1), "YYYY/MM/DD")', '2021/01/01'),
    ex('TEXT(23100, "#,##0.00")', '23,100.00'),
    ex('TEXT(0.256, "0.0%")', '25.6%'),
    ex('TEXT(DATE(2021, 4, 9), "DDDD, D MMMM YYYY")', 'Friday, 9 April 2021'),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = args.value(0);
  const pattern = str(args, 1);
  if (value === null || pattern === null) return null;
  if (value instanceof Dec) return formatNumber(value, pattern);
  // Text with a date pattern (M4): a date-shaped string is read with the
  // TODATE rule (or a bare "H:mm[:ss]"), as in Lark; unparseable is empty.
  if (typeof value === 'string') {
    if (!hasDateToken(pattern)) return value;
    const wall = parseTodateWall(value, args.rt.timeZone);
    return wall === null ? null : formatDate(pattern, wall);
  }
  if (isDate(value)) {
    return formatDate(pattern, { ...civilFromDays(value.day), hour: 0, minute: 0, second: 0 });
  }
  if (isDateTime(value)) {
    return formatDate(pattern, localWall(value.ms, value.zone ?? args.rt.timeZone));
  }
  return args.rt.text(value);
};
