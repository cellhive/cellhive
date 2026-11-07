/**
 * Opt-in eval of "Write a formula with AI" (BACKLOG T907, T917; how to run:
 * `test/ai-eval/README.md`): 20 Vietnamese descriptions on the demo tables.
 * A case passes when the route answers `200` — the formula already went
 * through `prepareComputedDefinition` like a save (CONTRACTS §29.2) — and
 * its `computed-preview` computes the same values as the reference formula
 * on the same records (the first 5 the admin reads).
 */
import { computedPreviewResponseSchema, type Id } from '@cellhive/contracts';
import { type FakeOpenAiReply } from '@cellhive/server-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AI_EVAL,
  expectVerdict,
  runSuite,
  SETUP_TIMEOUT_MS,
  startEval,
  SUITE_TIMEOUT_MS,
  type EvalCase,
  type EvalStack,
} from './harness.js';
import { sameValues } from './scoring.js';

interface FormulaCase extends EvalCase {
  readonly table: string;
  /** The formula a careful author would write (display form, names). */
  readonly reference: string;
}

const answer = (formula: string): FakeOpenAiReply => ({
  content: JSON.stringify({ formula, explanation: 'Công thức theo mô tả.' }),
});
/** A case the fake provider answers right at once. */
const right = (table: string, prompt: string, reference: string): FormulaCase => ({
  table,
  prompt,
  reference,
  fake: [answer(reference)],
});

const CASES: readonly FormulaCase[] = [
  right('Orders', 'Lãi = tiền trừ chi phí', '[amount] - [cost]'),
  right(
    'Orders',
    'Tỷ suất lãi theo phần trăm của tiền đơn hàng, làm tròn 1 chữ số thập phân',
    'ROUND(([amount] - [cost]) / [amount] * 100, 1)',
  ),
  right('Orders', 'Thuế VAT 10% của đơn hàng', '[amount] * 0.1'),
  right('Orders', 'Tổng tiền phải trả sau khi cộng VAT 10%', '[amount] * 1.1'),
  {
    // Validation run: a syntax error first, repaired on the second try.
    ...right(
      'Orders',
      'Ghi "Lớn" nếu tiền đơn trên 10 triệu, còn lại ghi "Nhỏ"',
      'IF([amount] > 10000000, "Lớn", "Nhỏ")',
    ),
    fake: [
      answer('IF([amount] > 10000000, "Lớn" "Nhỏ")'),
      answer('IF([amount] > 10000000, "Lớn", "Nhỏ")'),
    ],
  },
  right('Orders', 'Tháng của ngày đặt hàng', 'MONTH([Ngày đặt])'),
  right('Orders', 'Năm đặt hàng', 'YEAR([Ngày đặt])'),
  right('Orders', 'Số ngày từ ngày đặt đến hôm nay', 'DAYS(TODAY(), [Ngày đặt])'),
  right('Orders', 'Đơn hàng đã xong hay chưa (đúng hoặc sai)', '[status] = "Xong"'),
  {
    // Validation run: a valid formula that does something else — a fail.
    ...right('Orders', 'Tên đơn hàng viết hoa toàn bộ', 'UPPER([Tên đơn hàng])'),
    fake: [answer('LOWER([Tên đơn hàng])')],
    fakePasses: false,
  },
  right(
    'Orders',
    'Khu vực và trạng thái nối bằng dấu gạch, ví dụ "Miền Bắc - Xong"',
    '[Khu vực] & " - " & [status]',
  ),
  right('Tickets', 'Số ký tự của phần mô tả', 'LEN([Mô tả])'),
  right(
    'Tickets',
    'Ticket đã quá hạn mà chưa xong',
    'AND([Hạn] < TODAY(), [Trạng thái] != "Đã xong")',
  ),
  right('Tickets', 'Số tiền tính theo nghìn đồng', '[Số tiền] / 1000'),
  right(
    'Tickets',
    'Ưu tiên Cao hoặc Khẩn cấp thì ghi "Gấp", còn lại "Bình thường"',
    'IF(OR([Ưu tiên] = "Cao", [Ưu tiên] = "Khẩn cấp"), "Gấp", "Bình thường")',
  ),
  right('Tickets', 'Tiêu đề kèm mã ticket trong ngoặc đơn', '[Tiêu đề] & " (" & [Mã ticket] & ")"'),
  right('Customers', 'Năm khách hàng tham gia', 'YEAR([Ngày tham gia])'),
  {
    // Validation run: a field that does not exist, three times — `AI_INVALID_OUTPUT`.
    ...right(
      'Customers',
      'Khách VIP nếu hạng Vàng hoặc Kim cương, còn lại "Thường"',
      'IF(OR([Hạng] = "Vàng", [Hạng] = "Kim cương"), "VIP", "Thường")',
    ),
    fake: [
      answer('IF([Cấp độ] = "Vàng", "VIP", "Thường")'),
      answer('IF([Cấp độ] = "Vàng", "VIP", "Thường")'),
      answer('IF([Cấp độ] = "Vàng", "VIP", "Thường")'),
    ],
    fakePasses: false,
  },
  right(
    'Customers',
    'Tên khách hàng kèm thành phố, cách nhau bằng dấu gạch',
    '[Tên] & " - " & [Thành phố]',
  ),
  right(
    'Chi tiết đơn hàng',
    'Thành tiền bằng số lượng nhân đơn giá, giảm 5%',
    '[Số lượng] * [Đơn giá] * 0.95',
  ),
];

describe.skipIf(!AI_EVAL.on)('AI formula eval (T907, T917)', () => {
  let stack: EvalStack;

  beforeAll(async () => {
    stack = await startEval({ suite: 'formula', recordData: false });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack.close();
  });

  const preview = async (tableId: Id<'tbl'>, expression: string) => {
    const response = await stack.call('POST', `/tables/${tableId}/computed-preview`, {
      type: 'formula',
      options: { expression },
    });
    expect(response.statusCode, response.body).toBe(200);
    return computedPreviewResponseSchema.parse(response.json()).records;
  };

  it(
    `writes 20 formulas (pass mark ${String(AI_EVAL.passMark)})`,
    async () => {
      const summary = await runSuite(
        stack,
        'formula',
        CASES,
        (item) =>
          stack.call('POST', `/tables/${stack.table(item.table)}/ai/formula`, {
            description: item.prompt,
          }),
        async (item, response) => {
          const { formula } = response.json<{ formula: string }>();
          const tableId = stack.table(item.table);
          return sameValues(
            await preview(tableId, formula),
            await preview(tableId, item.reference),
          );
        },
      );
      expect(summary.total).toBe(20);
      expectVerdict(summary, CASES);
    },
    SUITE_TIMEOUT_MS,
  );
});
