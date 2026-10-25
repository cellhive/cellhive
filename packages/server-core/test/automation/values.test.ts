import { availableParallelism, loadavg } from 'node:os';

import {
  automationDefinitionSchema,
  type AutomationDefinitionInput,
  type EffectiveAccess,
  type Id,
  type TableAccess,
} from '@cellhive/contracts';
import { parseTemplate } from '@cellhive/markdown';
import { describe, expect, it } from 'vitest';

import {
  AutomationValueError,
  AutomationValueEvaluator,
  escapeHeader,
  eventActorId,
  escapePlain,
  escapeTelegramAttribute,
  escapeTelegramHtml,
  moreRecordsLine,
  previousValues,
  refusedFunctionsIn,
  truncateText,
  validateAutomationDefinition,
  type AutomationFieldMeta,
  type AutomationRecordReader,
  type AutomationValidationContext,
} from '../../src/automation/index.js';

import type { FormulaRecord } from '@cellhive/formula-engine';

const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const CUSTOMERS: Id<'tbl'> = 'tbl_CustomersTable01';
const F = {
  title: 'fld_OrdersTitle00001',
  amount: 'fld_OrdersAmount0001',
  cost: 'fld_OrdersCost000001',
  owner: 'fld_OrdersOwner00001',
  customer: 'fld_OrdersCustomer01',
  name: 'fld_CustomersName001',
  tier: 'fld_CustomersTier001',
} as const satisfies Record<string, Id<'fld'>>;

const FIELDS: AutomationFieldMeta[] = [
  { id: F.title, table_id: ORDERS, name: 'Title', type: 'text', options: {} },
  {
    id: F.amount,
    table_id: ORDERS,
    name: 'Amount',
    type: 'number',
    options: { style: { type: 'currency', currency_code: 'VND' } },
  },
  { id: F.cost, table_id: ORDERS, name: 'Cost', type: 'number', options: {} },
  { id: F.owner, table_id: ORDERS, name: 'Owner', type: 'user', options: {} },
  {
    id: F.customer,
    table_id: ORDERS,
    name: 'Customer',
    type: 'link',
    options: { link_table: CUSTOMERS },
  },
  { id: F.name, table_id: CUSTOMERS, name: 'Name', type: 'text', options: {} },
  { id: F.tier, table_id: CUSTOMERS, name: 'Tier', type: 'text', options: {} },
];

function tableAccess(fields: Record<string, 'read' | 'edit'>): TableAccess {
  return {
    perm: 'manage',
    operations: ['add', 'delete'],
    view_rule: { allow_edit: true, visible_views: null },
    read_scope: 'all',
    fields,
    option_edit_fields: [],
    file_download_fields: [],
  };
}

const ADMIN: EffectiveAccess = {
  role: null,
  is_admin: true,
  base_rule: { copy: true, download: true, share_link: true },
  tables: {
    [ORDERS]: tableAccess({
      [F.title]: 'edit',
      [F.amount]: 'edit',
      [F.cost]: 'edit',
      [F.owner]: 'edit',
      [F.customer]: 'edit',
    }),
    [CUSTOMERS]: tableAccess({ [F.name]: 'edit', [F.tier]: 'edit' }),
  },
  dashboards: {},
};

/** Absolute time budgets only while the machine is not overloaded (S4b-review §7.1). */
const timingBudgetsApply = (): boolean => (loadavg()[0] ?? 0) < 2 * availableParallelism();

/** `cost` hidden (CONTRACTS §5 role Sales), Customers readable. */
const SALES: EffectiveAccess = {
  ...ADMIN,
  is_admin: false,
  tables: {
    [ORDERS]: tableAccess({
      [F.title]: 'edit',
      [F.amount]: 'edit',
      [F.owner]: 'edit',
      [F.customer]: 'edit',
    }),
    [CUSTOMERS]: tableAccess({ [F.name]: 'read' }),
  },
};

function contextOf(access: EffectiveAccess): AutomationValidationContext {
  return {
    tables: [
      { id: ORDERS, name: 'Orders', primary_field_id: F.title },
      { id: CUSTOMERS, name: 'Customers', primary_field_id: F.name },
    ],
    fields: FIELDS,
    access,
  };
}

const onCreate = { type: 'record.created', table_id: ORDERS } as const;

const setTitle = (value: object, id = 'act_1') => ({
  id,
  type: 'update_record' as const,
  config: { table_id: ORDERS, fields: { [F.title]: value as never } },
});

const findOrders = (fields: string[] = [F.title, F.amount]) => ({
  id: 'act_find',
  type: 'find_records' as const,
  config: { table_id: ORDERS, fields: fields as never },
});

function validate(input: AutomationDefinitionInput, access: EffectiveAccess = ADMIN) {
  return validateAutomationDefinition(automationDefinitionSchema.parse(input), contextOf(access));
}

function errorsOf(input: AutomationDefinitionInput, access: EffectiveAccess = ADMIN) {
  const result = validate(input, access);
  return result.ok
    ? []
    : result.errors.map(({ path, code, params }) => ({
        path,
        code,
        ...(params?.['position'] === undefined ? {} : { position: params['position'] }),
        ...(params?.['function'] === undefined ? {} : { function: params['function'] }),
      }));
}

const fieldPath = (index = 0) => `definition.actions[${String(index)}].config.fields.${F.title}`;

describe('templates in definitions (BACKLOG T504)', () => {
  it('stores templates in the canonical stored form', () => {
    const result = validate({
      trigger: onCreate,
      actions: [setTitle({ template: `#{{[${F.title}]&"!"}} {{ now() }}` })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.actions[0]).toMatchObject({
      config: { fields: { [F.title]: { template: `#{{ [${F.title}] & "!" }} {{ NOW() }}` } } },
    });
  });

  it.each([
    {
      name: 'REGEX in a template → UNSUPPORTED_FUNCTION with function and position',
      template: 'x {{ REGEXMATCH("aaaa", "^(a+)+$") }}',
      errors: [
        {
          path: `${fieldPath()}.template`,
          code: 'UNSUPPORTED_FUNCTION',
          position: { start: 5, length: 29 },
          function: 'REGEXMATCH',
        },
      ],
    },
    {
      name: 'a name instead of an id',
      template: '{{ [Title] }}',
      errors: [
        {
          path: `${fieldPath()}.template`,
          code: 'INVALID_REFERENCE',
          position: { start: 3, length: 7 },
        },
      ],
    },
    {
      name: 'a whole table',
      template: `{{ COUNTA([${CUSTOMERS}].[${F.name}]) }}`,
      errors: [
        {
          path: `${fieldPath()}.template`,
          code: 'CROSS_TABLE_NOT_SUPPORTED',
          position: { start: 10, length: 22 },
        },
      ],
    },
    {
      name: 'an unknown or deleted field',
      template: '{{ [fld_Deleted000000001] }}',
      errors: [
        {
          path: `${fieldPath()}.template`,
          code: 'UNKNOWN_FIELD',
          position: { start: 3, length: 22 },
        },
      ],
    },
    {
      name: 'an unterminated placeholder',
      template: 'a {{ 1',
      errors: [
        {
          path: `${fieldPath()}.template`,
          code: 'UNTERMINATED_PLACEHOLDER',
          position: { start: 2, length: 4 },
        },
      ],
    },
  ])('$name', ({ template, errors }) => {
    expect(errorsOf({ trigger: onCreate, actions: [setTitle({ template })] })).toEqual(errors);
  });

  it('checks templates with the saver’s permissions (hidden field = unknown)', () => {
    expect(
      errorsOf(
        { trigger: onCreate, actions: [setTitle({ template: `{{ [${F.cost}] }}` })] },
        SALES,
      ),
    ).toEqual([
      {
        path: `${fieldPath()}.template`,
        code: 'UNKNOWN_FIELD',
        position: { start: 3, length: 22 },
      },
    ]);
    expect(
      errorsOf(
        {
          trigger: onCreate,
          actions: [setTitle({ template: `{{ [${F.customer}].[${F.tier}] }}` })],
        },
        SALES,
      ),
    ).toEqual([
      expect.objectContaining({ path: `${fieldPath()}.template`, code: 'UNKNOWN_FIELD' }),
    ]);
  });

  it('a trigger without record allows constants only', () => {
    expect(
      errorsOf({
        trigger: { type: 'schedule', cron: '0 8 * * *' },
        actions: [
          {
            id: 'act_1',
            type: 'create_record',
            config: {
              table_id: ORDERS,
              fields: { [F.title]: { template: `{{ TODAY() }} {{ [${F.title}] }}` } },
            },
          },
        ],
      }),
    ).toEqual([
      {
        path: `${fieldPath()}.template`,
        code: 'NO_TRIGGER_RECORD',
        position: { start: 17, length: 22 },
      },
    ]);
  });

  it('checks templates of if conditions and record ids', () => {
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [
          {
            id: 'act_1',
            type: 'if',
            config: {
              conditions: [
                {
                  value: { template: '{{ REGEXREPLACE("a", "a", "b") }}' },
                  operator: 'is',
                  compare: { template: '{{ 1 + }}' },
                },
              ],
            },
          },
        ],
      }).map(({ path, code }) => ({ path, code })),
    ).toEqual([
      {
        path: 'definition.actions[0].config.conditions[0].value.template',
        code: 'UNSUPPORTED_FUNCTION',
      },
      {
        path: 'definition.actions[0].config.conditions[0].compare.template',
        code: 'UNEXPECTED_END',
      },
    ]);
  });

  describe('digest', () => {
    const digest = (rowTemplate: string, step = 'act_find') => ({
      digest: { step, row_template: rowTemplate },
    });

    it('row templates read the fields the find_records step returns', () => {
      const result = validate({
        trigger: onCreate,
        actions: [
          findOrders(),
          setTitle(digest(`- {{[${F.title}]}}: {{ [${F.amount}] }}`), 'act_2'),
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.definition.actions[1]).toMatchObject({
        config: {
          fields: {
            [F.title]: {
              digest: { row_template: `- {{ [${F.title}] }}: {{ [${F.amount}] }}`, max_rows: 50 },
            },
          },
        },
      });
    });

    it('a field the step does not return is unknown', () => {
      expect(
        errorsOf({
          trigger: onCreate,
          actions: [findOrders([F.title]), setTitle(digest(`{{ [${F.amount}] }}`), 'act_2')],
        }),
      ).toEqual([
        {
          path: `${fieldPath(1)}.digest.row_template`,
          code: 'UNKNOWN_FIELD',
          position: { start: 3, length: 22 },
        },
      ]);
    });

    it('no fields = the primary field only', () => {
      expect(
        errorsOf({
          trigger: onCreate,
          actions: [findOrders([]), setTitle(digest(`{{ [${F.title}] }}`), 'act_2')],
        }),
      ).toEqual([]);
    });

    it('REGEX in a row template is refused', () => {
      expect(
        errorsOf({
          trigger: onCreate,
          actions: [findOrders(), setTitle(digest('{{ REGEXEXTRACT("a", "a") }}'), 'act_2')],
        }),
      ).toEqual([
        {
          path: `${fieldPath(1)}.digest.row_template`,
          code: 'UNSUPPORTED_FUNCTION',
          position: { start: 3, length: 22 },
          function: 'REGEXEXTRACT',
        },
      ]);
    });

    it('a digest of another step type', () => {
      expect(
        errorsOf({
          trigger: onCreate,
          actions: [setTitle({ literal: 'x' }), setTitle(digest('x', 'act_1'), 'act_2')],
        }),
      ).toEqual([{ path: `${fieldPath(1)}.digest.step`, code: 'UNSUPPORTED_VALUE_SOURCE' }]);
    });
  });
});

describe('refusedFunctionsIn (worker check before a run)', () => {
  it('finds REGEX in any template or row template, without a schema', () => {
    const definition = automationDefinitionSchema.parse({
      trigger: onCreate,
      actions: [
        setTitle({ template: 'ok {{ 1 }}' }),
        findOrders(),
        {
          id: 'act_3',
          type: 'if',
          config: {
            conditions: [
              {
                value: { template: '{{ REGEXMATCH([fld_x000000000000000], "a") }}' },
                operator: 'is_empty',
              },
            ],
            then: [
              setTitle(
                { digest: { step: 'act_find', row_template: '{{ "a".REGEXREPLACE("a", "b") }}' } },
                'act_4',
              ),
            ],
          },
        },
      ],
    });
    expect(refusedFunctionsIn(definition)).toEqual([
      { path: 'definition.actions[2].config.conditions[0].value.template', function: 'REGEXMATCH' },
      {
        path: `definition.actions[2].config.then[0].config.fields.${F.title}.digest.row_template`,
        function: 'REGEXREPLACE',
      },
    ]);
  });
});

describe('escaping by context (ADR-32 §3)', () => {
  it.each([
    ['header: CR/LF cannot add a header', 'Hi\r\nBcc: x@evil.test', 'Hi Bcc: x@evil.test'],
    ['header: controls and separators', 'a\u0000b c\td', 'a b c d'],
    ['header: trimmed', '\n  subject  \n', 'subject'],
  ])('%s', (_name, value, expected) => {
    expect(escapeHeader(value)).toBe(expected);
  });

  it.each([
    ['plain keeps lines, normalises CRLF', 'a\r\nb\rc\u0007', 'a\nb\nc'],
    ['plain fixes lone surrogates', 'x\ud800', 'x�'],
  ])('%s', (_name, value, expected) => {
    expect(escapePlain(value)).toBe(expected);
  });

  it.each([
    ['tags become text', '<b>bold</b>', '&lt;b&gt;bold&lt;/b&gt;'],
    ['entities', 'a & b "c"', 'a &amp; b &quot;c&quot;'],
    [
      'a link stays text',
      '<a href="javascript:alert(1)">x</a>',
      '&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;',
    ],
  ])('telegram html: %s', (_name, value, expected) => {
    expect(escapeTelegramHtml(value)).toBe(expected);
  });

  it.each([
    ['https URL', 'https://example.test/a?b=1&c=2', 'https://example.test/a?b=1&amp;c=2'],
    ['javascript: is dropped', 'javascript:alert(1)', ''],
    ['data: is dropped', 'data:text/html,<script>', ''],
    ['quote breaking out is dropped', '" onclick="x', ''],
    ['mailto', 'mailto:a@b.test', 'mailto:a@b.test'],
  ])('telegram attribute: %s', (_name, value, expected) => {
    expect(escapeTelegramAttribute(value)).toBe(expected);
  });

  it('cuts by code points with an ellipsis', () => {
    expect(truncateText('abcdef', 4)).toEqual({ text: 'abc…', truncated: true });
    expect(truncateText('😀😀😀', 2)).toEqual({ text: '😀…', truncated: true });
    expect(truncateText('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });

  it('says how many records the digest left out, by locale', () => {
    expect(moreRecordsLine(1, 'en')).toBe('… and 1 more record');
    expect(moreRecordsLine(1_234, 'en-US')).toBe('… and 1,234 more records');
    expect(moreRecordsLine(1, 'vi')).toBe('… và 1 record khác');
    expect(moreRecordsLine(1_234, 'vi-VN')).toBe('… và 1.234 record khác');
  });
});

// --- Run time --------------------------------------------------------------------------

const REC = 'rec_Order00000000001';
const CUST = 'rec_Customer00000001';

/** Reader over fixed rows, honouring `access` like `RecordQueryService` (hidden fields absent). */
class FakeReader implements AutomationRecordReader {
  readonly calls: { tableId: string; ids: string[]; fields: string[] }[] = [];

  constructor(
    private readonly rows: Record<string, FormulaRecord[]>,
    private readonly access: EffectiveAccess = ADMIN,
  ) {}

  read(
    tableId: Id<'tbl'>,
    recordIds: readonly string[],
    fieldIds: readonly string[],
  ): Promise<readonly FormulaRecord[]> {
    this.calls.push({ tableId, ids: [...recordIds], fields: [...fieldIds] });
    const readable = this.access.tables[tableId]?.fields ?? {};
    for (const field of fieldIds) {
      if (readable[field as Id<'fld'>] === undefined)
        throw new Error(`unreadable field ${field} requested`);
    }
    return Promise.resolve(
      (this.rows[tableId] ?? [])
        .filter((row) => recordIds.includes(row.id))
        .map((row) => ({
          id: row.id,
          fields: Object.fromEntries(
            fieldIds.filter((id) => id in row.fields).map((id) => [id, row.fields[id]]),
          ),
        })),
    );
  }
}

const ROWS: Record<string, FormulaRecord[]> = {
  [ORDERS]: [
    {
      id: REC,
      fields: {
        [F.title]: 'Đơn <b>1</b>\r\nBcc: x',
        [F.amount]: 1_500_000,
        [F.cost]: 99,
        [F.owner]: [{ id: 'usr_Lan0000000000001', name: 'Lan', email: 'lan@x.test' }],
        [F.customer]: [{ id: CUST, title: 'Acme' }],
      },
    },
  ],
  [CUSTOMERS]: [{ id: CUST, fields: { [F.name]: 'Acme', [F.tier]: 'Gold' } }],
};

function evaluator(
  definition: AutomationDefinitionInput = { trigger: onCreate },
  options: {
    access?: EffectiveAccess;
    reader?: AutomationRecordReader;
    steps?: Map<string, unknown>;
    clock?: () => number;
    locale?: string;
    trigger?: {
      tableId: Id<'tbl'> | null;
      recordId: string | null;
      data?: Record<string, unknown>;
    };
  } = {},
) {
  const access = options.access ?? ADMIN;
  return new AutomationValueEvaluator({
    context: contextOf(access),
    definition: automationDefinitionSchema.parse(definition),
    reader: options.reader ?? new FakeReader(ROWS, access),
    trigger: options.trigger ?? { tableId: ORDERS, recordId: REC },
    ...(options.steps === undefined ? {} : { steps: options.steps }),
    timeZone: 'Asia/Ho_Chi_Minh',
    locale: options.locale ?? 'vi',
    now: new Date('2026-10-05T03:00:00Z'),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    recordUrl: (tableId, recordId) => `https://ob.test/t/${tableId}?record=${recordId}`,
  });
}

describe('AutomationValueEvaluator (SPEC §11.4)', () => {
  it('renders fields, links, users, numbers with style, NOW and TODAY', async () => {
    const result = await evaluator().resolve({
      template:
        `{{ [${F.amount}] }} | {{ [${F.customer}].[${F.tier}] }} | {{ [${F.owner}] }} | ` +
        '{{ TODAY() }} | {{ TEXT(NOW(), "HH:mm") }}',
    });
    expect(result).toEqual({
      value: '1.500.000 ₫ | Gold | Lan | 2026-10-05 | 10:00',
      warnings: [],
      truncated: false,
    });
  });

  it('reads only the fields the template needs, as run_as', async () => {
    const reader = new FakeReader(ROWS);
    await evaluator(undefined, { reader }).resolve({
      template: `{{ [${F.title}] }} {{ [${F.customer}].[${F.name}] }}`,
    });
    expect(reader.calls).toEqual([
      { tableId: ORDERS, ids: [REC], fields: [F.customer, F.title].sort() },
      { tableId: CUSTOMERS, ids: [CUST], fields: [F.name] },
    ]);
  });

  it('a field run_as cannot read any more renders empty with a warning', async () => {
    const result = await evaluator(undefined, { access: SALES }).resolve({
      template: `[{{ [${F.cost}] }}] [{{ [${F.customer}].[${F.tier}] }}] {{ [${F.amount}] }}`,
    });
    expect(result).toEqual({
      value: '[] [] 1.500.000 ₫',
      warnings: [
        { code: 'unknown_reference', placeholder: 0 },
        { code: 'unknown_reference', placeholder: 1 },
      ],
      truncated: false,
    });
  });

  it('a field value run_as cannot read is null with a warning', async () => {
    expect(await evaluator(undefined, { access: SALES }).resolve({ field: F.cost })).toEqual({
      value: null,
      warnings: [{ code: 'field_unavailable', field_id: F.cost }],
      truncated: false,
    });
    expect((await evaluator().resolve({ field: F.amount })).value).toBe(1_500_000);
  });

  it('literal, step and trigger values with paths', async () => {
    const steps = new Map<string, unknown>([['act_1', { records: [{ id: 'rec_x' }], count: 1 }]]);
    const ev = evaluator(undefined, {
      steps,
      trigger: { tableId: null, recordId: null, data: { fired_at: '2026-10-05T01:00:00.000Z' } },
    });
    expect((await ev.resolve({ literal: { a: 1 } })).value).toEqual({ a: 1 });
    expect((await ev.resolve({ step: 'act_1', path: 'records[0].id' })).value).toBe('rec_x');
    expect((await ev.resolve({ step: 'act_1', path: 'records[3].id' })).value).toBeNull();
    expect((await ev.resolve({ step: 'act_9' })).value).toBeNull();
    expect((await ev.resolve({ trigger: 'fired_at' })).value).toBe('2026-10-05T01:00:00.000Z');
    expect((await ev.resolve({ trigger: 'due_at' })).value).toBeNull();
    ev.setStepOutput('act_2', { id: 'rec_y' });
    expect((await ev.resolve({ step: 'act_2', path: 'id' })).value).toBe('rec_y');
  });

  it('a trigger without record renders constants', async () => {
    const ev = evaluator(undefined, { trigger: { tableId: null, recordId: null } });
    expect((await ev.resolve({ template: 'Báo cáo {{ TODAY() }}' })).value).toBe(
      'Báo cáo 2026-10-05',
    );
  });

  it('escapes values for headers and Telegram HTML, literal text kept', async () => {
    const ev = evaluator();
    const title = `{{ [${F.title}] }}`;
    expect((await ev.resolve({ template: `Re: ${title}` }, { context: 'header' })).value).toBe(
      'Re: Đơn <b>1</b> Bcc: x',
    );
    expect(
      (await ev.resolve({ template: `<b>Order</b> ${title}` }, { context: 'telegram_html' })).value,
    ).toBe('<b>Order</b> Đơn &lt;b&gt;1&lt;/b&gt;\nBcc: x');
    expect(
      (
        await ev.resolve(
          {
            template: `<a href="{{ "javascript:" & [${F.title}] }}">x</a> <a href="{{ "https://a.test/?q=" & [${F.amount}] }}">y</a>`,
          },
          { context: 'telegram_html' },
        )
      ).value,
    ).toBe('<a href="">x</a> <a href="https://a.test/?q=1500000">y</a>');
  });

  it('cuts to the output limit', async () => {
    expect(
      await evaluator().resolve(
        { template: `{{ [${F.title}] }}` },
        { context: 'header', maxLength: 5 },
      ),
    ).toEqual({ value: 'Đơn …', warnings: [], truncated: true });
  });

  it('gives placeholder values in the order @cellhive/markdown finds them', async () => {
    const source = `# {{ [${F.title}] }}\n\n\\{{ not }} [link](https://a.test/{{ [${F.amount}] }}) \`{{ "}}" }}\``;
    const { values } = await evaluator().placeholderValues(source);
    const parsed = parseTemplate(source);
    expect(parsed.placeholders.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(values).toEqual(['Đơn <b>1</b>\r\nBcc: x', '1.500.000 ₫', '}}']);
  });

  describe('REGEX stored anyway (definition written to the database)', () => {
    it('fails the step before reading or evaluating anything', async () => {
      const reader = new FakeReader(ROWS);
      const started = performance.now();
      const error = await evaluator(undefined, { reader })
        .resolve({
          template: `{{ [${F.title}] }} {{ REGEXMATCH("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "^(a+)+$") }}`,
        })
        .catch((caught: unknown) => caught);
      if (timingBudgetsApply()) expect(performance.now() - started).toBeLessThan(50);
      expect(error).toBeInstanceOf(AutomationValueError);
      expect(error).toMatchObject({
        code: 'unsupported_function',
        params: { function: 'REGEXMATCH' },
      });
      expect(reader.calls).toEqual([]);
    });

    it('in a digest row template too', async () => {
      const steps = new Map<string, unknown>([
        ['act_find', { records: [{ id: REC, fields: {} }], count: 1 }],
      ]);
      const ev = evaluator({ trigger: onCreate, actions: [findOrders()] }, { steps });
      await expect(
        ev.resolve({
          digest: {
            step: 'act_find',
            row_template: '{{ REGEXREPLACE("a", "a", "b") }}',
            max_rows: 50,
            separator: '\n',
          },
        }),
      ).rejects.toMatchObject({ code: 'unsupported_function' });
    });
  });

  describe('digest', () => {
    const many = (count: number) => ({
      records: Array.from({ length: count }, (_, index) => ({
        id: `rec_Row${String(index).padStart(17, '0')}`,
        fields: { [F.title]: `T${String(index + 1)}`, [F.amount]: index + 1 },
      })),
      count,
      truncated: false,
    });
    const definition = { trigger: onCreate, actions: [findOrders()] };
    const digest = (rowTemplate: string, maxRows = 200) => ({
      digest: { step: 'act_find', row_template: rowTemplate, max_rows: maxRows, separator: '\n' },
    });

    it.each([
      ['vi', '… và 1 record khác'],
      ['en', '… and 1 more record'],
    ])('201 records → 200 lines and "%s"', async (locale, more) => {
      const ev = evaluator(definition, { steps: new Map([['act_find', many(201)]]), locale });
      const result = await ev.resolve(digest(`- {{ [${F.title}] }}`));
      const lines = String(result.value).split('\n');
      expect(lines).toHaveLength(201);
      expect(lines[0]).toBe('- T1');
      expect(lines[199]).toBe('- T200');
      expect(lines[200]).toBe(more);
      expect(result.truncated).toBe(false);
    });

    it('no record → empty text', async () => {
      const ev = evaluator(definition, { steps: new Map([['act_find', many(0)]]) });
      expect((await ev.resolve(digest('x'))).value).toBe('');
      expect((await evaluator(definition).resolve(digest('x'))).value).toBe('');
    });

    it('follows links of the found records, with the separator', async () => {
      const steps = new Map([
        [
          'act_find',
          {
            records: [
              { id: REC, fields: { [F.title]: 'A', [F.customer]: [{ id: CUST, title: 'Acme' }] } },
            ],
            count: 1,
          },
        ],
      ]);
      const ev = evaluator(
        { trigger: onCreate, actions: [findOrders([F.title, F.customer])] },
        { steps },
      );
      expect(
        (
          await ev.resolve({
            digest: {
              step: 'act_find',
              row_template: `{{ [${F.title}] }}/{{ [${F.customer}].[${F.tier}] }}`,
              max_rows: 5,
              separator: ' | ',
            },
          })
        ).value,
      ).toBe('A/Gold');
    });

    it('a render over the budget is cut (fake clock)', async () => {
      let now = 0;
      const ev = evaluator(definition, {
        steps: new Map([['act_find', many(50)]]),
        clock: () => (now += 7),
      });
      const result = await ev.resolve(digest(`{{ [${F.title}] }}`));
      const lines = String(result.value).split('\n');
      expect(result.truncated).toBe(true);
      expect(result.warnings).toEqual([{ code: 'render_timeout' }]);
      expect(lines.length).toBeLessThan(50);
      expect(lines.at(-1)).toMatch(/^… và \d+ record khác$/u);
    });

    it('a heavy expression is cut after about 100 ms (real clock)', async () => {
      const heavy = Array.from(
        { length: 60 },
        () => 'LEN(ARRAYJOIN(SORT(SPLIT([' + F.title + '], ",")), ","))',
      ).join(' + ');
      const big = Array.from({ length: 20_000 }, (_, index) =>
        String((index * 7919) % 20_000),
      ).join(',');
      const rows = {
        records: Array.from({ length: 200 }, (_, index) => ({
          id: `rec_Heavy${String(index).padStart(15, '0')}`,
          fields: { [F.title]: big },
        })),
        count: 200,
      };
      const ev = evaluator(definition, { steps: new Map([['act_find', rows]]) });
      const cpuAtStart = process.cpuUsage();
      const result = await ev.resolve(digest(`{{ ${heavy} }}`));
      const cpu = process.cpuUsage(cpuAtStart);
      expect(result.truncated).toBe(true);
      expect(result.warnings).toContainEqual({ code: 'render_timeout' });
      // One function call (a SORT of 20 000 items) cannot be interrupted: allow its time on top.
      // Measured as CPU time of this process, which does not grow when other processes share
      // the machine: the wall clock overshot 1 s in a full parallel `pnpm test` while the
      // 1-minute load still looked low (T527). The uncut render takes seconds of CPU.
      expect((cpu.user + cpu.system) / 1_000).toBeLessThan(1_000);
    });
  });
});

describe('trigger data and step records in templates (BACKLOG T505)', () => {
  const createCustomer = {
    id: 'act_new',
    type: 'create_record' as const,
    config: { table_id: CUSTOMERS, fields: { [F.name]: { literal: 'Acme' } } },
  };
  const later = (template: string, id = 'act_2') => setTitle({ template }, id);

  describe('checked when saved', () => {
    it('stores step, trigger and record references by id', () => {
      const template =
        `{{ [act_new].[${F.name}] }} {{ [act_new].[@url] }} {{ [@url] }} ` +
        '{{ TEXT([@fired_at], "YYYY") }} {{ [act_new] }}';
      const result = validate({ trigger: onCreate, actions: [createCustomer, later(template)] });
      expect(result.ok).toBe(true);
    });

    it.each([
      {
        name: 'a step that comes later',
        actions: [later('{{ [act_new].[@id] }}', 'act_1'), createCustomer],
        code: 'UNKNOWN_FIELD',
      },
      {
        name: 'a step without record (find before: ok; delete: none)',
        actions: [
          { id: 'act_del', type: 'delete_record' as const, config: {} },
          later('{{ [act_del].[@id] }}'),
        ],
        code: 'UNKNOWN_FIELD',
      },
      {
        name: 'a trigger reference the trigger does not have',
        actions: [later('{{ [@clicked_by] }}')],
        code: 'UNKNOWN_FIELD',
      },
    ])('$name → $code', ({ actions, code }) => {
      const codes = errorsOf({ trigger: onCreate, actions }).map((error) => error.code);
      expect(codes).toContain(code);
    });

    it('a field of the step record the saver cannot read is UNKNOWN_FIELD (P32-like)', () => {
      const result = errorsOf(
        {
          trigger: onCreate,
          actions: [findOrders([F.title]), later(`{{ [act_find].[${F.cost}] }}`)],
        },
        SALES,
      );
      expect(result).toEqual([
        expect.objectContaining({ code: 'UNKNOWN_FIELD', path: `${fieldPath(1)}.template` }),
      ]);
    });

    it('a schedule may use the trigger data and step records, not record fields', () => {
      const schedule = { type: 'schedule', cron: '0 9 * * *' } as const;
      const find = { ...findOrders([F.title]), config: { ...findOrders([F.title]).config } };
      const create = {
        id: 'act_2',
        type: 'create_record' as const,
        config: {
          table_id: CUSTOMERS,
          fields: {
            [F.name]: { template: `{{ [@fired_at] }} {{ [act_find].[${F.title}] }}` },
          },
        },
      };
      expect(errorsOf({ trigger: schedule, actions: [find, create] })).toEqual([]);
      const bad = {
        ...create,
        config: { ...create.config, fields: { [F.name]: { template: `{{ [${F.title}] }}` } } },
      };
      expect(errorsOf({ trigger: schedule, actions: [bad] }).map((e) => e.code)).toEqual([
        'NO_TRIGGER_RECORD',
      ]);
    });
  });

  describe('rendered at run time', () => {
    const definition = { trigger: onCreate, actions: [createCustomer, later('x')] };

    it('reads the step record again as run_as, with id, url and title', async () => {
      const reader = new FakeReader(ROWS);
      const subject = evaluator(definition, {
        reader,
        steps: new Map([['act_new', { id: CUST }]]),
        trigger: {
          tableId: ORDERS,
          recordId: REC,
          data: { fired_at: '2026-10-05T02:30:00.000Z' },
        },
      });
      const result = await subject.resolve({
        template:
          `{{ [act_new].[${F.tier}] }}|{{ [act_new] }}|{{ [act_new].[@id] }}|` +
          '{{ [act_new].[@url] }}|{{ [@url] }}|{{ TEXT([@fired_at], "HH:mm") }}',
      });
      expect(result.value).toBe(
        `Gold|Acme|${CUST}|https://ob.test/t/${CUSTOMERS}?record=${CUST}|` +
          `https://ob.test/t/${ORDERS}?record=${REC}|09:30`,
      );
      expect(result.warnings).toEqual([]);
      // Virtual references are never asked of the reader.
      expect(reader.calls.flatMap((call) => call.fields)).not.toContain('@url');
      expect(reader.calls).toContainEqual({
        tableId: CUSTOMERS,
        ids: [CUST],
        fields: [F.name, F.tier].sort(),
      });
    });

    it('a step that did not run, or a find without result, is empty', async () => {
      const subject = evaluator(definition, { steps: new Map([['act_new', { records: [] }]]) });
      const result = await subject.resolve({ template: `[{{ [act_new].[${F.tier}] }}]` });
      expect(result.value).toBe('[]');
      const none = await evaluator(definition).resolve({ template: '[{{ [act_new].[@id] }}]' });
      expect(none.value).toBe('[]');
    });

    it('the first record of a find_records step', async () => {
      const find = {
        id: 'act_find',
        type: 'find_records' as const,
        config: { table_id: CUSTOMERS, fields: [F.name] as never },
      };
      const subject = evaluator(
        { trigger: onCreate, actions: [find, later('x')] },
        { steps: new Map([['act_find', { records: [{ id: CUST, fields: {} }], count: 1 }]]) },
      );
      expect((await subject.resolve({ template: `{{ [act_find].[${F.tier}] }}` })).value).toBe(
        'Gold',
      );
    });

    it('a field of the step record run_as lost renders empty with a warning', async () => {
      const subject = evaluator(definition, {
        access: SALES,
        steps: new Map([['act_new', { id: CUST }]]),
      });
      const result = await subject.resolve({ template: `[{{ [act_new].[${F.tier}] }}]` });
      expect(result).toEqual({
        value: '[]',
        warnings: [{ code: 'unknown_reference', placeholder: 0 }],
        truncated: false,
      });
    });

    it('REGEX next to a step reference is still refused before running', () => {
      const refused = refusedFunctionsIn(
        automationDefinitionSchema.parse({
          trigger: onCreate,
          actions: [createCustomer, later('{{ [act_new].[@id] & REGEXREPLACE("a", "a", "b") }}')],
        }),
      );
      expect(refused).toEqual([{ path: `${fieldPath(1)}.template`, function: 'REGEXREPLACE' }]);
    });
  });
});

describe('[@actor] and [@previous] (T521 follow-up, SPEC §11.4)', () => {
  const onUpdate = {
    type: 'record.updated' as const,
    table_id: ORDERS,
    watch_fields: [F.amount],
  };
  const LAN = 'usr_Lan0000000000001';

  describe('checked when saved', () => {
    it('record.updated may use [@actor], [@previous].[fld] and { trigger: actor }', () => {
      const result = validate({
        trigger: onUpdate,
        actions: [
          setTitle({
            template: `{{ [@actor] }}: {{ [@previous].[${F.amount}] }} → {{ [${F.amount}] }}`,
          }),
          {
            id: 'act_2',
            type: 'update_record' as const,
            config: {
              table_id: ORDERS,
              record_id: null,
              fields: { [F.owner]: { trigger: 'actor' } },
            },
          },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it.each([
      {
        name: '[@previous] outside record.updated',
        trigger: onCreate,
        template: `{{ [@previous].[${F.amount}] }}`,
      },
      {
        name: '[@actor] on a schedule',
        trigger: { type: 'schedule', cron: '0 9 * * *' } as const,
        template: '{{ [@actor] }}',
      },
    ])('$name → UNKNOWN_FIELD', ({ trigger, template }) => {
      const create = {
        id: 'act_1',
        type: 'create_record' as const,
        config: { table_id: CUSTOMERS, fields: { [F.name]: { template } } },
      };
      expect(errorsOf({ trigger, actions: [create] }).map((error) => error.code)).toContain(
        'UNKNOWN_FIELD',
      );
    });

    it('{ trigger: actor } on a schedule is UNSUPPORTED_VALUE_SOURCE', () => {
      const create = {
        id: 'act_1',
        type: 'create_record' as const,
        config: { table_id: CUSTOMERS, fields: { [F.name]: { trigger: 'actor' } } },
      };
      const codes = errorsOf({
        trigger: { type: 'schedule', cron: '0 9 * * *' },
        actions: [create],
      }).map((error) => error.code);
      expect(codes).toContain('UNSUPPORTED_VALUE_SOURCE');
    });

    it('[@previous] of a field the saver cannot read is UNKNOWN_FIELD', () => {
      const codes = errorsOf(
        { trigger: onUpdate, actions: [setTitle({ template: `{{ [@previous].[${F.cost}] }}` })] },
        SALES,
      ).map((error) => error.code);
      expect(codes).toContain('UNKNOWN_FIELD');
    });
  });

  describe('rendered at run time', () => {
    it('shows the actor by name and the value before the change', async () => {
      const subject = new AutomationValueEvaluator({
        context: contextOf(ADMIN),
        definition: automationDefinitionSchema.parse({ trigger: onUpdate }),
        reader: new FakeReader(ROWS),
        trigger: {
          tableId: ORDERS,
          recordId: REC,
          data: { actor: LAN, previous: { [F.amount]: 900_000 } },
        },
        timeZone: 'Asia/Ho_Chi_Minh',
        locale: 'vi',
        now: new Date('2026-10-05T03:00:00Z'),
        userNames: new Map([[LAN, 'Lan']]),
        recordUrl: (tableId, recordId) => `https://ob.test/t/${tableId}?record=${recordId}`,
      });
      const result = await subject.resolve({
        template:
          `{{ [@actor] }}: {{ [@previous].[${F.amount}] }} → {{ [${F.amount}] }} ` +
          `({{ [@previous].[${F.title}] = [${F.title}] }}, {{ [@previous].[@id] }})`,
      });
      expect(result.value).toBe(`Lan: 900.000 ₫ → 1.500.000 ₫ (TRUE, ${REC})`);
      expect(result.warnings).toEqual([]);
      expect((await subject.resolve({ trigger: 'actor' })).value).toBe(LAN);
    });

    it('a change made by the system has no actor', async () => {
      const subject = evaluator(
        { trigger: onUpdate },
        { trigger: { tableId: ORDERS, recordId: REC, data: { actor: null } } },
      );
      expect((await subject.resolve({ template: '[{{ [@actor] }}]' })).value).toBe('[]');
    });
  });
});

describe('event data of a run (actor, previous values)', () => {
  it.each([
    [{ type: 'user', id: 'usr_Lan0000000000001' }, 'usr_Lan0000000000001'],
    [{ type: 'system', id: null }, null],
    [{ type: 'automation', id: 'aut_X000000000000001' }, null],
    [{ type: 'share_link', id: 'shl_X000000000000001' }, null],
  ])('actor %j → %s', (actor, id) => {
    expect(eventActorId(actor)).toBe(id);
  });

  it('turns the storage form of changes into what templates read', () => {
    const fields: AutomationFieldMeta[] = [
      ...FIELDS,
      {
        id: 'fld_Status0000000001',
        table_id: ORDERS,
        name: 'Status',
        type: 'select',
        options: { options: [{ id: 'opt_New0000000000001', name: 'New' }] },
      },
    ];
    const changes = {
      [F.amount]: { from: 900_000, to: 1_500_000 },
      [F.owner]: { from: ['usr_Lan0000000000001'], to: null },
      [F.customer]: { from: [CUST], to: null },
      fld_Status0000000001: { from: 'opt_New0000000000001', to: null },
      [F.name]: { from: 'other table', to: 'x' },
    };
    expect(previousValues(changes, fields, ORDERS)).toEqual({
      [F.amount]: 900_000,
      [F.owner]: ['usr_Lan0000000000001'],
      [F.customer]: [CUST],
      fld_Status0000000001: 'New',
    });
    expect(previousValues(undefined, fields, ORDERS)).toBeNull();
  });
});

describe('webhook data of a run (BACKLOG T604)', () => {
  const HOOK = 'hok_OrdersHook000001';
  const onHook = { type: 'webhook.received', incoming_webhook_id: HOOK } as const;
  const REQUEST = {
    body: {
      customer: { email: 'an@shop.test', vip: true, orders: 3 },
      items: [{ sku: 'A-1' }, { sku: 'B-2' }],
      note: '<b>hi</b>',
    },
    headers: {
      'x-shop-topic': 'orders/create',
      // Never stored by the route; a row written otherwise is still filtered.
      authorization: 'Bearer canary-token',
      Cookie: 'sid=canary',
    },
    query: { source: 'shop', tag: ['a', 'b'] },
  };

  function webhookEvaluator(load: () => Promise<typeof REQUEST | null>) {
    let loads = 0;
    const subject = new AutomationValueEvaluator({
      context: contextOf(ADMIN),
      definition: automationDefinitionSchema.parse({ trigger: onHook }),
      reader: new FakeReader(ROWS),
      trigger: { tableId: null, recordId: null, data: { fired_at: '2026-10-05T03:00:00.000Z' } },
      timeZone: 'Asia/Ho_Chi_Minh',
      locale: 'vi',
      now: new Date('2026-10-05T03:00:00Z'),
      webhook: {
        load: () => {
          loads += 1;
          return load();
        },
      },
    });
    return { subject, loads: () => loads };
  }

  it('reads body, headers and query values by path; sensitive headers are always null', async () => {
    const { subject, loads } = webhookEvaluator(() => Promise.resolve(REQUEST));
    const value = async (part: string, path?: string) =>
      (await subject.resolve({ trigger: part, ...(path === undefined ? {} : { path }) })).value;
    expect(await value('body', 'customer.email')).toBe('an@shop.test');
    expect(await value('body', 'items[1].sku')).toBe('B-2');
    expect(await value('body', 'missing.key')).toBeNull();
    expect(await value('query', 'source')).toBe('shop');
    expect(await value('query', 'tag[1]')).toBe('b');
    expect(await value('headers', 'X-Shop-Topic')).toBe('orders/create');
    expect(await value('headers', 'authorization')).toBeNull();
    expect(await value('headers', 'cookie')).toBeNull();
    expect(await value('headers')).toEqual({ 'x-shop-topic': 'orders/create' });
    // Loaded once for the whole run.
    expect(loads()).toBe(1);
  });

  it('renders [@body…] references as text; sensitive headers stay empty', async () => {
    const { subject } = webhookEvaluator(() => Promise.resolve(REQUEST));
    const result = await subject.resolve({
      template:
        '{{ [@body.customer.email] }}|{{ [@body.customer.vip] }}|{{ [@body.customer.orders] }}|' +
        '{{ [@body.items[0\\].sku] }}|{{ UPPER([@query.source]) }}|{{ [@headers.x-shop-topic] }}|' +
        '{{ [@headers.authorization] }}|{{ [@body.nothing] }}|{{ [@query.tag] }}',
    });
    expect(result.value).toBe('an@shop.test|true|3|A-1|SHOP|orders/create|||["a","b"]');
    expect(result.warnings).toEqual([]);
    // Values from outside are text nodes in context (Telegram HTML escapes them).
    const html = await subject.renderTemplate('{{ [@body.note] }}', { context: 'telegram_html' });
    expect(html.text).toBe('&lt;b&gt;hi&lt;/b&gt;');
  });

  it('a template without webhook data never loads the request', async () => {
    const { subject, loads } = webhookEvaluator(() => Promise.resolve(null));
    expect((await subject.resolve({ template: 'ok {{ 1 + 1 }}' })).value).toBe('ok 2');
    expect(loads()).toBe(0);
  });

  it('a request no longer stored fails with trigger_data_expired', async () => {
    const { subject } = webhookEvaluator(() => Promise.resolve(null));
    await expect(subject.resolve({ trigger: 'body', path: 'customer.email' })).rejects.toEqual(
      expect.objectContaining({ code: 'trigger_data_expired' }),
    );
    await expect(subject.resolve({ template: '{{ [@query.source] }}' })).rejects.toBeInstanceOf(
      AutomationValueError,
    );
  });
});
