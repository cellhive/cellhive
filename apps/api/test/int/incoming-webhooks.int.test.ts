import {
  INCOMING_WEBHOOKS_MAX_PER_BASE,
  incomingWebhookListSchema,
  incomingWebhookRequestListSchema,
  incomingWebhookSchema,
  incomingWebhookWithSecretsSchema,
  newId,
  type Id,
  type IncomingWebhookDto,
  type IncomingWebhookWithSecretsDto,
} from '@cellhive/contracts';
import {
  findIncomingWebhookByTokenHash,
  hashHookSecret,
  IncomingWebhookRequestsRepository,
  orgScope,
  parseSigningSecret,
  type Db,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const MAX_RATE = 20;
const URL_PATTERN = new RegExp(
  `^${TEST_PUBLIC_URL.replace(/\./gu, '\\.')}/api/v1/hooks/([A-Za-z0-9_-]{43})$`,
  'u',
);

/** The URL token of a hook DTO. */
function tokenOf(hook: Pick<IncomingWebhookDto, 'url'>): string {
  const match = URL_PATTERN.exec(hook.url);
  if (match?.[1] === undefined) throw new Error(`unexpected url ${hook.url}`);
  return match[1];
}

/**
 * BACKLOG T602 (CONTRACTS §25.1, ADR-35 §1): management of incoming
 * webhooks through the API — create with each `auth`, secrets shown once,
 * URL readable again, rotation, token regeneration, Bearer on/off, the
 * request log, `WEBHOOK_IN_USE`, the limits, audit, the P44/P46 rows of the
 * S5c matrix (base admin only: readers `403`, others `404`) and canaries.
 */
describe('incoming webhooks API (T602)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  /** Every response body seen, for the canary check. */
  const bodies: string[] = [];
  /** Every signing secret and Bearer token issued (shown once). */
  const secrets: string[] = [];
  /** Every URL token issued (readable again by base admins). */
  const urlTokens: string[] = [];

  async function call(
    user: FixtureUser,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<LightMyRequestResponse> {
    const response = await fx.call(user, method, url, payload);
    bodies.push(response.body);
    return response;
  }

  function remember(hook: IncomingWebhookWithSecretsDto): IncomingWebhookWithSecretsDto {
    if (hook.signing_secret !== null) secrets.push(hook.signing_secret);
    if (hook.bearer_token !== null) secrets.push(hook.bearer_token);
    return hook;
  }

  async function create(
    body: Record<string, unknown>,
    as: FixtureUser = 'u_admin',
  ): Promise<IncomingWebhookWithSecretsDto> {
    const response = await call(as, 'POST', `/bases/${fx.baseId}/incoming-webhooks`, body);
    expect(response.statusCode, response.body).toBe(201);
    return remember(incomingWebhookWithSecretsSchema.parse(response.json()));
  }

  async function get(id: Id<'hok'>, as: FixtureUser = 'u_admin'): Promise<IncomingWebhookDto> {
    const response = await call(as, 'GET', `/incoming-webhooks/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return incomingWebhookSchema.parse(response.json());
  }

  const auditOf = async (entityId: string) =>
    (
      await sql<{ action: string; before: unknown; after: unknown; entity_type: string }>`
        SELECT action, before, after, entity_type FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND entity_id = ${entityId}
         ORDER BY created_at, id
      `.execute(db.kysely)
    ).rows;

  const storedHook = async (id: Id<'hok'>) =>
    db.kysely
      .selectFrom('meta.incoming_webhooks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({
      DATABASE_URL: database.url,
      WEBHOOK_MAX_RATE_PER_SEC: String(MAX_RATE),
    });
    fx = await buildRecordFixture(t, db);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it.each([
    ['signature', true, false],
    ['bearer', false, true],
    ['both', true, true],
    ['none', false, false],
  ] as const)(
    'creates a hook with auth %s: URL + secrets once, then GET shows the URL only',
    async (auth, signature, bearer) => {
      const hook = await create({ name: `Create ${auth}`, auth });
      expect(hook).toMatchObject({
        base_id: fx.baseId,
        name: `Create ${auth}`,
        auth,
        enabled: true,
        rate_limit_per_sec: 5,
        signing_secret_rotating_until: null,
        listen_until: null,
        sample_captured_at: null,
        last_received_at: null,
        usages: [],
        created_by: { id: fx.users.u_admin.id, name: 'User admin' },
      });
      expect(hook.url).toMatch(URL_PATTERN);
      urlTokens.push(tokenOf(hook));
      expect(hook.signing_secret !== null).toBe(signature);
      expect(hook.bearer_token !== null).toBe(bearer);
      if (hook.signing_secret !== null) {
        expect(parseSigningSecret(hook.signing_secret)).toHaveLength(32);
      }
      if (hook.bearer_token !== null) expect(hook.bearer_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

      const read = await get(hook.id);
      expect(read.url).toBe(hook.url);
      expect(read).not.toHaveProperty('signing_secret');
      expect(read).not.toHaveProperty('bearer_token');

      // Stored: hashes and ciphertexts only.
      const row = await storedHook(hook.id);
      expect(row.token_hash).toBe(hashHookSecret(tokenOf(hook)));
      expect(row.bearer_hash).toBe(
        hook.bearer_token === null ? null : hashHookSecret(hook.bearer_token),
      );
      expect(row.signing_secret_enc === null).toBe(!signature);

      const audit = await auditOf(hook.id);
      expect(audit).toEqual([
        {
          action: 'incoming_webhook.created',
          entity_type: 'incoming_webhook',
          before: null,
          after: { name: `Create ${auth}`, auth, enabled: true, rate_limit_per_sec: 5 },
        },
      ]);
      const events = await sql<{ type: string; base_id: string }>`
        SELECT type, payload->>'base_id' AS base_id FROM meta.events WHERE entity_id = ${hook.id}
      `.execute(db.kysely);
      expect(events.rows).toEqual([{ type: 'incoming_webhook.created', base_id: fx.baseId }]);
    },
  );

  it('lists the live hooks of the base, oldest first, with their URLs', async () => {
    const response = await call('u_admin', 'GET', `/bases/${fx.baseId}/incoming-webhooks`);
    expect(response.statusCode).toBe(200);
    const list = incomingWebhookListSchema.parse(response.json());
    expect(list.items.map((item) => item.name).slice(0, 4)).toEqual([
      'Create signature',
      'Create bearer',
      'Create both',
      'Create none',
    ]);
    for (const item of list.items) {
      expect(item.url).toMatch(URL_PATTERN);
      expect(item).not.toHaveProperty('signing_secret');
    }
  });

  it('refuses a missing auth, a name taken (any case) and a rate above WEBHOOK_MAX_RATE_PER_SEC', async () => {
    expectProblem(
      await call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, { name: 'No auth' }),
      422,
      'VALIDATION_FAILED',
    );
    await create({ name: 'Taken', auth: 'none' });
    const taken = await call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: 'TAKEN',
      auth: 'none',
    });
    expectProblem(taken, 422, 'VALIDATION_FAILED');
    expect(problemOf(taken.body)['errors']).toEqual([
      expect.objectContaining({ path: 'name', code: 'WEBHOOK_NAME_TAKEN' }),
    ]);
    const tooFast = await call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: 'Too fast',
      auth: 'none',
      rate_limit_per_sec: MAX_RATE + 1,
    });
    expectProblem(tooFast, 422, 'VALIDATION_FAILED');
    expect(problemOf(tooFast.body)['errors']).toEqual([
      expect.objectContaining({ path: 'rate_limit_per_sec', code: 'RATE_LIMIT_TOO_HIGH' }),
    ]);
    const atMax = await create({ name: 'At max', auth: 'none', rate_limit_per_sec: MAX_RATE });
    expect(atMax.rate_limit_per_sec).toBe(MAX_RATE);
    const patch = await call('u_admin', 'PATCH', `/incoming-webhooks/${atMax.id}`, {
      rate_limit_per_sec: MAX_RATE + 1,
    });
    expect(problemOf(patch.body)['errors']).toEqual([
      expect.objectContaining({ code: 'RATE_LIMIT_TOO_HIGH' }),
    ]);
  });

  it('caps a base at 50 live hooks (TOO_MANY_WEBHOOKS)', async () => {
    const live = Number(
      (
        await sql<{ n: string }>`
          SELECT count(*) AS n FROM meta.incoming_webhooks
           WHERE base_id = ${fx.baseId} AND deleted_at IS NULL
        `.execute(db.kysely)
      ).rows[0]?.n,
    );
    const fillers: Id<'hok'>[] = [];
    for (let index = live; index < INCOMING_WEBHOOKS_MAX_PER_BASE; index += 1) {
      fillers.push((await create({ name: `Filler ${String(index)}`, auth: 'none' })).id);
    }
    const response = await call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: 'One more',
      auth: 'none',
    });
    expectProblem(response, 422, 'VALIDATION_FAILED');
    expect(problemOf(response.body)['errors']).toEqual([
      expect.objectContaining({ code: 'TOO_MANY_WEBHOOKS' }),
    ]);
    for (const id of fillers) {
      expect((await call('u_admin', 'DELETE', `/incoming-webhooks/${id}`)).statusCode).toBe(204);
    }
    // Deleted hooks do not count.
    await create({ name: 'One more', auth: 'none' });
  });

  it('rotates the signing secret: new secret once, the previous one valid 24 h', async () => {
    const hook = await create({ name: 'Rotate', auth: 'signature' });
    const response = await call('u_admin', 'POST', `/incoming-webhooks/${hook.id}/rotate-secret`);
    expect(response.statusCode, response.body).toBe(200);
    const rotated = remember(incomingWebhookWithSecretsSchema.parse(response.json()));
    expect(rotated.signing_secret).not.toBeNull();
    expect(rotated.signing_secret).not.toBe(hook.signing_secret);
    expect(rotated.bearer_token).toBeNull();
    const until = Date.parse(rotated.signing_secret_rotating_until ?? '');
    expect(until - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(until - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    const row = await storedHook(hook.id);
    expect(row.signing_secret_prev_enc).not.toBeNull();
    const read = await get(hook.id);
    expect(read.signing_secret_rotating_until).toBe(rotated.signing_secret_rotating_until);
    expect(read).not.toHaveProperty('signing_secret');
    expect((await auditOf(hook.id)).map((entry) => entry.action)).toEqual([
      'incoming_webhook.created',
      'incoming_webhook.secret_rotated',
    ]);

    // On a hook without signature, rotating turns it on with no previous secret.
    const plain = await create({ name: 'Rotate plain', auth: 'bearer' });
    const turnedOn = remember(
      incomingWebhookWithSecretsSchema.parse(
        (await call('u_admin', 'POST', `/incoming-webhooks/${plain.id}/rotate-secret`)).json(),
      ),
    );
    expect(turnedOn.auth).toBe('both');
    expect(turnedOn.signing_secret_rotating_until).toBeNull();
  });

  it('regenerates the token: new URL, the old token no longer resolves', async () => {
    const hook = await create({ name: 'Regenerate', auth: 'none' });
    const oldToken = tokenOf(hook);
    const response = await call(
      'u_admin',
      'POST',
      `/incoming-webhooks/${hook.id}/regenerate-token`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const regenerated = incomingWebhookSchema.parse(response.json());
    urlTokens.push(tokenOf(hook), tokenOf(regenerated));
    expect(regenerated.url).not.toBe(hook.url);
    expect(
      await findIncomingWebhookByTokenHash(db.kysely, hashHookSecret(oldToken)),
    ).toBeUndefined();
    expect(
      await findIncomingWebhookByTokenHash(db.kysely, hashHookSecret(tokenOf(regenerated))),
    ).toEqual({ organization_id: fx.orgId, incoming_webhook_id: hook.id });
    expect((await auditOf(hook.id)).at(-1)).toMatchObject({
      action: 'incoming_webhook.token_regenerated',
    });
  });

  it('sets and removes the Bearer token; PATCH auth only removes checks', async () => {
    const hook = await create({ name: 'Bearer', auth: 'signature' });
    const set = await call('u_admin', 'PUT', `/incoming-webhooks/${hook.id}/bearer`);
    expect(set.statusCode, set.body).toBe(200);
    const withBearer = remember(incomingWebhookWithSecretsSchema.parse(set.json()));
    expect(withBearer).toMatchObject({ auth: 'both', signing_secret: null });
    expect(withBearer.bearer_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect((await storedHook(hook.id)).bearer_hash).toBe(
      hashHookSecret(withBearer.bearer_token ?? ''),
    );

    const removed = await call('u_admin', 'DELETE', `/incoming-webhooks/${hook.id}/bearer`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(incomingWebhookSchema.parse(removed.json()).auth).toBe('signature');
    expect((await storedHook(hook.id)).bearer_hash).toBeNull();

    const adding = await call('u_admin', 'PATCH', `/incoming-webhooks/${hook.id}`, {
      auth: 'both',
    });
    expectProblem(adding, 422, 'VALIDATION_FAILED');
    expect(problemOf(adding.body)['errors']).toEqual([
      expect.objectContaining({ path: 'auth', code: 'CREDENTIAL_REQUIRED' }),
    ]);

    const dropped = await call('u_admin', 'PATCH', `/incoming-webhooks/${hook.id}`, {
      auth: 'none',
      name: 'Bearer renamed',
      enabled: false,
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(incomingWebhookSchema.parse(dropped.json())).toMatchObject({
      auth: 'none',
      name: 'Bearer renamed',
      enabled: false,
    });
    const row = await storedHook(hook.id);
    expect(row).toMatchObject({
      signing_secret_enc: null,
      signing_secret_prev_enc: null,
      bearer_hash: null,
    });
    const updates = (await auditOf(hook.id)).filter(
      (entry) => entry.action === 'incoming_webhook.updated',
    );
    expect(updates.at(-1)).toMatchObject({
      before: { name: 'Bearer', auth: 'signature', enabled: true, rate_limit_per_sec: 5 },
      after: { name: 'Bearer renamed', auth: 'none', enabled: false, rate_limit_per_sec: 5 },
    });
  });

  it('lists received requests newest first, metadata only, cursor-paginated', async () => {
    const hook = await create({ name: 'Log', auth: 'none' });
    const repository = new IncomingWebhookRequestsRepository(db);
    const scope = orgScope(fx.orgId);
    for (let index = 0; index < 3; index += 1) {
      await repository.insert(scope, {
        id: newId('whr'),
        incomingWebhookId: hook.id,
        messageId: `m${String(index)}`,
        body: { order: index, canary: 'BODY-CANARY' },
        headers: { 'x-shop': 'HEADER-CANARY' },
        query: {},
        sizeBytes: 30 + index,
        causationAccepted: index === 2,
        eventId: newId('evt'),
        receivedAt: new Date(Date.now() - (3 - index) * 1000),
      });
    }
    const first = await call('u_admin', 'GET', `/incoming-webhooks/${hook.id}/requests?limit=2`);
    expect(first.statusCode, first.body).toBe(200);
    const page = incomingWebhookRequestListSchema.parse(first.json());
    expect(page.items.map((item) => item.size_bytes)).toEqual([32, 31]);
    expect(page.items[0]).toMatchObject({ duplicate: false, causation_accepted: true });
    expect(first.body).not.toContain('CANARY');
    const second = incomingWebhookRequestListSchema.parse(
      (
        await call(
          'u_admin',
          'GET',
          `/incoming-webhooks/${hook.id}/requests?limit=2&cursor=${page.next_cursor ?? ''}`,
        )
      ).json(),
    );
    expect(second.items.map((item) => item.size_bytes)).toEqual([30]);
    expect(second.next_cursor).toBeNull();
    expectProblem(
      await call('u_admin', 'GET', `/incoming-webhooks/${hook.id}/requests?cursor=zzz`),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('refuses to delete a hook automations use (409 WEBHOOK_IN_USE), then soft-deletes it', async () => {
    const hook = await create({ name: 'In use', auth: 'none' });
    const automationId = newId('aut');
    await db.kysely
      .insertInto('meta.automations')
      .values({
        id: automationId,
        organization_id: fx.orgId,
        base_id: fx.baseId,
        name: 'Orders from the shop',
        definition: { trigger: { type: 'webhook.received', incoming_webhook_id: hook.id } },
        trigger_type: 'webhook.received',
        trigger_table_id: null,
        created_by: fx.users.u_admin.id,
        updated_by: fx.users.u_admin.id,
        run_as_user_id: fx.users.u_admin.id,
      })
      .execute();
    expect((await get(hook.id)).usages).toEqual([
      { automation_id: automationId, name: 'Orders from the shop' },
    ]);
    const refused = await call('u_admin', 'DELETE', `/incoming-webhooks/${hook.id}`);
    expectProblem(refused, 409, 'WEBHOOK_IN_USE');
    expect(problemOf(refused.body)['errors']).toEqual([
      expect.objectContaining({
        code: 'WEBHOOK_IN_USE',
        params: {
          usages: [{ automation_id: automationId, name: 'Orders from the shop' }],
          total: 1,
        },
      }),
    ]);
    await db.kysely
      .updateTable('meta.automations')
      .set({ deleted_at: new Date() })
      .where('id', '=', automationId)
      .execute();
    expect((await call('u_admin', 'DELETE', `/incoming-webhooks/${hook.id}`)).statusCode).toBe(204);
    expectProblem(await call('u_admin', 'GET', `/incoming-webhooks/${hook.id}`), 404, 'NOT_FOUND');
    expectProblem(
      await call('u_admin', 'DELETE', `/incoming-webhooks/${hook.id}`),
      404,
      'NOT_FOUND',
    );
    expect((await storedHook(hook.id)).deleted_at).toBeInstanceOf(Date);
    expect((await auditOf(hook.id)).at(-1)).toMatchObject({
      action: 'incoming_webhook.deleted',
      before: { name: 'In use', auth: 'none', enabled: true, rate_limit_per_sec: 5 },
    });
  });

  describe('P44/P46: base admins only — readers 403, others 404', () => {
    let hook: IncomingWebhookWithSecretsDto;

    beforeAll(async () => {
      hook = await create({ name: 'Matrix', auth: 'both' });
    });

    const routes = () =>
      [
        ['GET', `/bases/${fx.baseId}/incoming-webhooks`, undefined],
        ['POST', `/bases/${fx.baseId}/incoming-webhooks`, { name: 'Sneaky', auth: 'none' }],
        ['GET', `/incoming-webhooks/${hook.id}`, undefined],
        ['PATCH', `/incoming-webhooks/${hook.id}`, { name: 'Sneaky' }],
        ['POST', `/incoming-webhooks/${hook.id}/rotate-secret`, undefined],
        ['POST', `/incoming-webhooks/${hook.id}/regenerate-token`, undefined],
        ['PUT', `/incoming-webhooks/${hook.id}/bearer`, undefined],
        ['DELETE', `/incoming-webhooks/${hook.id}/bearer`, undefined],
        ['GET', `/incoming-webhooks/${hook.id}/requests`, undefined],
        ['DELETE', `/incoming-webhooks/${hook.id}`, undefined],
      ] as const;

    it.each(['u_editor', 'u_reader', 'u_sales1'] as const)(
      '%s, who reads the base without being a base admin, gets 403 everywhere',
      async (user) => {
        for (const [method, url, body] of routes()) {
          expectProblem(await call(user, method, url, body), 403, 'PERMISSION_DENIED');
        }
      },
    );

    it.each(['u_out', 'stranger'] as const)(
      '%s, who cannot read the base, gets 404 everywhere',
      async (user) => {
        for (const [method, url, body] of routes()) {
          expectProblem(await call(user, method, url, body), 404, 'NOT_FOUND');
        }
      },
    );

    it('nothing changed; the organization owner (a base admin) may manage it', async () => {
      const row = await storedHook(hook.id);
      expect(row).toMatchObject({ name: 'Matrix', deleted_at: null, auth: 'both' });
      expect(tokenOf(await get(hook.id, 'owner'))).toBe(tokenOf(hook));
    });

    it('an unknown or malformed id is 404 / 4xx', async () => {
      expectProblem(
        await call('u_admin', 'GET', `/incoming-webhooks/${newId('hok')}`),
        404,
        'NOT_FOUND',
      );
      const malformed = await call('u_admin', 'GET', '/incoming-webhooks/not-an-id');
      expect([400, 404, 422]).toContain(malformed.statusCode);
    });
  });

  it('canaries: no secret, Bearer or URL token in logs, audit, events, jobs, GETs or errors', async () => {
    expect(secrets.length).toBeGreaterThan(10);
    const { rows: audit } = await sql`SELECT * FROM meta.audit_logs`.execute(db.kysely);
    const { rows: events } = await sql`SELECT * FROM meta.events`.execute(db.kysely);
    const { rows: jobs } = await sql`SELECT payload FROM graphile_worker._private_jobs`.execute(
      db.kysely,
    );
    const { rows: hooks } = await sql`SELECT * FROM meta.incoming_webhooks`.execute(db.kysely);
    const stored = JSON.stringify({ audit, events, jobs, hooks });
    const logs = t.logs.raw();
    for (const canary of [...secrets, ...urlTokens]) {
      expect(logs).not.toContain(canary);
      expect(stored).not.toContain(canary);
    }
    // A signing secret or Bearer token is in exactly one response: the one that issued it.
    for (const canary of secrets) {
      expect(bodies.filter((body) => body.includes(canary))).toHaveLength(1);
    }
    // Errors never echo anything secret.
    const errors = bodies.filter((body) => /"status":\s*4\d\d/u.test(body));
    expect(errors.length).toBeGreaterThan(20);
    for (const body of errors) {
      for (const canary of [...secrets, ...urlTokens]) expect(body).not.toContain(canary);
    }
  });
});
