import {
  createdApiTokenSchema,
  MCP_SCHEMA_CALLS_PER_MINUTE,
  newId,
  organizationSchema,
  roleListSchema,
  type ApiTokenScope,
  type CreatedApiToken,
  type CreateTableResult,
  type FieldDto,
  type Id,
  type McpFieldResult,
  type McpToolError,
  type RealtimeServerMessage,
  type RoleDto,
  type WriteRecordsResult,
} from '@cellhive/contracts';
import {
  BaseRolesRepository,
  OrgMembersRepository,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
} from '@cellhive/server-core';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
} from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

const DAY = 86_400_000;
const ACCEPT = 'application/json, text/event-stream';
const SCHEMA_TOOLS = ['create_table', 'create_field', 'update_field'];
const SCHEMA_READ_TOOLS = ['list_bases', 'list_tables', 'describe_table'];
/** A small column budget, so that P106 can reach it (`MAX_FIELDS_PER_TABLE`). */
const MAX_FIELDS = 40;
/** The text of a tool result with its random data-block tags made equal. */
const untagged = (text: string) =>
  text.replaceAll(/cellhive-data-[0-9a-f]{16}/gu, 'cellhive-data-*');

type Era = 'modern' | 'legacy';
const ERAS = ['modern', 'legacy'] as const;

interface ToolAnswer {
  readonly isError: boolean;
  readonly data: Record<string, unknown>;
  readonly text: string;
}

/**
 * BACKLOG T1014 (CONTRACTS §30.7, §5 P103–P108, ADR-40 amendment): the MCP
 * schema tools `create_table`, `create_field`, `update_field` through HTTP
 * with the real SDK clients of both protocol eras
 * (`@modelcontextprotocol/client` v2 on 2026-07-28,
 * `@modelcontextprotocol/sdk` v1 on 2025-11-25), sent in turn to two API
 * instances.
 *
 * Fixture (CONTRACTS §5): B with Orders (`customer` link → Customers, the
 * AI field `ai_note` whose prompt reads `cost`), Customers, Tickets; r1–r3;
 * B2 (u_admin admin); another organization. "Sales manager" = the Sales
 * role with Orders `manage` (`cost` still `no_perm`) and Tickets read, a
 * direct role of u_sales2 (locked out of `ai_note`). Tokens: `tk_schema_w`
 * (u_admin, `schema:read` + `schema:write`), `tk_schema_w2` (u_admin, the
 * same scopes), `tk_editor_s` (u_editor, the same), `tk_sales_s` (u_sales2,
 * the same), `tk_admin_b2` (u_admin, the same, `base_ids = [B2]`),
 * `tk_other` (stranger, the same, another organization), `tk_sales_r`
 * (u_sales1, `records:read` + `schema:read`), `tk_auto_r` (u_admin,
 * `schema:read` + `automations:read`), `tk_editor` (u_editor, `records:*` +
 * `schema:read`). The schema tool limit is lifted except in P108.
 */
describe('MCP schema tools (T1014)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let urls: Record<'a' | 'b', string>;
  let ws: string;
  let fx: RecordFixture;
  let base2: Id<'bse'>;
  let otherOrgId: Id<'org'>;
  let customer: Id<'fld'>;
  let aiNote: Id<'fld'>;
  let note: Id<'fld'>;
  const sockets: TestSocket[] = [];
  const tk = {} as Record<
    | 'schema_w'
    | 'schema_w2'
    | 'editor_s'
    | 'sales_s'
    | 'admin_b2'
    | 'other'
    | 'sales_r'
    | 'auto_r'
    | 'editor',
    CreatedApiToken
  >;
  const rec = {} as Record<'r1' | 'r2' | 'r3' | 'c1' | 'c2', Id<'rec'>>;

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

  async function toolsOf(era: Era, token: CreatedApiToken) {
    const client = await connected(era, token);
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
    }
  }

  /** One tool call on a fresh client of `era`. */
  async function call(
    token: CreatedApiToken,
    name: string,
    args: Record<string, unknown>,
    era: Era = 'modern',
  ): Promise<ToolAnswer> {
    const client = await connected(era, token);
    try {
      const result = await client.callTool({ name, arguments: args });
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
  async function rawCall(token: CreatedApiToken, name: string, args: unknown) {
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
        params: { name, arguments: args },
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

  async function setMcp(settings: Record<string, boolean>) {
    const response = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
      settings: { mcp: settings },
    });
    expect(response.statusCode, response.body).toBe(200);
    return organizationSchema.parse(response.json()).settings.mcp;
  }

  async function fieldsOf(tableId: Id<'tbl'>): Promise<FieldDto[]> {
    const response = await fx.call('u_admin', 'GET', `/tables/${tableId}/fields`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ items: FieldDto[] }>().items;
  }

  async function tableNames(baseId: Id<'bse'> = fx.baseId): Promise<string[]> {
    const response = await fx.call('u_admin', 'GET', `/bases/${baseId}/tables`);
    return response.json<{ items: { name: string }[] }>().items.map((table) => table.name);
  }

  /** Every cell of Orders as u_admin reads it (P105: no value is ever lost). */
  async function ordersSnapshot(): Promise<unknown> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      {},
    );
    expect(response.statusCode, response.body).toBe(200);
    return response
      .json<{ records: { id: string; fields: Record<string, unknown> }[] }>()
      .records.map((record) => ({ id: record.id, fields: record.fields }));
  }

  const errorOf = (answer: ToolAnswer) => {
    expect(answer.isError, JSON.stringify(answer.data)).toBe(true);
    return answer.data as unknown as McpToolError;
  };

  const okOf = (answer: ToolAnswer): Record<string, unknown> => {
    expect(answer.isError, JSON.stringify(answer.data)).toBe(false);
    return answer.data;
  };

  /** Both API instances: the same rule for the schema tool limit. */
  function schemaLimit(rule: { limit: number; windowSeconds: number }) {
    for (const app of [a, b]) app.app.get(ApiRateLimits).mcpSchema = rule;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    const env = { DATABASE_URL: database.url, MAX_FIELDS_PER_TABLE: String(MAX_FIELDS) };
    a = await startTestApp(env);
    b = await startTestApp(env);
    ws = await listen(a.app);
    const wsB = await listen(b.app);
    urls = {
      a: ws.replace('ws://', 'http://').replace('/ws', '/'),
      b: wsB.replace('ws://', 'http://').replace('/ws', '/'),
    };
    fx = await buildRecordFixture(a, db);
    schemaLimit({ limit: 100_000, windowSeconds: 60 });

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

    // Another organization with MCP and schema writes on; u_admin is a member there too.
    const orgs = await fx.call('stranger', 'GET', '/orgs');
    otherOrgId = orgs.json<{ items: { id: Id<'org'> }[] }>().items[0]?.id as Id<'org'>;
    await new OrgMembersRepository(db).add(orgScope(otherOrgId), fx.users.u_admin.id, 'member');
    expect(
      (
        await fx.call('stranger', 'PATCH', `/orgs/${otherOrgId}`, {
          settings: { mcp: { enabled: true, allow_schema_writes: true } },
        })
      ).statusCode,
    ).toBe(200);

    // Orders: a link to Customers, a plain text field, the AI field `ai_note` reading `cost`.
    const link = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    expect(link.statusCode, link.body).toBe(201);
    customer = link.json<{ id: Id<'fld'> }>().id;
    const text = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'note',
      type: 'text',
    });
    expect(text.statusCode, text.body).toBe(201);
    note = text.json<{ id: Id<'fld'> }>().id;
    aiNote = (
      await a.app.get(SchemaService).addField(
        orgScope(fx.orgId),
        fx.orders.id,
        {
          name: 'ai_note',
          type: 'text',
          options: {
            ai: {
              task: 'summarize',
              prompt: 'Tóm tắt {{ [title] }} — chi phí {{ [cost] }}',
              auto_update: false,
            },
          },
        },
        systemAuditContext(),
      )
    ).id;

    const customers = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
      records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Bình Minh' } }],
    });
    expect(customers.statusCode, customers.body).toBe(201);
    const [c1, c2] = customers.json<{ records: { id: Id<'rec'> }[] }>().records;
    Object.assign(rec, { c1: c1?.id, c2: c2?.id });
    const rows = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        {
          fields: {
            title: 'r1',
            amount: 100,
            cost: 60,
            status: 'Mới',
            owner: [{ id: fx.users.u_sales1.id }],
            customer: [{ id: c1?.id }, { id: c2?.id }],
            note: 'một',
          },
        },
        {
          fields: {
            title: 'r2',
            amount: 200,
            cost: 120,
            status: 'Xong',
            owner: [{ id: fx.users.u_sales2.id }],
            customer: [{ id: c2?.id }],
          },
        },
        { fields: { title: 'r3', amount: 300, cost: 180, status: 'Xong' } },
      ],
    });
    expect(rows.statusCode, rows.body).toBe(201);
    const [r1, r2, r3] = rows.json<{ records: { id: Id<'rec'> }[] }>().records;
    Object.assign(rec, { r1: r1?.id, r2: r2?.id, r3: r3?.id });

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

    const schemaScopes: ApiTokenScope[] = ['schema:read', 'schema:write'];
    tk.schema_w = await createToken('u_admin', schemaScopes);
    tk.schema_w2 = await createToken('u_admin', schemaScopes);
    tk.editor_s = await createToken('u_editor', schemaScopes);
    tk.sales_s = await createToken('u_sales2', schemaScopes);
    tk.admin_b2 = await createToken('u_admin', schemaScopes, { base_ids: [base2] });
    tk.other = await createToken('stranger', schemaScopes, {}, otherOrgId);
    tk.sales_r = await createToken('u_sales1', ['records:read', 'schema:read']);
    tk.auto_r = await createToken('u_admin', ['schema:read', 'automations:read']);
    tk.editor = await createToken('u_editor', ['records:read', 'records:write', 'schema:read']);
  }, 120_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  it.each(ERAS)(
    'P103: schema tools only with schema:write and allow_schema_writes, apart from allow_writes (%s)',
    async (era) => {
      await setMcp({ enabled: true });
      for (const [allowWrites, allowSchemaWrites] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ] as const) {
        expect(
          await setMcp({ allow_writes: allowWrites, allow_schema_writes: allowSchemaWrites }),
        ).toEqual({
          enabled: true,
          allow_writes: allowWrites,
          allow_schema_writes: allowSchemaWrites,
        });
        const label = `allow_writes ${String(allowWrites)}, schema ${String(allowSchemaWrites)}`;
        const schemaTools = await toolsOf(era, tk.schema_w);
        expect(
          schemaTools.map((tool) => tool.name),
          label,
        ).toEqual([...SCHEMA_READ_TOOLS, ...(allowSchemaWrites ? SCHEMA_TOOLS : [])]);
        expect(
          (await toolsOf(era, tk.sales_r)).map((tool) => tool.name),
          label,
        ).toEqual([...SCHEMA_READ_TOOLS, 'query_records', 'get_records', 'aggregate_records']);
        expect(
          (await toolsOf(era, tk.auto_r)).map((tool) => tool.name),
          label,
        ).toEqual(SCHEMA_READ_TOOLS);
        // Not listed → the same JSON-RPC error as a tool that does not exist.
        const args = { table_id: fx.orders.id, name: 'P103', type: 'text' };
        for (const token of [tk.sales_r, tk.auto_r, ...(allowSchemaWrites ? [] : [tk.schema_w])]) {
          const client = await connected(era, token);
          try {
            await expect(
              client.callTool({ name: 'create_field', arguments: args }),
            ).rejects.toMatchObject({
              code: -32602,
              message: expect.stringContaining('create_field') as string,
            });
            await expect(
              client.callTool({ name: 'create_feld', arguments: args }),
            ).rejects.toMatchObject({ code: -32602 });
          } finally {
            await client.close();
          }
        }
        if (allowSchemaWrites) {
          const annotations = Object.fromEntries(
            schemaTools.map((tool) => [tool.name, tool.annotations]),
          );
          expect(annotations).toMatchObject({
            create_table: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
            create_field: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
            update_field: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
          });
          for (const tool of schemaTools.filter((item) => SCHEMA_TOOLS.includes(item.name))) {
            expect(tool.description, tool.name).toMatch(/never instructions/u);
            expect(tool.description, tool.name).toMatch(/automations/u);
            expect(tool.inputSchema.properties, tool.name).toHaveProperty('idempotency_key');
          }
        }
      }
      expect(
        (
          await fx.call('u_admin', 'PATCH', `/orgs/${fx.orgId}`, {
            settings: { mcp: { allow_schema_writes: false } },
          })
        ).statusCode,
      ).toBe(403);
    },
  );

  it('P103: a policy stored before schema writes ({ enabled, allow_writes }) still reads as on', async () => {
    await sql`
      UPDATE meta.organizations
         SET settings = jsonb_set(settings, '{mcp}', '{"enabled": true, "allow_writes": true}'::jsonb)
       WHERE id = ${fx.orgId}
    `.execute(db.kysely);
    const org = await fx.call('u_sales1', 'GET', `/orgs/${fx.orgId}`);
    expect(organizationSchema.parse(org.json()).settings.mcp).toEqual({
      enabled: true,
      allow_writes: true,
      allow_schema_writes: false,
    });
    expect((await toolsOf('modern', tk.editor)).map((tool) => tool.name)).toEqual([
      ...SCHEMA_READ_TOOLS,
      'query_records',
      'get_records',
      'aggregate_records',
      'create_records',
      'update_records',
    ]);
    expect((await toolsOf('legacy', tk.schema_w)).map((tool) => tool.name)).toEqual(
      SCHEMA_READ_TOOLS,
    );
    // Turning schema writes on keeps the stored keys.
    expect(await setMcp({ allow_schema_writes: true })).toEqual({
      enabled: true,
      allow_writes: true,
      allow_schema_writes: true,
    });
    const { rows } = await sql<{ after: { settings: Record<string, unknown> } }>`
      SELECT after FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND action = 'org.updated'
       ORDER BY created_at DESC, id DESC LIMIT 1
    `.execute(db.kysely);
    expect(rows[0]?.after.settings['mcp']).toEqual({
      enabled: true,
      allow_writes: true,
      allow_schema_writes: true,
    });
  });

  it.each(ERAS)(
    'P104: tables need base admin, fields schema rights; NOT_FOUND outside the reach (%s)',
    async (era) => {
      await setMcp({ enabled: true, allow_schema_writes: true });
      const name = `P104 ${era}`;

      // u_editor: no schema rights (P05).
      const editorTable = await call(
        tk.editor_s,
        'create_table',
        { base_id: fx.baseId, name },
        era,
      );
      expect(errorOf(editorTable).code).toBe('PERMISSION_DENIED');
      const editorField = await call(
        tk.editor_s,
        'create_field',
        { table_id: fx.orders.id, name, type: 'text' },
        era,
      );
      expect(errorOf(editorField).code).toBe('PERMISSION_DENIED');
      // "Sales manager" manages Orders but is no base admin.
      const managerTable = await call(
        tk.sales_s,
        'create_table',
        { base_id: fx.baseId, name },
        era,
      );
      expect(errorOf(managerTable).code).toBe('PERMISSION_DENIED');
      expect(await tableNames()).not.toContain(name);

      // u_admin creates the table with its fields.
      const table = okOf(
        await call(
          tk.schema_w,
          'create_table',
          {
            base_id: fx.baseId,
            name,
            primary_field_name: 'Tiêu đề',
            fields: [
              { name: 'Mức', type: 'select', options: { options: [{ name: 'Cao', color: 3 }] } },
              { name: 'Số', type: 'number' },
            ],
          },
          era,
        ),
      ) as unknown as CreateTableResult;
      expect(table).toMatchObject({ name, truncated: false });
      expect(table.fields.map((field) => [field.name, field.type, field.is_primary])).toEqual([
        ['Tiêu đề', 'text', true],
        ['Mức', 'select', false],
        ['Số', 'number', false],
      ]);
      expect(table.fields[1]).toMatchObject({ options: ['Cao'], read_only: false });
      expect(table.views).toHaveLength(1);
      expect(await tableNames()).toContain(name);

      // "Sales manager" adds a field to Orders, which it manages.
      const added = okOf(
        await call(
          tk.sales_s,
          'create_field',
          { table_id: fx.orders.id, name: `Ghi chú ${era}`, type: 'text', description: 'MCP' },
          era,
        ),
      ) as unknown as McpFieldResult;
      expect(added).toEqual({
        table_id: fx.orders.id,
        field: {
          name: `Ghi chú ${era}`,
          type: 'text',
          description: 'MCP',
          is_primary: false,
          read_only: false,
        },
      });

      // `cost` (no permission) is a field that does not exist, byte for byte.
      const update = (field: string) =>
        call(tk.sales_s, 'update_field', { table_id: fx.orders.id, field, name: 'x' }, era);
      const onCost = await update('cost');
      const onXyz = await update('xyz');
      expect(errorOf(onCost)).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'field', code: 'UNKNOWN_FIELD', params: { field: 'cost' } }],
      });
      expect(JSON.stringify(onCost.data).replaceAll('cost', 'xyz')).toBe(
        JSON.stringify(onXyz.data),
      );
      expect(untagged(onCost.text).replaceAll('cost', 'xyz')).toBe(untagged(onXyz.text));

      // Outside `base_ids`, another organization, an unknown id: one NOT_FOUND.
      const outside = [
        await call(tk.admin_b2, 'create_table', { base_id: fx.baseId, name }, era),
        await call(tk.other, 'create_table', { base_id: fx.baseId, name }, era),
        await call(tk.schema_w, 'create_table', { base_id: newId('bse'), name }, era),
        await call(
          tk.admin_b2,
          'create_field',
          { table_id: fx.orders.id, name, type: 'text' },
          era,
        ),
        await call(
          tk.other,
          'update_field',
          { table_id: fx.orders.id, field: 'amount', name },
          era,
        ),
      ];
      for (const answer of outside) {
        expect(errorOf(answer)).toEqual({
          code: 'NOT_FOUND',
          message: 'Not found, or not accessible with this API token.',
          errors: [],
          total: 0,
        });
        expect(untagged(answer.text)).toBe(untagged(String(outside[0]?.text)));
      }
      // Within its base, the limited token works.
      okOf(await call(tk.admin_b2, 'create_table', { base_id: base2, name }, era));
      expect(await tableNames(base2)).toContain(name);
    },
  );

  it('P105: update_field never deletes nor loses data', async () => {
    await setMcp({ enabled: true, allow_schema_writes: true });
    const before = await ordersSnapshot();
    const statusId = fx.fld.status?.id as Id<'fld'>;
    const optionsOf = async (id: Id<'fld'>) =>
      (
        (await fieldsOf(fx.orders.id)).find((field) => field.id === id)?.options['options'] as {
          id: string;
          name: string;
        }[]
      ).map((option) => option.name);
    const storedOptions = async () =>
      (await fieldsOf(fx.orders.id)).find((field) => field.id === statusId)?.options['options'] as {
        id: string;
        name: string;
      }[];
    const idsBefore = (await storedOptions()).map((option) => option.id);

    // A list without "Xong": kept; a new name: added. No job removes values.
    const upserted = okOf(
      await call(tk.schema_w, 'update_field', {
        table_id: fx.orders.id,
        field: 'status',
        options: { options: [{ name: 'Mới', color: 4 }, { name: 'Đang làm' }] },
      }),
    ) as unknown as McpFieldResult;
    expect(upserted.field).toMatchObject({ name: 'status', options: ['Mới', 'Xong', 'Đang làm'] });
    expect(await optionsOf(statusId)).toEqual(['Mới', 'Xong', 'Đang làm']);
    expect((await storedOptions()).slice(0, 2).map((option) => option.id)).toEqual(idsBefore);
    const empty = okOf(
      await call(tk.schema_w, 'update_field', {
        table_id: fx.orders.id,
        field: 'status',
        options: { options: [] },
      }),
    ) as unknown as McpFieldResult;
    expect(empty.field.options).toEqual(['Mới', 'Xong', 'Đang làm']);
    const { rows: jobs } = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM meta.jobs
       WHERE organization_id = ${fx.orgId} AND type = 'schema.remove_select_options'
    `.execute(db.kysely);
    expect(jobs[0]?.count).toBe('0');

    const refusals: [string, Record<string, unknown>, Record<string, unknown>][] = [
      // A type: no such argument.
      [
        'type',
        { table_id: fx.orders.id, field: 'note', name: 'note 2', type: 'number' },
        { code: 'VALIDATION_FAILED', errors: [{ path: 'type', code: 'UNRECOGNIZED_KEY' }] },
      ],
      // One link per cell instead of several would cut links.
      [
        'cut links',
        { table_id: fx.orders.id, field: 'customer', options: { allow_multiple: false } },
        {
          code: 'VALIDATION_FAILED',
          errors: [
            {
              path: 'options.allow_multiple',
              code: 'NOT_AVAILABLE_OVER_MCP',
              params: { reason: 'cuts_links' },
            },
          ],
        },
      ],
      // AI settings: set on a plain field, removed from an AI field.
      [
        'set options.ai',
        {
          table_id: fx.orders.id,
          field: 'note',
          options: { ai: { task: 'summarize', prompt: 'Tóm tắt {{ [title] }}' } },
        },
        {
          code: 'VALIDATION_FAILED',
          errors: [
            {
              path: 'options.ai',
              code: 'NOT_AVAILABLE_OVER_MCP',
              params: { reason: 'ai_options' },
            },
          ],
        },
      ],
      [
        'remove options.ai',
        { table_id: fx.orders.id, field: 'ai_note', options: { ai: null } },
        {
          code: 'VALIDATION_FAILED',
          errors: [
            {
              path: 'options.ai',
              code: 'NOT_AVAILABLE_OVER_MCP',
              params: { reason: 'ai_options' },
            },
          ],
        },
      ],
      // The primary field.
      [
        'primary field',
        { table_id: fx.orders.id, field: 'title', name: 'Tên đơn' },
        {
          code: 'VALIDATION_FAILED',
          errors: [
            { path: 'field', code: 'NOT_AVAILABLE_OVER_MCP', params: { reason: 'primary_field' } },
          ],
        },
      ],
      // Options deleted by id cannot even be named.
      [
        'an option by id',
        {
          table_id: fx.orders.id,
          field: 'status',
          options: { options: [{ id: idsBefore[0], name: 'Mới' }] },
        },
        {
          code: 'VALIDATION_FAILED',
          errors: [{ path: 'options.options[0].id', code: 'UNRECOGNIZED_KEY' }],
        },
      ],
    ];
    for (const era of ERAS) {
      for (const [label, args, expected] of refusals) {
        expect(errorOf(await call(tk.schema_w, 'update_field', args, era)), label).toMatchObject(
          expected,
        );
      }
    }

    // `ai_note` reads `cost`: the "Sales manager" is locked out of it — even a rename.
    for (const era of ERAS) {
      const locked = await call(
        tk.sales_s,
        'update_field',
        { table_id: fx.orders.id, field: 'ai_note', name: 'ai' },
        era,
      );
      expect(errorOf(locked).code).toBe('PERMISSION_DENIED');
    }
    const ai = (await fieldsOf(fx.orders.id)).find((field) => field.id === aiNote);
    expect(ai).toMatchObject({ name: 'ai_note' });
    expect(ai?.options['ai']).toMatchObject({ task: 'summarize' });

    // Creating: no button, parent or system field, no AI settings.
    for (const type of ['button', 'parent', 'created_at', 'auto_number']) {
      const refused = await call(tk.schema_w, 'create_field', {
        table_id: fx.orders.id,
        name: `P105 ${type}`,
        type,
      });
      expect(errorOf(refused), type).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'type' }],
      });
    }
    const aiField = await call(tk.schema_w, 'create_field', {
      table_id: fx.orders.id,
      name: 'P105 ai',
      type: 'select',
      options: { options: [{ name: 'A' }], ai: { task: 'classify', prompt: '{{ [title] }}' } },
    });
    expect(errorOf(aiField)).toMatchObject({
      errors: [{ path: 'options.ai', params: { reason: 'ai_options' } }],
    });

    // No tool deletes anything.
    for (const era of ERAS) {
      const names = (await toolsOf(era, tk.schema_w)).map((tool) => tool.name);
      expect(names.filter((tool) => /delete|remove|drop|purge/u.test(tool))).toEqual([]);
      const client = await connected(era, tk.schema_w);
      try {
        for (const tool of ['delete_field', 'delete_table', 'delete_records']) {
          await expect(
            client.callTool({ name: tool, arguments: { table_id: fx.orders.id } }),
          ).rejects.toMatchObject({ code: -32602 });
        }
      } finally {
        await client.close();
      }
    }

    // Every cell as it was: options, links, AI field, the field `note`.
    expect(await ordersSnapshot()).toEqual(before);
    expect((await fieldsOf(fx.orders.id)).map((field) => field.id)).toEqual(
      expect.arrayContaining([statusId, customer, aiNote, note]),
    );
    const link = (await fieldsOf(fx.orders.id)).find((field) => field.id === customer);
    expect(link?.options).toMatchObject({ allow_multiple: true });
  });

  it('P106: formulas, lookups and links within what the caller reads; the column budget', async () => {
    await setMcp({ enabled: true, allow_schema_writes: true });

    // A formula on `cost` is a formula on a field that does not exist.
    const formula = (field: string) =>
      call(tk.sales_s, 'create_field', {
        table_id: fx.orders.id,
        name: 'lãi',
        type: 'formula',
        options: { expression: `[amount] - [${field}]` },
      });
    const onCost = await formula('cost');
    const onXyz = await formula('xyzw');
    expect(errorOf(onCost).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_FIELD' })]),
    );
    expect(JSON.stringify(onCost.data).replaceAll('cost', 'xyzw')).toBe(JSON.stringify(onXyz.data));
    expect(untagged(onCost.text).replaceAll('cost', 'xyzw')).toBe(untagged(onXyz.text));

    // A lookup into Customers, which the "Sales manager" cannot read.
    const lookup = (field: string) =>
      call(tk.sales_s, 'create_field', {
        table_id: fx.orders.id,
        name: 'tên khách',
        type: 'lookup',
        options: { link_field: 'customer', field },
      });
    const onName = await lookup('Tên');
    const onNope = await lookup('Nope');
    expect(errorOf(onName)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'options.field', code: 'UNKNOWN_FIELD', params: { field: 'Tên' } }],
    });
    expect(JSON.stringify(onName.data).replace('Tên', 'Nope')).toBe(JSON.stringify(onNope.data));

    // Links: to a table it cannot read → NOT_FOUND like an unknown id; two-way to a table it
    // reads without managing it → PERMISSION_DENIED, as through REST.
    const linkTo = (tableId: Id<'tbl'>, bidirectional = false) =>
      call(tk.sales_s, 'create_field', {
        table_id: fx.orders.id,
        name: 'liên kết',
        type: 'link',
        options: { link_table_id: tableId, bidirectional },
      });
    const unreadable = await linkTo(fx.customers.id);
    const unknown = await linkTo(newId('tbl'));
    expect(errorOf(unreadable).code).toBe('NOT_FOUND');
    expect(unreadable.data).toEqual(unknown.data);
    expect(errorOf(await linkTo(fx.tickets.id, true)).code).toBe('PERMISSION_DENIED');
    const names = (await fieldsOf(fx.orders.id)).map((field) => field.name);
    for (const name of ['lãi', 'tên khách', 'liên kết']) expect(names).not.toContain(name);

    // u_admin: a link, a lookup and a formula in one table, by name, in order.
    const table = okOf(
      await call(tk.schema_w, 'create_table', {
        base_id: fx.baseId,
        name: 'Hoá đơn',
        fields: [
          { name: 'Khách', type: 'link', options: { link_table_id: fx.customers.id } },
          { name: 'Tên khách', type: 'lookup', options: { link_field: 'Khách', field: 'Tên' } },
          { name: 'Tiền', type: 'number' },
          { name: 'VAT', type: 'formula', options: { expression: '[Tiền] * 0.1' } },
        ],
      }),
    ) as unknown as CreateTableResult;
    expect(table.fields.map((field) => [field.name, field.type, field.read_only])).toEqual([
      ['Name', 'text', false],
      ['Khách', 'link', false],
      ['Tên khách', 'lookup', true],
      ['Tiền', 'number', false],
      ['VAT', 'formula', true],
    ]);
    expect(table.fields[1]).toMatchObject({ link_table_id: fx.customers.id, multiple: true });

    // Past the column budget: the REST code at fields[i], and no half-made table is left.
    const wide = await call(tk.schema_w, 'create_table', {
      base_id: fx.baseId,
      name: 'Quá rộng',
      fields: Array.from({ length: MAX_FIELDS + 5 }, (_, n) => ({
        name: `c${String(n)}`,
        type: 'text',
      })),
    });
    expect(errorOf(wide)).toMatchObject({
      code: 'FIELD_LIMIT_EXCEEDED',
      errors: [{ path: `fields[${String(MAX_FIELDS - 1)}]` }],
    });
    expect(await tableNames()).not.toContain('Quá rộng');
    const trash = await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/tables/trash`);
    expect(trash.json<{ items: { name: string }[] }>().items.map((item) => item.name)).toContain(
      'Quá rộng',
    );

    // A field that fails names its index; the table it was in goes to the trash too.
    const bad = await call(tk.schema_w, 'create_table', {
      base_id: fx.baseId,
      name: 'Sai',
      fields: [
        { name: 'Một', type: 'text' },
        { name: 'Hai', type: 'select', options: { options: [{ name: 'A', color: 99 }] } },
      ],
    });
    expect(errorOf(bad)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'fields[1].options.options[0].color' }],
    });
    expect(await tableNames()).not.toContain('Sai');
  });

  it('P107: idempotency_key — one table, a replay, a reused key, per token', async () => {
    await setMcp({ enabled: true, allow_writes: true, allow_schema_writes: true });
    const input = {
      base_id: fx.baseId,
      name: 'Một lần',
      fields: [{ name: 'Mức', type: 'select', options: { options: [{ name: 'Cao' }] } }],
      idempotency_key: 'p107-create-table',
    };
    const first = okOf(
      await call(tk.schema_w, 'create_table', input),
    ) as unknown as CreateTableResult;
    expect(first).not.toHaveProperty('replayed');
    const again = okOf(
      await call(tk.schema_w, 'create_table', input, 'legacy'),
    ) as unknown as CreateTableResult;
    expect(again).toEqual({ ...first, replayed: true });
    expect((await tableNames()).filter((name) => name === 'Một lần')).toHaveLength(1);

    // The same key with other arguments.
    const other = await call(tk.schema_w, 'create_table', { ...input, name: 'Hai lần' });
    expect(errorOf(other).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await tableNames()).not.toContain('Hai lần');

    // Two calls at once with one key: the second finds the first still running.
    const slow = {
      base_id: fx.baseId,
      name: 'Song song',
      fields: Array.from({ length: 30 }, (_, n) => ({ name: `f${String(n)}`, type: 'number' })),
      idempotency_key: 'p107-parallel',
    };
    const both = await Promise.all([
      call(tk.schema_w, 'create_table', slow),
      call(tk.schema_w, 'create_table', slow, 'legacy'),
    ]);
    expect(both.map((answer) => answer.isError).sort()).toEqual([false, true]);
    const refused = both.find((answer) => answer.isError);
    expect(errorOf(refused as ToolAnswer).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await tableNames()).filter((name) => name === 'Song song')).toHaveLength(1);

    // Another token, the same key and arguments: its own call — it runs (no replay of the other
    // token's result) and meets the table the first one made.
    const second = await call(tk.schema_w2, 'create_table', input);
    expect(errorOf(second)).toMatchObject({
      code: 'NAME_CONFLICT',
      errors: [{ path: 'name', code: 'NAME_CONFLICT' }],
    });
    expect(
      okOf(
        await call(tk.schema_w2, 'create_table', { ...input, name: 'Khác' }),
      ) as unknown as CreateTableResult,
    ).not.toHaveProperty('replayed');
    expect((await tableNames()).filter((name) => name === 'Một lần')).toHaveLength(1);

    // create_field and update_field replay too.
    const field = { table_id: first.id, name: 'Ghi chú', type: 'text', idempotency_key: 'p107-f' };
    okOf(await call(tk.schema_w, 'create_field', field));
    expect(okOf(await call(tk.schema_w, 'create_field', field))).toMatchObject({ replayed: true });
    expect((await fieldsOf(first.id)).filter((item) => item.name === 'Ghi chú')).toHaveLength(1);
    const rename = {
      table_id: first.id,
      field: 'Ghi chú',
      name: 'Note',
      idempotency_key: 'p107-u',
    };
    okOf(await call(tk.schema_w, 'update_field', rename));
    expect(okOf(await call(tk.schema_w, 'update_field', rename))).toMatchObject({
      replayed: true,
      field: { name: 'Note' },
    });

    // create_records (Câu hỏi mở S8 #10): no duplicate on a resend.
    const count = async () =>
      (await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/records/query`, {})).json<{
        records: unknown[];
      }>().records.length;
    const records = {
      table_id: fx.tickets.id,
      records: [{ fields: { 'Tiêu đề': 'Một lần thôi' } }],
      idempotency_key: 'p107-records',
    };
    const before = await count();
    const created = okOf(
      await call(tk.editor, 'create_records', records),
    ) as unknown as WriteRecordsResult;
    const resent = okOf(
      await call(tk.editor, 'create_records', records, 'legacy'),
    ) as unknown as WriteRecordsResult;
    expect(resent).toEqual({ ...created, replayed: true });
    expect(await count()).toBe(before + 1);
    const updated = await call(tk.editor, 'update_records', {
      table_id: fx.tickets.id,
      records: [{ id: created.record_ids[0], fields: { 'Tiêu đề': 'Đổi' } }],
      idempotency_key: 'p107-records',
    });
    expect(errorOf(updated).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('P108: audit via MCP, schema.changed to the people on the table, 31 calls → RATE_LIMITED', async () => {
    await setMcp({ enabled: true, allow_schema_writes: true });
    const socket = await TestSocket.connect(ws, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie('u_editor'),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`table:${fx.orders.id}`, 's-editor')).toMatchObject({
      type: 'subscribed',
    });

    okOf(
      await call(tk.schema_w, 'create_field', {
        table_id: fx.orders.id,
        name: 'P108',
        type: 'number',
      }),
    );
    const id = (await fieldsOf(fx.orders.id)).find((field) => field.name === 'P108')?.id;
    expect(id).toBeDefined();
    const changed = await socket.next(
      (message: RealtimeServerMessage) =>
        message.type === 'schema.changed' && message.entity_id === id,
    );
    expect(changed).toMatchObject({ type: 'schema.changed', entity_id: id });

    const via = { api_token_id: tk.schema_w.id, mcp: true };
    const { rows } = await sql<{ action: string; actor_id: string; via: unknown }>`
      SELECT action, actor_id, via FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND entity_id = ${String(id)}
    `.execute(db.kysely);
    expect(rows).toEqual([{ action: 'field.created', actor_id: fx.users.u_admin.id, via }]);
    // The audit log of the base (the schema history) shows the source: "via MCP".
    const audit = await fx.call(
      'u_admin',
      'GET',
      `/bases/${fx.baseId}/audit-logs?via=mcp&limit=200`,
    );
    expect(audit.statusCode, audit.body).toBe(200);
    const items = audit.json<{
      items: { action: string; entity_id: string; via: { mcp?: true } | null }[];
    }>().items;
    expect(items.every((item) => item.via?.mcp === true)).toBe(true);
    const actions = new Set(items.map((item) => item.action));
    for (const action of ['table.created', 'field.created', 'field.updated', 'table.deleted']) {
      expect(actions).toContain(action);
    }
    expect(items.find((item) => item.entity_id === id)?.action).toBe('field.created');

    // 30 schema tool calls a minute per token, whatever they do; the 31st is refused.
    schemaLimit({ limit: MCP_SCHEMA_CALLS_PER_MINUTE, windowSeconds: 60 });
    try {
      const token = await createToken('u_admin', ['schema:read', 'schema:write']);
      for (let n = 0; n < MCP_SCHEMA_CALLS_PER_MINUTE; n += 1) {
        const answer = await rawCall(token, 'update_field', {
          table_id: fx.orders.id,
          field: 'P108',
          description: `call ${String(n)}`,
        });
        expect(answer.isError, JSON.stringify(answer.data)).toBe(false);
      }
      const limited = await rawCall(token, 'create_field', {
        table_id: fx.orders.id,
        name: 'P108 31',
        type: 'text',
      });
      expect(limited.isError).toBe(true);
      expect(limited.data).toMatchObject({ code: 'RATE_LIMITED' });
      expect(limited.data['retry_after']).toBeGreaterThanOrEqual(1);
      expect(limited.data['retry_after']).toBeLessThanOrEqual(60);
      expect((await fieldsOf(fx.orders.id)).map((field) => field.name)).not.toContain('P108 31');
      // Reads are not counted.
      expect((await rawCall(token, 'list_tables', { base_id: fx.baseId })).isError).toBe(false);
      // Another token has its own count.
      const fresh = await createToken('u_admin', ['schema:read', 'schema:write']);
      expect(
        (
          await rawCall(fresh, 'update_field', {
            table_id: fx.orders.id,
            field: 'P108',
            name: 'P108',
          })
        ).isError,
      ).toBe(false);
    } finally {
      schemaLimit({ limit: 100_000, windowSeconds: 60 });
    }
  });
});
