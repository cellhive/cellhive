import { define, p, sig, exl, argType } from '../catalogue/define.js';

/** LET (SPEC §9.3, logic). */
export const LET = define({
  name: 'LET',
  group: 'logic',
  signatures: [sig('T', [p('name', 'value'), p('value', 'value'), p('expression', 'value')])],
  syntax: 'LET(name1, value1, [name2, value2, …], expression)',
  result: argType(2),
  description: {
    en: 'Names intermediate values and uses them in the final expression; each value may use the names before it. Names are case-insensitive and cannot be function names, TRUE, FALSE or CurrentValue.',
    vi: 'Đặt tên cho giá trị trung gian rồi dùng trong biểu thức cuối; mỗi giá trị dùng được các tên đặt trước nó. Tên không phân biệt hoa thường, không trùng tên hàm, TRUE, FALSE, CurrentValue.',
  },
  notes: {
    en: 'LET is syntax: it cannot be chained (x.LET(…)).',
    vi: 'LET là cú pháp riêng: không gọi kiểu chaining (x.LET(…)).',
  },
  examples: [
    exl(
      'LET(price, [Unit price], quantity, [Quantity], price * quantity)',
      'LET(gia, [Đơn giá], so_luong, [Số lượng], gia * so_luong)',
      '250000',
    ),
  ],
});
