/**
 * Opt-in eval of "Ask AI" (BACKLOG T909, T917; how to run:
 * `test/ai-eval/README.md`): 20 questions on the demo tables, asked as the
 * demo admin in Asia/Ho_Chi_Minh. A case passes when the answer's numbers
 * (`data.rows`) are the numbers of the reference widget — a widget with
 * the config a careful author would build, computed by the same engine
 * (`POST /widgets/:id/data`) — or, for the question nothing in the data
 * answers, when the answer is `unanswerable`. Record data stays off: no
 * narrative call (CONTRACTS §29.4).
 */
import { aiAskSchema, type AiAsk, type Id } from '@cellhive/contracts';
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
import { sameRows } from './scoring.js';

const HCM = 'Asia/Ho_Chi_Minh';

/** The reference widget of a question (ids), or `unanswerable`. */
type Reference =
  | 'unanswerable'
  | ((s: EvalStack) => { readonly type: string; readonly config: Record<string, unknown> });

interface AskCase extends EvalCase {
  readonly table: string;
  readonly reference: Reference;
}

/** A plan of the model by name (every key, as the strict schema asks). */
const plan = (extra: Record<string, unknown>): FakeOpenAiReply => ({
  content: JSON.stringify({
    answerable: true,
    chart: 'bar',
    title: 'Câu trả lời',
    metric: { aggregation: 'count', field: null },
    dimension: null,
    series: null,
    filter: null,
    sort: null,
    limit: null,
    compare: null,
    ...extra,
  }),
});
const sum = (field: string) => ({ aggregation: 'sum', field });
const count = { aggregation: 'count', field: null };
const by = (field: string, date_bucket: string | null = null) => ({ field, date_bucket });
const where = (...conditions: unknown[][]) => ({ logic: 'and', conditions });

// --- reference widgets (ids) -----------------------------------------------------------------

type Metric = { aggregation: string; field?: string };
const kpi =
  (table: string, metric: (s: EvalStack) => Metric, filter?: (s: EvalStack) => unknown) =>
  (s: EvalStack) => ({
    type: 'kpi',
    config: {
      table_id: s.table(table),
      metrics: [{ id: 'm1', ...metric(s) }],
      ...(filter === undefined ? {} : { filter: filter(s) }),
    },
  });
const grouped =
  (
    type: 'bar' | 'line',
    table: string,
    metric: (s: EvalStack) => Metric,
    dimension: { field: string; date_bucket?: string },
    series?: string,
  ) =>
  (s: EvalStack) => ({
    type,
    config: {
      table_id: s.table(table),
      metrics: [{ id: 'm1', ...metric(s) }],
      dimension: {
        field: s.field(table, dimension.field),
        ...(dimension.date_bucket === undefined ? {} : { date_bucket: dimension.date_bucket }),
      },
      ...(series === undefined ? {} : { series_dimension: { field: s.field(table, series) } }),
    },
  });
const sumOf = (table: string, field: string) => (s: EvalStack) => ({
  aggregation: 'sum',
  field: s.field(table, field),
});
const ofField = (aggregation: string, table: string, field: string) => (s: EvalStack) => ({
  aggregation,
  field: s.field(table, field),
});
const counted = () => ({ aggregation: 'count' });
const option =
  (table: string, field: string, operator: 'is' | 'is_not', name: string) => (s: EvalStack) => ({
    op: 'and',
    items: [{ field: s.field(table, field), operator, value: s.option(table, field, name) }],
  });

const CASES: readonly AskCase[] = [
  {
    // Validation run: a date dimension without a bucket first, repaired on the second try.
    table: 'Orders',
    prompt: 'Doanh thu theo tháng',
    reference: grouped('line', 'Orders', sumOf('Orders', 'amount'), {
      field: 'Ngày đặt',
      date_bucket: 'month',
    }),
    fake: [
      plan({ chart: 'line', metric: sum('amount'), dimension: by('Ngày đặt') }),
      plan({ chart: 'line', metric: sum('amount'), dimension: by('Ngày đặt', 'month') }),
    ],
  },
  {
    table: 'Orders',
    prompt: 'Tổng doanh thu là bao nhiêu?',
    reference: kpi('Orders', sumOf('Orders', 'amount')),
    fake: [plan({ chart: 'kpi', metric: sum('amount') })],
  },
  {
    table: 'Orders',
    prompt: 'Có bao nhiêu đơn hàng?',
    reference: kpi('Orders', counted),
    fake: [plan({ chart: 'kpi', metric: count })],
  },
  {
    table: 'Orders',
    prompt: 'Số đơn theo khu vực',
    reference: grouped('bar', 'Orders', counted, { field: 'Khu vực' }),
    fake: [plan({ metric: count, dimension: by('Khu vực') })],
  },
  {
    // Validation run: counts instead of the revenue asked for — a fail.
    table: 'Orders',
    prompt: 'Doanh thu theo khu vực',
    reference: grouped('bar', 'Orders', sumOf('Orders', 'amount'), { field: 'Khu vực' }),
    fake: [plan({ metric: count, dimension: by('Khu vực') })],
    fakePasses: false,
  },
  {
    table: 'Orders',
    prompt: 'Tổng chi phí theo trạng thái đơn',
    reference: grouped('bar', 'Orders', sumOf('Orders', 'cost'), { field: 'status' }),
    fake: [plan({ metric: sum('cost'), dimension: by('status') })],
  },
  {
    table: 'Orders',
    prompt: 'Doanh thu của miền Bắc',
    reference: kpi(
      'Orders',
      sumOf('Orders', 'amount'),
      option('Orders', 'Khu vực', 'is', 'Miền Bắc'),
    ),
    fake: [
      plan({ chart: 'kpi', metric: sum('amount'), filter: where(['Khu vực', '==', 'Miền Bắc']) }),
    ],
  },
  {
    table: 'Orders',
    prompt: 'Có bao nhiêu đơn đã xong?',
    reference: kpi('Orders', counted, option('Orders', 'status', 'is', 'Xong')),
    fake: [plan({ chart: 'kpi', metric: count, filter: where(['status', '==', 'Xong']) })],
  },
  {
    table: 'Orders',
    prompt: 'Doanh thu theo người phụ trách',
    reference: grouped('bar', 'Orders', sumOf('Orders', 'amount'), { field: 'owner' }),
    fake: [plan({ chart: 'pie', metric: sum('amount'), dimension: by('owner') })],
  },
  {
    table: 'Orders',
    prompt: 'Giá trị trung bình của một đơn hàng',
    reference: kpi('Orders', ofField('avg', 'Orders', 'amount')),
    fake: [plan({ chart: 'kpi', metric: { aggregation: 'avg', field: 'amount' } })],
  },
  {
    table: 'Orders',
    prompt: 'Đơn hàng lớn nhất trị giá bao nhiêu?',
    reference: kpi('Orders', ofField('max', 'Orders', 'amount')),
    fake: [plan({ chart: 'kpi', metric: { aggregation: 'max', field: 'amount' } })],
  },
  {
    table: 'Orders',
    prompt: 'Số đơn mỗi tuần',
    reference: grouped('line', 'Orders', counted, { field: 'Ngày đặt', date_bucket: 'week' }),
    fake: [plan({ chart: 'line', metric: count, dimension: by('Ngày đặt', 'week') })],
  },
  {
    table: 'Orders',
    prompt: 'Doanh thu theo tháng, tách theo khu vực',
    reference: grouped(
      'bar',
      'Orders',
      sumOf('Orders', 'amount'),
      { field: 'Ngày đặt', date_bucket: 'month' },
      'Khu vực',
    ),
    fake: [
      plan({
        metric: sum('amount'),
        dimension: by('Ngày đặt', 'month'),
        series: by('Khu vực'),
      }),
    ],
  },
  {
    table: 'Tickets',
    prompt: 'Số ticket theo trạng thái',
    reference: grouped('bar', 'Tickets', counted, { field: 'Trạng thái' }),
    fake: [plan({ metric: count, dimension: by('Trạng thái') })],
  },
  {
    table: 'Tickets',
    prompt: 'Có bao nhiêu ticket khẩn cấp?',
    reference: kpi('Tickets', counted, option('Tickets', 'Ưu tiên', 'is', 'Khẩn cấp')),
    fake: [plan({ chart: 'kpi', metric: count, filter: where(['Ưu tiên', '==', 'Khẩn cấp']) })],
  },
  {
    table: 'Tickets',
    prompt: 'Tổng số tiền của các ticket chưa xong',
    reference: kpi(
      'Tickets',
      sumOf('Tickets', 'Số tiền'),
      option('Tickets', 'Trạng thái', 'is_not', 'Đã xong'),
    ),
    fake: [
      plan({
        chart: 'kpi',
        metric: sum('Số tiền'),
        filter: where(['Trạng thái', '!=', 'Đã xong']),
      }),
    ],
  },
  {
    table: 'Customers',
    prompt: 'Số khách hàng theo thành phố',
    reference: grouped('bar', 'Customers', counted, { field: 'Thành phố' }),
    fake: [plan({ metric: count, dimension: by('Thành phố') })],
  },
  {
    table: 'Customers',
    prompt: 'Có bao nhiêu khách hàng hạng Vàng?',
    reference: kpi('Customers', counted, option('Customers', 'Hạng', 'is', 'Vàng')),
    fake: [plan({ chart: 'kpi', metric: count, filter: where(['Hạng', '==', 'Vàng']) })],
  },
  {
    // Validation run: the filter the wrong way round — other numbers, a fail.
    table: 'Orders',
    prompt: 'Tổng doanh thu của các đơn trên 10 triệu đồng',
    reference: kpi('Orders', sumOf('Orders', 'amount'), (s) => ({
      op: 'and',
      items: [{ field: s.field('Orders', 'amount'), operator: 'gt', value: 10_000_000 }],
    })),
    fake: [
      plan({ chart: 'kpi', metric: sum('amount'), filter: where(['amount', '<', 10_000_000]) }),
    ],
    fakePasses: false,
  },
  {
    table: 'Orders',
    prompt: 'Thời tiết ở Hà Nội hôm nay thế nào?',
    reference: 'unanswerable',
    fake: [plan({ answerable: false })],
  },
];

describe.skipIf(!AI_EVAL.on)('AI Q&A eval (T909, T917)', () => {
  let stack: EvalStack;
  let dashboard: Id<'dsh'>;

  beforeAll(async () => {
    stack = await startEval({ suite: 'ask', recordData: false });
    const created = await stack.call('POST', `/bases/${stack.baseId}/dashboards`, {
      name: 'AI eval references',
    });
    expect(created.statusCode, created.body).toBe(201);
    dashboard = created.json<{ id: Id<'dsh'> }>().id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack.close();
  });

  /** The rows of the reference widget, computed by the dashboard engine. */
  const expectedRows = async (reference: Exclude<Reference, 'unanswerable'>) => {
    const widget = await stack.call('POST', `/dashboards/${dashboard}/widgets`, {
      title: 'Reference',
      ...reference(stack),
    });
    expect(widget.statusCode, widget.body).toBe(201);
    const data = await stack.call('POST', `/widgets/${widget.json<{ id: string }>().id}/data`, {
      filters: [],
    });
    expect(data.statusCode, data.body).toBe(200);
    return data.json<{ rows: unknown[] }>().rows;
  };

  it(
    `answers 20 questions (pass mark ${String(AI_EVAL.passMark)})`,
    async () => {
      const summary = await runSuite(
        stack,
        'ask',
        CASES,
        (item) =>
          stack.call('POST', `/tables/${stack.table(item.table)}/ai/ask`, {
            question: item.prompt,
            timezone: HCM,
          }),
        async (item, response) => {
          const answer: AiAsk = aiAskSchema.parse(response.json());
          if (item.reference === 'unanswerable') return answer.status === 'unanswerable';
          if (answer.status !== 'ok') return false;
          return sameRows(answer.data.rows, await expectedRows(item.reference));
        },
      );
      expect(summary.total).toBe(20);
      expectVerdict(summary, CASES);
    },
    SUITE_TIMEOUT_MS,
  );
});
