import {
  createdApiTokenSchema,
  organizationSchema,
  type ApiTokenScope,
  type CreatedApiToken,
  type Id,
  type ListBasesResult,
} from '@cellhive/contracts';
import {
  BaseRolesRepository,
  OrgMembersRepository,
  orgScope,
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

import { MetricsService } from '../../src/modules/metrics/metrics.service.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { listen } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

const DAY = 86_400_000;
const CHALLENGE = 'Bearer error="invalid_token"';
const ACCEPT = 'application/json, text/event-stream';
const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

interface Exchange {
  readonly instance: 'a' | 'b';
  readonly method: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly sessionId: string | null;
  readonly challenge: string | null;
}

/**
 * BACKLOG T920 (CONTRACTS §30.1, ADR-40): `POST /api/v1/mcp` with real SDK
 * clients of both protocol eras — `@modelcontextprotocol/client` v2 on
 * 2026-07-28 and `@modelcontextprotocol/sdk` v1 on 2025-11-25 — sent in turn
 * to two API instances (stateless: no session, no affinity); the endpoint
 * gates (Bearer only, `Origin`, `405`, `MCP_DISABLED`, scope); `list_bases`
 * within the token's organization and `base_ids`. P94 (`list_bases`), P97,
 * P98, P100 (route scope) of CONTRACTS §5.
 */
describe('MCP endpoint (T920)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let urls: Record<'a' | 'b', string>;
  let fx: RecordFixture;
  let base2: Id<'bse'>;
  let otherOrgId: Id<'org'>;
  let otherBase: Id<'bse'>;
  const tk = {} as Record<
    'sales_r' | 'admin' | 'admin_b2' | 'records_only' | 'other',
    CreatedApiToken
  >;
  const exchanges: Exchange[] = [];

  /** `fetch` for SDK clients: every request to the next instance, recorded. */
  function alternatingFetch(): typeof fetch {
    let next: 'a' | 'b' = 'a';
    return async (input, init) => {
      const instance = next;
      next = next === 'a' ? 'b' : 'a';
      const url = new URL(input instanceof Request ? input.url : String(input));
      const target = new URL(url.pathname, urls[instance]);
      const response = await fetch(target, init);
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { method?: string }) : {};
      exchanges.push({
        instance,
        method: init?.method === 'POST' ? (body.method ?? '?') : (init?.method ?? 'GET'),
        status: response.status,
        contentType: response.headers.get('content-type'),
        sessionId: response.headers.get('mcp-session-id'),
        challenge: response.headers.get('www-authenticate'),
      });
      return response;
    };
  }

  const mcpUrl = () => new URL('/api/v1/mcp', urls.a);

  function post(headers: Record<string, string>, body: unknown = LIST_TOOLS): Promise<Response> {
    return fetch(mcpUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
      body: JSON.stringify(body),
    });
  }

  const bearer = (token: CreatedApiToken) => ({ authorization: `Bearer ${token.token}` });

  async function problemOf(response: Response) {
    return (await response.json()) as { code: string; errors?: { params?: unknown }[] };
  }

  async function createToken(
    user: FixtureUser,
    scopes: ApiTokenScope[],
    extra: Record<string, unknown> = {},
    orgId: Id<'org'> = fx.orgId,
  ): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${orgId}/me/api-tokens`, {
      name: `${user} mcp ${scopes.join(' ')}`,
      scopes,
      expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  async function setMcp(settings: Record<string, boolean>, user: FixtureUser = 'owner') {
    return fx.call(user, 'PATCH', `/orgs/${fx.orgId}`, { settings: { mcp: settings } });
  }

  function modernClient(token: CreatedApiToken) {
    const client = new ModernClient(
      { name: 'cellhive-int', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new ModernTransport(mcpUrl(), {
      requestInit: { headers: bearer(token) },
      fetch: alternatingFetch(),
    });
    return { client, transport };
  }

  function legacyClient(token: CreatedApiToken) {
    const client = new LegacyClient({ name: 'cellhive-int', version: '1.0.0' });
    const transport = new LegacyTransport(mcpUrl(), {
      requestInit: { headers: bearer(token) },
      fetch: alternatingFetch(),
    });
    return { client, transport };
  }

  type Era = 'modern' | 'legacy';
  async function connected(era: Era, token: CreatedApiToken) {
    const { client, transport } = era === 'modern' ? modernClient(token) : legacyClient(token);
    await client.connect(transport);
    return { client, transport };
  }

  async function basesOf(era: Era, token: CreatedApiToken): Promise<string[]> {
    const { client } = await connected(era, token);
    try {
      const result = await client.callTool({ name: 'list_bases', arguments: {} });
      expect(result.isError ?? false).toBe(false);
      const data = result.structuredContent as ListBasesResult;
      expect(data.truncated).toBe(false);
      return data.bases.map((base) => base.id).sort();
    } finally {
      await client.close();
    }
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    const wsA = await listen(a.app);
    const wsB = await listen(b.app);
    urls = {
      a: wsA.replace('ws://', 'http://').replace('/ws', '/'),
      b: wsB.replace('ws://', 'http://').replace('/ws', '/'),
    };
    fx = await buildRecordFixture(a, db);

    // Base B2 (S6 fixture): u_admin is its admin; u_sales1 has no role there.
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
    const assigned = await fx.call('owner', 'PUT', `/bases/${base2}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_admin.id,
      role_id: adminRole?.id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);

    // `stranger` owns another organization with MCP on and one base; u_admin is a member there.
    const orgs = await fx.call('stranger', 'GET', '/orgs');
    otherOrgId = orgs.json<{ items: { id: Id<'org'> }[] }>().items[0]?.id as Id<'org'>;
    await new OrgMembersRepository(db).add(orgScope(otherOrgId), fx.users.u_admin.id, 'member');
    const otherWorkspace = await fx.call('stranger', 'POST', `/orgs/${otherOrgId}/workspaces`, {
      name: 'Elsewhere',
    });
    const other = await fx.call(
      'stranger',
      'POST',
      `/workspaces/${otherWorkspace.json<{ id: string }>().id}/bases`,
      { name: 'Other' },
    );
    expect(other.statusCode, other.body).toBe(201);
    otherBase = other.json<{ id: Id<'bse'> }>().id;
    const otherOn = await fx.call('stranger', 'PATCH', `/orgs/${otherOrgId}`, {
      settings: { mcp: { enabled: true } },
    });
    expect(otherOn.statusCode, otherOn.body).toBe(200);

    tk.sales_r = await createToken('u_sales1', ['records:read', 'schema:read']);
    tk.admin = await createToken('u_admin', ['records:read', 'schema:read']);
    tk.admin_b2 = await createToken('u_admin', ['records:read', 'schema:read'], {
      base_ids: [base2],
    });
    tk.records_only = await createToken('u_admin', ['records:read']);
    tk.other = await createToken('stranger', ['schema:read'], {}, otherOrgId);
  });

  afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  it('P97: answers 403 MCP_DISABLED before any JSON-RPC until an org admin turns MCP on', async () => {
    const off = await post(bearer(tk.sales_r), {});
    expect(off.status).toBe(403);
    expect((await problemOf(off)).code).toBe('MCP_DISABLED');

    const org = await fx.call('u_sales1', 'GET', `/orgs/${fx.orgId}`);
    expect(organizationSchema.parse(org.json()).settings.mcp).toEqual({
      enabled: false,
      allow_writes: false,
    });
    expect((await setMcp({ enabled: true }, 'u_sales1')).statusCode).toBe(403);

    const on = await setMcp({ enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    // Keys left out keep their value.
    expect(organizationSchema.parse(on.json()).settings.mcp).toEqual({
      enabled: true,
      allow_writes: false,
    });
    const { rows } = await sql<{ after: { settings: Record<string, unknown> } }>`
      SELECT after FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND action = 'org.updated'
       ORDER BY created_at DESC, id DESC LIMIT 1
    `.execute(db.kysely);
    expect(rows[0]?.after.settings['mcp']).toEqual({ enabled: true, allow_writes: false });

    const listed = await post(bearer(tk.sales_r));
    expect(listed.status).toBe(200);
    expect(listed.headers.get('content-type')).toMatch(/^application\/json/u);
  });

  it('P97: a token of an organization that turned tokens off stays 401', async () => {
    const off = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
      settings: { api_tokens: { enabled: false } },
    });
    expect(off.statusCode, off.body).toBe(200);
    try {
      const response = await post(bearer(tk.sales_r));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
    } finally {
      await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
        settings: { api_tokens: { enabled: true } },
      });
    }
  });

  it('P98: Bearer only, Origin checked, GET and DELETE are 405', async () => {
    const cookie = await fx.cookie('u_sales1');
    for (const headers of [{ cookie }, {}, { authorization: 'Bearer cht_not_a_real_token' }]) {
      const response = await post(headers);
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
      expect((await problemOf(response)).code).toBe('UNAUTHENTICATED');
    }

    const evil = await post({ ...bearer(tk.sales_r), origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect((await problemOf(evil)).code).toBe('PERMISSION_DENIED');
    const own = await post({ ...bearer(tk.sales_r), origin: new URL(TEST_PUBLIC_URL).origin });
    expect(own.status).toBe(200);

    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(mcpUrl(), { method, headers: bearer(tk.sales_r) });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });

  it('P100: a token without schema:read is refused at the route (INSUFFICIENT_SCOPE)', async () => {
    const response = await post(bearer(tk.records_only));
    expect(response.status).toBe(403);
    const problem = await problemOf(response);
    expect(problem.code).toBe('INSUFFICIENT_SCOPE');
    expect(problem.errors?.[0]?.params).toEqual({ required: ['schema:read'] });
  });

  it.each(['modern', 'legacy'] as const)(
    'serves a real %s-era SDK client statelessly across two instances',
    async (era) => {
      exchanges.length = 0;
      const { client, transport } = await connected(era, tk.sales_r);
      try {
        expect(transport.protocolVersion).toBe(era === 'modern' ? '2026-07-28' : '2025-11-25');
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual(['list_bases']);
        expect(tools.tools[0]?.annotations).toMatchObject({ readOnlyHint: true });
        const result = await client.callTool({ name: 'list_bases', arguments: {} });
        expect(result.structuredContent).toEqual({
          bases: [
            {
              id: fx.baseId,
              name: 'B',
              description: null,
              workspace: { id: expect.any(String) as string, name: 'Sales' },
            },
          ],
          truncated: false,
        });
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
        expect(text).toMatch(/<(cellhive-data-[0-9a-f]{16})>\n.*\n<\/\1>$/su);

        await expect(
          client.callTool({ name: 'delete_everything', arguments: {} }),
        ).rejects.toMatchObject({ code: -32602 });
        const invalid = await client.callTool({ name: 'list_bases', arguments: { x: 1 } });
        expect(invalid.isError).toBe(true);
        expect(invalid.structuredContent).toMatchObject({ code: 'VALIDATION_FAILED' });
      } finally {
        await client.close();
      }
      const posts = exchanges.filter((exchange) => exchange.method !== 'GET');
      expect(new Set(posts.map((exchange) => exchange.instance))).toEqual(new Set(['a', 'b']));
      expect(posts.map((exchange) => exchange.method)).toContain(
        era === 'modern' ? 'server/discover' : 'initialize',
      );
      for (const exchange of exchanges) {
        expect(exchange.sessionId, exchange.method).toBeNull();
        if (exchange.method === 'GET') expect(exchange.status).toBe(405);
        else if (exchange.status === 202) expect(exchange.method).toMatch(/^notifications\//u);
        else expect(exchange.contentType, exchange.method).toMatch(/^application\/json/u);
      }
    },
  );

  it.each(['modern', 'legacy'] as const)(
    'P94: list_bases within the organization and base_ids of the token (%s)',
    async (era) => {
      expect(await basesOf(era, tk.admin)).toEqual([fx.baseId, base2].sort());
      expect(await basesOf(era, tk.admin_b2)).toEqual([base2]);
      expect(await basesOf(era, tk.sales_r)).toEqual([fx.baseId]);
      expect(await basesOf(era, tk.other)).toEqual([otherBase]);
    },
  );

  it.each(['modern', 'legacy'] as const)(
    'answers 401 on the call right after the token is revoked (%s)',
    async (era) => {
      const token = await createToken('u_sales1', ['schema:read']);
      exchanges.length = 0;
      const { client } = await connected(era, token);
      try {
        await client.callTool({ name: 'list_bases', arguments: {} });
        const revoked = await fx.call('u_sales1', 'DELETE', `/api-tokens/${token.id}`);
        expect(revoked.statusCode, revoked.body).toBe(204);
        await expect(client.callTool({ name: 'list_bases', arguments: {} })).rejects.toThrow();
      } finally {
        await client.close().catch(() => undefined);
      }
      const last = exchanges.filter((exchange) => exchange.method === 'tools/call').at(-1);
      expect(last).toMatchObject({ status: 401, challenge: CHALLENGE });
    },
  );

  it('counts requests and tool calls without organization, user or token labels', async () => {
    const text = await a.app.get(MetricsService).registry.metrics();
    expect(text).toMatch(/mcp_requests_total\{method="tools\/call",status="200"\} \d+/u);
    expect(text).toMatch(/mcp_tool_calls_total\{tool="list_bases",status="ok"\} \d+/u);
    expect(text).toMatch(/mcp_tool_seconds_count\{tool="list_bases"\} \d+/u);
    expect(text).not.toMatch(/mcp_[^\n]*(org_|usr_|tok_)/u);
  });
});
