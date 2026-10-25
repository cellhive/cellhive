import {
  automationDefinitionSchema,
  type AutomationDefinitionInput,
  type EffectiveAccess,
  type Id,
  type TableAccess,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  recipientPartsOf,
  validateAutomationDefinition,
  type AutomationFieldMeta,
  type AutomationValidationContext,
} from '../../src/automation/index.js';

const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const F = {
  title: 'fld_OrdersTitle00001',
  amount: 'fld_OrdersAmount0001',
  cost: 'fld_OrdersCost000001',
  owner: 'fld_OrdersOwner00001',
  contact: 'fld_OrdersContact001',
  phone: 'fld_OrdersPhone00001',
} as const satisfies Record<string, Id<'fld'>>;

const FIELDS: AutomationFieldMeta[] = [
  { id: F.title, table_id: ORDERS, name: 'title', type: 'text', options: {} },
  { id: F.amount, table_id: ORDERS, name: 'amount', type: 'number', options: {} },
  { id: F.cost, table_id: ORDERS, name: 'cost', type: 'number', options: {} },
  { id: F.owner, table_id: ORDERS, name: 'owner', type: 'user', options: {} },
  {
    id: F.contact,
    table_id: ORDERS,
    name: 'contact',
    type: 'text',
    options: { style: { type: 'email' } },
  },
  {
    id: F.phone,
    table_id: ORDERS,
    name: 'phone',
    type: 'text',
    options: { style: { type: 'phone' } },
  },
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

const ALL = Object.fromEntries(Object.values(F).map((id) => [id, 'edit' as const]));
const ADMIN: EffectiveAccess = {
  role: null,
  is_admin: true,
  base_rule: { copy: true, download: true, share_link: true },
  tables: { [ORDERS]: tableAccess(ALL) },
  dashboards: {},
};
/** `cost` hidden (CONTRACTS §5 Sales). */
const SALES: EffectiveAccess = {
  ...ADMIN,
  is_admin: false,
  tables: {
    [ORDERS]: tableAccess(Object.fromEntries(Object.entries(ALL).filter(([id]) => id !== F.cost))),
  },
};

function context(access: EffectiveAccess): AutomationValidationContext {
  return { tables: [{ id: ORDERS, name: 'Orders' }], fields: FIELDS, access };
}

const onCreate = { type: 'record.created', table_id: ORDERS } as const;

function email(config: Record<string, unknown>, id = 'act_mail') {
  return {
    id,
    type: 'send_email' as const,
    config: {
      to: [{ field: F.owner }],
      subject: { template: `Đơn {{ [${F.title}] }}` },
      body: { format: 'markdown', template: 'Xin chào' },
      ...config,
    } as never,
  };
}

function errorsOf(
  actions: unknown[],
  access: EffectiveAccess = ADMIN,
  trigger: AutomationDefinitionInput['trigger'] = onCreate,
) {
  const result = validateAutomationDefinition(
    automationDefinitionSchema.parse({ trigger, actions }),
    context(access),
  );
  return result.ok ? [] : result.errors.map(({ path, code }) => ({ path, code }));
}

const AT = 'definition.actions[0].config';

describe('recipientPartsOf (BACKLOG T514)', () => {
  it.each([
    ['one address', 'a@b.vn', { addresses: ['a@b.vn'], userIds: [] }],
    [
      'a list in text',
      'a@b.vn, c@d.vn;e@f.vn  g@h.vn',
      {
        addresses: ['a@b.vn', 'c@d.vn', 'e@f.vn', 'g@h.vn'],
        userIds: [],
      },
    ],
    [
      'a user cell',
      [{ id: 'usr_UserA00000000001', name: 'A' }],
      {
        addresses: [],
        userIds: ['usr_UserA00000000001'],
      },
    ],
    [
      'a user id (clicked_by)',
      'usr_UserA00000000001',
      {
        addresses: [],
        userIds: ['usr_UserA00000000001'],
      },
    ],
    ['an object with an email', { email: 'x@y.vn' }, { addresses: ['x@y.vn'], userIds: [] }],
    [
      'a step output list',
      ['a@b.vn', ['c@d.vn']],
      { addresses: ['a@b.vn', 'c@d.vn'], userIds: [] },
    ],
    ['empty values', [null, '', undefined, 3], { addresses: [], userIds: [] }],
    [
      'a record object (not a user)',
      { id: 'rec_RecordA000000001' },
      { addresses: [], userIds: [] },
    ],
  ])('%s', (_name, value, expected) => {
    expect(recipientPartsOf(value)).toEqual(expected);
  });

  it('reads at most 1 000 items of one value', () => {
    const many = Array.from({ length: 1_500 }, (_, i) => `u${String(i)}@b.vn`);
    expect(recipientPartsOf(many).addresses).toHaveLength(1_000);
  });
});

describe('validateAutomationDefinition: send_email (BACKLOG T514)', () => {
  it('accepts user and email fields, literals, steps; fills defaults; stores templates by id', () => {
    const result = validateAutomationDefinition(
      automationDefinitionSchema.parse({
        trigger: onCreate,
        actions: [
          email({
            to: [{ field: F.owner }, { field: F.contact }, { literal: ['a@b.vn', 'c@d.vn'] }],
            cc: [{ literal: 'boss@b.vn' }],
            reply_to: { field: F.owner },
          }),
        ],
      }),
      context(ADMIN),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.actions[0]).toMatchObject({
      type: 'send_email',
      config: {
        identity_id: null,
        bcc: [],
        include_signature: true,
        footer: 'minimal',
        subject: { template: `Đơn {{ [${F.title}] }}` },
        body: { format: 'markdown', template: 'Xin chào', digest: null },
      },
    });
  });

  it.each([
    [
      'a literal that is not an address',
      { to: [{ literal: 'not-an-email' }] },
      [{ path: `${AT}.to[0].literal`, code: 'INVALID_EMAIL' }],
    ],
    [
      'one bad address of a list',
      { to: [{ literal: ['ok@b.vn', 'bad'] }] },
      [{ path: `${AT}.to[0].literal[1]`, code: 'INVALID_EMAIL' }],
    ],
    [
      'a number field',
      { to: [{ field: F.amount }] },
      [{ path: `${AT}.to[0].field`, code: 'INVALID_FIELD_TYPE' }],
    ],
    [
      'a text field without the email style',
      { cc: [{ field: F.phone }] },
      [{ path: `${AT}.cc[0].field`, code: 'INVALID_FIELD_TYPE' }],
    ],
    [
      'trigger data that is not a person',
      { bcc: [{ trigger: 'fired_at' }] },
      [{ path: `${AT}.bcc[0].trigger`, code: 'UNSUPPORTED_VALUE_SOURCE' }],
    ],
    [
      'a step that does not come earlier',
      { to: [{ step: 'act_later' }] },
      [{ path: `${AT}.to[0].step`, code: 'UNKNOWN_STEP' }],
    ],
    [
      'Reply-To from a text field',
      { reply_to: { field: F.contact } },
      [{ path: `${AT}.reply_to.field`, code: 'EMAIL_REPLY_TO_INVALID' }],
    ],
    [
      'Reply-To clicked_by without a button trigger',
      { reply_to: { trigger: 'clicked_by' } },
      [{ path: `${AT}.reply_to.trigger`, code: 'UNSUPPORTED_VALUE_SOURCE' }],
    ],
    [
      'REGEX in the subject',
      { subject: { template: `{{ REGEXMATCH([${F.title}], "a") }}` } },
      [{ path: `${AT}.subject.template`, code: 'UNSUPPORTED_FUNCTION' }],
    ],
    [
      'REGEX in the body',
      { body: { format: 'markdown', template: `{{ REGEXREPLACE([${F.title}], "a", "b") }}` } },
      [{ path: `${AT}.body.template`, code: 'UNSUPPORTED_FUNCTION' }],
    ],
    [
      '[@digest] without a digest',
      { body: { format: 'markdown', template: '{{ [@digest] }}' } },
      [{ path: `${AT}.body.template`, code: 'UNKNOWN_FIELD' }],
    ],
  ])('%s', (_name, config, expected) => {
    expect(errorsOf([email(config)])).toEqual(expected);
  });

  it('checks fields with the saver’s permissions (Sales cannot read cost)', () => {
    expect(
      errorsOf(
        [email({ body: { format: 'markdown', template: `Giá vốn {{ [${F.cost}] }}` } })],
        SALES,
      ),
    ).toEqual([{ path: `${AT}.body.template`, code: 'UNKNOWN_FIELD' }]);
  });

  it('a digest of an earlier find_records step goes where the body says [@digest]', () => {
    const find = {
      id: 'act_find',
      type: 'find_records',
      config: { table_id: ORDERS, fields: [F.title] },
    };
    const digest = { step: 'act_find', row_template: `- {{ [${F.title}] }}` };
    expect(
      errorsOf([
        find,
        email({ body: { format: 'markdown', template: 'Danh sách:\n\n{{ [@digest] }}', digest } }),
      ]),
    ).toEqual([]);
    expect(
      errorsOf([
        { id: 'act_up', type: 'update_record', config: { table_id: ORDERS, fields: {} } },
        email({
          body: {
            format: 'markdown',
            template: '{{ [@digest] }}',
            digest: { step: 'act_up', row_template: 'x' },
          },
        }),
      ]),
    ).toEqual([
      {
        path: 'definition.actions[1].config.body.digest.step',
        code: 'UNSUPPORTED_VALUE_SOURCE',
      },
    ]);
  });

  it('a trigger without record: fields cannot be recipients, literals can', () => {
    const schedule = { type: 'schedule', cron: '0 8 * * *' } as const;
    expect(
      errorsOf(
        [email({ to: [{ field: F.owner }], subject: { template: 'Báo cáo' } })],
        ADMIN,
        schedule,
      ),
    ).toEqual([{ path: `${AT}.to[0]`, code: 'UNSUPPORTED_VALUE_SOURCE' }]);
    expect(
      errorsOf(
        [email({ to: [{ literal: 'team@b.vn' }], subject: { template: 'Báo cáo' } })],
        ADMIN,
        schedule,
      ),
    ).toEqual([]);
  });
});
