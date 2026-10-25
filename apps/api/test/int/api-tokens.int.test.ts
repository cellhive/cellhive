import {
  API_TOKENS_MAX_PER_USER,
  apiTokenListSchema,
  apiTokenSchema,
  createdApiTokenSchema,
  newId,
  orgApiTokenListSchema,
  organizationSchema,
  type CreatedApiToken,
  type Id,
} from '@cellhive/contracts';
import {
  attachRealtimePublisher,
  parseApiToken,
  realtimePublisherOf,
  type Db,
  type RealtimeEnvelope,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

/**
 * BACKLOG T703 (CONTRACTS §26.4, ADR-36 §1): API token management through
 * the API — create (shown once), list mine / the organization's, rename,
 * revoke, the organization policy, the 50-token cap, cascade and realtime
 * envelope when a member leaves, P57 of the S6 permission matrix, and the
 * canaries (the token value appears in its create response only).
 */
describe('API tokens API (T703)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  const envelopes: RealtimeEnvelope[] = [];
  /** Every response body seen, for the canaries. */
  const bodies: string[] = [];
  /** Every token value issued. */
  const issued: string[] = [];

  async function call(
    user: FixtureUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse> {
    const response = await fx.call(user, method, url, payload, headers);
    bodies.push(response.body);
    return response;
  }

  async function create(
    user: FixtureUser,
    body: Record<string, unknown> = {},
    headers?: Record<string, string>,
  ): Promise<CreatedApiToken> {
    const response = await call(
      user,
      'POST',
      `/orgs/${fx.orgId}/me/api-tokens`,
      { name: `${user} token`, scopes: ['records:read'], expires_at: inDays(90), ...body },
      headers,
    );
    expect(response.statusCode, response.body).toBe(201);
    const created = createdApiTokenSchema.parse(response.json());
    issued.push(created.token);
    return created;
  }

  const auditOf = async (entityId: string) =>
    (
      await sql<{ action: string; actor_id: string; before: unknown; after: unknown }>`
        SELECT action, actor_id, before, after FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND entity_id = ${entityId}
         ORDER BY created_at, id
      `.execute(db.kysely)
    ).rows;

  const eventsOf = async (entityId: string) =>
    (
      await sql<{ type: string; entity_type: string; payload: Record<string, unknown> }>`
        SELECT type, entity_type, payload FROM meta.events
         WHERE organization_id = ${fx.orgId} AND entity_id = ${entityId}
         ORDER BY created_at, id
      `.execute(db.kysely)
    ).rows;

  const setPolicy = (policy: Record<string, unknown>, user: FixtureUser = 'owner') =>
    call(user, 'PATCH', `/orgs/${fx.orgId}`, { settings: { api_tokens: policy } });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    // u_sales2 becomes an organization admin (not an owner).
    await sql`
      UPDATE meta.org_members SET role = 'admin'
       WHERE organization_id = ${fx.orgId} AND user_id = ${fx.users.u_sales2.id}
    `.execute(db.kysely);
    // Record what the api publishes on the realtime bus, and still publish it.
    const appDb = t.app.get<Db>(DB);
    const bus = realtimePublisherOf(appDb);
    attachRealtimePublisher(appDb, {
      publish: async (envelope) => {
        envelopes.push(envelope);
        await bus?.publish(envelope);
      },
    });
  });

  beforeEach(() => {
    envelopes.length = 0;
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('creates a token shown once, stores only its hash and audits its metadata', async () => {
    const created = await create('u_editor', {
      name: '  CI export  ',
      scopes: ['records:write', 'records:read', 'records:read'],
      base_ids: [fx.baseId],
    });
    expect(parseApiToken(created.token)).toBe('ok');
    expect(created).toMatchObject({
      name: 'CI export',
      token_prefix: created.token.slice(4, 12),
      scopes: ['records:read', 'records:write'],
      base_ids: [fx.baseId],
      last_used_at: null,
      revoked_at: null,
    });

    const row = await db.kysely
      .selectFrom('meta.api_tokens')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBe(fx.users.u_editor.id);
    expect(row.token_hash).toHaveLength(32);

    const snapshot = {
      user_id: fx.users.u_editor.id,
      name: 'CI export',
      token_prefix: created.token_prefix,
      scopes: ['records:read', 'records:write'],
      base_ids: [fx.baseId],
      expires_at: created.expires_at,
    };
    expect(await auditOf(created.id)).toEqual([
      {
        action: 'api_token.created',
        actor_id: fx.users.u_editor.id,
        before: null,
        after: snapshot,
      },
    ]);
    expect(await eventsOf(created.id)).toEqual([
      expect.objectContaining({ type: 'api_token.created', entity_type: 'api_token' }),
    ]);

    // Listed without the value.
    const mine = apiTokenListSchema.parse(
      (await call('u_editor', 'GET', `/orgs/${fx.orgId}/me/api-tokens`)).json(),
    );
    expect(mine.items.map((item) => item.id)).toContain(created.id);
    expect(mine.items[0]).not.toHaveProperty('token');
  });

  it('validates scopes, expiry and bases', async () => {
    const post = (body: Record<string, unknown>, user: FixtureUser = 'u_sales1') =>
      call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
        name: 'Bad',
        scopes: ['records:read'],
        expires_at: inDays(30),
        ...body,
      });
    const codesOf = (response: LightMyRequestResponse) =>
      (problemOf(response.body)['errors'] as { path: string; code: string }[]).map((item) => ({
        path: item.path,
        code: item.code,
      }));

    const unknownScope = await post({ scopes: ['records:read', 'admin:all'] });
    expectProblem(unknownScope, 422, 'VALIDATION_FAILED');
    expect(codesOf(unknownScope)).toEqual([{ path: 'scopes[1]', code: 'INVALID_VALUE' }]);
    expectProblem(await post({ scopes: [] }), 422, 'VALIDATION_FAILED');

    const past = await post({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expectProblem(past, 422, 'VALIDATION_FAILED');
    expect(codesOf(past)).toEqual([{ path: 'expires_at', code: 'OUT_OF_RANGE' }]);
    const tooFar = await post({ expires_at: inDays(3651) });
    expect(codesOf(tooFar)).toEqual([{ path: 'expires_at', code: 'OUT_OF_RANGE' }]);
    expectProblem(await post({ expires_at: undefined }), 422, 'VALIDATION_FAILED');

    // A base the caller cannot read (u_out has no role in B) and one of another organization.
    const otherBase = newId('bse');
    const unreadable = await post({ base_ids: [otherBase, fx.baseId] }, 'u_out');
    expectProblem(unreadable, 404, 'NOT_FOUND');
    expect(codesOf(unreadable)).toEqual([
      { path: 'base_ids[0]', code: 'NOT_FOUND' },
      { path: 'base_ids[1]', code: 'NOT_FOUND' },
    ]);
    // Never expiring is allowed while the organization sets no limit.
    const forever = await create('u_out', { expires_at: null });
    expect(forever.expires_at).toBeNull();
  });

  it('applies the organization policy: lifetime limit, then tokens turned off', async () => {
    const org = organizationSchema.parse((await call('owner', 'GET', `/orgs/${fx.orgId}`)).json());
    expect(org.settings.api_tokens).toEqual({ enabled: true, max_lifetime_days: null });

    // Only owners/admins change it.
    expectProblem(await setPolicy({ enabled: false }, 'u_sales1'), 403, 'PERMISSION_DENIED');

    const limited = await setPolicy({ max_lifetime_days: 30 }, 'u_sales2');
    expect(limited.statusCode, limited.body).toBe(200);
    expect(organizationSchema.parse(limited.json()).settings.api_tokens).toEqual({
      enabled: true,
      max_lifetime_days: 30,
    });
    const tooLong = await call('u_sales1', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: 'Long',
      scopes: ['records:read'],
      expires_at: inDays(31),
    });
    expectProblem(tooLong, 422, 'VALIDATION_FAILED');
    expect(problemOf(tooLong.body)['errors']).toEqual([
      expect.objectContaining({
        path: 'expires_at',
        code: 'TOKEN_LIFETIME_EXCEEDED',
        params: { max_lifetime_days: 30 },
      }),
    ]);
    const neverExpiring = await call('u_sales1', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: 'Forever',
      scopes: ['records:read'],
      expires_at: null,
    });
    expect(problemOf(neverExpiring.body)['errors']).toEqual([
      expect.objectContaining({ code: 'TOKEN_LIFETIME_EXCEEDED' }),
    ]);
    await create('u_sales1', { expires_at: inDays(29) });

    const off = await setPolicy({ enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(organizationSchema.parse(off.json()).settings.api_tokens).toEqual({
      enabled: false,
      max_lifetime_days: 30,
    });
    expect(envelopes).toEqual([{ v: 1, type: 'api_token.revoked', organization_id: fx.orgId }]);
    expectProblem(
      await call('u_sales1', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
        name: 'Off',
        scopes: ['records:read'],
        expires_at: inDays(1),
      }),
      403,
      'API_TOKENS_DISABLED',
    );
    const { rows: orgAudit } = await sql<{ after: { settings: Record<string, unknown> } }>`
      SELECT after FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND action = 'org.updated'
       ORDER BY created_at DESC, id DESC LIMIT 1
    `.execute(db.kysely);
    expect(orgAudit[0]?.after.settings['api_tokens']).toEqual({
      enabled: false,
      max_lifetime_days: 30,
    });

    envelopes.length = 0;
    const back = await setPolicy({ enabled: true, max_lifetime_days: null });
    expect(back.statusCode, back.body).toBe(200);
    // Turning tokens on again publishes nothing.
    expect(envelopes).toEqual([]);
  });

  it(`caps a member at ${String(API_TOKENS_MAX_PER_USER)} tokens not revoked (TOO_MANY_TOKENS)`, async () => {
    const existing = Number(
      (
        await sql<{ n: string }>`
          SELECT count(*) AS n FROM meta.api_tokens
           WHERE organization_id = ${fx.orgId} AND user_id = ${fx.users.u_reader.id}
             AND revoked_at IS NULL
        `.execute(db.kysely)
      ).rows[0]?.n,
    );
    let last: CreatedApiToken | undefined;
    for (let index = existing; index < API_TOKENS_MAX_PER_USER; index += 1) {
      last = await create('u_reader', { name: `Bulk ${String(index)}` });
    }
    const response = await call('u_reader', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: 'One more',
      scopes: ['records:read'],
      expires_at: inDays(1),
    });
    expectProblem(response, 422, 'VALIDATION_FAILED');
    expect(problemOf(response.body)['errors']).toEqual([
      expect.objectContaining({ code: 'TOO_MANY_TOKENS', params: { maximum: 50 } }),
    ]);
    // A revoked token no longer counts.
    expect((await call('u_reader', 'DELETE', `/api-tokens/${String(last?.id)}`)).statusCode).toBe(
      204,
    );
    await create('u_reader', { name: 'Replacement' });
  });

  it('renames: the owner only (audit api_token.updated)', async () => {
    const token = await create('u_editor', { name: 'Old name' });
    const renamed = await call('u_editor', 'PATCH', `/api-tokens/${token.id}`, {
      name: 'New name',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(apiTokenSchema.parse(renamed.json())).toMatchObject({ id: token.id, name: 'New name' });
    expect((await auditOf(token.id)).map((row) => [row.action, row.before, row.after])).toEqual([
      ['api_token.created', null, expect.anything()],
      ['api_token.updated', { name: 'Old name' }, { name: 'New name' }],
    ]);
    // api_token.updated is audit only.
    expect((await eventsOf(token.id)).map((row) => row.type)).toEqual(['api_token.created']);

    expectProblem(
      await call('u_sales2', 'PATCH', `/api-tokens/${token.id}`, { name: 'Admin rename' }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await call('u_sales1', 'PATCH', `/api-tokens/${token.id}`, { name: 'Member rename' }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await call('stranger', 'PATCH', `/api-tokens/${token.id}`, { name: 'Stranger' }),
      404,
      'NOT_FOUND',
    );
  });

  describe('P57: members, organization admins, another organization', () => {
    let salesToken: CreatedApiToken;
    let editorToken: CreatedApiToken;

    beforeAll(async () => {
      salesToken = await create('u_sales1', { name: 'P57 sales' });
      editorToken = await create('u_editor', { name: 'P57 editor' });
    });

    it('u_sales1 lists only their own tokens', async () => {
      const mine = apiTokenListSchema.parse(
        (await call('u_sales1', 'GET', `/orgs/${fx.orgId}/me/api-tokens?limit=200`)).json(),
      );
      expect(mine.items.map((item) => item.id)).toContain(salesToken.id);
      expect(mine.items.map((item) => item.id)).not.toContain(editorToken.id);
      const owners = await db.kysely
        .selectFrom('meta.api_tokens')
        .select('user_id')
        .where(
          'id',
          'in',
          mine.items.map((item) => item.id),
        )
        .execute();
      expect(new Set(owners.map((row) => row.user_id))).toEqual(new Set([fx.users.u_sales1.id]));
    });

    it.each(['u_sales1', 'u_admin', 'u_out'] as const)(
      '%s, a member who is not an owner/admin: 403 on the organization list, 404 revoking another token',
      async (user) => {
        expectProblem(
          await call(user, 'GET', `/orgs/${fx.orgId}/api-tokens`),
          403,
          'PERMISSION_DENIED',
        );
        expectProblem(
          await call(user, 'DELETE', `/api-tokens/${editorToken.id}`),
          404,
          'NOT_FOUND',
        );
      },
    );

    it('an organization admin sees metadata (never value or hash) and revokes with audit', async () => {
      const response = await call(
        'u_sales2',
        'GET',
        `/orgs/${fx.orgId}/api-tokens?user_id=${fx.users.u_editor.id}&limit=200`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const list = orgApiTokenListSchema.parse(response.json());
      const item = list.items.find((entry) => entry.id === editorToken.id);
      expect(item).toMatchObject({
        name: 'P57 editor',
        token_prefix: editorToken.token_prefix,
        user: { id: fx.users.u_editor.id, display_name: 'User editor' },
      });
      expect(list.items.every((entry) => entry.user.id === fx.users.u_editor.id)).toBe(true);
      expect(response.body).not.toContain(editorToken.token);
      expect(Object.keys(item ?? {})).not.toContain('token_hash');

      const revoked = await call('u_sales2', 'DELETE', `/api-tokens/${editorToken.id}`);
      expect(revoked.statusCode, revoked.body).toBe(204);
      expect(envelopes).toEqual([
        {
          v: 1,
          type: 'api_token.revoked',
          organization_id: fx.orgId,
          token_ids: [editorToken.id],
        },
      ]);
      const audit = await auditOf(editorToken.id);
      expect(audit.map((row) => [row.action, row.actor_id])).toEqual([
        ['api_token.created', fx.users.u_editor.id],
        ['api_token.revoked', fx.users.u_sales2.id],
      ]);
      expect(audit[1]?.before).toMatchObject({ name: 'P57 editor', user_id: fx.users.u_editor.id });
      expect((await eventsOf(editorToken.id)).map((row) => row.type)).toEqual([
        'api_token.created',
        'api_token.revoked',
      ]);
      const row = await db.kysely
        .selectFrom('meta.api_tokens')
        .select(['revoked_at', 'revoked_by'])
        .where('id', '=', editorToken.id)
        .executeTakeFirstOrThrow();
      expect(row.revoked_by).toBe(fx.users.u_sales2.id);

      // Revoking again changes nothing.
      envelopes.length = 0;
      expect((await call('u_editor', 'DELETE', `/api-tokens/${editorToken.id}`)).statusCode).toBe(
        204,
      );
      expect(envelopes).toEqual([]);
      expect(await auditOf(editorToken.id)).toHaveLength(2);

      const filtered = orgApiTokenListSchema.parse(
        (
          await call('owner', 'GET', `/orgs/${fx.orgId}/api-tokens?status=revoked&limit=200`)
        ).json(),
      );
      expect(filtered.items.map((entry) => entry.id)).toContain(editorToken.id);
      expect(filtered.items.every((entry) => entry.revoked_at !== null)).toBe(true);
    });

    it('the owner revokes their own token', async () => {
      const own = await create('u_sales1', { name: 'P57 own' });
      expect((await call('u_sales1', 'DELETE', `/api-tokens/${own.id}`)).statusCode).toBe(204);
    });

    it('another organization: 404 everywhere', async () => {
      expectProblem(
        await call('stranger', 'GET', `/orgs/${fx.orgId}/me/api-tokens`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call('stranger', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
          name: 'Sneaky',
          scopes: ['records:read'],
          expires_at: inDays(1),
        }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call('stranger', 'GET', `/orgs/${fx.orgId}/api-tokens`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call('stranger', 'DELETE', `/api-tokens/${salesToken.id}`),
        404,
        'NOT_FOUND',
      );
      expectProblem(await call('owner', 'DELETE', `/api-tokens/${newId('tok')}`), 404, 'NOT_FOUND');
      // The organization admin of another organization sees none of this one's tokens.
      const strangerOrg = (
        await sql<{ organization_id: Id<'org'> }>`
          SELECT organization_id FROM meta.org_members WHERE user_id = ${fx.users.stranger.id}
        `.execute(db.kysely)
      ).rows[0]?.organization_id;
      const theirs = orgApiTokenListSchema.parse(
        (await call('stranger', 'GET', `/orgs/${String(strangerOrg)}/api-tokens`)).json(),
      );
      expect(theirs.items).toEqual([]);
      const row = await db.kysely
        .selectFrom('meta.api_tokens')
        .select('revoked_at')
        .where('id', '=', salesToken.id)
        .executeTakeFirstOrThrow();
      expect(row.revoked_at).toBeNull();
    });
  });

  it('removing u_sales1 from the organization deletes their tokens and publishes it', async () => {
    const before = await db.kysely
      .selectFrom('meta.api_tokens')
      .select('id')
      .where('organization_id', '=', fx.orgId)
      .where('user_id', '=', fx.users.u_sales1.id)
      .execute();
    expect(before.length).toBeGreaterThan(1);
    const removed = await call(
      'owner',
      'DELETE',
      `/orgs/${fx.orgId}/members/${fx.users.u_sales1.id}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    const after = await db.kysely
      .selectFrom('meta.api_tokens')
      .select('id')
      .where('user_id', '=', fx.users.u_sales1.id)
      .execute();
    expect(after).toEqual([]);
    const published = envelopes.filter((envelope) => envelope.type === 'api_token.revoked');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ organization_id: fx.orgId });
    expect(new Set((published[0] as { token_ids?: string[] }).token_ids)).toEqual(
      new Set(before.map((row) => row.id)),
    );
  });

  it('canaries: the token value is in its create response only — never in logs, audit, events, jobs, idempotency keys, GETs or errors', async () => {
    // A create with an Idempotency-Key: the stored copy of the response is encrypted.
    await create('u_editor', { name: 'Keyed' }, { 'idempotency-key': 'tok-canary' });

    expect(issued.length).toBeGreaterThan(50);
    const { rows: audit } = await sql`SELECT * FROM meta.audit_logs`.execute(db.kysely);
    const { rows: events } = await sql`SELECT * FROM meta.events`.execute(db.kysely);
    const { rows: jobs } = await sql`SELECT payload FROM graphile_worker._private_jobs`.execute(
      db.kysely,
    );
    const { rows: keys } = await sql`SELECT * FROM meta.idempotency_keys`.execute(db.kysely);
    const { rows: tokens } = await sql`
      SELECT id, name, token_prefix, encode(token_hash, 'hex') AS hash FROM meta.api_tokens
    `.execute(db.kysely);
    expect(keys.length).toBeGreaterThan(0);
    const stored = JSON.stringify({ audit, events, jobs, keys, tokens });
    const logs = t.logs.raw();
    for (const token of issued) {
      expect(logs).not.toContain(token);
      expect(stored).not.toContain(token);
      // Exactly one response carried it: the one that created it.
      expect(bodies.filter((body) => body.includes(token))).toHaveLength(1);
    }
    const errors = bodies.filter((body) => /"status":\s*4\d\d/u.test(body));
    expect(errors.length).toBeGreaterThan(10);
  });
});
