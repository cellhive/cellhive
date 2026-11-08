import {
  aiAutomationDraftSchema,
  automationSchema,
  createdApiTokenSchema,
  draftAutomationResultSchema,
  MCP_AUTOMATION_DRAFTS_PER_USER,
  mcpAutomationDraftSchema,
  newId,
  roleListSchema,
  type ApiTokenScope,
  type CreatedApiToken,
  type DraftAutomationResult,
  type Id,
  type McpToolError,
  type RoleDto,
} from '@cellhive/contracts';
import { BaseRolesRepository, orgScope, type Db } from '@cellhive/server-core';
import { startFakeOpenAiServer, type FakeOpenAiServer } from '@cellhive/server-core/testing';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
} from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CACHE_CLIENT } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { listen } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Redis } from 'ioredis';

const DAY = 86_400_000;
const ACCEPT = 'application/json, text/event-stream';
const LOCALHOST = () => Promise.resolve(['127.0.0.1']);
/** The milestone sentence of S8 (Quyết định S8 #6). */
const MILESTONE = 'Khi ticket chuyển DONE thì gửi Telegram cho người phụ trách';
const EXPLANATION = 'Gửi qua kênh thông báo của người nhận (Telegram nếu đã liên kết).';
/** The data-block tags of a tool result made equal. */
const untagged = (text: string) =>
  text.replaceAll(/cellhive-data-[0-9a-f]{16}/gu, 'cellhive-data-*');

type Era = 'modern' | 'legacy';
const ERAS = ['modern', 'legacy'] as const;

/** The milestone as the model of T908 answers it: every key, unused ones `null`. */
const MODEL_DRAFT = {
  name: 'Báo người phụ trách khi ticket xong',
  trigger: {
    type: 'record.updated',
    table: 'Tickets',
    watch_fields: ['Trạng thái'],
    changed_to: 'Đã xong',
    form: null,
    cron: null,
    date_field: null,
    offset_minutes: null,
  },
  condition: null,
  actions: [
    {
      type: 'send_notification',
      table: null,
      fields: null,
      recipients: ['Phụ trách'],
      title: 'Ticket {{ [Tiêu đề] }} đã xong',
      text: 'Số tiền: {{ [Số tiền] }}',
      bot: null,
      chat_id: null,
      chat_field: null,
      minutes: null,
    },
  ],
  explanation: EXPLANATION,
  warnings: [],
};

/** The same draft as an MCP client writes it: unused keys left out, no warnings. */
const CLIENT_DRAFT = {
  name: MODEL_DRAFT.name,
  trigger: { type: 'record.updated', watch_fields: ['Trạng thái'], changed_to: 'Đã xong' },
  actions: [
    {
      type: 'send_notification',
      recipients: ['Phụ trách'],
      title: 'Ticket {{ [Tiêu đề] }} đã xong',
      text: 'Số tiền: {{ [Số tiền] }}',
    },
  ],
  explanation: EXPLANATION,
};

interface ToolAnswer {
  readonly isError: boolean;
  readonly data: Record<string, unknown>;
  readonly text: string;
}

/**
 * BACKLOG T1015 (CONTRACTS §30.8, §5 P109–P110, research S9 §5.3): the MCP
 * tool `draft_automation` through HTTP with the real SDK clients of both
 * protocol eras (`@modelcontextprotocol/client` v2 on 2026-07-28,
 * `@modelcontextprotocol/sdk` v1 on 2025-11-25), sent in turn to two API
 * instances, and the session-only route the builder reads the draft from.
 *
 * Fixture (CONTRACTS §5): B with Orders, Customers, Tickets (+ `Phụ trách`,
 * a user field); a Telegram bot usable in B; B2 (u_admin admin); another
 * organization. "Sales manager" = the Sales role with Orders `manage`
 * (`cost` still `no_perm`) and Tickets read, a direct role of u_sales2.
 * Tokens (all with `schema:read` + `automations:read`, the route and tool
 * scopes): `tk_auto_r` (u_admin), `tk_reader_auto` (u_reader),
 * `tk_sales_r` (u_sales1, also `records:read`), `tk_sales_auto`
 * (u_sales2), `tk_admin_b2` (u_admin, `base_ids = [B2]`), `tk_other`
 * (stranger, another organization); `tk_schema` (u_admin, `schema:read`
 * only). The organization's AI is off except in the T908 comparison, with
 * a fake provider whose requests every case counts.
 */
describe('MCP draft_automation (T1015)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let urls: Record<'a' | 'b', string>;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let cache: Redis;
  let base2: Id<'bse'>;
  let otherOrgId: Id<'org'>;
  let assignee: Id<'fld'>;
  let botId: Id<'sec'>;
  const tk = {} as Record<
    'auto_r' | 'reader_auto' | 'sales_r' | 'sales_auto' | 'admin_b2' | 'other' | 'schema',
    CreatedApiToken
  >;

  /** `fetch` for SDK clients: every request to the next instance. */
  function alternatingFetch(): typeof fetch {
    let next: 'a' | 'b' = 'a';
    return (input, init) => {
      const instance = next;
      next = next === 'a' ? 'b' : 'a';
      const url = new URL(input instanceof Request ? input.url : String(input));
      return fetch(new URL(url.pathname, urls[instance]), init);
    };
  }

  const mcpUrl = () => new URL('/api/v1/mcp', urls.a);
  const bearer = (token: CreatedApiToken) => ({ authorization: `Bearer ${token.token}` });

  async function connected(era: Era, token: CreatedApiToken) {
    if (era === 'modern') {
      const client = new ModernClient(
        { name: 'cellhive-int', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      await client.connect(
        new ModernTransport(mcpUrl(), {
          requestInit: { headers: bearer(token) },
          fetch: alternatingFetch(),
        }),
      );
      return client;
    }
    const client = new LegacyClient({ name: 'cellhive-int', version: '1.0.0' });
    await client.connect(
      new LegacyTransport(mcpUrl(), {
        requestInit: { headers: bearer(token) },
        fetch: alternatingFetch(),
      }),
    );
    return client;
  }

  /** One `draft_automation` call on a fresh client of `era`. */
  async function draft(
    token: CreatedApiToken,
    args: Record<string, unknown>,
    era: Era = 'modern',
  ): Promise<ToolAnswer> {
    const client = await connected(era, token);
    try {
      const result = await client.callTool({ name: 'draft_automation', arguments: args });
      return {
        isError: result.isError === true,
        data: result.structuredContent as Record<string, unknown>,
        text: (result.content as { text: string }[])[0]?.text ?? '',
      };
    } finally {
      await client.close();
    }
  }

  /** One `tools/call` posted as a 2025-era request (no handshake), for many quick calls. */
  async function rawDraft(token: CreatedApiToken, args: unknown) {
    const response = await fetch(mcpUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        'mcp-protocol-version': '2025-06-18',
        ...bearer(token),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'draft_automation', arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    return { isError: result.isError ?? false, data: result.structuredContent };
  }

  async function createToken(
    user: FixtureUser,
    scopes: ApiTokenScope[],
    extra: Record<string, unknown> = {},
    orgId: Id<'org'> = fx.orgId,
  ): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${orgId}/me/api-tokens`, {
      name: `${user} ${scopes.join(' ')} ${newId('req').slice(-6)}`,
      scopes,
      expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  const errorOf = (answer: ToolAnswer | { isError: boolean; data: Record<string, unknown> }) => {
    expect(answer.isError, JSON.stringify(answer.data)).toBe(true);
    return answer.data as unknown as McpToolError;
  };

  const okOf = (answer: { isError: boolean; data: Record<string, unknown> }) => {
    expect(answer.isError, JSON.stringify(answer.data)).toBe(false);
    return draftAutomationResultSchema.parse(answer.data);
  };

  const draftIdOf = (result: DraftAutomationResult) =>
    new URL(result.open_url).searchParams.get('draft') as Id<'mdr'>;
  const draftUrl = (draftId: string, baseId: Id<'bse'> = fx.baseId) =>
    `/bases/${baseId}/automation-drafts/${draftId}`;

  /** What a draft must never leave behind: automations, events, audit entries. */
  async function footprint() {
    const { rows } = await sql<{ automations: number; events: number; audits: number }>`
      SELECT (SELECT count(*)::int FROM meta.automations) AS automations,
             (SELECT count(*)::int FROM meta.events) AS events,
             (SELECT count(*)::int FROM meta.audit_logs) AS audits`.execute(db.kysely);
    return rows[0];
  }

  /** The definition of the milestone with the ids of this fixture (CONTRACTS §29.3). */
  function milestoneDefinition() {
    const options = (fx.fld['ticketStatus']?.options as { options: { id: string; name: string }[] })
      .options;
    return {
      trigger: {
        type: 'record.updated',
        table_id: fx.tickets.id,
        watch_fields: [fx.fld['ticketStatus']?.id],
        skip_bulk: false,
      },
      condition: {
        field: fx.fld['ticketStatus']?.id,
        operator: 'changed_to',
        value: options.find((option) => option.name === 'Đã xong')?.id,
      },
      actions: [
        {
          id: 'act_1',
          type: 'send_notification',
          config: {
            recipients: [{ field: assignee }],
            title: { template: `Ticket {{ [${String(fx.fld['ticketTitle']?.id)}] }} đã xong` },
            body: { template: `Số tiền: {{ [${String(fx.fld['ticketAmount']?.id)}] }}` },
            link_record: 'trigger',
            skip_actor: false,
          },
        },
      ],
    };
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    const env = { DATABASE_URL: database.url };
    a = await startTestApp(env, { outboundLookup: LOCALHOST });
    b = await startTestApp(env, { outboundLookup: LOCALHOST });
    const wsA = await listen(a.app);
    const wsB = await listen(b.app);
    urls = {
      a: wsA.replace('ws://', 'http://').replace('/ws', '/'),
      b: wsB.replace('ws://', 'http://').replace('/ws', '/'),
    };
    fx = await buildRecordFixture(a, db);
    cache = a.app.get<Redis>(CACHE_CLIENT);
    fake = await startFakeOpenAiServer();
    const entry = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `localhost:${String(fake.port)}`,
    });
    expect(entry.statusCode, entry.body).toBe(201);
    expect(
      (
        await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
          settings: { mcp: { enabled: true } },
        })
      ).statusCode,
    ).toBe(200);

    // The person in charge of a ticket (CONTRACTS §1.4 + the milestone sentence).
    const field = await fx.call('owner', 'POST', `/tables/${fx.tickets.id}/fields`, {
      name: 'Phụ trách',
      type: 'user',
      options: { multiple: false },
    });
    expect(field.statusCode, field.body).toBe(201);
    assignee = field.json<{ id: Id<'fld'> }>().id;
    const secret = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'telegram_bot',
      name: 'Bot nhóm',
      value: '000000000:FAKE_TEST_TOKEN_not_a_real_bot_000000',
      base_scope: 'all',
    });
    expect(secret.statusCode, secret.body).toBe(201);
    botId = secret.json<{ id: Id<'sec'> }>().id;

    // B2: u_admin is its admin.
    const workspaces = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/workspaces`);
    const workspaceId = workspaces.json<{ items: { id: Id<'wsp'> }[] }>().items[0]?.id;
    const created = await fx.call('owner', 'POST', `/workspaces/${String(workspaceId)}/bases`, {
      name: 'B2',
    });
    expect(created.statusCode, created.body).toBe(201);
    base2 = created.json<{ id: Id<'bse'> }>().id;
    const adminRole = (
      await new BaseRolesRepository(db).listByBase(orgScope(fx.orgId), base2)
    ).find((role) => role.kind === 'system_admin');
    expect(
      (
        await fx.call('owner', 'PUT', `/bases/${base2}/role-assignments`, {
          principal_type: 'user',
          principal_id: fx.users.u_admin.id,
          role_id: adminRole?.id,
        })
      ).statusCode,
    ).toBe(200);

    // Another organization with MCP on.
    const orgs = await fx.call('stranger', 'GET', '/orgs');
    otherOrgId = orgs.json<{ items: { id: Id<'org'> }[] }>().items[0]?.id as Id<'org'>;
    expect(
      (
        await fx.call('stranger', 'PATCH', `/orgs/${otherOrgId}`, {
          settings: { mcp: { enabled: true } },
        })
      ).statusCode,
    ).toBe(200);

    // "Sales manager": Sales with Orders `manage` and Tickets read, u_sales2's direct role.
    const sales = roleListSchema
      .parse((await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json())
      .items.find((role) => role.name === 'Sales') as RoleDto;
    const tables = structuredClone(sales.config.tables) as Record<string, Record<string, unknown>>;
    tables[fx.orders.id] = { ...tables[fx.orders.id], perm: 'manage' };
    tables[fx.tickets.id] = { perm: 'read_only', field_rule: { mode: 'all_read' } };
    const manager = await fx.call('owner', 'POST', `/bases/${fx.baseId}/roles`, {
      name: 'Sales quản lý',
      config: { ...sales.config, tables },
    });
    expect(manager.statusCode, manager.body).toBe(201);
    expect(
      (
        await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
          principal_type: 'user',
          principal_id: fx.users.u_sales2.id,
          role_id: manager.json<{ id: Id<'rol'> }>().id,
        })
      ).statusCode,
    ).toBe(200);

    const scopes: ApiTokenScope[] = ['schema:read', 'automations:read'];
    tk.auto_r = await createToken('u_admin', scopes);
    tk.reader_auto = await createToken('u_reader', scopes);
    tk.sales_r = await createToken('u_sales1', ['records:read', ...scopes]);
    tk.sales_auto = await createToken('u_sales2', scopes);
    tk.admin_b2 = await createToken('u_admin', scopes, { base_ids: [base2] });
    tk.other = await createToken('stranger', scopes, {}, otherOrgId);
    tk.schema = await createToken('u_admin', ['schema:read']);
  }, 120_000);

  afterAll(async () => {
    await fake.close();
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  beforeEach(() => {
    fake.requests.length = 0;
  });

  it.each(ERAS)(
    'P109: the milestone drafted by a client is checked and kept, with AI off: nothing stored, no event, the provider gets nothing (%s)',
    async (era) => {
      const before = await footprint();
      const result = okOf(
        await draft(
          tk.auto_r,
          { base_id: fx.baseId, table_id: fx.tickets.id, draft: CLIENT_DRAFT },
          era,
        ),
      );
      expect(result).toEqual({
        name: CLIENT_DRAFT.name,
        definition: milestoneDefinition(),
        warnings: [],
        open_url: `${TEST_PUBLIC_URL}/b/${fx.baseId}/automations/new?draft=${draftIdOf(result)}`,
        expires_at: result.expires_at,
      });
      expect(draftIdOf(result)).toMatch(/^mdr_[0-9A-Za-z]{16}$/u);
      const expires = Date.parse(result.expires_at) - Date.now();
      expect(expires).toBeGreaterThan(DAY - 60_000);
      expect(expires).toBeLessThanOrEqual(DAY);
      // Kept in Valkey for 24 hours, bound to its creator, organization and base.
      const key = `ob:mcp-draft:${draftIdOf(result)}`;
      expect(await cache.ttl(key)).toBeGreaterThan(86_340);
      expect(JSON.parse((await cache.get(key)) ?? '{}')).toMatchObject({
        user_id: fx.users.u_admin.id,
        organization_id: fx.orgId,
        base_id: fx.baseId,
      });
      // AI is off: no request, nothing in the base, no event, no audit entry.
      expect(fake.requests).toEqual([]);
      expect(await footprint()).toEqual(before);
      expect(before?.automations).toBe(0);
    },
  );

  it('P109: the milestone of a client compiles to the definition of the T908 draft of the sentence', async () => {
    const configured = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
    });
    expect(configured.statusCode, configured.body).toBe(200);
    try {
      fake.script({ content: JSON.stringify(MODEL_DRAFT) });
      const fromModel = await fx.call(
        'u_admin',
        'POST',
        `/bases/${fx.baseId}/ai/automation-draft`,
        {
          prompt: MILESTONE,
          table_id: fx.tickets.id,
        },
      );
      expect(fromModel.statusCode, fromModel.body).toBe(200);
      expect(fake.chatRequests()).toHaveLength(1);
      const model = aiAutomationDraftSchema.parse(fromModel.json());

      // The client's draft: unused keys left out, the trigger table from `table_id`.
      for (const era of ERAS) {
        const client = okOf(
          await draft(
            tk.auto_r,
            { base_id: fx.baseId, table_id: fx.tickets.id, draft: CLIENT_DRAFT },
            era,
          ),
        );
        expect(client.definition).toEqual(model.definition);
        expect(client.definition).toEqual(milestoneDefinition());
        expect(client.warnings).toEqual(model.warnings);
      }
      // The model's full draft without its warnings is a valid client draft too.
      const full = Object.fromEntries(
        Object.entries(MODEL_DRAFT).filter(([key]) => key !== 'warnings'),
      );
      expect(okOf(await draft(tk.auto_r, { base_id: fx.baseId, draft: full })).definition).toEqual(
        model.definition,
      );
      // Only the T908 call reached the provider.
      expect(fake.chatRequests()).toHaveLength(1);
    } finally {
      const off = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
        enabled: false,
      });
      expect(off.statusCode, off.body).toBe(200);
    }
    // AI turned off again: the tool still drafts, the provider still gets nothing.
    fake.requests.length = 0;
    okOf(
      await draft(tk.auto_r, { base_id: fx.baseId, table_id: fx.tickets.id, draft: CLIENT_DRAFT }),
    );
    expect(fake.requests).toEqual([]);
  });

  it.each(ERAS)(
    'P109: who may create no automation gets PERMISSION_DENIED; what the token cannot reach NOT_FOUND (%s)',
    async (era) => {
      const args = { base_id: fx.baseId, table_id: fx.tickets.id, draft: CLIENT_DRAFT };
      // u_reader and u_sales1 (Sales: `edit`, nothing to manage) cannot create automations.
      for (const token of [tk.reader_auto, tk.sales_r]) {
        expect(errorOf(await draft(token, args, era))).toMatchObject({
          code: 'PERMISSION_DENIED',
        });
      }
      // "Sales manager": Customers not readable → NOT_FOUND, like an unknown table;
      // Tickets read but not managed → PERMISSION_DENIED.
      const notFound = errorOf(
        await draft(tk.sales_auto, { ...args, table_id: fx.customers.id }, era),
      );
      expect(notFound).toEqual({
        code: 'NOT_FOUND',
        message: 'Not found, or not accessible with this API token.',
        errors: [],
        total: 0,
      });
      expect(errorOf(await draft(tk.sales_auto, { ...args, table_id: newId('tbl') }, era))).toEqual(
        notFound,
      );
      expect(errorOf(await draft(tk.sales_auto, args, era))).toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      // B outside `base_ids`, another organization, an unknown base: one NOT_FOUND.
      for (const [token, baseId] of [
        [tk.admin_b2, fx.baseId],
        [tk.other, fx.baseId],
        [tk.auto_r, newId('bse')],
      ] as const) {
        expect(errorOf(await draft(token, { ...args, base_id: baseId }, era))).toEqual(notFound);
      }
      // Without `automations:read` the tool is not listed: the error of a tool that does not exist.
      const client = await connected(era, tk.schema);
      try {
        expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
          'draft_automation',
        );
        await expect(
          client.callTool({ name: 'draft_automation', arguments: args }),
        ).rejects.toThrow(/Unknown tool: draft_automation/u);
      } finally {
        await client.close();
      }
      expect(fake.requests).toEqual([]);
      expect((await footprint())?.automations).toBe(0);
    },
  );

  it.each(ERAS)(
    'P109: cost is UNKNOWN_FIELD exactly like a field that does not exist; paths follow the draft (%s)',
    async (era) => {
      const ordersDraft = (field: string) => ({
        base_id: fx.baseId,
        table_id: fx.orders.id,
        draft: {
          name: 'Báo khi đổi',
          trigger: { type: 'record.updated', watch_fields: [field] },
          actions: [{ type: 'send_notification', recipients: ['owner'], title: 'Đổi' }],
        },
      });
      const cost = await draft(tk.sales_auto, ordersDraft('cost'), era);
      const missing = await draft(tk.sales_auto, ordersDraft('xyz'), era);
      expect(errorOf(cost)).toEqual({
        code: 'VALIDATION_FAILED',
        message:
          'The draft does not compile, or does not pass the check of saving it, with your permissions.',
        errors: [
          {
            path: 'draft.trigger.watch_fields[0]',
            code: 'UNKNOWN_FIELD',
            message: 'Not a field of this table',
          },
        ],
        total: 1,
      });
      expect(untagged(cost.text)).toBe(untagged(missing.text));
      expect(cost.data).toEqual(missing.data);
      // u_admin reads `cost`: the same draft passes.
      okOf(await draft(tk.auto_r, ordersDraft('cost'), era));
      // The save check's errors keep the draft's paths, names instead of ids.
      const computed = errorOf(
        await draft(
          tk.auto_r,
          {
            base_id: fx.baseId,
            table_id: fx.tickets.id,
            draft: {
              ...CLIENT_DRAFT,
              actions: [{ type: 'update_record', fields: [{ field: 'Mã ticket', value: 'TK-1' }] }],
            },
          },
          era,
        ),
      );
      expect(computed.errors).toEqual([
        expect.objectContaining({
          path: 'draft.actions[0].config.fields.Mã ticket',
          code: 'FIELD_READ_ONLY',
        }),
      ]);
      expect(JSON.stringify(computed)).not.toMatch(/(fld|tbl|opt)_/u);
      // A key the draft does not have: the input schema's error, with its path.
      expect(
        errorOf(
          await draft(
            tk.auto_r,
            { base_id: fx.baseId, draft: { ...CLIENT_DRAFT, enabled: true } },
            era,
          ),
        ).errors,
      ).toEqual([expect.objectContaining({ path: 'draft.enabled', code: 'UNRECOGNIZED_KEY' })]);
      expect(fake.requests).toEqual([]);
    },
  );

  it.each(ERAS)(
    'P109: steps drafts never have are UNSUPPORTED_ACTION; a chat id written in the draft is a literal_chat_id warning (%s)',
    async (era) => {
      const args = (actions: unknown[]) => ({
        base_id: fx.baseId,
        table_id: fx.tickets.id,
        draft: { ...CLIENT_DRAFT, actions },
      });
      const unsupported = errorOf(
        await draft(
          tk.auto_r,
          args([
            CLIENT_DRAFT.actions[0],
            { type: 'http_request', text: 'https://example.com/hook' },
            { type: 'delete_record' },
          ]),
          era,
        ),
      );
      expect(unsupported).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [
          { path: 'draft.actions[1].type', code: 'UNSUPPORTED_ACTION' },
          { path: 'draft.actions[2].type', code: 'UNSUPPORTED_ACTION' },
        ],
        total: 2,
      });
      expect(unsupported.errors[0]?.message).toContain('A draft has no http_request step');

      const before = await footprint();
      const telegram = okOf(
        await draft(
          tk.auto_r,
          args([
            { type: 'send_telegram', bot: 'Bot nhóm', chat_id: '-1001234567890', text: 'Xong' },
            CLIENT_DRAFT.actions[0],
          ]),
          era,
        ),
      );
      // A warning, not a refusal: the draft is kept with the chat as written.
      expect(telegram.definition.actions[0]).toMatchObject({
        id: 'act_1',
        type: 'send_telegram',
        config: { secret_id: botId, chat_id: { literal: '-1001234567890' } },
      });
      expect(telegram.warnings).toEqual([
        {
          code: 'literal_chat_id',
          message:
            'Step act_1 posts to the Telegram chat -1001234567890 written in the draft, not ' +
            'taken from a field: save it only if this group or channel is yours.',
          action_id: 'act_1',
        },
      ]);
      // The builder reads the same warning.
      const stored = await fx.call('u_admin', 'GET', draftUrl(draftIdOf(telegram)));
      expect(stored.statusCode, stored.body).toBe(200);
      expect(mcpAutomationDraftSchema.parse(stored.json()).warnings).toEqual(telegram.warnings);
      expect(await footprint()).toEqual(before);
      expect(fake.requests).toEqual([]);
    },
  );

  it('P110: only the creator’s session reads the draft, in its base; anyone else, a token, an expired draft → 404 / 403', async () => {
    const result = okOf(
      await draft(tk.auto_r, { base_id: fx.baseId, table_id: fx.tickets.id, draft: CLIENT_DRAFT }),
    );
    const draftId = draftIdOf(result);

    // The creator's session: the draft as the tool answered it.
    const own = await fx.call('u_admin', 'GET', draftUrl(draftId));
    expect(own.statusCode, own.body).toBe(200);
    expect(mcpAutomationDraftSchema.parse(own.json())).toEqual({
      id: draftId,
      base_id: fx.baseId,
      name: CLIENT_DRAFT.name,
      definition: result.definition,
      explanation: EXPLANATION,
      warnings: [],
      expires_at: result.expires_at,
    });

    // Another user of the organization (one who can open B, one who cannot), another
    // organization, another base, an unknown draft: one 404.
    for (const user of [
      'u_editor',
      'u_sales2',
      'u_reader',
      'u_out',
      'stranger',
      'owner',
    ] as const) {
      expectProblem(await fx.call(user, 'GET', draftUrl(draftId)), 404, 'NOT_FOUND');
    }
    expectProblem(await fx.call('u_admin', 'GET', draftUrl(draftId, base2)), 404, 'NOT_FOUND');
    expectProblem(await fx.call('u_admin', 'GET', draftUrl(newId('mdr'))), 404, 'NOT_FOUND');
    expectProblem(await fx.call('u_admin', 'GET', draftUrl('mdr_short')), 422, 'VALIDATION_FAILED');

    // API tokens never read a draft: session only, after the base check.
    for (const token of [
      tk.auto_r,
      await createToken('u_admin', [
        'schema:read',
        'records:read',
        'automations:read',
        'automations:write',
      ]),
    ]) {
      const response = await fx.call('u_admin', 'GET', draftUrl(draftId), undefined, bearer(token));
      expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
      expect(response.json<{ errors: { params: unknown }[] }>().errors[0]?.params).toEqual({
        required: ['session'],
      });
    }
    expectProblem(
      await fx.call('u_admin', 'GET', draftUrl(draftId), undefined, bearer(tk.admin_b2)),
      404,
      'NOT_FOUND',
    );

    // Valkey deletes it after 24 hours (the key's TTL); a stale `expires_at` reads as gone too.
    const key = `ob:mcp-draft:${draftId}`;
    const value = JSON.parse((await cache.get(key)) ?? '{}') as Record<string, unknown>;
    await cache.set(
      key,
      JSON.stringify({ ...value, expires_at: new Date(Date.now() - 1000).toISOString() }),
      'EX',
      60,
    );
    expectProblem(await fx.call('u_admin', 'GET', draftUrl(draftId)), 404, 'NOT_FOUND');
    await cache.set(key, JSON.stringify(value), 'PX', 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await cache.exists(key)).toBe(0);
    expectProblem(await fx.call('u_admin', 'GET', draftUrl(draftId)), 404, 'NOT_FOUND');

    // Saving it is the builder's usual create, turned off: the first automation of the base.
    const saved = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: result.name,
      definition: result.definition,
      enabled: false,
    });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(automationSchema.parse(saved.json())).toMatchObject({
      enabled: false,
      definition: result.definition,
    });
    expect((await footprint())?.automations).toBe(1);
  });

  it(`keeps the ${String(MCP_AUTOMATION_DRAFTS_PER_USER)} latest drafts of a user`, async () => {
    const args = { base_id: fx.baseId, table_id: fx.tickets.id, draft: CLIENT_DRAFT };
    const ids: Id<'mdr'>[] = [];
    for (let index = 0; index <= MCP_AUTOMATION_DRAFTS_PER_USER; index += 1) {
      ids.push(draftIdOf(okOf(await rawDraft(tk.auto_r, args))));
    }
    const [first, second] = ids;
    expectProblem(await fx.call('u_admin', 'GET', draftUrl(String(first))), 404, 'NOT_FOUND');
    expect((await fx.call('u_admin', 'GET', draftUrl(String(second)))).statusCode).toBe(200);
    expect((await fx.call('u_admin', 'GET', draftUrl(String(ids.at(-1))))).statusCode).toBe(200);
    expect(await cache.llen(`ob:mcp-drafts:${fx.users.u_admin.id}`)).toBe(
      MCP_AUTOMATION_DRAFTS_PER_USER,
    );
    // Another user's drafts are their own count.
    okOf(
      await rawDraft(tk.sales_auto, {
        base_id: fx.baseId,
        table_id: fx.orders.id,
        draft: {
          name: 'Đơn mới',
          trigger: { type: 'record.created' },
          actions: [{ type: 'send_notification', recipients: ['owner'], title: 'Đơn mới' }],
        },
      }),
    );
    expect((await fx.call('u_admin', 'GET', draftUrl(String(second)))).statusCode).toBe(200);
  });
});
