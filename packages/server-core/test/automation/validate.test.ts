import {
  automationDefinitionSchema,
  type AutomationDefinitionInput,
  type EffectiveAccess,
  type Id,
  type TableAccess,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  canManageAutomation,
  canSeeAutomation,
  managedTableIds,
  managesAnyAutomation,
  validateAutomationDefinition,
  type AutomationFieldMeta,
  type AutomationValidationContext,
} from '../../src/automation/index.js';

const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const CUSTOMERS: Id<'tbl'> = 'tbl_CustomersTable01';
const TRASHED: Id<'tbl'> = 'tbl_TrashedTable0001';
const F = {
  title: 'fld_OrdersTitle00001',
  amount: 'fld_OrdersAmount0001',
  cost: 'fld_OrdersCost000001',
  status: 'fld_OrdersStatus0001',
  owner: 'fld_OrdersOwner00001',
  due: 'fld_OrdersDue0000001',
  total: 'fld_OrdersTotal00001',
  name: 'fld_CustomersName001',
} as const satisfies Record<string, Id<'fld'>>;
const OPT_NEW = 'opt_StatusNew0000001';
const OPT_DONE = 'opt_StatusDone000001';
const FORM: Id<'viw'> = 'viw_OrdersForm000001';
const GRID: Id<'viw'> = 'viw_OrdersGrid000001';

const FIELDS: AutomationFieldMeta[] = [
  { id: F.title, table_id: ORDERS, name: 'title', type: 'text', options: {} },
  { id: F.amount, table_id: ORDERS, name: 'amount', type: 'number', options: {} },
  { id: F.cost, table_id: ORDERS, name: 'cost', type: 'number', options: {} },
  {
    id: F.status,
    table_id: ORDERS,
    name: 'status',
    type: 'select',
    options: {
      multiple: false,
      options: [
        { id: OPT_NEW, name: 'Mới', color: 1 },
        { id: OPT_DONE, name: 'Xong', color: 2 },
      ],
    },
  },
  { id: F.owner, table_id: ORDERS, name: 'owner', type: 'user', options: {} },
  { id: F.due, table_id: ORDERS, name: 'due', type: 'datetime', options: {} },
  { id: F.total, table_id: ORDERS, name: 'total', type: 'formula', options: {} },
  { id: F.name, table_id: CUSTOMERS, name: 'name', type: 'text', options: {} },
];

function tableAccess(
  perm: TableAccess['perm'],
  fields: Record<string, 'read' | 'create' | 'edit'>,
  operations: TableAccess['operations'] = ['add', 'delete'],
): TableAccess {
  return {
    perm,
    operations,
    view_rule: { allow_edit: true, visible_views: null },
    read_scope: 'all',
    fields,
    option_edit_fields: [],
    file_download_fields: [],
  };
}

const allOrders = {
  [F.title]: 'edit',
  [F.amount]: 'edit',
  [F.cost]: 'edit',
  [F.status]: 'edit',
  [F.owner]: 'edit',
  [F.due]: 'edit',
  [F.total]: 'read',
} as const;

const ADMIN: EffectiveAccess = {
  role: null,
  is_admin: true,
  base_rule: { copy: true, download: true, share_link: true },
  tables: {
    [ORDERS]: tableAccess('manage', allOrders),
    [CUSTOMERS]: tableAccess('manage', { [F.name]: 'edit' }),
  },
  dashboards: {},
};

/** CONTRACTS §5 role Sales, P32 variant: `manage` on Orders, `cost` hidden, `status` read. */
const SALES: EffectiveAccess = {
  role: null,
  is_admin: false,
  base_rule: { copy: false, download: false, share_link: false },
  tables: {
    [ORDERS]: {
      ...tableAccess(
        'manage',
        {
          [F.title]: 'edit',
          [F.amount]: 'edit',
          [F.status]: 'read',
          [F.owner]: 'edit',
          [F.due]: 'edit',
          [F.total]: 'read',
        },
        ['add'],
      ),
      view_rule: { allow_edit: false, visible_views: [GRID] },
    },
  },
  dashboards: {},
};

const EDITOR: EffectiveAccess = {
  ...ADMIN,
  is_admin: false,
  tables: {
    [ORDERS]: tableAccess('edit', allOrders),
    [CUSTOMERS]: tableAccess('read_only', { [F.name]: 'read' }),
  },
};

function context(access: EffectiveAccess, extra: Partial<AutomationValidationContext> = {}) {
  return {
    tables: [{ id: ORDERS }, { id: CUSTOMERS }],
    fields: FIELDS,
    access,
    views: new Map([
      [FORM, { id: FORM, table_id: ORDERS, type: 'form', is_personal: false }],
      [GRID, { id: GRID, table_id: ORDERS, type: 'grid', is_personal: false }],
    ]),
    ...extra,
  } satisfies AutomationValidationContext;
}

const onCreate = { type: 'record.created', table_id: ORDERS } as const;

function check(input: AutomationDefinitionInput, access: EffectiveAccess = ADMIN, extra = {}) {
  return validateAutomationDefinition(
    automationDefinitionSchema.parse(input),
    context(access, extra),
  );
}

function errorsOf(input: AutomationDefinitionInput, access: EffectiveAccess = ADMIN, extra = {}) {
  const result = check(input, access, extra);
  return result.ok ? [] : result.errors.map(({ path, code }) => ({ path, code }));
}

const update = (id: string, table: Id<'tbl'>, fields: Record<string, unknown>) => ({
  id,
  type: 'update_record' as const,
  config: { table_id: table, fields: fields as never },
});

describe('validateAutomationDefinition (ADR-25 §3, BACKLOG T502)', () => {
  it('accepts a definition within the saver’s permissions and normalises filters', () => {
    const result = check(
      {
        trigger: { type: 'record.updated', table_id: ORDERS, watch_fields: [F.status] },
        condition: { field: F.status, operator: 'changed_to', value: 'Xong' },
        actions: [
          update('act_1', ORDERS, { [F.amount]: { literal: 1 } }),
          {
            id: 'act_2',
            type: 'find_records',
            config: {
              table_id: ORDERS,
              filter: { logic: 'and', conditions: [[F.status, '==', 'Mới']] },
              fields: [F.title],
            },
          },
          {
            id: 'act_3',
            type: 'if',
            config: {
              conditions: [
                {
                  value: { step: 'act_2', path: 'count' },
                  operator: 'gt',
                  compare: { literal: 0 },
                },
              ],
              then: [
                update('act_4', ORDERS, { [F.title]: { step: 'act_2', path: 'records[0].id' } }),
              ],
            },
          },
        ],
      },
      SALES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.triggerTableId).toBe(ORDERS);
    expect(result.definition.condition).toEqual({
      field: F.status,
      operator: 'changed_to',
      value: OPT_DONE,
    });
    const find = result.definition.actions[1];
    expect(find?.type === 'find_records' && find.config.filter).toEqual({
      op: 'and',
      items: [{ field: F.status, operator: 'is', value: OPT_NEW }],
    });
  });

  it.each([
    [
      'P32: update_record into Customers (unreadable)',
      { trigger: onCreate, actions: [update('act_1', CUSTOMERS, { [F.name]: { literal: 'x' } })] },
      [{ path: 'definition.actions[0].config.table_id', code: 'UNKNOWN_TABLE' }],
    ],
    [
      'P32: writing the hidden field cost',
      { trigger: onCreate, actions: [update('act_1', ORDERS, { [F.cost]: { literal: 1 } })] },
      [{ path: `definition.actions[0].config.fields.${F.cost}`, code: 'UNKNOWN_FIELD' }],
    ],
    [
      'writing a read-only field',
      {
        trigger: onCreate,
        actions: [update('act_1', ORDERS, { [F.status]: { literal: OPT_DONE } })],
      },
      [{ path: `definition.actions[0].config.fields.${F.status}`, code: 'PERMISSION_DENIED' }],
    ],
    [
      'a condition on the hidden field',
      { trigger: onCreate, condition: { field: F.cost, operator: 'is_empty' } },
      [{ path: 'definition.condition.field', code: 'UNKNOWN_FIELD' }],
    ],
    [
      'reading a hidden field into a value',
      { trigger: onCreate, actions: [update('act_1', ORDERS, { [F.title]: { field: F.cost } })] },
      [{ path: `definition.actions[0].config.fields.${F.title}.field`, code: 'UNKNOWN_FIELD' }],
    ],
    [
      'deleting without the delete operation',
      { trigger: onCreate, actions: [{ id: 'act_1', type: 'delete_record' }] },
      [{ path: 'definition.actions[0]', code: 'PERMISSION_DENIED' }],
    ],
    [
      'find_records on an unreadable table',
      {
        trigger: onCreate,
        actions: [{ id: 'act_1', type: 'find_records', config: { table_id: CUSTOMERS } }],
      },
      [{ path: 'definition.actions[0].config.table_id', code: 'UNKNOWN_TABLE' }],
    ],
    [
      'a form view outside visible_views',
      { trigger: { type: 'form.submitted', view_id: FORM } },
      [{ path: 'definition.trigger.view_id', code: 'UNKNOWN_VIEW' }],
    ],
  ] as const)('rejects %s for u_sales1', (_name, input, expected) => {
    expect(errorsOf(input as AutomationDefinitionInput, SALES)).toEqual(expected);
  });

  it.each([
    [
      'a writable computed field',
      { trigger: onCreate, actions: [update('act_1', ORDERS, { [F.total]: { literal: 1 } })] },
      [{ path: `definition.actions[0].config.fields.${F.total}`, code: 'FIELD_READ_ONLY' }],
    ],
    [
      'a trashed or unknown trigger table',
      { trigger: { type: 'record.created', table_id: TRASHED } },
      [{ path: 'definition.trigger.table_id', code: 'UNKNOWN_TABLE' }],
    ],
    [
      'a field of another table',
      { trigger: { type: 'record.updated', table_id: ORDERS, watch_fields: [F.name] } },
      [{ path: 'definition.trigger.watch_fields[0]', code: 'UNKNOWN_FIELD' }],
    ],
    [
      'the same watched field twice',
      { trigger: { type: 'record.updated', table_id: ORDERS, watch_fields: [F.title, F.title] } },
      [{ path: 'definition.trigger.watch_fields', code: 'DUPLICATE_FIELD' }],
    ],
    [
      'a grid view as form trigger',
      { trigger: { type: 'form.submitted', view_id: GRID } },
      [{ path: 'definition.trigger.view_id', code: 'UNKNOWN_VIEW' }],
    ],
    [
      'a date trigger on a text field',
      { trigger: { type: 'record.date_reached', table_id: ORDERS, field_id: F.title } },
      [{ path: 'definition.trigger.field_id', code: 'INVALID_FIELD_TYPE' }],
    ],
    [
      'a button trigger before button fields exist (T517)',
      { trigger: { type: 'button.clicked', table_id: ORDERS, field_id: F.title } },
      [{ path: 'definition.trigger.field_id', code: 'INVALID_FIELD_TYPE' }],
    ],
    [
      'a bad operator in record.matches',
      {
        trigger: {
          type: 'record.matches',
          table_id: ORDERS,
          condition: { field: F.status, operator: 'changed', value: null },
        },
      },
      [{ path: 'definition.trigger.condition.operator', code: 'OPERATOR_NOT_ALLOWED' }],
    ],
    [
      'record.matches without any condition (T510)',
      {
        trigger: { type: 'record.matches', table_id: ORDERS, condition: { op: 'and', items: [] } },
      },
      [{ path: 'definition.trigger.condition', code: 'EMPTY_FILTER' }],
    ],
    [
      'record.matches with only an empty group (T510)',
      {
        trigger: {
          type: 'record.matches',
          table_id: ORDERS,
          condition: { op: 'or', items: [{ op: 'and', items: [] }] },
        },
      },
      [{ path: 'definition.trigger.condition', code: 'EMPTY_FILTER' }],
    ],
    [
      'a condition on a schedule',
      {
        trigger: { type: 'schedule', cron: '0 8 * * *' },
        condition: { field: F.title, operator: 'is_empty' },
      },
      [{ path: 'definition.condition', code: 'NO_TRIGGER_RECORD' }],
    ],
    [
      'update_record of the trigger record on a schedule',
      { trigger: { type: 'schedule', cron: '0 8 * * *' }, actions: [update('act_1', ORDERS, {})] },
      [{ path: 'definition.actions[0].config.record_id', code: 'NO_TRIGGER_RECORD' }],
    ],
    [
      'update_record of the trigger record in another table',
      { trigger: onCreate, actions: [update('act_1', CUSTOMERS, {})] },
      [{ path: 'definition.actions[0].config.table_id', code: 'NOT_TRIGGER_TABLE' }],
    ],
    [
      'a field value without trigger record',
      {
        trigger: { type: 'schedule', cron: '0 8 * * *' },
        actions: [
          {
            id: 'act_1',
            type: 'create_record',
            config: { table_id: ORDERS, fields: { [F.title]: { field: F.title } } },
          },
        ],
      },
      [
        {
          path: `definition.actions[0].config.fields.${F.title}`,
          code: 'UNSUPPORTED_VALUE_SOURCE',
        },
      ],
    ],
    [
      'trigger data the trigger does not have',
      {
        trigger: onCreate,
        actions: [update('act_1', ORDERS, { [F.title]: { trigger: 'fired_at' } })],
      },
      [
        {
          path: `definition.actions[0].config.fields.${F.title}.trigger`,
          code: 'UNSUPPORTED_VALUE_SOURCE',
        },
      ],
    ],
    [
      'a step that comes later',
      {
        trigger: onCreate,
        actions: [
          update('act_1', ORDERS, { [F.title]: { step: 'act_2' } }),
          { id: 'act_2', type: 'find_records', config: { table_id: ORDERS } },
        ],
      },
      [{ path: `definition.actions[0].config.fields.${F.title}.step`, code: 'UNKNOWN_STEP' }],
    ],
    [
      'a digest of an unknown step',
      {
        trigger: { type: 'schedule', cron: '0 8 * * *' },
        actions: [
          {
            id: 'act_1',
            type: 'create_record',
            config: {
              table_id: ORDERS,
              fields: { [F.title]: { digest: { step: 'act_9', row_template: 'x' } } },
            },
          },
        ],
      },
      [
        {
          path: `definition.actions[0].config.fields.${F.title}.digest.step`,
          code: 'UNKNOWN_STEP',
        },
      ],
    ],
    [
      'duplicate action ids, also inside branches',
      {
        trigger: onCreate,
        actions: [
          { id: 'act_1', type: 'delay', config: { minutes: 5 } },
          {
            id: 'act_2',
            type: 'if',
            config: {
              conditions: [{ filter: { field: F.title, operator: 'is_not_empty' } }],
              else: [{ id: 'act_1', type: 'delay', config: { minutes: 5 } }],
            },
          },
        ],
      },
      [{ path: 'definition.actions[1].config.else[0].id', code: 'DUPLICATE_ACTION_ID' }],
    ],
    [
      'a recheck on a schedule',
      {
        trigger: { type: 'schedule', cron: '0 8 * * *' },
        actions: [
          {
            id: 'act_1',
            type: 'delay',
            config: { minutes: 5, recheck_condition: { field: F.title, operator: 'is_empty' } },
          },
        ],
      },
      [{ path: 'definition.actions[0].config.recheck_condition', code: 'NO_TRIGGER_RECORD' }],
    ],
    [
      'an unknown sort field of find_records',
      {
        trigger: onCreate,
        actions: [
          {
            id: 'act_1',
            type: 'find_records',
            config: { table_id: ORDERS, sort: [{ field: F.name }] },
          },
        ],
      },
      [{ path: 'definition.actions[0].config.sort[0].field', code: 'UNKNOWN_FIELD' }],
    ],
  ] as const)('rejects %s', (_name, input, expected) => {
    expect(errorsOf(input as AutomationDefinitionInput)).toEqual(expected);
  });

  it('counts if branches towards the 20 actions (21 → TOO_MANY_ACTIONS)', () => {
    const delays = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `act_${String(from + i)}`,
        type: 'delay' as const,
        config: { minutes: 1 },
      }));
    const twenty = [
      ...delays(1, 9),
      {
        id: 'act_if',
        type: 'if' as const,
        config: {
          conditions: [{ filter: { field: F.title, operator: 'is_empty' } }],
          then: delays(10, 5),
          else: delays(15, 5),
        },
      },
    ];
    expect(check({ trigger: onCreate, actions: twenty }).ok).toBe(true);
    expect(errorsOf({ trigger: onCreate, actions: [...twenty, ...delays(30, 1)] })).toEqual([
      { path: 'definition.actions', code: 'TOO_MANY_ACTIONS' },
    ]);
  });

  it('treats locked computed fields as hidden in conditions and watches', () => {
    expect(
      errorsOf(
        {
          trigger: { type: 'record.updated', table_id: ORDERS, watch_fields: [F.total] },
          condition: { field: F.total, operator: 'is_empty' },
        },
        ADMIN,
        { lockedFieldIds: new Set([F.total]) },
      ),
    ).toEqual([
      { path: 'definition.trigger.watch_fields[0]', code: 'UNKNOWN_FIELD' },
      { path: 'definition.condition.field', code: 'UNKNOWN_FIELD' },
    ]);
  });

  it('rejects virtual formulas in watch_fields and changed* (T509), stored ones pass', () => {
    const virtual = 'fld_OrdersRecent0001' as Id<'fld'>;
    const stored = 'fld_OrdersStored0001' as Id<'fld'>;
    const fields: AutomationFieldMeta[] = [
      ...FIELDS,
      {
        id: virtual,
        table_id: ORDERS,
        name: 'recent',
        type: 'formula',
        options: {},
        compute_mode: 'virtual',
        result_type: { kind: 'number' },
      },
      {
        id: stored,
        table_id: ORDERS,
        name: 'stored',
        type: 'lookup',
        options: {},
        compute_mode: 'stored',
        result_type: { kind: 'number' },
      },
    ];
    const access: EffectiveAccess = {
      ...ADMIN,
      tables: {
        ...ADMIN.tables,
        [ORDERS]: tableAccess('manage', { ...allOrders, [virtual]: 'read', [stored]: 'read' }),
      },
    };
    const cases: [AutomationDefinitionInput, { path: string; code: string }[]][] = [
      [
        { trigger: { type: 'record.updated', table_id: ORDERS, watch_fields: [F.title, virtual] } },
        [{ path: 'definition.trigger.watch_fields[1]', code: 'INVALID_FIELD_TYPE' }],
      ],
      [
        {
          trigger: { type: 'record.updated', table_id: ORDERS, watch_fields: [F.title] },
          condition: {
            op: 'or',
            items: [
              { field: F.title, operator: 'changed' },
              { op: 'not', item: { field: virtual, operator: 'changed' } },
            ],
          },
        },
        [{ path: 'definition.condition.items[1].item.field', code: 'INVALID_FIELD_TYPE' }],
      ],
      // A virtual field tested on the latest record (not changed*) is fine.
      [
        {
          trigger: { type: 'record.updated', table_id: ORDERS, watch_fields: [stored] },
          condition: {
            op: 'and',
            items: [
              { field: stored, operator: 'changed' },
              { field: virtual, operator: 'is_not_empty' },
            ],
          },
        },
        [],
      ],
      // record.matches (T510): a virtual field never enters a condition through an event.
      [
        {
          trigger: {
            type: 'record.matches',
            table_id: ORDERS,
            condition: {
              op: 'and',
              items: [
                { field: stored, operator: 'gt', value: 10 },
                { op: 'not', item: { field: virtual, operator: 'is_empty' } },
              ],
            },
          },
        },
        [{ path: 'definition.trigger.condition.items[1].item.field', code: 'INVALID_FIELD_TYPE' }],
      ],
      [
        {
          trigger: {
            type: 'record.matches',
            table_id: ORDERS,
            condition: { field: stored, operator: 'gt', value: 10 },
          },
        },
        [],
      ],
    ];
    for (const [input, expected] of cases) {
      expect(errorsOf(input, access, { fields })).toEqual(expected);
    }
    const result = check(
      { trigger: { type: 'record.updated', table_id: ORDERS, watch_fields: [virtual] } },
      access,
      { fields },
    );
    expect(result.ok ? null : result.errors[0]?.params).toEqual({
      expected: 'stored',
      type: 'formula',
      compute_mode: 'virtual',
    });
  });

  it('accepts every trigger with its table for an admin', () => {
    for (const trigger of [
      onCreate,
      { type: 'record.deleted', table_id: ORDERS },
      { type: 'record.date_reached', table_id: ORDERS, field_id: F.due },
      { type: 'form.submitted', view_id: FORM },
      { type: 'schedule', cron: '*/5 * * * *' },
    ] as const) {
      const result = check({ trigger });
      expect(result.ok, trigger.type).toBe(true);
      if (result.ok)
        expect(result.triggerTableId).toBe(trigger.type === 'schedule' ? null : ORDERS);
    }
  });
});

describe('who manages an automation (ADR-25 §3)', () => {
  it.each([
    ['base admin, any trigger', ADMIN, ORDERS, true, true],
    ['base admin, schedule', ADMIN, null, true, true],
    ['manage on the trigger table', SALES, ORDERS, true, true],
    ['manage elsewhere, schedule', SALES, null, false, true],
    ['unreadable trigger table', SALES, CUSTOMERS, false, false],
    ['editor (P31)', EDITOR, ORDERS, false, true],
  ] as const)('%s', (_name, access, table, manages, sees) => {
    expect(canManageAutomation(access, table)).toBe(manages);
    expect(canSeeAutomation(access, table)).toBe(sees);
  });

  it('lets base admins see automations whose trigger table is in the trash', () => {
    expect(canSeeAutomation(ADMIN, TRASHED)).toBe(true);
    expect(canManageAutomation(ADMIN, TRASHED)).toBe(true);
    expect(canSeeAutomation(SALES, TRASHED)).toBe(false);
  });

  it('lists the managed tables', () => {
    expect(managedTableIds(SALES)).toEqual([ORDERS]);
    expect(managesAnyAutomation(SALES)).toBe(true);
    expect(managesAnyAutomation(EDITOR)).toBe(false);
    expect(managesAnyAutomation(ADMIN)).toBe(true);
  });
});

describe('update_records filter values and delay until (BACKLOG T506)', () => {
  const updateMany = (filter: unknown) => ({
    id: 'act_many',
    type: 'update_records' as const,
    config: {
      table_id: ORDERS,
      filter: filter as never,
      fields: { [F.amount]: { literal: 0 } },
    },
  });

  it.each([
    ['a trigger field', { field: F.title }],
    ['a template', { template: `{{ [${F.title}] }}` }],
    ['a literal', { literal: 'abc' }],
  ])('accepts %s as the whole value of a condition, stored as given', (_label, value) => {
    const filter = {
      op: 'and',
      items: [
        { field: F.title, operator: 'eq', value },
        { field: F.status, operator: 'is', value: OPT_DONE },
      ],
    };
    const result = check({ trigger: onCreate, actions: [updateMany(filter)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = result.definition.actions[0] as { config: { filter: unknown } };
    expect(stored.config.filter).toEqual(filter);
  });

  it('accepts an earlier step value and refuses a later or unknown one', () => {
    const find = {
      id: 'act_find',
      type: 'find_records' as const,
      config: { table_id: ORDERS, fields: [F.title] },
    };
    const filter = { field: F.title, operator: 'eq', value: { step: 'act_find', path: 'count' } };
    expect(errorsOf({ trigger: onCreate, actions: [find, updateMany(filter)] })).toEqual([]);
    expect(errorsOf({ trigger: onCreate, actions: [updateMany(filter), find] })).toEqual([
      { path: 'definition.actions[0].config.filter.value.step', code: 'UNKNOWN_STEP' },
    ]);
  });

  it.each([
    [
      'a value on a no-value operator',
      { field: F.title, operator: 'is_empty', value: { field: F.title } },
      [{ path: 'definition.actions[0].config.filter.value', code: 'VALUE_NOT_ALLOWED' }],
    ],
    [
      'an operator the field does not take',
      {
        op: 'and',
        items: [{ field: F.amount, operator: 'starts_with', value: { field: F.title } }],
      },
      [
        {
          path: 'definition.actions[0].config.filter.items[0].operator',
          code: 'OPERATOR_NOT_ALLOWED',
        },
      ],
    ],
    [
      'a hidden field (as unknown)',
      { field: F.cost, operator: 'eq', value: { field: F.amount } },
      [{ path: 'definition.actions[0].config.filter.field', code: 'UNKNOWN_FIELD' }],
    ],
    [
      'a value reading a field the saver cannot read',
      { field: F.amount, operator: 'eq', value: { field: F.cost } },
      [{ path: 'definition.actions[0].config.filter.value.field', code: 'UNKNOWN_FIELD' }],
    ],
  ])('reports %s', (_label, filter, errors) => {
    expect(errorsOf({ trigger: onCreate, actions: [updateMany(filter)] }, SALES)).toEqual(
      expect.arrayContaining(errors),
    );
  });

  it('still validates plain literal values', () => {
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [updateMany({ field: F.amount, operator: 'eq', value: 'not a number' })],
      }),
    ).toEqual([{ path: 'definition.actions[0].config.filter.value', code: 'INVALID_VALUE' }]);
  });

  it('checks the until value of a delay like any value', () => {
    const delay = (until: unknown) => ({
      id: 'act_wait',
      type: 'delay' as const,
      config: { until: until as never },
    });
    const schedule = { type: 'schedule', cron: '0 9 * * *' } as const;
    expect(errorsOf({ trigger: onCreate, actions: [delay({ field: F.due })] })).toEqual([]);
    expect(errorsOf({ trigger: schedule, actions: [delay({ field: F.due })] })).toEqual([
      { path: 'definition.actions[0].config.until', code: 'UNSUPPORTED_VALUE_SOURCE' },
    ]);
    expect(errorsOf({ trigger: schedule, actions: [delay({ trigger: 'fired_at' })] })).toEqual([]);
  });
});

describe('time triggers at save (BACKLOG T508)', () => {
  it.each([
    ['every 5 minutes', '*/5 * * * *', null, []],
    ['daily at 08:00 in Ho Chi Minh City', '0 8 * * *', 'Asia/Ho_Chi_Minh', []],
    [
      'every minute',
      '*/1 * * * *',
      null,
      [{ path: 'definition.trigger.cron', code: 'CRON_TOO_FREQUENT' }],
    ],
    [
      'two minutes apart',
      '0,2 8 * * *',
      null,
      [{ path: 'definition.trigger.cron', code: 'CRON_TOO_FREQUENT' }],
    ],
    [
      'six fields',
      '0 0 8 * * *',
      null,
      [{ path: 'definition.trigger.cron', code: 'INVALID_CRON' }],
    ],
    ['minute 61', '61 8 * * *', null, [{ path: 'definition.trigger.cron', code: 'INVALID_CRON' }]],
    [
      'an unknown zone',
      '0 8 * * *',
      'Mars/Olympus',
      [{ path: 'definition.trigger.timezone', code: 'INVALID_TIME_ZONE' }],
    ],
  ] as const)('schedule: %s', (_name, cron, timezone, expected) => {
    expect(errorsOf({ trigger: { type: 'schedule', cron, timezone } })).toEqual(expected);
  });

  it('too frequent reports the interval and the minimum', () => {
    const result = check({ trigger: { type: 'schedule', cron: '* * * * *' } });
    expect(result.ok ? null : result.errors[0]?.params).toEqual({
      min_interval_minutes: 5,
      interval_minutes: 1,
    });
  });

  it('record.date_reached: datetime, created_at and stored date formulas; virtual → stored', () => {
    const fld = (id: string, type: string, extra: Partial<AutomationFieldMeta> = {}) =>
      ({ id: id as Id<'fld'>, table_id: ORDERS, name: id, type, options: {}, ...extra }) as const;
    const created = fld('fld_OrdersCreated001', 'created_at');
    const stored = fld('fld_OrdersStoredDue1', 'formula', {
      compute_mode: 'stored',
      result_type: { kind: 'date' },
    });
    const virtual = fld('fld_OrdersVirtualDu1', 'formula', {
      compute_mode: 'virtual',
      result_type: { kind: 'datetime' },
    });
    const number = fld('fld_OrdersStoredNum1', 'formula', {
      compute_mode: 'stored',
      result_type: { kind: 'number' },
    });
    const fields = [...FIELDS, created, stored, virtual, number];
    const access: EffectiveAccess = {
      ...ADMIN,
      tables: {
        ...ADMIN.tables,
        [ORDERS]: tableAccess('manage', {
          ...allOrders,
          [created.id]: 'read',
          [stored.id]: 'read',
          [virtual.id]: 'read',
          [number.id]: 'read',
        }),
      },
    };
    const date = (fieldId: string) =>
      check(
        {
          trigger: {
            type: 'record.date_reached',
            table_id: ORDERS,
            field_id: fieldId,
          },
        },
        access,
        { fields },
      );
    expect(date(F.due).ok).toBe(true);
    expect(date(created.id).ok).toBe(true);
    expect(date(stored.id).ok).toBe(true);
    const virtualResult = date(virtual.id);
    expect(virtualResult.ok ? null : virtualResult.errors[0]).toMatchObject({
      path: 'definition.trigger.field_id',
      code: 'INVALID_FIELD_TYPE',
      params: { expected: 'stored', type: 'formula', compute_mode: 'virtual' },
    });
    const numberResult = date(number.id);
    expect(numberResult.ok ? null : numberResult.errors[0]).toMatchObject({
      code: 'INVALID_FIELD_TYPE',
      params: { expected: 'datetime', type: 'formula' },
    });
    // A field the saver cannot read is unknown, whatever its type (P32).
    expect(
      errorsOf(
        { trigger: { type: 'record.date_reached', table_id: ORDERS, field_id: F.cost } },
        SALES,
      ),
    ).toEqual([{ path: 'definition.trigger.field_id', code: 'UNKNOWN_FIELD' }]);
  });
});

describe('webhook.received at save (BACKLOG T604)', () => {
  const HOOK: Id<'hok'> = 'hok_OrdersHook000001';
  const OTHER: Id<'hok'> = 'hok_OtherBaseHook001';
  const hooks = { incomingWebhookIds: new Set<string>([HOOK]) };
  const trigger = { type: 'webhook.received', incoming_webhook_id: HOOK } as const;
  const create = (fields: Record<string, unknown>) => ({
    id: 'act_1',
    type: 'create_record' as const,
    config: { table_id: ORDERS, fields: fields as never },
  });

  it('accepts a live hook of the base, without trigger table, reading body/headers/query', () => {
    const result = check(
      {
        trigger,
        actions: [
          create({
            [F.title]: { trigger: 'body', path: 'customer.email' },
            [F.owner]: { trigger: 'headers', path: 'x-shop-user' },
            [F.amount]: { trigger: 'query', path: 'amount' },
          }),
        ],
      },
      ADMIN,
      hooks,
    );
    expect(result.ok).toBe(true);
    expect(result.ok ? result.triggerTableId : 'error').toBeNull();
  });

  it.each([
    ['another base or deleted', OTHER],
    ['unknown', 'hok_NoSuchHook000001'],
  ] as const)('refuses a hook that is %s: UNKNOWN_WEBHOOK', (_name, id) => {
    expect(
      errorsOf({ trigger: { ...trigger, incoming_webhook_id: id }, actions: [] }, ADMIN, hooks),
    ).toEqual([{ path: 'definition.trigger.incoming_webhook_id', code: 'UNKNOWN_WEBHOOK' }]);
    // No hook list at all (a caller that loaded none): unknown too.
    expect(errorsOf({ trigger: { ...trigger, incoming_webhook_id: id } })).toEqual([
      { path: 'definition.trigger.incoming_webhook_id', code: 'UNKNOWN_WEBHOOK' },
    ]);
  });

  it('refuses any condition (no record): INVALID_CONDITION', () => {
    expect(
      errorsOf(
        { trigger, condition: { field: F.status, operator: 'is_not_empty' }, actions: [] },
        ADMIN,
        hooks,
      ),
    ).toEqual([{ path: 'definition.condition', code: 'INVALID_CONDITION' }]);
  });

  it('has no record: field values and the trigger record are refused, other parts too', () => {
    expect(
      errorsOf(
        {
          trigger,
          actions: [
            create({
              [F.title]: { field: F.title },
              [F.amount]: { trigger: 'fired_at' },
            }),
            { id: 'act_2', type: 'delete_record', config: {} },
          ],
        },
        ADMIN,
        hooks,
      ),
    ).toEqual([
      {
        path: `definition.actions[0].config.fields.${F.title}`,
        code: 'UNSUPPORTED_VALUE_SOURCE',
      },
      {
        path: `definition.actions[0].config.fields.${F.amount}.trigger`,
        code: 'UNSUPPORTED_VALUE_SOURCE',
      },
      { path: 'definition.actions[1]', code: 'NO_TRIGGER_RECORD' },
    ]);
  });

  it('checks [@body…] references in templates; other triggers do not have them', () => {
    const source =
      '{{ [@body.customer.email] }} / {{ UPPER([@query.source]) }} / ' +
      '{{ [@headers.x-shop-topic] }} / {{ [@body.items[0\\].sku] }} / {{ [@body] }} / ' +
      '{{ [@fired_at] }}';
    const template = (text: string) => create({ [F.title]: { template: text } });
    const ok = check({ trigger, actions: [template(source)] }, ADMIN, hooks);
    expect(ok.ok ? null : ok.errors).toBeNull();
    // Stored as written (the reference id is its own name).
    const stored = ok.ok ? ok.definition.actions[0] : undefined;
    expect(stored?.type === 'create_record' ? stored.config.fields[F.title] : null).toEqual({
      template: source,
    });
    // A malformed path is not a reference.
    expect(
      errorsOf({ trigger, actions: [template('{{ [@body..x] }}')] }, ADMIN, hooks).map(
        (error) => error.code,
      ),
    ).toEqual(['INVALID_REFERENCE']);
    // `record.created` has no webhook data.
    expect(
      errorsOf({ trigger: onCreate, actions: [template('{{ [@body.customer] }}')] }).map(
        (error) => error.code,
      ),
    ).toEqual(['UNKNOWN_FIELD']);
  });

  it('is managed by base admins only (no trigger table)', () => {
    expect(canManageAutomation(ADMIN, null)).toBe(true);
    expect(canManageAutomation(SALES, null)).toBe(false);
  });
});
