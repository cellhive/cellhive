import { AI_ASK_MAX_GROUPS, type Id, type WidgetDataDto } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  aggregatePlanOfAsk,
  askDigest,
  askDigestJson,
  askInterpretation,
  askMessages,
  askPlanSchema,
  askProblems,
  askResultJson,
  narrativeMessages,
  type AskPlan,
} from '../../src/ai/features/ask/ask.js';
import { llmJsonSchema } from '../../src/ai/json-schema.js';
import { UNTRUSTED_DATA_INSTRUCTIONS } from '../../src/ai/untrusted.js';
import { widgetConfigOfPlan } from '../../src/records/dashboard-aggregate/plan-by-name.js';

import type {
  BaseSchemaRows,
  SchemaReadability,
} from '../../src/computed/definition/schema-rows.js';
import type { FieldRow, TableRow } from '../../src/db/schema.js';

/**
 * BACKLOG T909: the digest of AI Q&A (what the asker reads and the widget
 * engine reads for them, names only), the plan schema with enums, the
 * prompts, the plan as a widget config, the repair paths, the
 * interpretation built without the model and the rows of the narrative.
 */

const ORDERS = 'tbl_AskOrders0000000' as Id<'tbl'>;
const CUSTOMERS = 'tbl_AskCustomers0000';
const SECRET = 'tbl_AskSecret0000000';

const table = (id: string, name: string): TableRow =>
  ({ id, name, primary_field_id: null }) as unknown as TableRow;

const field = (
  id: string,
  tableId: string,
  name: string,
  type: string,
  extra: Partial<Record<keyof FieldRow, unknown>> = {},
): FieldRow =>
  ({
    id,
    table_id: tableId,
    name,
    type,
    options: {},
    is_primary: false,
    deleted_at: null,
    description: null,
    result_type: null,
    compute_mode: null,
    ...extra,
  }) as unknown as FieldRow;

const F = {
  title: 'fld_AskTitle00000000',
  amount: 'fld_AskAmount0000000',
  cost: 'fld_AskCost000000000',
  status: 'fld_AskStatus0000000',
  owner: 'fld_AskOwner00000000',
  date: 'fld_AskDate000000000',
  customer: 'fld_AskCustomer00000',
  plan: 'fld_AskPlan000000000',
  margin: 'fld_AskMargin0000000',
  total: 'fld_AskTotal00000000',
  files: 'fld_AskFiles00000000',
  approve: 'fld_AskApprove000000',
  parent: 'fld_AskParent0000000',
  customerName: 'fld_AskCustName00000',
  codename: 'fld_AskCodename00000',
} as const;
const NEW = 'opt_AskOptNew0000000';
const DONE = 'opt_AskOptDone000000';

const rows: BaseSchemaRows = {
  baseId: 'bse_AskBase000000000',
  tables: [table(ORDERS, 'Orders'), table(CUSTOMERS, 'Customers'), table(SECRET, 'Secret plans')],
  fields: [
    field(F.title, ORDERS, 'title', 'text', { is_primary: true, description: 'Order title' }),
    field(F.amount, ORDERS, 'amount', 'number', { description: `VND ${'x'.repeat(300)}` }),
    field(F.cost, ORDERS, 'cost', 'number'),
    field(F.status, ORDERS, 'status', 'select', {
      options: {
        options: [
          { id: NEW, name: 'Mới' },
          { id: DONE, name: 'Xong' },
          ...Array.from({ length: 60 }, (_, index) => ({
            id: `opt_AskMany${String(index).padStart(9, '0')}`,
            name: `o${String(index)}`,
          })),
        ],
      },
    }),
    field(F.owner, ORDERS, 'owner', 'user'),
    field(F.date, ORDERS, 'Ngày đặt', 'datetime'),
    field(F.customer, ORDERS, 'customer', 'link', { options: { link_table: CUSTOMERS } }),
    field(F.plan, ORDERS, 'plan', 'link', { options: { link_table: SECRET } }),
    // Reads `cost`: locked for the asker in a strict base (P36).
    field(F.margin, ORDERS, 'margin', 'formula', {
      options: { expression: `[${F.amount}] - [${F.cost}]` },
      result_type: { kind: 'number' },
      compute_mode: 'stored',
    }),
    field(F.total, ORDERS, 'total', 'formula', {
      options: { expression: `[${F.amount}] * 2` },
      result_type: { kind: 'number' },
      compute_mode: 'stored',
    }),
    field(F.files, ORDERS, 'files', 'attachment'),
    field(F.approve, ORDERS, 'Approve', 'button'),
    field(F.parent, ORDERS, 'parent', 'parent'),
    field(F.customerName, CUSTOMERS, 'Tên', 'text', { is_primary: true }),
    field(F.codename, SECRET, 'codename', 'text', { is_primary: true }),
  ],
};

/** u_sales1: `cost` is `no_perm`, the secret table is hidden. */
const sales: SchemaReadability = {
  table: (tableId) => tableId !== SECRET,
  field: (tableId, fieldId) => tableId !== SECRET && fieldId !== F.cost,
};

const digest = askDigest(rows, ORDERS, sales, true);

const plan = (extra: Partial<AskPlan> = {}): AskPlan => ({
  answerable: true,
  chart: 'line',
  title: 'Doanh thu theo tháng',
  metric: { aggregation: 'sum', field: 'amount' },
  dimension: { field: 'Ngày đặt', date_bucket: 'month' },
  series: null,
  filter: { logic: 'and', conditions: [['status', '==', 'Xong']] },
  sort: null,
  limit: null,
  compare: null,
  ...extra,
});

describe('askDigest (T909)', () => {
  it('lists the fields the widget engine reads for the asker, by name', () => {
    expect(JSON.parse(askDigestJson(digest))).toEqual({
      table: 'Orders',
      fields: [
        { name: 'title', type: 'text', kind: 'text', description: 'Order title' },
        {
          name: 'amount',
          type: 'number',
          kind: 'number',
          description: `VND ${'x'.repeat(196)}`,
        },
        {
          name: 'status',
          type: 'select',
          kind: 'select',
          options: [
            'Mới',
            'Xong',
            ...Array.from({ length: 48 }, (_, index) => `o${String(index)}`),
          ],
        },
        { name: 'owner', type: 'user', kind: 'user' },
        { name: 'Ngày đặt', type: 'datetime', kind: 'date' },
        { name: 'customer', type: 'link', kind: 'link', link_table: 'Customers' },
        { name: 'total', type: 'formula', kind: 'number' },
        { name: 'files', type: 'attachment' },
      ],
    });
    // Never an id, the hidden field, the locked formula or the hidden linked table.
    const json = askDigestJson(digest);
    expect(json).not.toMatch(/(fld|tbl|opt)_/u);
    for (const hidden of ['cost', 'margin', 'plan', 'Secret', 'Approve', 'parent']) {
      expect(json).not.toContain(hidden);
    }
  });

  it('keeps a formula on a hidden field when the base is not strict', () => {
    const lenient = askDigest(rows, ORDERS, sales, false);
    expect(lenient.fields.map((item) => item.meta.name)).toContain('margin');
  });

  it('refuses a table the asker cannot read', () => {
    expect(() => askDigest(rows, SECRET as Id<'tbl'>, sales, false)).toThrow(TypeError);
  });
});

describe('askPlanSchema (T909)', () => {
  const schema = askPlanSchema(digest);

  it('takes names of the digest only, where they fit', () => {
    expect(schema.safeParse(plan()).success).toBe(true);
    expect(schema.safeParse(plan({ metric: { aggregation: 'sum', field: 'cost' } })).success).toBe(
      false,
    );
    // `files` filters (empty / non_empty) but neither groups nor aggregates.
    expect(
      schema.safeParse(plan({ filter: { logic: 'and', conditions: [['files', 'empty', null]] } }))
        .success,
    ).toBe(true);
    expect(
      schema.safeParse(plan({ dimension: { field: 'files', date_bucket: null } })).success,
    ).toBe(false);
    expect(
      schema.safeParse(plan({ compare: { date_field: 'amount', range: 'month' } })).success,
    ).toBe(false);
    expect(schema.safeParse(plan({ limit: AI_ASK_MAX_GROUPS + 1 })).success).toBe(false);
  });

  it('is a strict JSON Schema with the names as enums', () => {
    const { schema: json } = llmJsonSchema(schema);
    const text = JSON.stringify(json);
    expect(text).toContain('"Ngày đặt"');
    expect(text).not.toContain('cost');
    expect(text).not.toMatch(/(fld|tbl|opt)_/u);
  });

  it('is null-only for a kind with no field', () => {
    const bare = askDigest(
      { ...rows, fields: rows.fields.filter((item) => item.id === F.title) },
      ORDERS,
      sales,
      false,
    );
    const { schema: json } = llmJsonSchema(askPlanSchema(bare));
    expect((json['properties'] as Record<string, unknown>)['compare']).toEqual({ type: 'null' });
  });
});

describe('askMessages (T909)', () => {
  it('puts the digest in a data block, the date and zone in the rules, the question last', () => {
    const [system, user] = askMessages({
      digest,
      question: 'Doanh thu theo tháng?',
      today: '2026-10-31',
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    expect(system?.content).toContain(UNTRUSTED_DATA_INSTRUCTIONS);
    expect(system?.content).toContain('Today is 2026-10-31 in the time zone Asia/Ho_Chi_Minh.');
    expect(user?.content).toMatch(/<<DATA schema [0-9a-f]{16}>>\n\{"table":"Orders"/u);
    expect(user?.content).toContain('Ngàyˆđặt');
    expect(user?.content.endsWith('Question:\nDoanh thu theo tháng?')).toBe(true);
  });
});

describe('plan → widget config, problems, interpretation (T909)', () => {
  const table = { id: ORDERS, fields: digest.fields.map((item) => item.meta) };

  it('builds the widget of "revenue by month"', () => {
    const built = widgetConfigOfPlan(aggregatePlanOfAsk(plan()), table);
    expect(built).toMatchObject({
      ok: true,
      type: 'line',
      config: {
        metrics: [{ aggregation: 'sum', field: F.amount }],
        dimension: { field: F.date, date_bucket: 'month' },
        sort: 'dimension_asc',
        filter: { op: 'and', items: [{ field: F.status, operator: 'is', value: DONE }] },
      },
    });
  });

  it('sends problems back in the paths the model wrote', () => {
    const built = widgetConfigOfPlan(
      aggregatePlanOfAsk(
        plan({ metric: { aggregation: 'avg', field: 'status' }, dimension: null }),
      ),
      table,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(askProblems(built.problems)).toEqual([
      { path: 'dimension', code: 'REQUIRED', message: 'A line needs a dimension' },
    ]);
    const metric = widgetConfigOfPlan(
      aggregatePlanOfAsk(plan({ metric: { aggregation: 'avg', field: 'status' } })),
      table,
    );
    if (metric.ok) throw new Error('expected problems');
    expect(askProblems(metric.problems)).toEqual([
      expect.objectContaining({ path: 'metric.field', code: 'INVALID_METRIC' }),
    ]);
  });

  it('builds the interpretation from the plan, with ids', () => {
    expect(
      askInterpretation(
        plan({
          series: { field: 'owner', date_bucket: null },
          filter: {
            logic: 'or',
            conditions: [
              ['status', '==', 'Xong'],
              ['files', 'empty', null],
            ],
          },
        }),
        digest,
      ),
    ).toEqual({
      metric: 'sum',
      field: { id: F.amount, name: 'amount' },
      dimension: { id: F.date, name: 'Ngày đặt' },
      bucket: 'month',
      series: { id: F.owner, name: 'owner' },
      series_bucket: null,
      filter_logic: 'or',
      filters: [
        { field: { id: F.status, name: 'status' }, operator: '==', value: 'Xong' },
        { field: { id: F.files, name: 'files' }, operator: 'empty', value: null },
      ],
      compare: null,
    });
  });
});

describe('the narrative call (T909)', () => {
  const interpretation = askInterpretation(
    plan({ dimension: { field: 'customer', date_bucket: null }, filter: null, chart: 'bar' }),
    digest,
  );
  const group = (value: unknown, label: unknown = null) => ({ value, label });
  const data: WidgetDataDto = {
    status: 'ok',
    columns: [
      {
        key: 'dimension',
        role: 'dimension',
        field_id: F.customer,
        field_type: 'link',
        aggregation: null,
        date_bucket: null,
        bucket_width: null,
      },
      {
        key: 'm1',
        role: 'metric',
        field_id: F.amount,
        field_type: 'number',
        aggregation: 'sum',
        date_bucket: null,
        bucket_width: null,
      },
    ],
    rows: [
      [group('rec_AskRecord0000001', 'An Phát'), 300],
      [group('rec_AskRecord0000002'), 200],
      [group(null), 100],
      ...Array.from({ length: 60 }, (_, index) => [group(`r${String(index)}`), index]),
    ],
    total: [600],
    computed_at: '2026-10-31T00:00:00.000Z',
    cache: 'miss',
    ignored_filters: [],
  };

  it('reads labels and numbers, at most 50 rows, never an id', () => {
    const result = JSON.parse(askResultJson(interpretation, data)) as Record<string, unknown>;
    expect(result['columns']).toEqual(['customer', 'sum of amount']);
    const lines = result['rows'] as unknown[][];
    expect(lines).toHaveLength(AI_ASK_MAX_GROUPS);
    expect(lines.slice(0, 3)).toEqual([
      ['An Phát', 300],
      [null, 200],
      [null, 100],
    ]);
    expect(result['more_rows']).toBe(13);
    expect(result['total']).toEqual([600]);
    expect(askResultJson(interpretation, data)).not.toMatch(/(rec|fld|tbl|opt|usr)_/u);
  });

  it('puts the result in a data block and the question last', () => {
    const [system, user] = narrativeMessages({
      question: 'Ai mua nhiều nhất?',
      result: askResultJson(interpretation, data),
    });
    expect(system?.content).toContain(UNTRUSTED_DATA_INSTRUCTIONS);
    expect(user?.content).toMatch(/<<DATA result [0-9a-f]{16}>>/u);
    expect(user?.content).toContain('Anˆ' + 'Phát');
    expect(user?.content.endsWith('Question:\nAi mua nhiều nhất?')).toBe(true);
  });
});
