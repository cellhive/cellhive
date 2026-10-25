import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  automationDefinitionSchema,
  automationIfMatchHeaderSchema,
  automationValueSchema,
  createAutomationRequestSchema,
  DUPLICATE_ACTION_ID,
  NO_ACTIONS,
  NO_TRIGGER_RECORD,
  NOT_TRIGGER_TABLE,
  TOO_MANY_ACTIONS,
  UNKNOWN_STEP,
  UNSUPPORTED_VALUE_SOURCE,
  UNSUPPORTED_FUNCTION,
  CROSS_TABLE_NOT_SUPPORTED,
  TEMPLATE_SYNTAX_DETAIL_CODES,
  parseValuePath,
  readValuePath,
  updateAutomationRequestSchema,
  validateAutomationTemplateRequestSchema,
  isTemplateReferenceId,
} from '../src/automations.js';
import { AUTOMATION_DETAIL_CODES } from '../src/error-details.js';

const TBL = 'tbl_A1b2C3d4E5f6G7h8';
const FLD = 'fld_A1b2C3d4E5f6G7h8';
const VIW = 'viw_A1b2C3d4E5f6G7h8';

describe('automation triggers (SPEC §11.2)', () => {
  it.each([
    [{ type: 'record.created', table_id: TBL }, { skip_bulk: false }],
    [{ type: 'record.updated', table_id: TBL, watch_fields: [FLD] }, { skip_bulk: false }],
    [{ type: 'record.deleted', table_id: TBL, skip_bulk: true }, { skip_bulk: true }],
    [
      { type: 'record.matches', table_id: TBL, condition: { field: FLD, operator: 'is_empty' } },
      { skip_bulk: false },
    ],
    [{ type: 'form.submitted', view_id: VIW }, {}],
    [{ type: 'schedule', cron: '0 8 * * *' }, { timezone: null }],
    [
      { type: 'record.date_reached', table_id: TBL, field_id: FLD },
      { offset_minutes: 0, time_of_day: null },
    ],
    [
      { type: 'button.clicked', table_id: TBL, field_id: FLD },
      { min_permission: 'edit', enabled_when: null },
    ],
  ])('accepts %j with defaults', (trigger, defaults) => {
    const parsed = automationDefinitionSchema.parse({ trigger });
    expect(parsed.trigger).toEqual({ ...trigger, ...defaults });
    expect(parsed.condition).toBeNull();
    expect(parsed.actions).toEqual([]);
  });

  it('lists every trigger type the union accepts', () => {
    expect(AUTOMATION_TRIGGER_TYPES).toHaveLength(9);
  });

  it.each([
    ['unknown type', { type: 'approval.completed', table_id: TBL }],
    ['webhook with a table', { type: 'webhook.received', table_id: TBL }],
    ['webhook with a bad hook id', { type: 'webhook.received', incoming_webhook_id: 'hok_x' }],
    ['updated without watch_fields', { type: 'record.updated', table_id: TBL, watch_fields: [] }],
    ['extra key', { type: 'record.created', table_id: TBL, view_id: VIW }],
    ['bad table id', { type: 'record.created', table_id: 'tbl_x' }],
    [
      'offset over 30 days',
      { type: 'record.date_reached', table_id: TBL, field_id: FLD, offset_minutes: 43_201 },
    ],
    [
      'bad time of day',
      { type: 'record.date_reached', table_id: TBL, field_id: FLD, time_of_day: '24:00' },
    ],
    [
      'bad min_permission',
      { type: 'button.clicked', table_id: TBL, field_id: FLD, min_permission: 'manage' },
    ],
    ['matches without condition', { type: 'record.matches', table_id: TBL }],
  ])('rejects %s', (_name, trigger) => {
    expect(automationDefinitionSchema.safeParse({ trigger }).success).toBe(false);
  });
});

describe('automation actions (SPEC §11.5)', () => {
  const trigger = { type: 'record.created', table_id: TBL };

  it('fills action defaults', () => {
    const parsed = automationDefinitionSchema.parse({
      trigger,
      actions: [
        { id: 'act_1', type: 'find_records', config: { table_id: TBL } },
        { id: 'act_2', type: 'update_record', config: { table_id: TBL, fields: {} } },
        { id: 'act_3', type: 'delete_record' },
        {
          id: 'act_4',
          type: 'if',
          config: { conditions: [{ filter: { field: FLD, operator: 'is_empty' } }] },
        },
      ],
    });
    expect(parsed.actions).toEqual([
      {
        id: 'act_1',
        type: 'find_records',
        config: { table_id: TBL, filter: null, sort: [], fields: [], limit: 50 },
      },
      {
        id: 'act_2',
        type: 'update_record',
        config: { table_id: TBL, record_id: null, fields: {} },
      },
      { id: 'act_3', type: 'delete_record', config: {} },
      {
        id: 'act_4',
        type: 'if',
        config: {
          match: 'and',
          conditions: [{ filter: { field: FLD, operator: 'is_empty' } }],
          on_false: 'else',
          then: [],
          else: [],
        },
      },
    ]);
  });

  it('lists every action type the union accepts', () => {
    expect([...AUTOMATION_ACTION_TYPES].sort()).toEqual([
      'create_record',
      'delay',
      'delete_record',
      'find_records',
      'http_request',
      'if',
      'run_n8n_workflow',
      'send_email',
      'send_notification',
      'send_telegram',
      'update_record',
      'update_records',
    ]);
  });

  it.each([
    [
      'an if nested in an if',
      {
        id: 'act_1',
        type: 'if',
        config: {
          conditions: [{ filter: {} }],
          then: [{ id: 'act_2', type: 'if', config: { conditions: [{ filter: {} }] } }],
        },
      },
    ],
    ['a bad action id', { id: 'action-1', type: 'delete_record' }],
    ['an unknown type', { id: 'act_1', type: 'send_fax', config: {} }],
    [
      'find_records over 200',
      { id: 'act_1', type: 'find_records', config: { table_id: TBL, limit: 201 } },
    ],
    [
      'update_records over 10 000',
      {
        id: 'act_1',
        type: 'update_records',
        config: { table_id: TBL, filter: {}, fields: {}, limit: 10_001 },
      },
    ],
    ['a delay over 30 days', { id: 'act_1', type: 'delay', config: { minutes: 43_201 } }],
    ['a delay under 1 minute', { id: 'act_1', type: 'delay', config: { minutes: 0 } }],
    ['a delay with neither minutes nor until', { id: 'act_1', type: 'delay', config: {} }],
    [
      'a delay with both minutes and until',
      { id: 'act_1', type: 'delay', config: { minutes: 5, until: { field: FLD } } },
    ],
    ['an if without condition', { id: 'act_1', type: 'if', config: { conditions: [] } }],
    [
      'field values keyed by name',
      {
        id: 'act_1',
        type: 'create_record',
        config: { table_id: TBL, fields: { Title: { literal: 'x' } } },
      },
    ],
  ])('rejects %s', (_name, action) => {
    expect(automationDefinitionSchema.safeParse({ trigger, actions: [action] }).success).toBe(
      false,
    );
  });
});

describe('delay and update_records configs (BACKLOG T506)', () => {
  const trigger = { type: 'record.created', table_id: TBL };

  it('fills the delay defaults: minutes or until, no recheck', () => {
    const parsed = automationDefinitionSchema.parse({
      trigger,
      actions: [
        { id: 'act_1', type: 'delay', config: { minutes: 5 } },
        { id: 'act_2', type: 'delay', config: { until: { field: FLD } } },
      ],
    });
    expect(parsed.actions.map((action) => action.config)).toEqual([
      { minutes: 5, until: null, recheck_condition: null },
      { minutes: null, until: { field: FLD }, recheck_condition: null },
    ]);
  });

  it('defaults the update_records limit to 1 000 and keeps values inside the filter', () => {
    const filter = { field: FLD, operator: 'eq', value: { step: 'act_0', path: 'id' } };
    const parsed = automationDefinitionSchema.parse({
      trigger,
      actions: [
        { id: 'act_1', type: 'update_records', config: { table_id: TBL, filter, fields: {} } },
      ],
    });
    expect(parsed.actions[0]?.config).toEqual({ table_id: TBL, filter, fields: {}, limit: 1_000 });
  });
});

describe('automation values (SPEC §11.4)', () => {
  it.each([
    [{ literal: 'abc' }],
    [{ literal: null }],
    [{ literal: [1, 2] }],
    [{ literal: { a: 1 } }],
    [{ field: FLD }],
    [{ step: 'act_1' }],
    [{ step: 'act_1', path: 'records[0].id' }],
    [{ trigger: 'fired_at' }],
    [{ template: 'Ticket {{ [fld_A1b2C3d4E5f6G7h8] }}' }],
    [{ digest: { step: 'act_1', row_template: '- {{ 1 }}' } }],
  ])('accepts %j', (value) => {
    expect(automationValueSchema.safeParse(value).success).toBe(true);
  });

  it('defaults digest rows and separator', () => {
    expect(automationValueSchema.parse({ digest: { step: 'act_1', row_template: 'x' } })).toEqual({
      digest: { step: 'act_1', row_template: 'x', max_rows: 50, separator: '\n' },
    });
  });

  it.each([
    [{}],
    [{ literal: 'a', field: FLD }],
    [{ field: 'Title' }],
    [{ step: 'x' }],
    [{ digest: { step: 'act_1', row_template: 'x', max_rows: 201 } }],
    [{ template: 'x'.repeat(20_001) }],
    [{ step: 'act_1', path: 'a..b' }],
    [{ trigger: 'fired_at', path: '' }],
    ['plain string'],
  ])('rejects %j', (value) => {
    expect(automationValueSchema.safeParse(value).success).toBe(false);
  });
});

describe('automation requests (CONTRACTS §21)', () => {
  const definition = { trigger: { type: 'record.created', table_id: TBL } };

  it('creates disabled with an empty description by default', () => {
    expect(createAutomationRequestSchema.parse({ name: ' Notify ', definition })).toMatchObject({
      name: 'Notify',
      description: '',
      enabled: false,
    });
  });

  it.each([[{}], [{ version: 2 }], [{ name: '', version: 1 }], [{ name: 'x', enabled: true }]])(
    'rejects the update %j',
    (body) => {
      expect(updateAutomationRequestSchema.safeParse(body).success).toBe(false);
    },
  );

  it.each([[{ name: 'x' }], [{ description: '' }], [{ definition, version: 3 }]])(
    'accepts the update %j',
    (body) => {
      expect(updateAutomationRequestSchema.safeParse(body).success).toBe(true);
    },
  );

  it.each([
    ['3', true],
    ['"3"', true],
    ['W/"3"', true],
    ['*', false],
    ['"abc"', false],
  ])('If-Match %s → %s', (value, ok) => {
    expect(automationIfMatchHeaderSchema.safeParse({ 'if-match': value }).success).toBe(ok);
  });
});

describe('AUTOMATION_INVALID detail codes (CONTRACTS §6)', () => {
  it('lists the constants of automations.ts', () => {
    expect(AUTOMATION_DETAIL_CODES).toEqual(
      expect.arrayContaining([
        TOO_MANY_ACTIONS,
        DUPLICATE_ACTION_ID,
        UNKNOWN_STEP,
        NO_TRIGGER_RECORD,
        NOT_TRIGGER_TABLE,
        UNSUPPORTED_VALUE_SOURCE,
        NO_ACTIONS,
        UNSUPPORTED_FUNCTION,
        CROSS_TABLE_NOT_SUPPORTED,
        ...TEMPLATE_SYNTAX_DETAIL_CODES,
        'PERMISSION_DENIED',
        'UNKNOWN_TABLE',
        'UNKNOWN_FIELD',
      ]),
    );
  });
});

describe('value paths (SPEC §11.4)', () => {
  it.each([
    ['id', ['id']],
    ['body.id', ['body', 'id']],
    ['items[0].sku', ['items', 0, 'sku']],
    ['records[12].fields.fld_A1b2C3d4E5f6G7h8', ['records', 12, 'fields', 'fld_A1b2C3d4E5f6G7h8']],
    ['[0]', [0]],
    ['[0][1].a', [0, 1, 'a']],
    ['customer-email', ['customer-email']],
    ['tên khách', ['tên khách']],
  ])('parses %s', (path, segments) => {
    expect(parseValuePath(path)).toEqual(segments);
  });

  it.each(['', '.a', 'a.', 'a..b', 'a[x]', 'a[', 'a[-1]', 'a]', 'a.[0]', '[0]a', 'a[0]b'])(
    'rejects %j',
    (path) => {
      expect(parseValuePath(path)).toBeNull();
    },
  );

  const value = { records: [{ id: 'rec_1', fields: { a: [1, 2] } }], n: 0, f: false, z: null };
  it.each([
    ['records[0].id', 'rec_1'],
    ['records[0].fields.a[1]', 2],
    ['records[1].id', null],
    ['records.id', null],
    ['records[0].id.x', null],
    ['n', 0],
    ['f', false],
    ['z', null],
    ['missing', null],
    ['toString', null],
  ])('reads %s', (path, expected) => {
    expect(readValuePath(value, parseValuePath(path) ?? [])).toEqual(expected);
  });
});

describe('template check request (CONTRACTS §21)', () => {
  it('defaults to the display form and every readable field', () => {
    expect(
      validateAutomationTemplateRequestSchema.parse({ table_id: TBL, template: '{{ [A] }}' }),
    ).toEqual({
      table_id: TBL,
      template: '{{ [A] }}',
      form: 'display',
      row_fields: null,
      trigger_type: null,
      steps: [],
      digest: false,
    });
  });

  it('takes the trigger type and the earlier steps (T505)', () => {
    expect(
      validateAutomationTemplateRequestSchema.parse({
        table_id: TBL,
        template: '{{ [act_1].[@url] }}',
        trigger_type: 'record.created',
        steps: [{ id: 'act_1', table_id: TBL }],
      }),
    ).toMatchObject({ trigger_type: 'record.created', steps: [{ id: 'act_1', table_id: TBL }] });
  });

  it.each([
    [{ template: 'x' }],
    [{ table_id: TBL, template: 'x'.repeat(20_001) }],
    [{ table_id: TBL, template: 'x', form: 'names' }],
    [{ table_id: TBL, template: 'x', trigger_type: 'approval.completed' }],
    [{ table_id: TBL, template: 'x', steps: [{ id: 'step1', table_id: TBL }] }],
  ])('rejects %j', (body) => {
    expect(validateAutomationTemplateRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('template references (T505)', () => {
  it.each([
    ['@id', true],
    ['@fired_at', true],
    ['act_1', true],
    ['act_Step_2', true],
    ['@', false],
    ['@Url', false],
    ['act-1', false],
    ['fld_x', false],
  ])('isTemplateReferenceId(%s) → %s', (id, expected) => {
    expect(isTemplateReferenceId(id)).toBe(expected);
  });
});
