import {
  automationDefinitionSchema,
  type AutomationDefinitionInput,
  type EffectiveAccess,
  type Id,
  type TableAccess,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  notificationReferences,
  permissionProfileKey,
  summaryBody,
  summaryTitle,
  validateAutomationDefinition,
  type AutomationFieldMeta,
  type AutomationValidationContext,
} from '../../src/automation/index.js';

import type { MemberBaseAccess } from '../../src/import/member-access.js';

const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const CUSTOMERS: Id<'tbl'> = 'tbl_CustomersTable01';
const F = {
  title: 'fld_OrdersTitle00001',
  amount: 'fld_OrdersAmount0001',
  cost: 'fld_OrdersCost000001',
  owner: 'fld_OrdersOwner00001',
  customer: 'fld_OrdersCustomer01',
  name: 'fld_CustomersName001',
  total: 'fld_CustomersTotal01',
} as const satisfies Record<string, Id<'fld'>>;
const USER_A: Id<'usr'> = 'usr_NotifUserA000001';
const GROUP: Id<'grp'> = 'grp_NotifGroup000001';

const FIELDS: AutomationFieldMeta[] = [
  { id: F.title, table_id: ORDERS, name: 'title', type: 'text', options: {} },
  { id: F.amount, table_id: ORDERS, name: 'amount', type: 'number', options: {} },
  { id: F.cost, table_id: ORDERS, name: 'cost', type: 'number', options: {} },
  { id: F.owner, table_id: ORDERS, name: 'owner', type: 'user', options: {} },
  {
    id: F.customer,
    table_id: ORDERS,
    name: 'customer',
    type: 'link',
    options: { link_table: CUSTOMERS },
  },
  { id: F.name, table_id: CUSTOMERS, name: 'name', type: 'text', options: {} },
  { id: F.total, table_id: CUSTOMERS, name: 'total', type: 'number', options: {} },
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

const ordersFields = (except: string[] = []) =>
  Object.fromEntries(
    [F.title, F.amount, F.cost, F.owner, F.customer]
      .filter((id) => !except.includes(id))
      .map((id) => [id, 'edit' as const]),
  );

const ADMIN: EffectiveAccess = {
  role: null,
  is_admin: true,
  base_rule: { copy: true, download: true, share_link: true },
  tables: {
    [ORDERS]: tableAccess(ordersFields()),
    [CUSTOMERS]: tableAccess({ [F.name]: 'edit', [F.total]: 'edit' }),
  },
  dashboards: {},
};
/** `cost` hidden, no Customers (CONTRACTS §5 Sales). */
const SALES: EffectiveAccess = {
  ...ADMIN,
  is_admin: false,
  tables: { [ORDERS]: tableAccess(ordersFields([F.cost])) },
};

function context(access: EffectiveAccess): AutomationValidationContext {
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

function notify(config: Record<string, unknown>, id = 'act_note') {
  return {
    id,
    type: 'send_notification' as const,
    config: {
      recipients: [{ field: F.owner }],
      title: { template: `Đơn {{ [${F.title}] }}` },
      ...config,
    } as never,
  };
}

const find = {
  id: 'act_find',
  type: 'find_records' as const,
  config: { table_id: ORDERS, fields: [F.title] },
};
const create = {
  id: 'act_new',
  type: 'create_record' as const,
  config: { table_id: ORDERS, fields: { [F.title]: { literal: 'x' } } },
};

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
const AT1 = 'definition.actions[1].config';

describe('validateAutomationDefinition: send_notification (BACKLOG T515)', () => {
  it('accepts every recipient kind, fills defaults and stores templates by id', () => {
    const result = validateAutomationDefinition(
      automationDefinitionSchema.parse({
        trigger: onCreate,
        actions: [
          create,
          notify({
            recipients: [
              { field: F.owner },
              { user_ids: [USER_A] },
              { group_id: GROUP },
              { step: 'act_new', path: 'id' },
            ],
            body: { template: `Khách {{ [${F.customer}].[${F.name}] }}` },
            link_record: { step: 'act_new' },
          }),
        ],
      }),
      context(ADMIN),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.actions[1]).toMatchObject({
      type: 'send_notification',
      config: {
        skip_actor: false,
        title: { template: `Đơn {{ [${F.title}] }}` },
        body: { template: `Khách {{ [${F.customer}].[${F.name}] }}` },
        link_record: { step: 'act_new' },
      },
    });
    const defaults = automationDefinitionSchema.parse({ trigger: onCreate, actions: [notify({})] })
      .actions[0];
    expect(defaults).toMatchObject({ config: { link_record: 'trigger', body: { template: '' } } });
  });

  it.each([
    [
      'a field that is not a user field',
      [notify({ recipients: [{ field: F.title }] })],
      ADMIN,
      onCreate,
      [{ path: `${AT}.recipients[0].field`, code: 'INVALID_FIELD_TYPE' }],
    ],
    [
      'a recipient field the saver cannot read',
      [notify({ recipients: [{ field: F.cost }] })],
      SALES,
      onCreate,
      [{ path: `${AT}.recipients[0].field`, code: 'UNKNOWN_FIELD' }],
    ],
    [
      'clicked_by without a button trigger',
      [notify({ recipients: [{ trigger: 'clicked_by' }] })],
      ADMIN,
      onCreate,
      [{ path: `${AT}.recipients[0].trigger`, code: 'UNSUPPORTED_VALUE_SOURCE' }],
    ],
    [
      'a step that does not come earlier',
      [notify({ recipients: [{ step: 'act_later' }] })],
      ADMIN,
      onCreate,
      [{ path: `${AT}.recipients[0].step`, code: 'UNKNOWN_STEP' }],
    ],
    [
      'REGEX in the title',
      [notify({ title: { template: `{{ REGEXMATCH([${F.title}], "a") }}` } })],
      ADMIN,
      onCreate,
      [{ path: `${AT}.title.template`, code: 'UNSUPPORTED_FUNCTION' }],
    ],
    [
      'a field the saver cannot read in the body',
      [notify({ body: { template: `{{ [${F.cost}] }}` } })],
      SALES,
      onCreate,
      [{ path: `${AT}.body.template`, code: 'UNKNOWN_FIELD' }],
    ],
    [
      'a find_records record in the body (Câu hỏi mở S5 #3)',
      [find, notify({ body: { template: `{{ [act_find].[${F.title}] }}` } })],
      ADMIN,
      onCreate,
      [{ path: `${AT1}.body.template`, code: 'UNSUPPORTED_VALUE_SOURCE' }],
    ],
    [
      'a digest in the body',
      [notify({ body: { template: '{{ [@digest] }}' } })],
      ADMIN,
      onCreate,
      [{ path: `${AT}.body.template`, code: 'UNSUPPORTED_VALUE_SOURCE' }],
    ],
    [
      'a field without trigger record',
      [notify({ recipients: [{ user_ids: [USER_A] }] })],
      ADMIN,
      { type: 'schedule', cron: '0 8 * * *' },
      [{ path: `${AT}.title.template`, code: 'NO_TRIGGER_RECORD' }],
    ],
    [
      'linking the record of find_records',
      [find, notify({ link_record: { step: 'act_find' } })],
      ADMIN,
      onCreate,
      [{ path: `${AT1}.link_record.step`, code: 'UNSUPPORTED_VALUE_SOURCE' }],
    ],
    [
      'linking a step that does not come earlier',
      [notify({ link_record: { step: 'act_new' } }), create],
      ADMIN,
      onCreate,
      [{ path: `${AT}.link_record.step`, code: 'UNKNOWN_STEP' }],
    ],
  ] as const)('refuses %s', (_name, actions, access, trigger, expected) => {
    expect(errorsOf([...actions], access, trigger as never)).toEqual(expected);
  });

  it('allows clicked_by on a button trigger and literals without trigger record', () => {
    expect(
      errorsOf(
        [
          notify({
            recipients: [{ user_ids: [USER_A] }],
            title: { template: 'Báo cáo {{ TEXT([@fired_at], "dd/MM") }}' },
            link_record: 'trigger',
          }),
        ],
        ADMIN,
        { type: 'schedule', cron: '0 8 * * *' },
      ),
    ).toEqual([]);
  });

  it('rejects more than 100 fixed users and unknown keys by schema', () => {
    const many = Array.from(
      { length: 101 },
      (_, i) => `usr_NotifUser${String(i).padStart(7, '0')}`,
    );
    expect(
      automationDefinitionSchema.safeParse({
        trigger: onCreate,
        actions: [notify({ recipients: [{ user_ids: many }] })],
      }).success,
    ).toBe(false);
    expect(
      automationDefinitionSchema.safeParse({
        trigger: onCreate,
        actions: [notify({ digest: { step: 'act_find', row_template: '' } })],
      }).success,
    ).toBe(false);
  });
});

describe('notificationReferences (BACKLOG T515)', () => {
  const sources = { trigger: ['@fired_at' as const], steps: new Map([['act_new', ORDERS]]) };

  it.each([
    ['plain text', ['Xin chào'], { fields: {}, triggerRecord: false, steps: [] }],
    [
      'a field of the trigger record',
      [`{{ [${F.title}] }}`],
      { fields: { [F.title]: ORDERS }, triggerRecord: true, steps: [] },
    ],
    [
      'a field along a link (link field included)',
      [`{{ [${F.customer}].[${F.total}] }}`],
      {
        fields: { [F.customer]: ORDERS, [F.total]: CUSTOMERS },
        triggerRecord: true,
        steps: [],
      },
    ],
    [
      'a step record field',
      [`{{ [act_new].[${F.amount}] }}`],
      { fields: { [F.amount]: ORDERS }, triggerRecord: false, steps: ['act_new'] },
    ],
    ['trigger data only', ['{{ [@fired_at] }}'], { fields: {}, triggerRecord: false, steps: [] }],
    [
      'a field run_as cannot read still counts (whole base)',
      [`{{ [${F.cost}] }}`, ''],
      { fields: { [F.cost]: ORDERS }, triggerRecord: true, steps: [] },
    ],
  ])('%s', (_name, templates, expected) => {
    const found = notificationReferences(templates, context(SALES), ORDERS, sources);
    expect({
      fields: Object.fromEntries(found.fields),
      triggerRecord: found.triggerRecord,
      steps: [...found.steps],
    }).toEqual(expected);
  });
});

describe('permissionProfileKey (BACKLOG T515)', () => {
  function member(
    userId: Id<'usr'>,
    access: EffectiveAccess,
    readFilters: Record<string, unknown> = {},
    groupMemberUserIds: Id<'usr'>[] = [],
  ): MemberBaseAccess {
    return {
      isAdmin: access.is_admin,
      record: {
        baseId: 'bse_NotifBase0000001',
        resolved: { access, internal: { readFilters, editFilters: {} } } as never,
        userId,
        groupMemberUserIds,
        timeZone: 'UTC',
        locale: 'vi',
      },
    };
  }
  const other: Id<'usr'> = 'usr_NotifUserB000001';
  const mine = {
    [ORDERS]: { field: F.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
  };

  it.each([
    ['same roles, no personal rule', member(USER_A, SALES), member(other, SALES), 1, 1, true],
    ['another permission_version', member(USER_A, SALES), member(other, SALES), 1, 2, false],
    ['different access', member(USER_A, SALES), member(other, ADMIN), 1, 1, false],
    [
      'a read rule on current_user is personal',
      member(USER_A, SALES, mine),
      member(other, SALES, mine),
      1,
      1,
      false,
    ],
    [
      'same impersonal read rule',
      member(USER_A, SALES, { [ORDERS]: { field: F.amount, operator: 'gte', value: 5 } }),
      member(other, SALES, { [ORDERS]: { field: F.amount, operator: 'gte', value: 5 } }),
      1,
      1,
      true,
    ],
  ])('%s', (_name, a, b, versionA, versionB, same) => {
    expect(permissionProfileKey(a, versionA) === permissionProfileKey(b, versionB)).toBe(same);
  });

  it('canonicalJson sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('summary text (BACKLOG T515)', () => {
  it.each([
    ['vi', 3, 'Nhắc việc', '3 tin từ automation «Nhắc việc»'],
    ['en', 1_250, 'Reminders', '1,250 messages from automation «Reminders»'],
    ['fr', 2, 'Line\nbreak', '2 messages from automation «Line break»'],
  ])('%s', (locale, count, name, expected) => {
    expect(summaryTitle(locale, count, name)).toBe(expected);
  });

  it('cuts the title at 200 characters and states the limit in the body', () => {
    expect(Array.from(summaryTitle('vi', 5, 'x'.repeat(400)))).toHaveLength(200);
    expect(summaryBody('vi', 100)).toContain('100');
  });
});
