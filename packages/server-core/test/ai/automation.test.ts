import { type EffectiveAccess, type Id, type TableAccess } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_DIGEST_MAX_TABLES,
  automationDigestJson,
  automationDraftDigest,
  automationDraftMessages,
  automationDraftSchema,
  automationDraftTypes,
  automationValidationProblems,
  compileAutomationDraft,
  type AutomationDraft,
  type AutomationDraftDigest,
  type AutomationDraftSources,
} from '../../src/ai/features/automation/automation.js';
import { llmJsonSchema } from '../../src/ai/json-schema.js';
import { UNTRUSTED_DATA_INSTRUCTIONS } from '../../src/ai/untrusted.js';
import {
  validateAutomationDefinition,
  type AutomationFieldMeta,
  type AutomationValidationContext,
} from '../../src/automation/index.js';

/**
 * BACKLOG T908: the digest of "Create an automation with AI" (tables the
 * caller manages, fields they read, forms, bots, email), the flat draft
 * schema by name, the prompt, the compilation of a draft into a
 * definition the save check accepts, and the repair problems (no id).
 */

const TICKETS: Id<'tbl'> = 'tbl_TicketsTable0001';
const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const F = {
  title: 'fld_TicketTitle00001',
  status: 'fld_TicketStatus0001',
  assignee: 'fld_TicketAssignee01',
  due: 'fld_TicketDue0000001',
  mail: 'fld_TicketMail000001',
  chat: 'fld_TicketChat000001',
  secret: 'fld_TicketSecret0001',
  locked: 'fld_TicketLocked0001',
  button: 'fld_TicketButton0001',
  note: 'fld_TicketNote000001',
  orderTitle: 'fld_OrderTitle000001',
  cost: 'fld_OrderCost0000001',
} as const satisfies Record<string, Id<'fld'>>;
const OPT_DONE = 'opt_StatusDone000001';
const FORM: Id<'viw'> = 'viw_TicketsForm00001';
const BOT: Id<'sec'> = 'sec_TelegramBot00001';

const FIELDS: AutomationFieldMeta[] = [
  { id: F.title, table_id: TICKETS, name: 'Tiêu đề', type: 'text', options: {} },
  {
    id: F.status,
    table_id: TICKETS,
    name: 'Trạng thái',
    type: 'select',
    options: {
      options: [
        { id: 'opt_StatusNew0000001', name: 'Mới' },
        { id: OPT_DONE, name: 'Đã xong' },
      ],
    },
  },
  { id: F.assignee, table_id: TICKETS, name: 'Phụ trách', type: 'user', options: {} },
  { id: F.due, table_id: TICKETS, name: 'Hạn', type: 'datetime', options: {} },
  {
    id: F.mail,
    table_id: TICKETS,
    name: 'Email khách',
    type: 'text',
    options: { style: { type: 'email' } },
  },
  { id: F.chat, table_id: TICKETS, name: 'Chat', type: 'text', options: {} },
  { id: F.note, table_id: TICKETS, name: 'Ghi chú', type: 'text', options: {} },
  { id: F.secret, table_id: TICKETS, name: 'Bí mật', type: 'text', options: {} },
  { id: F.locked, table_id: TICKETS, name: 'Khoá', type: 'formula', options: {} },
  { id: F.button, table_id: TICKETS, name: 'Nút', type: 'button', options: {} },
  { id: F.orderTitle, table_id: ORDERS, name: 'title', type: 'text', options: {} },
  { id: F.cost, table_id: ORDERS, name: 'cost', type: 'number', options: {} },
];

function tableAccess(perm: TableAccess['perm'], fields: TableAccess['fields']): TableAccess {
  return {
    perm,
    operations: ['add', 'delete'],
    view_rule: { allow_edit: true, visible_views: null },
    read_scope: 'all',
    fields,
    option_edit_fields: [],
    file_download_fields: [],
  };
}

const ticketFields = {
  [F.title]: 'edit',
  [F.status]: 'edit',
  [F.assignee]: 'edit',
  [F.due]: 'edit',
  [F.mail]: 'edit',
  [F.chat]: 'edit',
  [F.note]: 'edit',
  [F.locked]: 'read',
  [F.button]: 'read',
} as const;

/** "Chỉ Tickets": `manage` Tickets (`Bí mật` hidden), Orders `edit`. */
const TICKETS_ONLY: EffectiveAccess = {
  role: null,
  is_admin: false,
  base_rule: { copy: false, download: false, share_link: false },
  tables: {
    [TICKETS]: tableAccess('manage', ticketFields),
    [ORDERS]: tableAccess('edit', { [F.orderTitle]: 'edit', [F.cost]: 'edit' }),
  },
  dashboards: {},
};
const ADMIN: EffectiveAccess = { ...TICKETS_ONLY, is_admin: true };

const contextOf = (access: EffectiveAccess): AutomationValidationContext => ({
  tables: [
    { id: ORDERS, name: 'Orders', primary_field_id: F.orderTitle },
    { id: TICKETS, name: 'Tickets', primary_field_id: F.title },
  ],
  fields: FIELDS,
  access,
  lockedFieldIds: new Set([F.locked]),
  // What the API adds for a `form.submitted` definition.
  views: new Map([[FORM, { id: FORM, table_id: TICKETS, type: 'form', is_personal: false }]]),
});

const sources = (overrides: Partial<AutomationDraftSources> = {}): AutomationDraftSources => ({
  context: contextOf(TICKETS_ONLY),
  views: [
    { id: FORM, table_id: TICKETS, name: 'Gửi ticket', type: 'form', is_personal: false },
    {
      id: 'viw_TicketsGrid00001',
      table_id: TICKETS,
      name: 'Lưới',
      type: 'grid',
      is_personal: false,
    },
    {
      id: 'viw_TicketsMine00001',
      table_id: TICKETS,
      name: 'Form riêng',
      type: 'form',
      is_personal: true,
    },
  ],
  bots: [{ id: BOT, name: 'Bot nhóm' }],
  email: true,
  currentTableId: null,
  ...overrides,
});

const digestOf = (overrides: Partial<AutomationDraftSources> = {}) =>
  automationDraftDigest(sources(overrides));

const ACTION = {
  table: null,
  fields: null,
  recipients: null,
  title: null,
  text: null,
  bot: null,
  chat_id: null,
  chat_field: null,
  minutes: null,
} as const;

const TRIGGER = {
  table: 'Tickets',
  watch_fields: null,
  changed_to: null,
  form: null,
  cron: null,
  date_field: null,
  offset_minutes: null,
} as const;

/** The milestone sentence (Quyết định S8 #6). */
const MILESTONE: AutomationDraft = {
  name: 'Báo người phụ trách khi ticket xong',
  trigger: {
    ...TRIGGER,
    type: 'record.updated',
    watch_fields: ['Trạng thái'],
    changed_to: 'Đã xong',
  },
  condition: null,
  actions: [
    {
      ...ACTION,
      type: 'send_notification',
      recipients: ['Phụ trách'],
      title: 'Ticket {{ [Tiêu đề] }} đã xong',
      text: 'Hạn: {{ [Hạn] }}',
    },
  ],
  explanation: 'Gửi qua kênh thông báo của người nhận (Telegram nếu đã liên kết).',
  warnings: [],
};

const draft = (overrides: Partial<AutomationDraft>): AutomationDraft => ({
  ...MILESTONE,
  ...overrides,
});

/** The compiled definition, which the save check must accept for the same person. */
function compiled(value: AutomationDraft, digest: AutomationDraftDigest = digestOf()) {
  const result = compileAutomationDraft(value, digest);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  const check = validateAutomationDefinition(result.definition, digest.context);
  expect(check.ok ? [] : check.errors).toEqual([]);
  return result.definition;
}

const problemsOf = (value: AutomationDraft, digest: AutomationDraftDigest = digestOf()) => {
  const result = compileAutomationDraft(value, digest);
  return result.ok ? [] : result.problems;
};

describe('automation draft digest (T908)', () => {
  it('lists the tables the caller manages and the fields they read, names only', () => {
    const digest = digestOf();
    expect(digest.tables.map((table) => table.name)).toEqual(['Tickets']);
    const json = JSON.parse(automationDigestJson(digest)) as Record<string, unknown>;
    expect(json).toEqual({
      current_table: null,
      tables: [
        {
          name: 'Tickets',
          fields: [
            { name: 'Tiêu đề', type: 'text' },
            { name: 'Trạng thái', type: 'select', options: ['Mới', 'Đã xong'] },
            { name: 'Phụ trách', type: 'user' },
            { name: 'Hạn', type: 'datetime' },
            { name: 'Email khách', type: 'email' },
            { name: 'Chat', type: 'text' },
            { name: 'Ghi chú', type: 'text' },
          ],
          forms: ['Gửi ticket'],
        },
      ],
      telegram_bots: ['Bot nhóm'],
      email_available: true,
    });
    // Hidden, locked and button fields, other tables and every id stay out.
    const text = automationDigestJson(digest);
    for (const absent of ['Bí mật', 'Khoá', 'Nút', 'Orders', 'cost', 'tbl_', 'fld_', 'opt_']) {
      expect(text).not.toContain(absent);
    }
  });

  it('gives a base admin every readable table, the current one first, capped', () => {
    const admin = digestOf({ context: contextOf(ADMIN), currentTableId: TICKETS });
    expect(admin.tables.map((table) => table.name)).toEqual(['Tickets', 'Orders']);
    expect(admin.currentTable).toBe('Tickets');
    const many = Array.from({ length: 25 }, (_, index) => ({
      id: `tbl_Many${String(index).padStart(12, '0')}` as Id<'tbl'>,
      name: `T${String(index)}`,
    }));
    const context = {
      ...contextOf(ADMIN),
      tables: many,
      access: {
        ...ADMIN,
        tables: Object.fromEntries(many.map((table) => [table.id, tableAccess('manage', {})])),
      },
    };
    expect(automationDraftDigest(sources({ context })).tables).toHaveLength(
      AUTOMATION_DIGEST_MAX_TABLES,
    );
  });

  it.each([
    [
      'everything',
      {},
      [
        'record.created',
        'record.updated',
        'record.matches',
        'form.submitted',
        'record.date_reached',
      ],
      [
        'send_notification',
        'send_telegram',
        'send_email',
        'update_record',
        'create_record',
        'delay',
      ],
    ],
    [
      'admin: schedule',
      { context: contextOf(ADMIN) },
      [
        'record.created',
        'record.updated',
        'record.matches',
        'form.submitted',
        'schedule',
        'record.date_reached',
      ],
      [
        'send_notification',
        'send_telegram',
        'send_email',
        'update_record',
        'create_record',
        'delay',
      ],
    ],
    [
      'no bot, no email, no form',
      { bots: [], email: false, views: [] },
      ['record.created', 'record.updated', 'record.matches', 'record.date_reached'],
      ['send_notification', 'update_record', 'create_record', 'delay'],
    ],
  ] as const)('drafts only what the base offers: %s', (_, overrides, triggers, actions) => {
    expect(automationDraftTypes(digestOf(overrides))).toEqual({ triggers, actions });
  });
});

describe('automation draft schema (T908)', () => {
  it('is a flat strict JSON Schema with the digest names as enums', () => {
    const schema = automationDraftSchema(digestOf());
    const json = JSON.stringify(llmJsonSchema(schema).schema);
    for (const name of ['Trạng thái', 'Phụ trách', 'Gửi ticket', 'Bot nhóm', 'send_notification']) {
      expect(json).toContain(name);
    }
    for (const absent of [
      'http_request',
      'run_n8n_workflow',
      'update_records',
      'delete_record',
      'find_records',
      '"if"',
      'schedule',
      'Orders',
      'Bí mật',
    ]) {
      expect(json).not.toContain(absent);
    }
    // Recipients: user and email fields only.
    const recipients = (llmJsonSchema(schema).schema as { properties: Record<string, unknown> })
      .properties['actions'];
    expect(JSON.stringify(recipients)).toContain('"enum":["Phụ trách","Email khách"]');
  });

  it('refuses an action drafts do not have and a name outside the digest', () => {
    const schema = automationDraftSchema(digestOf());
    expect(schema.safeParse(MILESTONE).success).toBe(true);
    const http = { ...MILESTONE, actions: [{ ...ACTION, type: 'http_request' }] };
    expect(schema.safeParse(http).success).toBe(false);
    const orders = { ...MILESTONE, trigger: { ...MILESTONE.trigger, table: 'Orders' } };
    expect(schema.safeParse(orders).success).toBe(false);
    const hidden = { ...MILESTONE, trigger: { ...MILESTONE.trigger, watch_fields: ['Bí mật'] } };
    expect(schema.safeParse(hidden).success).toBe(false);
  });

  it('keeps names out of reach when a kind has none (null only)', () => {
    const schema = automationDraftSchema(digestOf({ bots: [], views: [] }));
    const withForm = (form: string | null) => ({
      ...MILESTONE,
      trigger: { ...MILESTONE.trigger, form },
    });
    expect(schema.safeParse(withForm(null)).success).toBe(true);
    expect(schema.safeParse(withForm('Gửi ticket')).success).toBe(false);
  });
});

describe('automation draft prompt (T908)', () => {
  it('puts the digest in a data block and the sentence last; only the offered types', () => {
    const messages = automationDraftMessages({
      digest: digestOf({ bots: [] }),
      prompt: 'Khi ticket chuyển DONE thì gửi Telegram cho người phụ trách',
    });
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    const [system, user] = messages.map((message) => message.content);
    expect(system).toContain(UNTRUSTED_DATA_INSTRUCTIONS);
    expect(system).toContain('- send_notification:');
    expect(system).not.toContain('- send_telegram:');
    expect(system).not.toContain('- schedule:');
    expect(user).toMatch(
      /<<DATA schema [0-9a-f]{16}>>\n\{"current_table":null,"tables":\[\{"name":"Tickets"/u,
    );
    expect(user).toContain('"name":"Trạngˆthái"');
    expect(user?.endsWith('Khi ticket chuyển DONE thì gửi Telegram cho người phụ trách')).toBe(
      true,
    );
  });
});

describe('automation draft compilation (T908)', () => {
  it('compiles the milestone sentence to a definition the save check accepts', () => {
    expect(compiled(MILESTONE)).toEqual({
      trigger: {
        type: 'record.updated',
        table_id: TICKETS,
        watch_fields: [F.status],
        skip_bulk: false,
      },
      condition: { field: F.status, operator: 'changed_to', value: 'Đã xong' },
      actions: [
        {
          id: 'act_1',
          type: 'send_notification',
          config: {
            recipients: [{ field: F.assignee }],
            title: { template: `Ticket {{ [${F.title}] }} đã xong` },
            body: { template: `Hạn: {{ [${F.due}] }}` },
            link_record: 'trigger',
            skip_actor: false,
          },
        },
      ],
    });
    // The save check stores the option id.
    const check = validateAutomationDefinition(compiled(MILESTONE), digestOf().context);
    expect(check.ok && check.definition.condition).toEqual({
      field: F.status,
      operator: 'changed_to',
      value: OPT_DONE,
    });
  });

  it.each([
    [
      'record.created + condition',
      draft({
        trigger: { ...TRIGGER, type: 'record.created' },
        condition: {
          logic: 'and',
          conditions: [
            ['Trạng thái', '==', 'Mới'],
            ['Ghi chú', 'empty', null],
          ],
        },
      }),
      {
        trigger: { type: 'record.created', table_id: TICKETS, skip_bulk: false },
        condition: {
          op: 'and',
          items: [
            { field: F.status, operator: 'is', value: 'Mới' },
            { field: F.note, operator: 'is_empty' },
          ],
        },
      },
    ],
    [
      'record.updated: changed_to and a condition',
      draft({ condition: { logic: 'or', conditions: [['Ghi chú', 'non_empty', null]] } }),
      {
        condition: {
          op: 'and',
          items: [
            { field: F.status, operator: 'changed_to', value: 'Đã xong' },
            { op: 'or', items: [{ field: F.note, operator: 'is_not_empty' }] },
          ],
        },
      },
    ],
    [
      'record.matches: the condition records enter',
      draft({
        trigger: { ...TRIGGER, type: 'record.matches' },
        condition: { logic: 'and', conditions: [['Trạng thái', '==', 'Đã xong']] },
      }),
      {
        trigger: {
          type: 'record.matches',
          table_id: TICKETS,
          condition: { op: 'and', items: [{ field: F.status, operator: 'is', value: 'Đã xong' }] },
          skip_bulk: false,
        },
        condition: null,
      },
    ],
    [
      'form.submitted',
      draft({ trigger: { ...TRIGGER, type: 'form.submitted', form: 'Gửi ticket' } }),
      { trigger: { type: 'form.submitted', view_id: FORM } },
    ],
    [
      'record.date_reached',
      draft({
        trigger: {
          ...TRIGGER,
          type: 'record.date_reached',
          date_field: 'Hạn',
          offset_minutes: -60,
        },
      }),
      {
        trigger: {
          type: 'record.date_reached',
          table_id: TICKETS,
          field_id: F.due,
          offset_minutes: -60,
          time_of_day: null,
        },
      },
    ],
  ] as const)('compiles %s', (_, value, expected) => {
    expect(compiled(value, digestOf({ context: contextOf(ADMIN) }))).toMatchObject(expected);
  });

  it('compiles a schedule of a base admin: no record, no link', () => {
    const digest = digestOf({ context: contextOf(ADMIN) });
    const definition = compiled(
      draft({
        trigger: { ...TRIGGER, type: 'schedule', table: null, cron: '0 8 * * 1' },
        actions: [
          {
            ...ACTION,
            type: 'send_telegram',
            bot: 'Bot nhóm',
            chat_id: '-1001234567890',
            text: 'Họp tuần {{ [@fired_at] }}',
          },
        ],
      }),
      digest,
    );
    expect(definition).toMatchObject({
      trigger: { type: 'schedule', cron: '0 8 * * 1', timezone: null },
      condition: null,
      actions: [
        {
          type: 'send_telegram',
          config: {
            secret_id: BOT,
            chat_id: { literal: '-1001234567890' },
            text: { template: 'Họp tuần {{ [@fired_at] }}', digest: null },
          },
        },
      ],
    });
  });

  it('compiles every other action', () => {
    const definition = compiled(
      draft({
        actions: [
          {
            ...ACTION,
            type: 'send_telegram',
            bot: 'Bot nhóm',
            chat_field: 'Chat',
            text: '{{ [Tiêu đề] }} xong',
          },
          {
            ...ACTION,
            type: 'send_email',
            recipients: ['Email khách', 'Phụ trách'],
            title: 'Ticket {{ [Tiêu đề] }}',
            text: 'Đã xong.',
          },
          { ...ACTION, type: 'delay', minutes: 30 },
          {
            ...ACTION,
            type: 'update_record',
            fields: [{ field: 'Ghi chú', value: 'Đóng {{ TODAY() }}' }],
          },
          {
            ...ACTION,
            type: 'create_record',
            table: 'Tickets',
            fields: [
              { field: 'Tiêu đề', value: 'Theo dõi' },
              { field: 'Trạng thái', value: 'Mới' },
            ],
          },
        ],
      }),
    );
    expect(definition.actions).toMatchObject([
      {
        id: 'act_1',
        config: { chat_id: { field: F.chat }, text: { template: `{{ [${F.title}] }} xong` } },
      },
      {
        id: 'act_2',
        config: {
          identity_id: null,
          to: [{ field: F.mail }, { field: F.assignee }],
          subject: { template: `Ticket {{ [${F.title}] }}` },
          body: { format: 'markdown', template: 'Đã xong.' },
        },
      },
      { id: 'act_3', config: { minutes: 30, until: null } },
      {
        id: 'act_4',
        config: {
          table_id: TICKETS,
          record_id: null,
          fields: { [F.note]: { template: 'Đóng {{ TODAY() }}' } },
        },
      },
      {
        id: 'act_5',
        config: {
          table_id: TICKETS,
          fields: { [F.title]: { literal: 'Theo dõi' }, [F.status]: { literal: 'Mới' } },
        },
      },
    ]);
  });

  it.each([
    [
      'no watched field',
      draft({ trigger: { ...TRIGGER, type: 'record.updated', watch_fields: [] } }),
      [{ path: 'trigger.watch_fields', code: 'REQUIRED' }],
    ],
    [
      'changed_to on another trigger (never dropped)',
      draft({ trigger: { ...TRIGGER, type: 'record.created', changed_to: 'Đã xong' } }),
      [{ path: 'trigger.changed_to', code: 'NOT_ALLOWED' }],
    ],
    [
      'a field of another table',
      draft({ condition: { logic: 'and', conditions: [['title', '==', 'x']] } }),
      [{ path: 'condition.conditions[0][0]', code: 'UNKNOWN_FIELD' }],
    ],
    [
      'no title, an unknown field in a text',
      draft({
        actions: [
          {
            ...ACTION,
            type: 'send_notification',
            recipients: ['Phụ trách'],
            text: '{{ [Bí mật] }}',
          },
        ],
      }),
      [
        { path: 'actions[0].title', code: 'REQUIRED' },
        { path: 'actions[0].text', code: 'UNKNOWN_FIELD' },
      ],
    ],
    [
      'a condition on a schedule',
      draft({
        trigger: { ...TRIGGER, type: 'schedule', table: null, cron: '0 8 * * *' },
        condition: { logic: 'and', conditions: [['Ghi chú', 'empty', null]] },
        actions: [{ ...ACTION, type: 'delay', minutes: 5 }],
      }),
      [{ path: 'condition', code: 'NO_TRIGGER_RECORD' }],
    ],
    [
      'a chat id the contract refuses (zod)',
      draft({
        actions: [
          { ...ACTION, type: 'send_telegram', bot: 'Bot nhóm', chat_id: 'my friend', text: 'x' },
        ],
      }),
      [{ path: 'actions[0].config.chat_id.literal', code: 'INVALID_FORMAT' }],
    ],
  ] as const)('reports problems by draft path: %s', (_, value, expected) => {
    const problems = problemsOf(value, digestOf({ context: contextOf(ADMIN) }));
    expect(problems).toEqual(expected.map((item) => expect.objectContaining(item) as unknown));
    expect(JSON.stringify(problems)).not.toMatch(/(?:tbl|fld|opt|sec|viw)_/u);
  });

  it('turns save-check errors into problems with names, never ids', () => {
    const digest = digestOf();
    expect(
      automationValidationProblems(
        [
          {
            path: `definition.actions[0].config.fields.${F.status}`,
            code: 'FIELD_READ_ONLY',
            message: 'This field is computed',
          },
          {
            path: 'definition.trigger.table_id',
            code: 'UNKNOWN_TABLE',
            message: `Unknown ${ORDERS}`,
          },
          { path: 'definition', code: 'X', message: `secret ${F.secret}` },
        ],
        digest,
      ),
    ).toEqual([
      {
        path: 'actions[0].config.fields.Trạng thái',
        code: 'FIELD_READ_ONLY',
        message: 'This field is computed',
      },
      { path: 'trigger.table_id', code: 'UNKNOWN_TABLE', message: 'Unknown ?' },
      { path: '', code: 'X', message: 'secret ?' },
    ]);
  });
});
