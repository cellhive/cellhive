import { describe, expect, it } from 'vitest';

import {
  AI_AUTOMATION_MODEL_WARNING_CODES,
  AI_AUTOMATION_WARNING_CODES,
  aiAutomationWarningSchema,
  API_TOKEN_ROUTE_SCOPES,
  AUDIT_VIA_KINDS,
  aggregateRecordsResultSchema,
  createFieldInputSchema,
  createRecordsInputSchema,
  createTableInputSchema,
  DEFAULT_MCP_POLICY,
  draftAutomationResultSchema,
  ERROR_DETAIL_CODES,
  eventViaSchema,
  FIELD_TYPE_NAMES,
  listBasesInputSchema,
  MCP_AUTOMATION_DRAFT_DETAIL_CODES,
  MCP_AUTOMATION_DRAFT_TTL_SECONDS,
  MCP_AUTOMATION_DRAFTS_PER_USER,
  MCP_CREATABLE_FIELD_TYPES,
  MCP_CREATE_TABLE_FIELDS_MAX,
  MCP_REQUEST_MAX_BYTES,
  MCP_WRITE_RECORDS_MAX,
  mcpAutomationDraftSchema,
  mcpPolicySchema,
  mcpSelectOptionsInputSchema,
  mcpToolErrorSchema,
  NOT_AVAILABLE_OVER_MCP,
  orgAuditLogQuerySchema,
  organizationSettingsSchema,
  updateFieldInputSchema,
  updateOrganizationRequestSchema,
  updateRecordsInputSchema,
  writeRecordsResultSchema,
} from '../src/index.js';
import { generateOpenApiDocument } from '../src/openapi/index.js';

const SETTINGS = { locale: 'vi', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' };

describe('MCP contracts (CONTRACTS §30, T920)', () => {
  it('defaults settings.mcp to off, writes off, schema writes off', () => {
    const off = { enabled: false, allow_writes: false, allow_schema_writes: false };
    expect(DEFAULT_MCP_POLICY).toEqual(off);
    const parsed = organizationSettingsSchema.parse({
      ...SETTINGS,
      public_sharing: 'allowed',
    });
    expect(parsed.mcp).toEqual(off);
  });

  it('reads a policy stored before schema writes existed, with schema writes off (T1014)', () => {
    expect(mcpPolicySchema.parse({ enabled: true, allow_writes: true })).toEqual({
      enabled: true,
      allow_writes: true,
      allow_schema_writes: false,
    });
    expect(
      organizationSettingsSchema.parse({
        ...SETTINGS,
        public_sharing: 'allowed',
        mcp: { enabled: true, allow_writes: false },
      }).mcp,
    ).toEqual({ enabled: true, allow_writes: false, allow_schema_writes: false });
  });

  it.each([
    [{ settings: { mcp: { enabled: true } } }, true],
    [{ settings: { mcp: { allow_writes: false } } }, true],
    [{ settings: { mcp: { allow_schema_writes: true } } }, true],
    [{ settings: { mcp: { allow_schema_writes: 'on' } } }, false],
    [{ settings: { mcp: {} } }, false],
    [{ settings: { mcp: { enabled: 'yes' } } }, false],
    [{ settings: { mcp: { enabled: true, read_only: true } } }, false],
  ])('PATCH /orgs/:id %j → valid %s', (body, valid) => {
    expect(updateOrganizationRequestSchema.safeParse(body).success).toBe(valid);
  });

  it('takes no input for list_bases', () => {
    expect(listBasesInputSchema.safeParse({}).success).toBe(true);
    expect(listBasesInputSchema.safeParse({ base_id: 'bse_x' }).success).toBe(false);
  });

  it('takes 1–50 records by field name to write (T923)', () => {
    const table_id = 'tbl_A1b2C3d4E5f6G7h8';
    const id = 'rec_A1b2C3d4E5f6G7h8';
    const many = (n: number) => Array.from({ length: n }, () => ({ fields: { Name: 'x' } }));
    expect(createRecordsInputSchema.safeParse({ table_id, records: many(1) }).success).toBe(true);
    expect(
      createRecordsInputSchema.safeParse({ table_id, records: many(MCP_WRITE_RECORDS_MAX) })
        .success,
    ).toBe(true);
    for (const records of [[], many(MCP_WRITE_RECORDS_MAX + 1), [{ fields: {}, typecast: true }]]) {
      expect(createRecordsInputSchema.safeParse({ table_id, records }).success).toBe(false);
    }
    expect(
      updateRecordsInputSchema.safeParse({ table_id, records: [{ id, fields: { Name: 'y' } }] })
        .success,
    ).toBe(true);
    // No upsert, no version, no record without its id.
    for (const record of [{ fields: {} }, { id, version: 2, fields: {} }]) {
      expect(updateRecordsInputSchema.safeParse({ table_id, records: [record] }).success).toBe(
        false,
      );
    }
  });

  it('marks writes through MCP in event via and filters the audit log by it (T923)', () => {
    const via = { api_token_id: 'tok_A1b2C3d4E5f6G7h8', mcp: true };
    expect(eventViaSchema.parse(via)).toEqual(via);
    expect(eventViaSchema.safeParse({ ...via, mcp: false }).success).toBe(false);
    expect(AUDIT_VIA_KINDS).toContain('mcp');
    expect(orgAuditLogQuerySchema.parse({ via: 'mcp' }).via).toEqual(['mcp']);
  });

  it('documents one token-only operation with the schema:read route scope', () => {
    const operation = generateOpenApiDocument().paths?.['/api/v1/mcp'];
    expect(Object.keys(operation ?? {})).toEqual(['post']);
    expect(operation?.post?.operationId).toBe('mcp');
    expect(operation?.post?.security).toEqual([{ apiToken: ['schema:read'] }]);
    expect(MCP_REQUEST_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(JSON.stringify(operation?.post?.responses?.['413'])).toContain('body over 2 MiB');
  });

  it('counts the problems of a tool error, and flags aggregates cut at 32 KB (T1009)', () => {
    const error = { code: 'VALIDATION_FAILED', message: 'Invalid.', errors: [] };
    expect(mcpToolErrorSchema.safeParse(error).success).toBe(false);
    expect(mcpToolErrorSchema.safeParse({ ...error, total: 10_000 }).success).toBe(true);
    const result = { columns: [], rows: [], other: null, total: null };
    expect(aggregateRecordsResultSchema.safeParse(result).success).toBe(false);
    expect(aggregateRecordsResultSchema.safeParse({ ...result, truncated: true }).success).toBe(
      true,
    );
  });

  it('takes an optional idempotency key on the record writes, and flags replays (T1014)', () => {
    const table_id = 'tbl_A1b2C3d4E5f6G7h8';
    const records = [{ fields: { Name: 'x' } }];
    for (const [key, valid] of [
      ['a-1', true],
      ['x'.repeat(255), true],
      ['', false],
      ['x'.repeat(256), false],
      ['has space', false],
      ['é', false],
    ] as const) {
      expect(
        createRecordsInputSchema.safeParse({ table_id, records, idempotency_key: key }).success,
        key,
      ).toBe(valid);
    }
    const result = { record_ids: [], records: [], truncated: false, truncated_cells: [] };
    expect(writeRecordsResultSchema.safeParse(result).success).toBe(true);
    expect(writeRecordsResultSchema.safeParse({ ...result, replayed: true }).success).toBe(true);
    expect(writeRecordsResultSchema.safeParse({ ...result, replayed: false }).success).toBe(false);
  });
});

describe('MCP schema tools (CONTRACTS §30.7, T1014)', () => {
  const base_id = 'bse_A1b2C3d4E5f6G7h8';
  const table_id = 'tbl_A1b2C3d4E5f6G7h8';

  it('creates every type a person fills in, links, lookups and formulas — never the others', () => {
    expect(MCP_CREATABLE_FIELD_TYPES.every((type) => FIELD_TYPE_NAMES.includes(type))).toBe(true);
    const never = FIELD_TYPE_NAMES.filter(
      (type) => !(MCP_CREATABLE_FIELD_TYPES as readonly string[]).includes(type),
    );
    expect(never.sort()).toEqual(
      [
        'auto_number',
        'button',
        'created_at',
        'created_by',
        'parent',
        'updated_at',
        'updated_by',
      ].sort(),
    );
    for (const type of never) {
      expect(createFieldInputSchema.safeParse({ table_id, name: 'F', type }).success, type).toBe(
        false,
      );
    }
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['a name only', { base_id, name: 'Tasks' }, true],
    [
      'fields by name with options',
      {
        base_id,
        name: 'Tasks',
        primary_field_name: 'Title',
        fields: [
          { name: 'Status', type: 'select', options: { options: [{ name: 'Open' }] } },
          { name: 'Due', type: 'datetime', required: true },
        ],
        idempotency_key: 'k1',
      },
      true,
    ],
    [
      `${String(MCP_CREATE_TABLE_FIELDS_MAX)} fields`,
      {
        base_id,
        name: 'Wide',
        fields: Array.from({ length: MCP_CREATE_TABLE_FIELDS_MAX }, (_, n) => ({
          name: `f${String(n)}`,
          type: 'text',
        })),
      },
      true,
    ],
    [
      `${String(MCP_CREATE_TABLE_FIELDS_MAX + 1)} fields`,
      {
        base_id,
        name: 'Too wide',
        fields: Array.from({ length: MCP_CREATE_TABLE_FIELDS_MAX + 1 }, (_, n) => ({
          name: `f${String(n)}`,
          type: 'text',
        })),
      },
      false,
    ],
    ['a button field', { base_id, name: 'T', fields: [{ name: 'Go', type: 'button' }] }, false],
    [
      'a field with an id',
      { base_id, name: 'T', fields: [{ id: 'fld_x', name: 'A', type: 'text' }] },
      false,
    ],
    ['an empty name', { base_id, name: '  ' }, false],
    ['a table id for the base', { base_id: table_id, name: 'T' }, false],
  ])('create_table: %s', (_case, input, valid) => {
    expect(createTableInputSchema.safeParse(input).success).toBe(valid);
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['a new name', { table_id, field: 'Status', name: 'State' }, true],
    ['options', { table_id, field: 'Status', options: { options: [{ name: 'Done' }] } }, true],
    ['nothing to change', { table_id, field: 'Status' }, false],
    ['nothing but a key', { table_id, field: 'Status', idempotency_key: 'k' }, false],
    ['a type', { table_id, field: 'Status', type: 'text' }, false],
    ['a field id', { table_id, field_id: 'fld_A1b2C3d4E5f6G7h8', name: 'x' }, false],
    ['a position', { table_id, field: 'Status', position: 0 }, false],
  ])('update_field: %s', (_case, input, valid) => {
    expect(updateFieldInputSchema.safeParse(input).success).toBe(valid);
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['names and colours', { options: [{ name: 'Open', color: 3 }, { name: 'Done' }] }, true],
    ['a default by name', { options: [{ name: 'Open' }], default_value: 'Open' }, true],
    ['an option id', { options: [{ id: 'opt_A1b2C3d4E5f6G7h8', name: 'Open' }] }, false],
    ['a name twice', { options: [{ name: 'Open' }, { name: 'Open' }] }, false],
    ['a colour out of range', { options: [{ name: 'Open', color: 55 }] }, false],
    ['AI settings', { ai: { task: 'classify' } }, false],
  ])('select options: %s', (_case, options, valid) => {
    expect(mcpSelectOptionsInputSchema.safeParse(options).success).toBe(valid);
  });

  it('lists its detail code with every documented one', () => {
    expect(ERROR_DETAIL_CODES).toContain(NOT_AVAILABLE_OVER_MCP);
  });
});

describe('MCP automation drafts (CONTRACTS §30.8, T1015)', () => {
  const definition = {
    trigger: { type: 'record.created', table_id: 'tbl_A1b2C3d4E5f6G7h8', skip_bulk: false },
    condition: null,
    actions: [],
  };
  const warning = {
    code: 'literal_chat_id',
    message: 'Step act_1 posts to a chat id written in the draft.',
    action_id: 'act_1',
  };

  it('keeps a draft 24 hours, at most 20 per user', () => {
    expect(MCP_AUTOMATION_DRAFT_TTL_SECONDS).toBe(86_400);
    expect(MCP_AUTOMATION_DRAFTS_PER_USER).toBe(20);
  });

  it('adds the server warning literal_chat_id to the codes the model writes', () => {
    expect(AI_AUTOMATION_MODEL_WARNING_CODES).toEqual([
      'unsupported_action',
      'unsupported_trigger',
      'ambiguous',
    ]);
    expect(AI_AUTOMATION_WARNING_CODES).toEqual([
      ...AI_AUTOMATION_MODEL_WARNING_CODES,
      'literal_chat_id',
    ]);
    expect(aiAutomationWarningSchema.safeParse(warning).success).toBe(true);
    // Model warnings name no step.
    expect(
      aiAutomationWarningSchema.safeParse({ code: 'ambiguous', message: 'Two fields' }).success,
    ).toBe(true);
    expect(aiAutomationWarningSchema.safeParse({ ...warning, action_id: 'x' }).success).toBe(false);
  });

  it('answers the draft with its builder link, and gives it back by id for the builder', () => {
    const result = {
      name: 'Notify',
      definition,
      warnings: [warning],
      open_url:
        'https://cellhive.example.com/b/bse_A1b2C3d4E5f6G7h8/automations/new?draft=mdr_A1b2C3d4E5f6G7h8',
      expires_at: '2026-11-09T10:00:00.000Z',
    };
    expect(draftAutomationResultSchema.parse(result)).toMatchObject({ warnings: [warning] });
    expect(
      mcpAutomationDraftSchema.safeParse({
        id: 'mdr_A1b2C3d4E5f6G7h8',
        base_id: 'bse_A1b2C3d4E5f6G7h8',
        name: 'Notify',
        definition,
        explanation: '',
        warnings: [],
        expires_at: '2026-11-09T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('reads a draft through a session only, and lists its detail code', () => {
    expect(API_TOKEN_ROUTE_SCOPES.getMcpAutomationDraft).toEqual({
      method: 'GET',
      path: '/api/v1/bases/{baseId}/automation-drafts/{draftId}',
      scope: 'session',
    });
    const operation =
      generateOpenApiDocument().paths?.['/api/v1/bases/{baseId}/automation-drafts/{draftId}']?.get;
    expect(operation?.operationId).toBe('getMcpAutomationDraft');
    expect(operation?.security).toEqual([{ sessionCookie: [] }]);
    expect(MCP_AUTOMATION_DRAFT_DETAIL_CODES).toEqual(['UNSUPPORTED_ACTION']);
    expect(ERROR_DETAIL_CODES).toContain('UNSUPPORTED_ACTION');
  });
});
