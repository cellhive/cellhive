import {
  API_TOKEN_BEARER_FAILURES_PER_IP,
  CSRF_HEADER,
  createdApiTokenSchema,
  IMPORT_JOB_TYPE,
  newId,
  type ApiTokenScope,
  type CreatedApiToken,
  type Id,
} from '@cellhive/contracts';
import {
  apiTokenChecksum,
  AUDIT_EXPORT_JOB_TYPE,
  BaseRolesRepository,
  JobsRepository,
  OrgMembersRepository,
  orgScope,
  type Db,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AccessService } from '../../src/common/access/access.service.js';
import { ApiTokenAuthService } from '../../src/common/auth/api-token-auth.service.js';
import {
  ApiRateLimits,
  DEFAULT_BASE_RATE_LIMIT,
  DEFAULT_PRINCIPAL_RATE_LIMIT,
} from '../../src/common/rate-limit/api-rate-limits.js';

import { seedOrg, uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  relaxRateLimits,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const ALL_SCOPES: ApiTokenScope[] = [
  'records:read',
  'records:write',
  'schema:read',
  'schema:write',
  'automations:read',
  'automations:write',
];
const CHALLENGE = 'Bearer error="invalid_token"';
const DAY = 86_400_000;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** The SQL text of every statement the process sends to PostgreSQL while `run` runs. */
async function sqlDuring(run: () => Promise<unknown>): Promise<string[]> {
  const statements: string[] = [];
  const prototype = pg.Client.prototype as unknown as {
    query: (this: pg.Client, ...args: unknown[]) => unknown;
  };
  const original = prototype.query;
  const spy = vi.spyOn(prototype, 'query').mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const first = args[0];
    statements.push(
      typeof first === 'string' ? first : String((first as { text?: unknown } | null)?.text),
    );
    return original.apply(this, args);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return statements;
}

/** A token with a valid shape and checksum that was never issued. */
function unknownToken(): string {
  const random = 'Zz9'.repeat(10);
  return `cht_${random}${apiTokenChecksum(random)}`;
}

/**
 * BACKLOG T704 (CONTRACTS §26.1–26.3, ADR-36 §1): `Authorization: Bearer`
 * authentication over real HTTP — the route → scope check, the token's
 * organization and `base_ids` limits on top of the user's current access,
 * per-token rate limits, `last_used_at`, the 401s with `WWW-Authenticate`,
 * no fallback to the cookie and no CSRF; P28 and P53–P56 of the permission
 * matrix (CONTRACTS §5).
 */
describe('API token Bearer authentication (T704)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let otherOrgId: Id<'org'>;
  let workspaceId: Id<'wsp'>;
  let base2: Id<'bse'>;
  let automationId: Id<'aut'>;
  let viewId: Id<'viw'>;
  const ids = {} as Record<'r1' | 'r2', Id<'rec'>>;
  const tk = {} as Record<
    'sales_r' | 'sales_w' | 'editor' | 'admin_b2' | 'admin_a' | 'reader',
    CreatedApiToken
  >;

  const orders = () => `/tables/${fx.orders.id}/records`;
  const customers = () => `/tables/${fx.customers.id}/records`;
  const amountField = () => fx.fld['amount']?.id as Id<'fld'>;

  function bearer(
    token: string,
    method: Method,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    return t.app.inject({
      method,
      url: `/api/v1${url}`,
      // A fresh client IP each time: failed Bearer authentications are limited per IP.
      remoteAddress: uniqueIp(),
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  async function createToken(
    user: FixtureUser,
    scopes: ApiTokenScope[],
    extra: Record<string, unknown> = {},
  ): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: `${user} ${scopes.join(' ')}`.slice(0, 100),
      scopes,
      expires_at: new Date(Date.now() + 90 * DAY).toISOString(),
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  function expect401(response: LightMyRequestResponse, code: string): void {
    expectProblem(response, 401, code);
    expect(response.headers['www-authenticate']).toBe(CHALLENGE);
  }

  function expectScope(response: LightMyRequestResponse, required: string): void {
    expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
    const problem = problemOf(response.body) as {
      errors?: { code: string; params?: { required?: unknown } }[];
    };
    expect(problem.errors?.[0]).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      params: { required: [required] },
    });
  }

  const recordsOf = (response: LightMyRequestResponse) =>
    response.json<{ records: { id: Id<'rec'>; fields: Record<string, unknown> }[] }>().records;

  const lastUsedAt = async (id: Id<'tok'>) =>
    (
      await sql<{ last_used_at: Date | null }>`
        SELECT last_used_at FROM meta.api_tokens WHERE id = ${id}
      `.execute(db.kysely)
    ).rows[0]?.last_used_at ?? null;

  const setPolicy = async (enabled: boolean) => {
    const response = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
      settings: { api_tokens: { enabled } },
    });
    expect(response.statusCode, response.body).toBe(200);
  };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const scope = orgScope(fx.orgId);

    // Orders r1 (owner u_sales1) and r2 (owner u_sales2), CONTRACTS §5.
    const created = await fx.call('u_admin', 'POST', orders(), {
      records: [
        {
          fields: {
            title: 'r1',
            amount: 100,
            cost: 60,
            status: 'Mới',
            owner: [{ id: fx.users.u_sales1.id }],
          },
        },
        {
          fields: {
            title: 'r2',
            amount: 200,
            cost: 120,
            status: 'Mới',
            owner: [{ id: fx.users.u_sales2.id }],
          },
        },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    const [r1, r2] = recordsOf(created);
    ids.r1 = r1?.id as Id<'rec'>;
    ids.r2 = r2?.id as Id<'rec'>;

    // Base B2 (S6 fixture): u_admin is its admin, u_sales1 has no role.
    const workspaces = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/workspaces`);
    workspaceId = workspaces.json<{ items: { id: Id<'wsp'> }[] }>().items[0]?.id as Id<'wsp'>;
    const b2 = await fx.call('owner', 'POST', `/workspaces/${workspaceId}/bases`, { name: 'B2' });
    expect(b2.statusCode, b2.body).toBe(201);
    base2 = b2.json<{ id: Id<'bse'> }>().id;
    const adminRole = (await new BaseRolesRepository(db).listByBase(scope, base2)).find(
      (role) => role.kind === 'system_admin',
    );
    const assigned = await fx.call('owner', 'PUT', `/bases/${base2}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_admin.id,
      role_id: adminRole?.id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);

    // u_admin also belongs to another organization.
    otherOrgId = await seedOrg(db, 'Other');
    await new OrgMembersRepository(db).add(orgScope(otherOrgId), fx.users.u_admin.id, 'member');

    // An automation and a view of base B.
    const automation = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Set amount',
      definition: {
        trigger: { type: 'record.created', table_id: fx.orders.id },
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: { table_id: fx.orders.id, fields: { [amountField()]: { literal: 1 } } },
          },
        ],
      },
    });
    expect(automation.statusCode, automation.body).toBe(201);
    automationId = automation.json<{ id: Id<'aut'> }>().id;
    const views = await fx.call('owner', 'GET', `/tables/${fx.orders.id}/views`);
    expect(views.statusCode, views.body).toBe(200);
    viewId = views.json<{ items: { id: Id<'viw'> }[] }>().items[0]?.id as Id<'viw'>;

    tk.sales_r = await createToken('u_sales1', ['records:read', 'schema:read']);
    tk.sales_w = await createToken('u_sales1', ['records:write']);
    tk.editor = await createToken('u_editor', ALL_SCOPES);
    tk.admin_b2 = await createToken('u_admin', ALL_SCOPES, { base_ids: [base2] });
    tk.admin_a = await createToken('u_admin', ['records:read', 'schema:read']);
    tk.reader = await createToken('u_reader', ALL_SCOPES);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('P28 / P53: user ∩ scope', () => {
    it('P28: a records:read token of u_sales1 cannot PATCH r1 (403 INSUFFICIENT_SCOPE)', async () => {
      expectScope(
        await bearer(tk.sales_r.token, 'PATCH', `${orders()}/${ids.r1}`, { fields: { amount: 1 } }),
        'records:write',
      );
      expectScope(
        await bearer(tk.sales_r.token, 'PATCH', orders(), {
          records: [{ id: ids.r1, fields: { amount: 1 } }],
        }),
        'records:write',
      );
    });

    it('P53: tk_sales_r reads only r1 without `cost`; Customers is 404', async () => {
      const query = await bearer(tk.sales_r.token, 'POST', `${orders()}/query`, {});
      expect(query.statusCode, query.body).toBe(200);
      const list = recordsOf(query);
      expect(list.map((record) => record.id)).toEqual([ids.r1]);
      expect(list[0]?.fields).not.toHaveProperty('cost');
      expect(list[0]?.fields).toHaveProperty('amount');
      const one = await bearer(tk.sales_r.token, 'GET', `${orders()}/${ids.r1}`);
      expect(one.statusCode, one.body).toBe(200);
      expect(one.json<{ fields: object }>().fields).not.toHaveProperty('cost');
      expectProblem(
        await bearer(tk.sales_r.token, 'GET', `${orders()}/${ids.r2}`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await bearer(tk.sales_r.token, 'POST', `${customers()}/query`, {}),
        404,
        'NOT_FOUND',
      );
    });

    it('P53: tk_sales_w writes r1 as u_sales1 would; r2 is 404; write never implies read', async () => {
      const patched = await bearer(tk.sales_w.token, 'PATCH', `${orders()}/${ids.r1}`, {
        fields: { amount: 120 },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expectProblem(
        await bearer(tk.sales_w.token, 'PATCH', `${orders()}/${ids.r2}`, { fields: { amount: 1 } }),
        404,
        'NOT_FOUND',
      );
      // The user's field rules still apply (P10).
      expectProblem(
        await bearer(tk.sales_w.token, 'PATCH', `${orders()}/${ids.r1}`, {
          fields: { status: 'Xong' },
        }),
        403,
        'FIELD_READ_ONLY',
      );
      expectScope(await bearer(tk.sales_w.token, 'POST', `${orders()}/query`, {}), 'records:read');
    });

    it('checks the schema and automation scopes, and the user still needs the access', async () => {
      expect((await bearer(tk.sales_r.token, 'GET', `/tables/${fx.orders.id}`)).statusCode).toBe(
        200,
      );
      expectScope(
        await bearer(tk.sales_r.token, 'POST', `/tables/${fx.orders.id}/fields`, {
          name: 'x',
          type: 'text',
        }),
        'schema:write',
      );
      expectScope(
        await bearer(tk.admin_a.token, 'GET', `/automations/${automationId}`),
        'automations:read',
      );
      const automations = await createToken('u_admin', ['automations:read']);
      expect(
        (await bearer(automations.token, 'GET', `/automations/${automationId}`)).statusCode,
      ).toBe(200);
      expectScope(
        await bearer(automations.token, 'POST', `/automations/${automationId}/disable`, {}),
        'automations:write',
      );
      // u_reader's token has every scope, u_reader is still a reader (P03).
      expectProblem(
        await bearer(tk.reader.token, 'PATCH', `${orders()}/${ids.r1}`, { fields: { amount: 2 } }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await bearer(tk.reader.token, 'POST', `/tables/${fx.orders.id}/fields`, {
          name: 'x',
          type: 'text',
        }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('QA S6: rendering a record in a step test needs records:read, not only automations:write', async () => {
      const writer = await createToken('u_admin', ['automations:write']);
      for (const route of ['email-preview', 'http-test']) {
        const url = `/automations/${automationId}/actions/act_1/${route}`;
        expectScope(await bearer(writer.token, 'POST', url, { record_id: ids.r1 }), 'records:read');
        // Without a record: the usual answer (`act_1` is no such step → 404), no scope refusal.
        expectProblem(
          await bearer(writer.token, 'POST', url, { record_id: null }),
          404,
          'NOT_FOUND',
        );
      }
      // The test send renders the same request (refused before anything is sent).
      expectScope(
        await bearer(
          writer.token,
          'POST',
          `/automations/${automationId}/actions/act_1/email-test`,
          { record_id: ids.r1 },
        ),
        'records:read',
      );
      const both = await createToken('u_admin', ['automations:write', 'records:read']);
      expectProblem(
        await bearer(
          both.token,
          'POST',
          `/automations/${automationId}/actions/act_1/email-preview`,
          {
            record_id: ids.r1,
          },
        ),
        404,
        'NOT_FOUND',
      );
    });

    it('GET /me and GET /orgs show only the token organization', async () => {
      const me = await bearer(tk.admin_a.token, 'GET', '/me');
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json<{ orgs: { id: string }[] }>().orgs.map((org) => org.id)).toEqual([fx.orgId]);
      expect(me.headers['set-cookie']).toBeUndefined();
      const orgs = await bearer(tk.admin_a.token, 'GET', '/orgs');
      expect(orgs.statusCode, orgs.body).toBe(200);
      expect(JSON.stringify(orgs.json())).not.toContain(otherOrgId);
      // A session of the same user sees both.
      const session = await fx.call('u_admin', 'GET', '/me');
      expect(
        session
          .json<{ orgs: { id: string }[] }>()
          .orgs.map((org) => org.id)
          .sort(),
      ).toEqual([fx.orgId, otherOrgId].sort());
    });
  });

  describe('P54: base and organization limits', () => {
    it('everything of base B is 404 for tk_admin_b2, B2 works', async () => {
      const token = tk.admin_b2.token;
      for (const [method, url] of [
        ['GET', `/bases/${fx.baseId}`],
        ['GET', `/bases/${fx.baseId}/tables`],
        ['GET', `/tables/${fx.orders.id}`],
        ['GET', orders()],
        ['POST', `${orders()}/query`],
        ['GET', `/fields/${amountField()}`],
        ['GET', `/views/${viewId}`],
        ['GET', `/automations/${automationId}`],
        ['GET', `/bases/${fx.baseId}/automations`],
        ['PATCH', `${orders()}/${ids.r1}`],
      ] as const) {
        const payload =
          method === 'PATCH' ? { fields: { amount: 1 } } : method === 'POST' ? {} : undefined;
        expectProblem(await bearer(token, method, url, payload), 404, 'NOT_FOUND');
      }
      // The same user's session still sees B.
      expect((await fx.call('u_admin', 'GET', `/bases/${fx.baseId}`)).statusCode).toBe(200);
      expect((await bearer(token, 'GET', `/bases/${base2}`)).statusCode).toBe(200);
      expect((await bearer(token, 'GET', `/bases/${base2}/tables`)).statusCode).toBe(200);
    });

    it('lists only B2 (and its workspace) for tk_admin_b2', async () => {
      const bases = await bearer(tk.admin_b2.token, 'GET', `/workspaces/${workspaceId}/bases`);
      expect(bases.statusCode, bases.body).toBe(200);
      expect(bases.json<{ items: { id: string }[] }>().items.map((base) => base.id)).toEqual([
        base2,
      ]);
      const all = await bearer(tk.admin_a.token, 'GET', `/workspaces/${workspaceId}/bases`);
      expect(
        all
          .json<{ items: { id: string }[] }>()
          .items.map((base) => base.id)
          .sort(),
      ).toEqual([fx.baseId, base2].sort());
      const workspaces = await bearer(tk.admin_b2.token, 'GET', `/orgs/${fx.orgId}/workspaces`);
      expect(workspaces.statusCode, workspaces.body).toBe(200);
      expect(workspaces.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
        workspaceId,
      ]);
      expect(
        (await bearer(tk.admin_b2.token, 'GET', `/orgs/${fx.orgId}/workspaces/${workspaceId}`))
          .statusCode,
      ).toBe(200);
    });

    it('routes of another organization of the user are 404', async () => {
      expectProblem(await bearer(tk.admin_a.token, 'GET', `/orgs/${otherOrgId}`), 404, 'NOT_FOUND');
      expectProblem(
        await bearer(tk.admin_a.token, 'GET', `/orgs/${otherOrgId}/workspaces`),
        404,
        'NOT_FOUND',
      );
      expect((await fx.call('u_admin', 'GET', `/orgs/${otherOrgId}`)).statusCode).toBe(200);
    });

    it('a missing scope outside the token reach is 404, not 403', async () => {
      // tk_admin_a has no records:write; r1 is reachable → 403 …
      expectScope(
        await bearer(tk.admin_a.token, 'PATCH', `${orders()}/${ids.r1}`, { fields: { amount: 1 } }),
        'records:write',
      );
      // … but a session-only route of a base outside base_ids → 404.
      expectProblem(
        await bearer(tk.admin_b2.token, 'GET', `/bases/${fx.baseId}/roles`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await bearer(tk.admin_a.token, 'GET', `/orgs/${otherOrgId}/members`),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('service layer (ApiTokenAuthService, AccessService)', () => {
    it('resolves the token principal and limits it to its organization and bases', async () => {
      const auth = t.app.get(ApiTokenAuthService);
      const access = t.app.get(AccessService);
      const principal = await auth.authenticate(tk.admin_b2.token);
      expect(principal).toMatchObject({
        kind: 'api_token',
        userId: fx.users.u_admin.id,
        organizationId: fx.orgId,
        tokenId: tk.admin_b2.id,
        scopes: ALL_SCOPES,
        baseIds: [base2],
      });
      expect((await access.memberships(principal)).map((item) => item.organizationId)).toEqual([
        fx.orgId,
      ]);
      expect(await access.findBase(principal, fx.baseId)).toBeUndefined();
      expect((await access.findBase(principal, base2))?.access.is_admin).toBe(true);
      expect(await access.findOrg(principal, otherOrgId)).toBeUndefined();
      // P53 at the service level: the user's own access, not more.
      const sales = await auth.authenticate(tk.sales_r.token);
      const base = await access.findBase(sales, fx.baseId);
      expect(base?.access.tables[fx.customers.id]).toBeUndefined();
      expect(base?.access.tables[fx.orders.id]?.perm).toBe('edit');
      // P55: a wrong checksum never reaches the database.
      await expect(auth.authenticate(`${tk.sales_r.token.slice(0, -1)}#`)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    });
  });

  describe('P56: session-only routes and no fallback to the cookie', () => {
    it('tk_editor (every scope) gets 403 INSUFFICIENT_SCOPE ["session"] on management routes', async () => {
      const token = tk.editor.token;
      for (const [method, url] of [
        ['POST', `/bases/${fx.baseId}/roles`],
        ['PUT', `/bases/${fx.baseId}/role-assignments`],
        ['POST', `/orgs/${fx.orgId}/me/api-tokens`],
        ['GET', `/orgs/${fx.orgId}/me/api-tokens`],
        ['DELETE', `/api-tokens/${tk.editor.id}`],
        ['POST', `/views/${viewId}/share-links`],
        ['GET', `/orgs/${fx.orgId}/audit-logs`],
        ['GET', `/bases/${fx.baseId}/audit-logs`],
        ['POST', `/bases/${fx.baseId}/audit-logs/export`],
        ['POST', `/orgs/${fx.orgId}/secrets`],
        ['GET', `/orgs/${fx.orgId}/members`],
        ['POST', `/orgs/${fx.orgId}/workspaces`],
        ['PATCH', `/orgs/${fx.orgId}`],
        ['GET', `/orgs/${fx.orgId}/me/notifications`],
      ] as const) {
        const response = await bearer(token, method, url, method === 'GET' ? undefined : {});
        expectScope(response, 'session');
      }
      // The token still works and is not revoked.
      expect((await bearer(token, 'GET', `/bases/${fx.baseId}`)).statusCode).toBe(200);
    });

    it('a bad Bearer with a valid cookie is 401, never the cookie session', async () => {
      const cookie = await fx.cookie('u_editor');
      expect(
        (await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } })).statusCode,
      ).toBe(200);
      for (const authorization of [
        `Bearer ${unknownToken()}`,
        'Bearer cht_short',
        'Bearer',
        'Basic dXNlcjpwYXNz',
        `Token ${tk.editor.token}`,
        '',
      ]) {
        const response = await t.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          remoteAddress: uniqueIp(),
          headers: { cookie, authorization },
        });
        expect401(response, 'UNAUTHENTICATED');
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    });

    it('a valid Bearer wins over the cookie and needs no CSRF token', async () => {
      const cookie = await fx.cookie('u_editor');
      // The cookie (u_editor, editor of Orders) could write; the token cannot.
      const response = await t.app.inject({
        method: 'PATCH',
        url: `/api/v1${orders()}/${ids.r1}`,
        headers: { cookie, authorization: `Bearer ${tk.sales_r.token}` },
        payload: { fields: { amount: 3 } },
      });
      expectScope(response, 'records:write');
      // POST with a token, no cookie, no CSRF header → 2xx.
      const created = await bearer(tk.editor.token, 'POST', orders(), {
        records: [{ fields: { title: 'by token', amount: 5 } }],
      });
      expect(created.statusCode, created.body).toBe(201);
      // The same POST with the session cookie and no CSRF token is refused.
      const noCsrf = await t.app.inject({
        method: 'POST',
        url: `/api/v1${orders()}`,
        headers: { cookie },
        payload: { records: [{ fields: { title: 'by cookie' } }] },
      });
      expectProblem(noCsrf, 403, 'CSRF_INVALID');
      expect(CSRF_HEADER).toBe('x-csrf-token');
    });

    it('public routes ignore the Authorization header', async () => {
      for (const url of ['/api/v1/auth/providers', '/api/v1/setup', '/healthz']) {
        const response = await t.app.inject({
          method: 'GET',
          url,
          headers: { authorization: 'Bearer nonsense' },
        });
        expect(response.statusCode, `${url} ${response.body}`).toBe(200);
      }
      const share = await t.app.inject({
        method: 'GET',
        url: '/api/v1/shares/notatoken/meta',
        headers: { authorization: `Bearer ${tk.editor.token}` },
      });
      expect(share.statusCode).not.toBe(401);
      expect(share.headers['www-authenticate']).toBeUndefined();
      // T721: the incoming hook and Telegram webhook routes never reach the API
      // token branch either — an unknown path token is their own 404, not the
      // Bearer 401 of the AuthGuard.
      for (const url of ['/api/v1/hooks/notatoken', '/api/v1/telegram/webhook/notatoken']) {
        const response = await t.app.inject({
          method: 'POST',
          url,
          headers: {
            authorization: `Bearer ${tk.editor.token}`,
            'content-type': 'application/json',
          },
          payload: { update_id: 1 },
        });
        expect(response.statusCode, `${url} ${response.body}`).toBe(404);
        expect(response.headers['www-authenticate'], url).toBeUndefined();
      }
    });
  });

  describe('P55: token lifecycle', () => {
    it('a wrong checksum is 401 without a single database query', async () => {
      const valid = tk.sales_r.token;
      const last = valid.at(-1) === 'A' ? 'B' : 'A';
      const tampered = `${valid.slice(0, -1)}${last}`;
      let response: LightMyRequestResponse | undefined;
      const statements = await sqlDuring(async () => {
        response = await bearer(tampered, 'GET', `/bases/${fx.baseId}`);
      });
      expect401(response as LightMyRequestResponse, 'UNAUTHENTICATED');
      expect(statements).toEqual([]);
      // Malformed tokens likewise.
      const malformed = await sqlDuring(async () => {
        response = await bearer('cht_tooShort', 'GET', `/bases/${fx.baseId}`);
      });
      expect401(response as LightMyRequestResponse, 'UNAUTHENTICATED');
      expect(malformed).toEqual([]);
      // A well-formed unknown token costs one lookup.
      const unknown = await sqlDuring(async () => {
        response = await bearer(unknownToken(), 'GET', `/bases/${fx.baseId}`);
      });
      expect401(response as LightMyRequestResponse, 'UNAUTHENTICATED');
      expect(unknown).toHaveLength(1);
    });

    it('revoked → 401 TOKEN_REVOKED, expired → 401 TOKEN_EXPIRED', async () => {
      const revoked = await createToken('u_sales1', ['records:read']);
      expect((await bearer(revoked.token, 'POST', `${orders()}/query`, {})).statusCode).toBe(200);
      expect((await fx.call('u_sales1', 'DELETE', `/api-tokens/${revoked.id}`)).statusCode).toBe(
        204,
      );
      expect401(await bearer(revoked.token, 'POST', `${orders()}/query`, {}), 'TOKEN_REVOKED');

      const expiring = await createToken('u_sales1', ['records:read']);
      expect((await bearer(expiring.token, 'POST', `${orders()}/query`, {})).statusCode).toBe(200);
      await sql`
        UPDATE meta.api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${expiring.id}
      `.execute(db.kysely);
      expect401(await bearer(expiring.token, 'POST', `${orders()}/query`, {}), 'TOKEN_EXPIRED');
    });

    it('g_sales losing its role makes Orders 404 for tk_sales_r at once', async () => {
      const salesRole = (
        await new BaseRolesRepository(db).listByBase(orgScope(fx.orgId), fx.baseId)
      ).find((role) => role.name === 'Sales');
      const group = (
        await sql<{ group_id: Id<'grp'> }>`
          SELECT principal_id AS group_id FROM meta.base_role_members
           WHERE organization_id = ${fx.orgId} AND role_id = ${salesRole?.id ?? ''}
        `.execute(db.kysely)
      ).rows[0]?.group_id as Id<'grp'>;
      const removed = await fx.call('owner', 'DELETE', `/bases/${fx.baseId}/role-assignments`, {
        principal_type: 'group',
        principal_id: group,
      });
      expect(removed.statusCode, removed.body).toBe(204);
      try {
        expectProblem(
          await bearer(tk.sales_r.token, 'POST', `${orders()}/query`, {}),
          404,
          'NOT_FOUND',
        );
      } finally {
        const restored = await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
          principal_type: 'group',
          principal_id: group,
          role_id: salesRole?.id,
        });
        expect(restored.statusCode, restored.body).toBe(200);
      }
      expect((await bearer(tk.sales_r.token, 'POST', `${orders()}/query`, {})).statusCode).toBe(
        200,
      );
    });

    it('the organization turning tokens off makes every token 401 until it turns them on', async () => {
      await setPolicy(false);
      try {
        expect401(
          await bearer(tk.sales_r.token, 'POST', `${orders()}/query`, {}),
          'UNAUTHENTICATED',
        );
        expect401(await bearer(tk.editor.token, 'GET', `/bases/${fx.baseId}`), 'UNAUTHENTICATED');
        // Sessions are unaffected.
        expect((await fx.call('u_sales1', 'POST', `${orders()}/query`, {})).statusCode).toBe(200);
      } finally {
        await setPolicy(true);
      }
      expect((await bearer(tk.sales_r.token, 'POST', `${orders()}/query`, {})).statusCode).toBe(
        200,
      );
    });

    it('a user who is not active is 401', async () => {
      const token = await createToken('u_reader', ['schema:read']);
      await sql`UPDATE meta.users SET status = 'disabled' WHERE id = ${fx.users.u_reader.id}`.execute(
        db.kysely,
      );
      try {
        expect401(await bearer(token.token, 'GET', '/me'), 'UNAUTHENTICATED');
      } finally {
        await sql`UPDATE meta.users SET status = 'active' WHERE id = ${fx.users.u_reader.id}`.execute(
          db.kysely,
        );
      }
      expect((await bearer(token.token, 'GET', '/me')).statusCode).toBe(200);
    });
  });

  describe('rate limits and last_used_at', () => {
    it('61 requests in a window from one token → 429 + Retry-After; another token of the user is not limited', async () => {
      expect(DEFAULT_PRINCIPAL_RATE_LIMIT).toEqual({ limit: 60, windowSeconds: 1 });
      expect(DEFAULT_BASE_RATE_LIMIT).toEqual({ limit: 20, windowSeconds: 1 });
      const limits = t.app.get(ApiRateLimits);
      const first = await createToken('u_sales2', ['schema:read']);
      const second = await createToken('u_sales2', ['schema:read']);
      // 60 per window as in production; a long window keeps the test exact.
      limits.perPrincipal = { limit: 60, windowSeconds: 120 };
      try {
        for (let index = 0; index < 60; index += 1) {
          const response = await bearer(first.token, 'GET', '/me');
          expect(response.statusCode, `request ${String(index + 1)}`).toBe(200);
        }
        const limited = await bearer(first.token, 'GET', '/me');
        expectProblem(limited, 429, 'RATE_LIMITED');
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        expect((await bearer(second.token, 'GET', '/me')).statusCode).toBe(200);
        // Nor is the user's session.
        expect((await fx.call('u_sales2', 'GET', '/me')).statusCode).toBe(200);
      } finally {
        relaxRateLimits(t);
      }
    });

    it('21 requests on one base from one token → 429; the same token on another base is not limited', async () => {
      const limits = t.app.get(ApiRateLimits);
      const token = await createToken('u_admin', ['schema:read']);
      limits.perBase = { limit: 20, windowSeconds: 120 };
      try {
        for (let index = 0; index < 20; index += 1) {
          expect((await bearer(token.token, 'GET', `/bases/${fx.baseId}`)).statusCode).toBe(200);
        }
        expectProblem(await bearer(token.token, 'GET', `/bases/${fx.baseId}`), 429, 'RATE_LIMITED');
        expect((await bearer(token.token, 'GET', `/bases/${base2}`)).statusCode).toBe(200);
        expect((await bearer(tk.admin_a.token, 'GET', `/bases/${fx.baseId}`)).statusCode).toBe(200);
      } finally {
        relaxRateLimits(t);
      }
    });

    it('writes last_used_at once per 5 minutes under 1,000 requests', async () => {
      const token = await createToken('u_editor', ['schema:read']);
      expect(await lastUsedAt(token.id)).toBeNull();
      expect((await bearer(token.token, 'GET', '/me')).statusCode).toBe(200);
      const first = await lastUsedAt(token.id);
      expect(first).not.toBeNull();
      const isTouch = (statement: string) =>
        /^update "meta"\."api_tokens" set "last_used_at"/iu.test(statement);
      const statements = await sqlDuring(async () => {
        for (let batch = 0; batch < 50; batch += 1) {
          const responses = await Promise.all(
            Array.from({ length: 20 }, () => bearer(token.token, 'GET', '/me')),
          );
          for (const response of responses) expect(response.statusCode).toBe(200);
        }
      });
      expect(statements.filter(isTouch)).toEqual([]);
      expect(await lastUsedAt(token.id)).toEqual(first);
      // Five minutes later the next request writes it again, once.
      await sql`
        UPDATE meta.api_tokens SET last_used_at = now() - interval '6 minutes' WHERE id = ${token.id}
      `.execute(db.kysely);
      const later = await sqlDuring(async () => {
        await Promise.all(Array.from({ length: 5 }, () => bearer(token.token, 'GET', '/me')));
      });
      expect(later.filter(isTouch).length).toBeGreaterThanOrEqual(1);
      const touched = await lastUsedAt(token.id);
      expect(touched?.getTime()).toBeGreaterThan(Date.now() - 60_000);
      const updated = await sql<{ n: string }>`
        SELECT count(*) AS n FROM meta.api_tokens
         WHERE id = ${token.id} AND last_used_at > now() - interval '1 minute'
      `.execute(db.kysely);
      expect(Number(updated.rows[0]?.n)).toBe(1);
    });
  });

  describe('jobs, test deliveries and incoming webhooks through a token (review)', () => {
    const jobs = () => new JobsRepository(db);
    const newJob = async (
      user: FixtureUser,
      type: string,
      baseId?: Id<'bse'>,
    ): Promise<Id<'job'>> => {
      const job = await jobs().create(orgScope(fx.orgId), {
        type,
        createdBy: fx.users[user].id,
      });
      if (baseId !== undefined) {
        await sql`
          INSERT INTO meta.imports
            (id, organization_id, base_id, created_by, filename, format, size, job_id, expires_at)
          VALUES (${newId('imp')}, ${fx.orgId}, ${baseId}, ${fx.users[user].id}, 'a.csv', 'csv',
                  1, ${job.id}, now() + interval '1 day')
        `.execute(db.kysely);
      }
      return job.id;
    };

    it('GET /jobs/:id and export downloads: own jobs of reachable bases only, never audit exports', async () => {
      const inB = await newJob('u_admin', IMPORT_JOB_TYPE, fx.baseId);
      const inB2 = await newJob('u_admin', IMPORT_JOB_TYPE, base2);
      const noBase = await newJob('u_admin', 'computed.backfill');
      const editorsJob = await newJob('u_editor', IMPORT_JOB_TYPE, base2);
      const audit = await newJob('owner', AUDIT_EXPORT_JOB_TYPE);
      await sql`
        UPDATE meta.jobs SET status = 'succeeded',
               result = ${JSON.stringify({ download_url: '/x', expires_at: new Date(Date.now() + DAY).toISOString() })}::jsonb
         WHERE id = ${audit}
      `.execute(db.kysely);
      const owner = await createToken('owner', ['records:read']);
      const get = (token: string, id: Id<'job'>) => bearer(token, 'GET', `/jobs/${id}`);

      // Own job in an allowed base → 200; other base → 404.
      expect((await get(tk.admin_b2.token, inB2)).statusCode).toBe(200);
      expectProblem(await get(tk.admin_b2.token, inB), 404, 'NOT_FOUND');
      expectProblem(await get(tk.admin_b2.token, noBase), 404, 'NOT_FOUND');
      // Without base_ids: every own job of a base the user opens.
      expect((await get(tk.admin_a.token, inB)).statusCode).toBe(200);
      expect((await get(tk.admin_a.token, noBase)).statusCode).toBe(200);
      // Another user's job → 404, even for the organization owner's token …
      expectProblem(await get(owner.token, editorsJob), 404, 'NOT_FOUND');
      expect((await fx.call('owner', 'GET', `/jobs/${editorsJob}`)).statusCode).toBe(200);
      // … and the audit export → 404 through a token, readable by the session.
      expectProblem(await get(owner.token, audit), 404, 'NOT_FOUND');
      expectProblem(await bearer(owner.token, 'GET', `/files/exports/${audit}`), 404, 'NOT_FOUND');
      expect((await fx.call('owner', 'GET', `/jobs/${audit}`)).statusCode).toBe(200);
      expectProblem(
        await bearer(tk.admin_b2.token, 'GET', `/files/exports/${inB}`),
        404,
        'NOT_FOUND',
      );
    });

    it('GET /http-deliveries/:id through a token follows base_ids', async () => {
      const insert = async () => {
        const id = newId('hdl');
        await sql`
          INSERT INTO meta.http_deliveries
            (id, organization_id, kind, automation_id, action_id, requested_by, idempotency_key,
             message_id, method, target_host, request_enc, status, completed_at)
          VALUES (${id}, ${fx.orgId}, 'test', ${automationId}, 'act_1', ${fx.users.u_admin.id},
                  ${id}, ${`msg_${id}`}, 'POST', 'example.test', NULL, 'succeeded', now())
        `.execute(db.kysely);
        return id;
      };
      const delivery = await insert();
      const reader = await createToken('u_admin', ['automations:read']);
      expect((await bearer(reader.token, 'GET', `/http-deliveries/${delivery}`)).statusCode).toBe(
        200,
      );
      expectProblem(
        await bearer(tk.admin_b2.token, 'GET', `/http-deliveries/${delivery}`),
        404,
        'NOT_FOUND',
      );
      expect((await fx.call('u_admin', 'GET', `/http-deliveries/${delivery}`)).statusCode).toBe(
        200,
      );
    });

    it('reading incoming webhooks (their URL starts runs) needs automations:write', async () => {
      const reader = await createToken('u_admin', ['automations:read']);
      expectScope(
        await bearer(reader.token, 'GET', `/bases/${fx.baseId}/incoming-webhooks`),
        'automations:write',
      );
      const writer = await createToken('u_admin', ['automations:write']);
      expect(
        (await bearer(writer.token, 'GET', `/bases/${fx.baseId}/incoming-webhooks`)).statusCode,
      ).toBe(200);
    });

    it('limits failed Bearer authentications per IP: 429 + Retry-After before any lookup', async () => {
      const ip = uniqueIp();
      const attempt = (token: string) =>
        t.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          remoteAddress: ip,
          headers: { authorization: `Bearer ${token}` },
        });
      expect(API_TOKEN_BEARER_FAILURES_PER_IP).toEqual({ limit: 300, windowSeconds: 60 });
      const limits = t.app.get(ApiRateLimits);
      expect(limits.bearerFailures).toEqual(API_TOKEN_BEARER_FAILURES_PER_IP);
      // A lower limit keeps the test fast; the mechanism is the same.
      limits.bearerFailures = { limit: 20, windowSeconds: 60 };
      try {
        // tk_admin_a works from another IP first: it is "recently valid".
        expect((await bearer(tk.admin_a.token, 'GET', '/me')).statusCode).toBe(200);
        for (let index = 0; index < limits.bearerFailures.limit; index += 1) {
          expect401(await attempt(unknownToken()), 'UNAUTHENTICATED');
        }
        let blocked: LightMyRequestResponse | undefined;
        const statements = await sqlDuring(async () => {
          blocked = await attempt(unknownToken());
        });
        expectProblem(blocked as LightMyRequestResponse, 429, 'RATE_LIMITED');
        expect(Number(blocked?.headers['retry-after'])).toBeGreaterThan(0);
        expect(statements).toEqual([]);
        // QA S6: a token that authenticated recently (from any IP) still works from
        // that IP — failures of someone else on a shared IP do not lock it out.
        expect((await attempt(tk.admin_a.token)).statusCode).toBe(200);
        // A valid token never seen yet waits like a guess (no lookup); other IPs are not
        // affected, and once it authenticated there it goes through here too.
        const fresh = await createToken('u_admin', ['schema:read']);
        expectProblem(await attempt(fresh.token), 429, 'RATE_LIMITED');
        expect((await bearer(fresh.token, 'GET', '/me')).statusCode).toBe(200);
        expect((await attempt(fresh.token)).statusCode).toBe(200);
        // Still checked in full: revoked meanwhile, it fails — counted, so over the limit `429`.
        expect((await fx.call('u_admin', 'DELETE', `/api-tokens/${fresh.id}`)).statusCode).toBe(
          204,
        );
        expectProblem(await attempt(fresh.token), 429, 'RATE_LIMITED');
        expect401(await bearer(fresh.token, 'GET', '/me'), 'TOKEN_REVOKED');
      } finally {
        limits.bearerFailures = API_TOKEN_BEARER_FAILURES_PER_IP;
      }
    });
  });

  describe('P55: the owner leaving the organization', () => {
    it('tk_sales_r stops authenticating when u_sales1 is removed', async () => {
      expect((await bearer(tk.sales_r.token, 'GET', '/me')).statusCode).toBe(200);
      const removed = await fx.call(
        'owner',
        'DELETE',
        `/orgs/${fx.orgId}/members/${fx.users.u_sales1.id}`,
      );
      expect(removed.statusCode, removed.body).toBe(204);
      expect401(await bearer(tk.sales_r.token, 'GET', '/me'), 'UNAUTHENTICATED');
      expect401(await bearer(tk.sales_w.token, 'GET', '/me'), 'UNAUTHENTICATED');
    });
  });
});
