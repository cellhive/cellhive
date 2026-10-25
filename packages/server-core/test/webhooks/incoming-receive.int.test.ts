import { Buffer } from 'node:buffer';

import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, type Db } from '../../src/db/index.js';
import { toEventDocument } from '../../src/events/event.js';
import {
  buildSample,
  IncomingWebhookCredentials,
  IncomingWebhookRequestsRepository,
  IncomingWebhooksRepository,
  recordIncomingWebhookRequest,
  sampleFromJson,
  type ReceivedRequest,
} from '../../src/webhooks/incoming/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

const ORG_A = 'org_InReceiveOrgA001';
const ORG_B = 'org_InReceiveOrgB001';

const credentials = new IncomingWebhookCredentials(Buffer.alloc(32, 7));

/**
 * The transaction of the public route (BACKLOG T603, ADR-35 §1 step 7,
 * migration 0044): request row + `webhook.received` (actor `webhook`,
 * payload ids only, causation of the header) + `events.dispatch`; a
 * replayed `webhook-id` is logged as a duplicate with no event; the sample
 * goes to the first request of an open window only; the new repository
 * methods stay inside their organization.
 */
describe('incoming webhook receive (T603)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let hookA: Id<'hok'>;
  const hooks = () => new IncomingWebhooksRepository(db);
  const requests = () => new IncomingWebhookRequestsRepository(db);

  function input(overrides: Partial<ReceivedRequest> = {}): ReceivedRequest {
    return {
      organizationId: a.orgId,
      baseId: a.baseId,
      incomingWebhookId: hookA,
      messageId: null,
      body: { order: 1 },
      headers: { 'content-type': 'application/json' },
      query: { src: 'shop' },
      sizeBytes: 11,
      causation: undefined,
      causationAccepted: false,
      sample: () => buildSample({ body: { order: 1 }, headers: {}, query: {} }),
      ...overrides,
    };
  }

  const record = (value: ReceivedRequest) =>
    db.withTx((tx) =>
      recordIncomingWebhookRequest(db, tx, { hooks: hooks(), requests: requests() }, value),
    );

  const eventsOfHook = async (hookId: Id<'hok'>) =>
    db.kysely
      .selectFrom('meta.events')
      .selectAll()
      .where('entity_id', '=', hookId)
      .where('type', '=', 'webhook.received')
      .orderBy('created_at')
      .execute();

  async function createHook(tenant: SeededTenant): Promise<Id<'hok'>> {
    const token = credentials.issueToken();
    const row = await hooks().create(orgScope(tenant.orgId), {
      id: newId('hok'),
      base_id: tenant.baseId,
      name: `Hook ${newId('hok').slice(4, 10)}`,
      token_hash: token.tokenHash,
      token_enc: token.tokenEnc,
      auth: 'none',
      created_by: tenant.userId,
    });
    return row.id;
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
    hookA = await createHook(a);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('stores the request, a webhook.received event (actor webhook, ids only) and its dispatch job', async () => {
    const result = await record(input());
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    const row = await requests().findById(orgScope(a.orgId), result.requestId);
    expect(row).toMatchObject({
      incoming_webhook_id: hookA,
      event_id: result.eventId,
      body: { order: 1 },
      query: { src: 'shop' },
      duplicate: false,
      causation_accepted: false,
    });
    const [event] = (await eventsOfHook(hookA)).filter((e) => e.id === result.eventId);
    if (event === undefined) throw new Error('no event');
    const doc = toEventDocument(event);
    expect(doc).toMatchObject({
      type: 'webhook.received',
      entity_type: 'incoming_webhook',
      entity_id: hookA,
      base_id: a.baseId,
      actor: { type: 'webhook', id: hookA },
      data: { incoming_webhook_id: hookA, request_id: result.requestId },
      causation: { root_event_id: result.eventId, depth: 0, automation_chain: [] },
    });
    expect(JSON.stringify(event.payload)).not.toContain('order');
    const { rows: jobs } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id)
       WHERE task_identifier = 'events.dispatch' AND payload->>'event_id' = ${result.eventId}
    `.execute(db.kysely);
    expect(Number(jobs[0]?.n)).toBe(1);
  });

  it('carries the causation of the header', async () => {
    const root = newId('evt');
    const chain = [newId('aut')];
    const result = await record(
      input({
        causation: { root_event_id: root, depth: 2, automation_chain: chain },
        causationAccepted: true,
      }),
    );
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    const event = (await eventsOfHook(hookA)).find((e) => e.id === result.eventId);
    expect(event?.causation).toEqual({ root_event_id: root, depth: 2, automation_chain: chain });
    expect(
      (await requests().findById(orgScope(a.orgId), result.requestId))?.causation_accepted,
    ).toBe(true);
  });

  it('logs a replayed webhook-id as a duplicate: no body, no message id, no second event', async () => {
    const hook = await createHook(a);
    const first = await record(input({ incomingWebhookId: hook, messageId: 'msg_replay' }));
    const second = await record(input({ incomingWebhookId: hook, messageId: 'msg_replay' }));
    expect(first.kind).toBe('accepted');
    expect(second.kind).toBe('duplicate');
    expect(await eventsOfHook(hook)).toHaveLength(1);
    const duplicate = await requests().findById(orgScope(a.orgId), second.requestId);
    expect(duplicate).toMatchObject({
      duplicate: true,
      message_id: null,
      body: null,
      event_id: null,
      headers: {},
      query: {},
    });
    // Without a message id (no signing secret) nothing is deduplicated.
    await record(input({ incomingWebhookId: hook }));
    await record(input({ incomingWebhookId: hook }));
    expect(await eventsOfHook(hook)).toHaveLength(3);
  });

  it('captures the first request of an open window only, then closes it', async () => {
    const hook = await createHook(a);
    const scope = orgScope(a.orgId);
    const until = new Date(Date.now() + 180_000);
    let built = 0;
    const sample = (order: number) => () => {
      built += 1;
      return buildSample({ body: { order }, headers: { h: 'v' }, query: {} });
    };
    // Not listening: nothing is built or stored.
    await record(input({ incomingWebhookId: hook, sample: sample(0) }));
    expect(built).toBe(0);

    await hooks().startListening(scope, hook, a.userId, until);
    const first = await record(input({ incomingWebhookId: hook, sample: sample(1) }));
    const second = await record(input({ incomingWebhookId: hook, sample: sample(2) }));
    expect(first).toMatchObject({ kind: 'accepted', sampleCapturedFor: a.userId });
    expect(second).toMatchObject({ kind: 'accepted', sampleCapturedFor: null });
    const stored = await hooks().findById(scope, hook);
    expect(sampleFromJson(stored?.sample ?? null)?.body).toEqual({ order: 1 });
    expect(stored).toMatchObject({ listen_until: null, listened_by: null });
    expect(stored?.sample_captured_at).toBeInstanceOf(Date);

    // Listening again drops the old sample; stopping keeps a captured one.
    await hooks().startListening(scope, hook, a.userId, until);
    expect((await hooks().findById(scope, hook))?.sample).toBeNull();
    await record(input({ incomingWebhookId: hook, sample: sample(3) }));
    expect(await hooks().stopListening(scope, hook)).toBe(true);
    expect(sampleFromJson((await hooks().findById(scope, hook))?.sample ?? null)?.body).toEqual({
      order: 3,
    });
  });

  it('keeps the listening and sample methods inside their organization (tenant isolation)', async () => {
    const hook = await createHook(a);
    const scopeB = orgScope(b.orgId);
    const until = new Date(Date.now() + 180_000);
    expect(await hooks().startListening(scopeB, hook, b.userId, until)).toBeUndefined();
    expect(await hooks().stopListening(scopeB, hook)).toBe(false);
    await hooks().startListening(orgScope(a.orgId), hook, a.userId, until);
    const captured = await db.withTx((tx) =>
      hooks().captureSample(orgScope(b.orgId, tx), hook, () => ({ x: 1 })),
    );
    expect(captured).toBeUndefined();
    expect((await hooks().findById(orgScope(a.orgId), hook))?.listen_until).not.toBeNull();
    await expect(
      requests().insertDuplicate(scopeB, {
        id: newId('whr'),
        incomingWebhookId: hook,
        sizeBytes: 1,
      }),
    ).rejects.toThrow();
  });

  it('T617: a request row is read and written only inside its organization; no hook on a base of another one', async () => {
    const recorded = await record(input({ body: { order: 'isolation' } }));
    expect(recorded.kind).toBe('accepted');
    const scopeA = orgScope(a.orgId);
    const scopeB = orgScope(b.orgId);
    // The run engine reads trigger data by request id: another organization never sees it.
    expect(await requests().findById(scopeB, recorded.requestId)).toBeUndefined();
    expect((await requests().findById(scopeA, recorded.requestId))?.body).toEqual({
      order: 'isolation',
    });
    // A request of org B cannot be filed under a hook of org A (composite FK).
    await expect(
      requests().insert(scopeB, {
        id: newId('whr'),
        incomingWebhookId: hookA,
        messageId: null,
        body: { order: 'cross' },
        headers: {},
        query: {},
        sizeBytes: 1,
        causationAccepted: false,
        eventId: null,
      }),
    ).rejects.toThrow();
    // Nor can org B create a hook on a base of org A.
    const token = credentials.issueToken();
    await expect(
      hooks().create(scopeB, {
        id: newId('hok'),
        base_id: a.baseId,
        name: 'Cross-tenant hook',
        token_hash: token.tokenHash,
        token_enc: token.tokenEnc,
        auth: 'none',
        created_by: b.userId,
      }),
    ).rejects.toThrow();
  });
});
