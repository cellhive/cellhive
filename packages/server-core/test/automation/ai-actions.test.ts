import {
  automationDefinitionSchema,
  type AutomationDefinitionInput,
  type EffectiveAccess,
  type Id,
  type TableAccess,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  checkAiActions,
  validateAutomationDefinition,
  type AutomationFieldMeta,
  type AutomationValidationContext,
} from '../../src/automation/index.js';
import { orgScope } from '../../src/db/repository.js';

import type { AiSettingsState } from '../../src/ai/settings/settings.js';

const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const CUSTOMERS: Id<'tbl'> = 'tbl_CustomersTable01';
const F = {
  title: 'fld_OrdersTitle00001',
  cost: 'fld_OrdersCost000001',
  status: 'fld_OrdersStatus0001',
  tags: 'fld_OrdersTags000001',
  note: 'fld_OrdersNote000001',
  summary: 'fld_OrdersSummary001',
  files: 'fld_OrdersFiles00001',
  customer: 'fld_OrdersCustomer01',
  total: 'fld_OrdersTotal00001',
  name: 'fld_CustomersName001',
} as const satisfies Record<string, Id<'fld'>>;

const select = (multiple: boolean) => ({
  multiple,
  options: [
    { id: 'opt_StatusLow0000001', name: 'Thấp', color: 1 },
    { id: 'opt_StatusHigh000001', name: 'Khẩn', color: 2 },
  ],
});

const FIELDS: AutomationFieldMeta[] = [
  { id: F.title, table_id: ORDERS, name: 'title', type: 'text', options: {} },
  { id: F.cost, table_id: ORDERS, name: 'cost', type: 'number', options: {} },
  { id: F.status, table_id: ORDERS, name: 'status', type: 'select', options: select(false) },
  { id: F.tags, table_id: ORDERS, name: 'tags', type: 'select', options: select(true) },
  { id: F.note, table_id: ORDERS, name: 'note', type: 'text', options: {} },
  {
    id: F.summary,
    table_id: ORDERS,
    name: 'summary',
    type: 'text',
    options: { ai: { task: 'summarize', prompt: `{{ [${F.title}] }}`, instructions: null } },
  },
  { id: F.files, table_id: ORDERS, name: 'files', type: 'attachment', options: {} },
  {
    id: F.customer,
    table_id: ORDERS,
    name: 'customer',
    type: 'link',
    options: { link_table: CUSTOMERS },
  },
  {
    id: F.total,
    table_id: ORDERS,
    name: 'total',
    type: 'formula',
    options: {},
    compute_mode: 'stored',
    result_type: { kind: 'number' },
  },
  { id: F.name, table_id: CUSTOMERS, name: 'name', type: 'text', options: {} },
];

function tableAccess(
  perm: TableAccess['perm'],
  fields: Record<string, 'read' | 'create' | 'edit'>,
): TableAccess {
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

const ORDERS_FIELDS = {
  [F.title]: 'edit',
  [F.cost]: 'edit',
  [F.status]: 'edit',
  [F.tags]: 'edit',
  [F.note]: 'edit',
  // An AI field is read-only to every role (CONTRACTS §29.5).
  [F.summary]: 'read',
  [F.files]: 'edit',
  [F.customer]: 'edit',
  [F.total]: 'read',
} as const;

const ADMIN: EffectiveAccess = {
  role: null,
  is_admin: true,
  base_rule: { copy: true, download: true, share_link: true },
  tables: {
    [ORDERS]: tableAccess('manage', ORDERS_FIELDS),
    [CUSTOMERS]: tableAccess('manage', { [F.name]: 'edit' }),
  },
  dashboards: {},
};

/** CONTRACTS §5 role Sales with `manage` on Orders: `cost` hidden, `status` read only. */
const SALES: EffectiveAccess = {
  ...ADMIN,
  is_admin: false,
  tables: {
    [ORDERS]: tableAccess('manage', {
      [F.title]: 'edit',
      [F.status]: 'read',
      [F.tags]: 'edit',
      [F.note]: 'edit',
      [F.summary]: 'read',
      [F.files]: 'edit',
      [F.customer]: 'edit',
      [F.total]: 'read',
    }),
  },
};

function context(access: EffectiveAccess): AutomationValidationContext {
  return {
    tables: [{ id: ORDERS }, { id: CUSTOMERS }],
    fields: FIELDS,
    access,
    // The formula `total` reads another record (a link): no AI prompt source.
    aiCrossRecord: (ids) => ids.filter((id) => id === F.total),
  };
}

const onCreate = { type: 'record.created', table_id: ORDERS } as const;

const generate = (prompt: string, target: string | null = null, id = 'act_ai') => ({
  id,
  type: 'ai_generate_text' as const,
  config: { prompt, target_field_id: target as Id<'fld'> | null },
});
const classify = (input: string, target: string, id = 'act_cls') => ({
  id,
  type: 'ai_classify' as const,
  config: { input, target_field_id: target as Id<'fld'> },
});

function check(input: AutomationDefinitionInput, access: EffectiveAccess = ADMIN) {
  return validateAutomationDefinition(automationDefinitionSchema.parse(input), context(access));
}

function errorsOf(input: AutomationDefinitionInput, access: EffectiveAccess = ADMIN) {
  const result = check(input, access);
  return result.ok ? [] : result.errors.map(({ path, code }) => ({ path, code }));
}

describe('AI actions at save (BACKLOG T911, CONTRACTS §29.6)', () => {
  it('accepts a prompt of trigger-record fields; later templates place the text as [act_…]', () => {
    const result = check({
      trigger: onCreate,
      actions: [
        generate(`Tóm tắt {{ [${F.title}] }} — {{ [${F.cost}] * 2 }}`),
        classify(`{{ [${F.title}] }}`, F.status),
        {
          id: 'act_n',
          type: 'send_notification',
          config: {
            recipients: [{ user_ids: ['usr_SomeoneSomeone01'] }],
            title: { template: 'AI: {{ [act_ai] }}' },
            body: { template: '{{ [act_ai] }}' },
          },
        },
        {
          id: 'act_u',
          type: 'update_record',
          config: {
            table_id: ORDERS,
            record_id: null,
            fields: { [F.note]: { step: 'act_ai', path: 'text' } },
          },
        },
      ],
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it.each([
    [
      'classify into a text field',
      [classify(`{{ [${F.title}] }}`, F.title)],
      'definition.actions[0].config.target_field_id',
      'INVALID_FIELD_TYPE',
    ],
    [
      'classify into a multiple select',
      [classify(`{{ [${F.title}] }}`, F.tags)],
      'definition.actions[0].config.target_field_id',
      'INVALID_FIELD_TYPE',
    ],
    [
      'text into a select',
      [generate(`{{ [${F.title}] }}`, F.status)],
      'definition.actions[0].config.target_field_id',
      'INVALID_FIELD_TYPE',
    ],
    [
      'text into an AI field',
      [generate(`{{ [${F.title}] }}`, F.summary)],
      'definition.actions[0].config.target_field_id',
      'FIELD_READ_ONLY',
    ],
    [
      'text into a formula',
      [generate(`{{ [${F.title}] }}`, F.total)],
      'definition.actions[0].config.target_field_id',
      'FIELD_READ_ONLY',
    ],
    [
      'a prompt reading [@id] (record ids never reach a model)',
      [generate('{{ [@id] }}')],
      'definition.actions[0].config.prompt',
      'UNKNOWN_FIELD',
    ],
    [
      'a prompt reading an attachment',
      [generate(`{{ [${F.files}] }}`)],
      'definition.actions[0].config.prompt',
      'INVALID_FIELD_TYPE',
    ],
    [
      'a prompt reading an AI field',
      [generate(`{{ [${F.summary}] }}`)],
      'definition.actions[0].config.prompt',
      'INVALID_FIELD_TYPE',
    ],
    [
      'a prompt reading through a link',
      [generate(`{{ [${F.customer}].[${F.name}] }}`)],
      'definition.actions[0].config.prompt',
      'CROSS_TABLE_NOT_SUPPORTED',
    ],
    [
      'a prompt reading a formula that reads another record',
      [generate(`{{ [${F.total}] }}`)],
      'definition.actions[0].config.prompt',
      'CROSS_TABLE_NOT_SUPPORTED',
    ],
    [
      'a template naming an AI step before it ran',
      [
        {
          id: 'act_u',
          type: 'update_record' as const,
          config: {
            table_id: ORDERS,
            record_id: null,
            fields: { [F.note]: { template: '{{ [act_ai] }}' } },
          },
        },
        generate(`{{ [${F.title}] }}`),
      ],
      `definition.actions[0].config.fields.${F.note}.template`,
      'UNKNOWN_FIELD',
    ],
    [
      'P87: update_record writing an AI field',
      [
        {
          id: 'act_u',
          type: 'update_record' as const,
          config: { table_id: ORDERS, record_id: null, fields: { [F.summary]: { literal: 'x' } } },
        },
      ],
      `definition.actions[0].config.fields.${F.summary}`,
      'FIELD_READ_ONLY',
    ],
  ])('%s → %s %s', (_name, actions, path, code) => {
    expect(errorsOf({ trigger: onCreate, actions })).toContainEqual({
      path,
      code,
    });
  });

  it('checks prompt and target as the saver (Sales: cost hidden, status read only)', () => {
    expect(
      errorsOf(
        {
          trigger: onCreate,
          actions: [classify(`{{ [${F.cost}] }}`, F.status), generate('x', F.cost, 'act_2')],
        },
        SALES,
      ),
    ).toEqual([
      { path: 'definition.actions[0].config.input', code: 'UNKNOWN_FIELD' },
      { path: 'definition.actions[0].config.target_field_id', code: 'PERMISSION_DENIED' },
      { path: 'definition.actions[1].config.target_field_id', code: 'UNKNOWN_FIELD' },
    ]);
  });

  it('needs a trigger record', () => {
    expect(
      errorsOf({
        trigger: { type: 'schedule', cron: '0 8 * * *', timezone: null },
        actions: [classify('x', F.status)],
      }),
    ).toEqual([{ path: 'definition.actions[0].config.input', code: 'NO_TRIGGER_RECORD' }]);
  });

  it('stores the prompt in canonical form', () => {
    const result = check({ trigger: onCreate, actions: [generate(`{{[${F.title}]}}`)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [action] = result.definition.actions;
    expect(action?.type === 'ai_generate_text' && action.config.prompt).toBe(`{{ [${F.title}] }}`);
  });
});

describe('checkAiActions: AI and record data on (T911, P85)', () => {
  const scope = orgScope('org_SomeOrganizatio1');
  const definition = automationDefinitionSchema.parse({
    trigger: onCreate,
    actions: [
      {
        id: 'act_if',
        type: 'if',
        config: {
          conditions: [{ value: { literal: 1 }, operator: 'is_not_empty' }],
          then: [classify('x', F.status)],
        },
      },
    ],
  });
  const settings = (state: Partial<AiSettingsState> | undefined) => ({
    find: () =>
      Promise.resolve(
        state === undefined
          ? undefined
          : ({
              enabled: true,
              provider_base_url: 'http://localhost:1/v1',
              model: 'm',
              allow_record_data: true,
              ...state,
            } as AiSettingsState),
      ),
  });

  it.each([
    ['never set up', undefined, ['AI_NOT_CONFIGURED']],
    ['turned off', { enabled: false }, ['AI_NOT_CONFIGURED']],
    ['record data off', { allow_record_data: false }, ['AI_RECORD_DATA_DISABLED']],
    ['on', {}, []],
  ])('%s', async (_name, state, codes) => {
    const errors = await checkAiActions(settings(state), scope, definition);
    expect(errors.map((error) => error.code)).toEqual(codes);
    for (const error of errors) {
      expect(error.path).toBe('definition.actions[0].config.then[0].type');
    }
  });

  it('asks nothing when the definition has no AI action', async () => {
    const none = automationDefinitionSchema.parse({ trigger: onCreate, actions: [] });
    const find = () => Promise.reject(new Error('not called'));
    await expect(checkAiActions({ find }, scope, none)).resolves.toEqual([]);
  });
});
