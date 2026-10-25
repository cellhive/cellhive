import { Buffer } from 'node:buffer';

import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findIncomingWebhookByTokenHash, orgScope, type Db } from '../../src/db/index.js';
import { purgeExpiredOperationalRows } from '../../src/jobs/index.js';
import {
  IncomingWebhookCredentials,
  IncomingWebhookRequestsRepository,
  IncomingWebhooksRepository,
  IncomingWebhookUsageRepository,
  type NewIncomingWebhook,
} from '../../src/webhooks/incoming/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

const ORG_A = 'org_InWebhookOrgA001';
const ORG_B = 'org_InWebhookOrgB001';

const credentials = new IncomingWebhookCredentials(Buffer.alloc(32, 7));

/**
 * `meta.incoming_webhooks` / `meta.incoming_webhook_requests` (BACKLOG
 * T602, migration 0043): tenant isolation of the three repositories, the
 * cross-tenant token lookup (ids only), the constraints that keep `auth`
 * and the credentials in agreement, `webhook-id` dedupe, the request log
 * cursor and the 7-day purge.
 */
describe('incoming webhook repositories (T602)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  const hooks = () => new IncomingWebhooksRepository(db);
  const requests = () => new IncomingWebhookRequestsRepository(db);

  function newHook(tenant: SeededTenant, overrides: Partial<NewIncomingWebhook> = {}) {
    const token = credentials.issueToken();
    return {
      token: token.token,
      input: {
        id: newId('hok'),
        base_id: tenant.baseId,
        name: `Hook ${newId('hok').slice(4, 10)}`,
        token_hash: token.tokenHash,
        token_enc: token.tokenEnc,
        auth: 'none',
        created_by: tenant.userId,
        ...overrides,
      } satisfies NewIncomingWebhook,
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    for (const tenant of [a, b]) {
      await db.kysely
        .insertInto('meta.org_members')
        .values({ organization_id: tenant.orgId, user_id: tenant.userId, role: 'owner' })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('keeps every hook inside its organization (tenant isolation)', async () => {
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const hookA = await hooks().create(scopeA, newHook(a, { name: 'Orders' }).input);
    const hookB = await hooks().create(scopeB, newHook(b, { name: 'Orders' }).input);

    expect((await hooks().listByBase(scopeA, a.baseId)).map((row) => row.id)).toContain(hookA.id);
    expect((await hooks().listByBase(scopeA, b.baseId)).map((row) => row.id)).toEqual([]);
    expect(await hooks().findById(scopeB, hookA.id)).toBeUndefined();
    expect(await hooks().findListRow(scopeB, hookA.id)).toBeUndefined();
    expect(await hooks().countByBase(scopeB, a.baseId)).toBe(0);
    expect(await hooks().update(scopeB, hookA.id, { name: 'Stolen' })).toBeUndefined();
    expect(await hooks().softDelete(scopeB, hookA.id)).toBe(false);
    expect((await hooks().findById(scopeA, hookA.id))?.name).toBe('Orders');
    expect((await hooks().findListRow(scopeA, hookA.id))?.created_by_name).toBe(a.userId.slice(4));
    expect(hookB.organization_id).toBe(ORG_B);

    // Requests and usages are isolated too.
    await requests().insert(scopeA, {
      id: newId('whr'),
      incomingWebhookId: hookA.id,
      messageId: null,
      body: { a: 1 },
      headers: {},
      query: {},
      sizeBytes: 7,
      causationAccepted: false,
      eventId: null,
    });
    expect(
      (await requests().listPage(scopeB, hookA.id, { cursor: null, limit: 10 })).items,
    ).toEqual([]);
    expect(
      (await requests().listPage(scopeA, hookA.id, { cursor: null, limit: 10 })).items,
    ).toHaveLength(1);
    expect(await new IncomingWebhookUsageRepository(db).list(scopeB, hookA.id)).toEqual([]);
  });

  it('finds a hook by token hash across organizations, returning ids only', async () => {
    const { token, input } = newHook(b);
    await hooks().create(orgScope(ORG_B), input);
    const match = await findIncomingWebhookByTokenHash(
      db.kysely,
      credentials.issueToken().tokenHash.replace(/./u, '0'),
    );
    expect(match).toBeUndefined();
    const found = await findIncomingWebhookByTokenHash(
      db.kysely,
      (await import('../../src/webhooks/incoming/index.js')).hashHookSecret(token),
    );
    expect(found).toEqual({ organization_id: ORG_B, incoming_webhook_id: input.id });
    // Deleted hooks are still found (the route answers the same 404 after the scoped read).
    await hooks().softDelete(orgScope(ORG_B), input.id);
    expect(await findIncomingWebhookByTokenHash(db.kysely, input.token_hash)).toEqual(found);
    expect(await hooks().findById(orgScope(ORG_B), input.id)).toBeUndefined();
    expect(
      (await hooks().findById(orgScope(ORG_B), input.id, { includeDeleted: true }))?.deleted_at,
    ).toBeInstanceOf(Date);
  });

  it('keeps names unique among live hooks of a base, case-insensitively', async () => {
    const scope = orgScope(ORG_A);
    const first = await hooks().create(scope, newHook(a, { name: 'Shop' }).input);
    await expect(hooks().create(scope, newHook(a, { name: 'SHOP' }).input)).rejects.toMatchObject({
      constraint: 'incoming_webhooks_base_name_key',
    });
    await hooks().softDelete(scope, first.id);
    await hooks().create(scope, newHook(a, { name: 'shop' }).input);
  });

  it.each([
    ['signature without a secret', { auth: 'signature' as const }],
    ['bearer without a hash', { auth: 'bearer' as const }],
    ['a secret with auth none', { auth: 'none' as const, signing_secret_enc: 'x' }],
    [
      'a bearer hash with auth signature',
      {
        auth: 'signature' as const,
        signing_secret_enc: 'x',
        bearer_hash: 'a'.repeat(64),
      },
    ],
    ['a malformed bearer hash', { auth: 'bearer' as const, bearer_hash: 'nothex' }],
    ['a malformed token hash', { token_hash: 'abc' }],
    [
      'a previous secret without expiry',
      {
        auth: 'signature' as const,
        signing_secret_enc: 'x',
        signing_secret_prev_enc: 'y',
      },
    ],
    ['a rate of 0', { rate_limit_per_sec: 0 }],
    ['an empty name', { name: '' }],
  ])('refuses %s (CHECK)', async (_name, overrides) => {
    await expect(
      hooks().create(orgScope(ORG_A), newHook(a, overrides as Partial<NewIncomingWebhook>).input),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('deduplicates on webhook-id per hook and pages the log newest first', async () => {
    const scope = orgScope(ORG_A);
    const hook = await hooks().create(scope, newHook(a).input);
    const other = await hooks().create(scope, newHook(a).input);
    const insert = (hookId: Id<'hok'>, messageId: string | null, receivedAt: Date) =>
      requests().insert(scope, {
        id: newId('whr'),
        incomingWebhookId: hookId,
        messageId,
        body: [1, 2],
        headers: { 'content-type': 'application/json' },
        query: { a: 'b' },
        sizeBytes: 5,
        causationAccepted: true,
        eventId: newId('evt'),
        receivedAt,
      });
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    expect(await insert(hook.id, 'msg_1', new Date(base))).toBeDefined();
    expect(await insert(hook.id, 'msg_1', new Date(base + 1000))).toBeUndefined();
    expect(await insert(other.id, 'msg_1', new Date(base))).toBeDefined(); // another hook
    for (let index = 0; index < 4; index += 1) {
      expect(await insert(hook.id, null, new Date(base + 2000 + index))).toBeDefined(); // no dedupe
    }
    const first = await requests().listPage(scope, hook.id, { cursor: null, limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    expect(Object.keys(first.items[0] ?? {}).sort()).toEqual([
      'causation_accepted',
      'duplicate',
      'event_id',
      'id',
      'received_at',
      'size_bytes',
    ]);
    const { decodeCursor } = await import('../../src/db/cursor.js');
    const second = await requests().listPage(scope, hook.id, {
      cursor: decodeCursor(first.nextCursor ?? undefined),
      limit: 3,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const times = [...first.items, ...second.items].map((row) => row.received_at.getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(times.at(-1)).toBe(base);
  });

  it('lists automations triggered by a hook as its usages (not deleted ones)', async () => {
    const scope = orgScope(ORG_A);
    const hook = await hooks().create(scope, newHook(a).input);
    const definition = (hookId: Id<'hok'>) => ({
      trigger: { type: 'webhook.received', incoming_webhook_id: hookId },
      actions: [],
    });
    const insert = (name: string, hookId: Id<'hok'>, deleted = false) =>
      db.kysely
        .insertInto('meta.automations')
        .values({
          id: newId('aut'),
          organization_id: ORG_A,
          base_id: a.baseId,
          name,
          definition: definition(hookId),
          trigger_type: 'webhook.received',
          trigger_table_id: null,
          created_by: a.userId,
          updated_by: a.userId,
          run_as_user_id: a.userId,
          ...(deleted ? { deleted_at: new Date() } : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const used = await insert('B uses it', hook.id);
    await insert('A deleted', hook.id, true);
    await insert('Other hook', newId('hok'));
    const usages = await new IncomingWebhookUsageRepository(db).list(scope, hook.id);
    expect(usages).toEqual([
      { automationId: used.id, baseId: a.baseId, triggerTableId: null, name: 'B uses it' },
    ]);
  });

  it('purges requests older than 7 days in every organization, by age only', async () => {
    const insertAged = async (tenant: SeededTenant, days: number) => {
      const scope = orgScope(tenant.orgId);
      const hook = (await hooks().listByBase(scope, tenant.baseId))[0];
      if (hook === undefined) throw new Error('no hook');
      const row = await requests().insert(scope, {
        id: newId('whr'),
        incomingWebhookId: hook.id,
        messageId: null,
        body: null,
        headers: {},
        query: {},
        sizeBytes: 0,
        causationAccepted: false,
        eventId: null,
        receivedAt: new Date(Date.now() - days * 86_400_000),
      });
      if (row === undefined) throw new Error('not inserted');
      return { scope, id: row.id };
    };
    await hooks().create(orgScope(ORG_B), newHook(b, { name: 'Purge B' }).input);
    const oldA = await insertAged(a, 8);
    const oldB = await insertAged(b, 8);
    const recentA = await insertAged(a, 6);
    const before = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.incoming_webhook_requests
       WHERE received_at < now() - interval '7 days'
    `.execute(db.kysely);
    const result = await purgeExpiredOperationalRows(db, { now: new Date(), batchSize: 1 });
    expect(result.incomingWebhookRequests).toBe(before.rows[0]?.n);
    expect(result.incomingWebhookRequests).toBeGreaterThanOrEqual(2);
    expect(await requests().findById(oldA.scope, oldA.id)).toBeUndefined();
    expect(await requests().findById(oldB.scope, oldB.id)).toBeUndefined();
    expect(await requests().findById(recentA.scope, recentA.id)).toBeDefined();
  });

  it('clears the creator when the member leaves and cascades with the base', async () => {
    const tenant = await seedTenant(db, 'org_InWebhookOrgC001');
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: tenant.orgId, user_id: tenant.userId, role: 'owner' })
      .onConflict((oc) => oc.doNothing())
      .execute();
    const scope = orgScope(tenant.orgId);
    const hook = await hooks().create(scope, newHook(tenant).input);
    await db.kysely
      .deleteFrom('meta.org_members')
      .where('organization_id', '=', tenant.orgId)
      .where('user_id', '=', tenant.userId)
      .execute();
    expect((await hooks().findById(scope, hook.id))?.created_by).toBeNull();
    await sql`DELETE FROM meta.bases WHERE id = ${tenant.baseId}`.execute(db.kysely);
    expect(await hooks().findById(scope, hook.id, { includeDeleted: true })).toBeUndefined();
  });
});
