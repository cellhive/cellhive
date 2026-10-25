import {
  automationDefinitionSchema,
  n8nWorkflowPayloadSchema,
  runN8nWorkflowConfigSchema,
  type AutomationDefinitionInput,
  type AutomationValue,
  type EffectiveAccess,
  type Id,
  type RunN8nWorkflowConfigInput,
  type TableAccess,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildN8nPayload,
  createRunN8nWorkflowAction,
  type N8nPayloadDeps,
} from '../../src/automation/actions/run-n8n-workflow/index.js';
import { AutomationStepError } from '../../src/automation/engine/errors.js';
import {
  validateAutomationDefinition,
  type AutomationActionContext,
  type AutomationFieldMeta,
  type AutomationRunInfo,
} from '../../src/automation/index.js';

const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const TITLE: Id<'fld'> = 'fld_OrdersTitle00001';
const COST: Id<'fld'> = 'fld_OrdersCost000001';
const STATUS: Id<'fld'> = 'fld_OrdersStatus0001';
const CUSTOMER: Id<'fld'> = 'fld_OrdersCustomer01';
const BUTTON: Id<'fld'> = 'fld_OrdersButton0001';
const SEC: Id<'sec'> = 'sec_WebhookSigning01';
const REC = 'rec_OrdersRecord0001';
const EVT = 'evt_OrdersEvent00001';
const OPT_NEW = 'opt_StatusNew0000001';
const OPT_DONE = 'opt_StatusDone000001';

const FIELDS: AutomationFieldMeta[] = [
  { id: TITLE, table_id: ORDERS, name: 'title', type: 'text', options: {} },
  { id: COST, table_id: ORDERS, name: 'cost', type: 'number', options: {} },
  {
    id: STATUS,
    table_id: ORDERS,
    name: 'status',
    type: 'select',
    options: {
      options: [
        { id: OPT_NEW, name: 'Mới' },
        { id: OPT_DONE, name: 'Xong' },
      ],
    },
  },
  { id: CUSTOMER, table_id: ORDERS, name: 'customer', type: 'link', options: {} },
  { id: BUTTON, table_id: ORDERS, name: 'go', type: 'button', options: {} },
];

/** u_sales1 of the P47 shape: every field of Orders but `cost`. */
const TABLE: TableAccess = {
  perm: 'manage',
  operations: ['add', 'delete'],
  view_rule: { allow_edit: true, visible_views: null },
  read_scope: 'all',
  fields: { [TITLE]: 'edit', [STATUS]: 'read', [CUSTOMER]: 'edit', [BUTTON]: 'read' },
  option_edit_fields: [],
  file_download_fields: [],
};

const accessOf = (tables: Record<string, TableAccess>): EffectiveAccess => ({
  role: null,
  is_admin: false,
  base_rule: { copy: true, download: true, share_link: true },
  tables,
  dashboards: {},
});

const n8n = (input: Record<string, unknown> = {}) => ({
  id: 'act_n8n',
  type: 'run_n8n_workflow' as const,
  config: { url: { literal: 'https://n8n.test/webhook/x' }, signing_secret_id: SEC, ...input },
});

describe('run_n8n_workflow config (BACKLOG T607)', () => {
  it('requires a signing secret and defaults the rest', () => {
    expect(
      runN8nWorkflowConfigSchema.safeParse({ url: { literal: 'https://n.test' } }).success,
    ).toBe(false);
    expect(
      runN8nWorkflowConfigSchema.parse({
        url: { literal: 'https://n.test' },
        signing_secret_id: SEC,
      }),
    ).toEqual({
      url: { literal: 'https://n.test' },
      signing_secret_id: SEC,
      fields: null,
      include_changes: true,
    });
  });

  it.each([
    ['an empty list', []],
    ['a field twice', [TITLE, TITLE]],
    ['101 fields', Array.from({ length: 101 }, (_, i) => `fld_F${String(i).padStart(15, '0')}`)],
  ])('refuses %s', (_label, fields) => {
    expect(
      runN8nWorkflowConfigSchema.safeParse({
        url: { literal: 'https://n.test' },
        signing_secret_id: SEC,
        fields,
      }).success,
    ).toBe(false);
  });
});

describe('run_n8n_workflow at save (BACKLOG T607)', () => {
  const errorsOf = (input: AutomationDefinitionInput) => {
    const result = validateAutomationDefinition(automationDefinitionSchema.parse(input), {
      tables: [{ id: ORDERS }],
      fields: FIELDS,
      access: accessOf({ [ORDERS]: TABLE }),
      views: new Map(),
    });
    return result.ok ? [] : result.errors.map(({ path, code }) => ({ path, code }));
  };
  const onCreate = { type: 'record.created', table_id: ORDERS } as const;
  const P = 'definition.actions[0].config';

  it('accepts readable fields of the trigger table and a URL template', () => {
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [
          n8n({
            url: { template: `https://n8n.test/webhook/{{ [${TITLE}] }}` },
            fields: [TITLE, STATUS],
          }),
        ],
      }),
    ).toEqual([]);
  });

  it('P47: a field the saver cannot read is UNKNOWN_FIELD', () => {
    expect(errorsOf({ trigger: onCreate, actions: [n8n({ fields: [TITLE, COST] })] })).toEqual([
      { path: `${P}.fields[1]`, code: 'UNKNOWN_FIELD' },
    ]);
  });

  it('a URL that can never be called is INVALID_URL; a template field must be readable', () => {
    expect(
      errorsOf({ trigger: onCreate, actions: [n8n({ url: { literal: 'ftp://n8n.test/' } })] }),
    ).toEqual([{ path: `${P}.url`, code: 'INVALID_URL' }]);
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [n8n({ url: { template: `https://n8n.test/{{ [${COST}] }}` } })],
      }),
    ).toEqual([{ path: `${P}.url.template`, code: 'UNKNOWN_FIELD' }]);
  });

  it('fields need a trigger with a record; fields = null does not', () => {
    const schedule = { type: 'schedule', cron: '0 8 * * *', timezone: null } as const;
    expect(errorsOf({ trigger: schedule, actions: [n8n({ fields: [TITLE] })] })).toEqual([
      { path: `${P}.fields`, code: 'NO_TRIGGER_RECORD' },
    ]);
    expect(errorsOf({ trigger: schedule, actions: [n8n()] })).toEqual([]);
  });
});

// --- Payload -----------------------------------------------------------------------------

/** Cells of the record as `RecordQueryService` would return them for `fields`. */
const JSON_CELLS: Record<string, unknown> = {
  [TITLE]: 'Đơn 1',
  [COST]: 999,
  [STATUS]: 'Xong',
  [CUSTOMER]: [{ id: 'rec_Customer00000001', title: null }],
};
const TEXT_CELLS: Record<string, unknown> = {
  [TITLE]: 'Đơn 1',
  [COST]: '999',
  [STATUS]: 'Xong',
  [CUSTOMER]: '',
};

interface Calls {
  reads: { fields: readonly string[] | null | undefined; cellFormat: unknown }[];
}

function fakeQuery(
  calls: Calls,
  options: { missing?: boolean; title?: string; trashedReadable?: boolean } = {},
) {
  return {
    matchRecord(
      _scope: unknown,
      _table: unknown,
      _id: string,
      _access: unknown,
      _filter: unknown,
      read: { trashed?: boolean } = {},
    ) {
      return Promise.resolve(read.trashed === true && options.trashedReadable === true);
    },
    getRecords(
      _scope: unknown,
      _table: unknown,
      ids: readonly string[],
      _access: unknown,
      read: { fields?: readonly string[] | null; cell_format?: string } = {},
    ) {
      calls.reads.push({ fields: read.fields, cellFormat: read.cell_format });
      if (options.missing === true) return Promise.resolve([]);
      const source = read.cell_format === 'text' ? TEXT_CELLS : JSON_CELLS;
      const fields = Object.fromEntries(
        (read.fields ?? []).map((id) => [
          id,
          id === TITLE && options.title !== undefined ? options.title : source[id],
        ]),
      );
      return Promise.resolve(ids.map((id) => ({ id, fields })));
    },
  } as unknown as N8nPayloadDeps['query'];
}

const fakeEvents = (changes: unknown): NonNullable<N8nPayloadDeps['events']> =>
  ({
    getByKey: () =>
      Promise.resolve({
        id: EVT,
        type: 'record.updated',
        organization_id: 'org_Org0000000000001',
        entity_type: 'record',
        entity_id: REC,
        actor_type: 'user',
        actor_id: 'usr_User000000000001',
        payload: {
          base_id: 'bse_Base000000000001',
          table_id: ORDERS,
          changes,
          record_version: 2,
        },
        causation: { root_event_id: EVT, depth: 0, automation_chain: [] },
        dispatched_at: null,
        created_at: new Date('2026-10-18T03:00:00.000Z'),
      }),
  }) as unknown as NonNullable<N8nPayloadDeps['events']>;

const RUN: AutomationRunInfo = {
  id: 'run_Run0000000000001',
  automationId: 'aut_Auto000000000001',
  baseId: 'bse_Base000000000001',
  triggerTableId: ORDERS,
  triggerRecordId: REC,
  triggerEventId: EVT,
  triggerType: 'record.updated',
  timeZone: 'Asia/Ho_Chi_Minh',
  locale: 'vi',
  triggerEventCreatedAt: '2026-10-18T03:00:00.000Z',
  automationName: 'Gửi sang n8n',
  baseName: 'Bán hàng',
};

function contextOf(
  config: RunN8nWorkflowConfigInput,
  run: Partial<AutomationRunInfo> = {},
  tables: Record<string, TableAccess> = { [ORDERS]: TABLE },
): AutomationActionContext {
  const values = {
    resolve(item: AutomationValue) {
      if ('trigger' in item) {
        return Promise.resolve({
          value: item.trigger === 'fired_at' ? '2026-10-18T01:00:00.000Z' : null,
          warnings: [],
          truncated: false,
        });
      }
      if ('literal' in item) {
        return Promise.resolve({ value: item.literal, warnings: [], truncated: false });
      }
      return Promise.resolve({ value: '', warnings: [], truncated: false });
    },
  };
  return {
    db: undefined as never,
    scope: { organizationId: 'org_Org0000000000001' } as never,
    run: { ...RUN, ...run },
    action: {
      id: 'act_n8n',
      type: 'run_n8n_workflow',
      config: runN8nWorkflowConfigSchema.parse(config),
    },
    access: { record: {}, isAdmin: false } as never,
    schema: {
      tables: [{ id: ORDERS, name: 'Orders', primary_field_id: TITLE }],
      fields: FIELDS,
      access: accessOf(tables),
    },
    values: values as never,
    audit: {} as never,
    causation: { root_event_id: EVT, depth: 1, automation_chain: [] },
    idempotencyKey: 'aut:evt:act_n8n',
    attempt: 1,
    previous: null,
    now: () => new Date('2026-10-18T05:00:00.000Z'),
    saveProgress: () => Promise.resolve(),
    complete: () => Promise.resolve(),
  };
}

const CONFIG = { url: { literal: 'https://n8n.test/webhook/x' }, signing_secret_id: SEC };

describe('buildN8nPayload (BACKLOG T607, SPEC §13.3)', () => {
  const changes = {
    [TITLE]: { from: 'Đơn', to: 'Đơn 1' },
    [COST]: { from: 1, to: 999 },
    [STATUS]: { from: [OPT_NEW], to: [OPT_DONE] },
  };

  it('P47: fields = null sends what run_as reads now — no cost anywhere, link title null', async () => {
    const calls: Calls = { reads: [] };
    const { payload, warnings } = await buildN8nPayload(
      { query: fakeQuery(calls), events: fakeEvents(changes) },
      contextOf(CONFIG),
      runN8nWorkflowConfigSchema.parse(CONFIG),
    );
    expect(n8nWorkflowPayloadSchema.parse(payload)).toEqual({
      event: {
        id: EVT,
        type: 'record.updated',
        entity_id: REC,
        created_at: '2026-10-18T03:00:00.000Z',
      },
      automation: { id: RUN.automationId, name: 'Gửi sang n8n', run_id: RUN.id },
      base: { id: RUN.baseId, name: 'Bán hàng' },
      table: { id: ORDERS, name: 'Orders' },
      record: {
        id: REC,
        fields: { title: 'Đơn 1', status: 'Xong', customer: '' },
        fields_by_id: {
          [TITLE]: 'Đơn 1',
          [STATUS]: 'Xong',
          [CUSTOMER]: [{ id: 'rec_Customer00000001', title: null }],
        },
      },
      changes: {
        title: { from: 'Đơn', to: 'Đơn 1' },
        status: { from: 'Mới', to: 'Xong' },
      },
    });
    expect(warnings).toEqual([]);
    // Only readable fields are ever asked for; the button is never sent.
    expect(calls.reads.map((read) => read.fields)).toEqual([
      [TITLE, STATUS, CUSTOMER],
      [TITLE, STATUS, CUSTOMER],
    ]);
    expect(JSON.stringify(payload)).not.toContain('cost');
    expect(JSON.stringify(payload)).not.toContain('999');
  });

  it('listed fields: only those, the ones run_as lost left out with field_unavailable', async () => {
    const config = { ...CONFIG, fields: [STATUS, COST] };
    const { payload, warnings } = await buildN8nPayload(
      { query: fakeQuery({ reads: [] }), events: fakeEvents(changes) },
      contextOf(config),
      runN8nWorkflowConfigSchema.parse(config),
    );
    expect(payload.record).toEqual({
      id: REC,
      fields: { status: 'Xong' },
      fields_by_id: { [STATUS]: 'Xong' },
    });
    expect(payload.changes).toEqual({ status: { from: 'Mới', to: 'Xong' } });
    expect(warnings).toEqual([{ code: 'field_unavailable', field_id: COST }]);
  });

  it('include_changes: false, or a trigger other than record.updated → changes: null', async () => {
    const off = { ...CONFIG, include_changes: false };
    const built = await buildN8nPayload(
      { query: fakeQuery({ reads: [] }), events: fakeEvents(changes) },
      contextOf(off),
      runN8nWorkflowConfigSchema.parse(off),
    );
    expect(built.payload.changes).toBeNull();
    const created = await buildN8nPayload(
      { query: fakeQuery({ reads: [] }), events: fakeEvents(changes) },
      contextOf(CONFIG, { triggerType: 'record.created' }),
      runN8nWorkflowConfigSchema.parse(CONFIG),
    );
    expect(created.payload.changes).toBeNull();
  });

  it('schedule: no record, no table, no event id; created_at = fired_at', async () => {
    const calls: Calls = { reads: [] };
    const { payload } = await buildN8nPayload(
      { query: fakeQuery(calls) },
      contextOf(CONFIG, {
        triggerType: 'schedule',
        triggerTableId: null,
        triggerRecordId: null,
        triggerEventId: null,
        triggerEventCreatedAt: null,
      }),
      runN8nWorkflowConfigSchema.parse(CONFIG),
    );
    expect(payload).toMatchObject({
      event: {
        id: null,
        type: 'schedule',
        entity_id: null,
        created_at: '2026-10-18T01:00:00.000Z',
      },
      table: null,
      record: null,
      changes: null,
    });
    expect(calls.reads).toEqual([]);
  });

  it('a record run_as no longer reads (deleted, outside its read rule) → record: null', async () => {
    const { payload } = await buildN8nPayload(
      { query: fakeQuery({ reads: [] }, { missing: true }), events: fakeEvents(changes) },
      contextOf(CONFIG),
      runN8nWorkflowConfigSchema.parse(CONFIG),
    );
    expect(payload.record).toBeNull();
  });

  it.each([
    [true, REC],
    [false, null],
  ])(
    'T616: record.deleted → record null, event.entity_id only when run_as reads the trashed record (%s)',
    async (trashedReadable, expected) => {
      const { payload } = await buildN8nPayload(
        { query: fakeQuery({ reads: [] }, { missing: true, trashedReadable }) },
        contextOf(CONFIG, { triggerType: 'record.deleted' }),
        runN8nWorkflowConfigSchema.parse(CONFIG),
      );
      expect(payload.record).toBeNull();
      expect(payload.event.entity_id).toBe(expected);
    },
  );

  it('T616: a live record run_as cannot read (another trigger) → entity_id null, never asked in the trash', async () => {
    const { payload } = await buildN8nPayload(
      {
        query: fakeQuery({ reads: [] }, { missing: true, trashedReadable: true }),
        events: fakeEvents(changes),
      },
      contextOf(CONFIG),
      runN8nWorkflowConfigSchema.parse(CONFIG),
    );
    expect(payload.event.entity_id).toBeNull();
  });

  it('a trigger table run_as no longer reads fails permission_denied', async () => {
    await expect(
      buildN8nPayload(
        { query: fakeQuery({ reads: [] }) },
        contextOf(CONFIG, {}, {}),
        runN8nWorkflowConfigSchema.parse(CONFIG),
      ),
    ).rejects.toMatchObject({ code: 'permission_denied', options: { params: { scope: 'table' } } });
  });
});

describe('run_n8n_workflow handler (BACKLOG T607)', () => {
  it('renders a signed JSON POST for the outbox, never calling the network', async () => {
    const handler = createRunN8nWorkflowAction({
      query: fakeQuery({ reads: [] }),
      events: fakeEvents({}),
    });
    const result = await handler.execute(contextOf(CONFIG));
    expect(result.output).toEqual({});
    const delivery = result.delivery;
    expect(delivery).toMatchObject({
      request: {
        method: 'POST',
        url: 'https://n8n.test/webhook/x',
        headers: [['Content-Type', 'application/json']],
        authHeaderName: null,
        failOnHttpError: true,
      },
      authSecretId: null,
      signingSecretId: SEC,
    });
    const body = n8nWorkflowPayloadSchema.parse(JSON.parse(delivery?.request.body ?? 'null'));
    expect(body.record?.id).toBe(REC);
    expect(body.changes).toEqual({});
  });

  it('a payload over 1 MiB fails the step http_request_too_large', async () => {
    const handler = createRunN8nWorkflowAction({
      // The title is sent twice (`fields` and `fields_by_id`): 1.2 MiB.
      query: fakeQuery({ reads: [] }, { title: 'x'.repeat(600 * 1024) }),
      events: fakeEvents({}),
    });
    const error = await handler.execute(contextOf(CONFIG)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AutomationStepError);
    expect(error).toMatchObject({
      code: 'http_request_too_large',
      options: { params: { limit_bytes: 1024 * 1024 } },
    });
  });
});
