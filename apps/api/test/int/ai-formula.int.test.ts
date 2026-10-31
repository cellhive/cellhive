import {
  aiFormulaSchema,
  createdApiTokenSchema,
  newId,
  roleListSchema,
  type ApiTokenScope,
  type Id,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import {
  startFakeOpenAiServer,
  type FakeOpenAiReply,
  type FakeOpenAiServer,
} from '@cellhive/server-core/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { AiAccess } from '../../src/modules/ai/ai-access.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

const DAY_MS = 86_400_000;
const DESCRIPTION = 'Lãi = tiền trừ chi phí';

/** A scripted answer of the model. */
const answer = (formula: string, explanation = 'Profit.'): FakeOpenAiReply => ({
  content: JSON.stringify({ formula, explanation }),
});

/**
 * BACKLOG T907 (CONTRACTS §29.2, ADR-39): `POST /tables/:tableId/ai/formula`
 * against the fake provider — a formula checked like a save on the first
 * answer, after a repair round, or `AI_INVALID_OUTPUT` after two; the digest
 * by name of what the caller reads (P82: a hidden field is a field that does
 * not exist); `404`/`403` before anything about AI (P80, P81, P84); token
 * scopes (P89); the field being edited; the time budget. Every case also
 * checks what the provider received.
 */
describe('AI formula API (T907)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let base2: Id<'bse'>;

  const url = (tableId: Id<'tbl'> = fx.orders.id) => `/tables/${tableId}/ai/formula`;
  const ask = (
    user: FixtureUser,
    body: Record<string, unknown> = { description: DESCRIPTION },
    tableId?: Id<'tbl'>,
    headers?: Record<string, string>,
  ) => fx.call(user, 'POST', url(tableId), body, headers);
  const chats = () => fake.chatRequests();
  /** The text of every message of one chat request. */
  const textOf = (index: number) => JSON.stringify(chats()[index]?.body?.['messages']);
  const lastUserMessage = (index: number) => {
    const messages = chats()[index]?.body?.['messages'] as { content: string }[] | undefined;
    return messages?.at(-1)?.content ?? '';
  };
  const createToken = async (
    user: FixtureUser,
    scopes: ApiTokenScope[],
    extra: Record<string, unknown> = {},
  ) => {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: `${user} ${scopes.join(' ')}`,
      scopes,
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(201);
    return { authorization: `Bearer ${createdApiTokenSchema.parse(response.json()).token}` };
  };
  const lastAudit = async () =>
    (
      await sql<{ entity_type: string; entity_id: string; table_id: string; after: object }>`
        SELECT entity_type, entity_id, table_id, after FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND action = 'ai.requested'
         ORDER BY created_at DESC, id DESC LIMIT 1`.execute(db.kysely)
    ).rows[0];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp(
      { DATABASE_URL: database.url },
      { outboundLookup: () => Promise.resolve(['127.0.0.1']) },
    );
    fx = await buildRecordFixture(t, db);
    t.app.get(ApiRateLimits).ai = { limit: 10_000, windowSeconds: 60 };
    fake = await startFakeOpenAiServer();
    const entry = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `localhost:${String(fake.port)}`,
    });
    expect(entry.statusCode, entry.body).toBe(201);

    // "Sales quản lý" (C§5 S8 fixture): `manage` on Orders, `cost` still `no_perm`.
    const roles = roleListSchema.parse(
      (await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    const sales = roles.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('missing Sales role');
    const tables = sales.config.tables as Record<string, object>;
    const patched = await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
      config: {
        ...sales.config,
        tables: { ...tables, [fx.orders.id]: { ...tables[fx.orders.id], perm: 'manage' } },
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    // B2: u_admin is its admin, for `tk_admin_b2`.
    const workspaces = (await fx.call('owner', 'GET', `/orgs/${fx.orgId}/workspaces`)).json<{
      items: { id: Id<'wsp'> }[];
    }>();
    const created = await fx.call(
      'owner',
      'POST',
      `/workspaces/${String(workspaces.items[0]?.id)}/bases`,
      { name: 'B2' },
    );
    expect(created.statusCode, created.body).toBe(201);
    base2 = created.json<{ id: Id<'bse'> }>().id;
    const roles2 = roleListSchema.parse(
      (await fx.call('owner', 'GET', `/bases/${base2}/roles`)).json(),
    ).items;
    const assigned = await fx.call('owner', 'PUT', `/bases/${base2}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_admin.id,
      role_id: roles2.find((role) => role.kind === 'system_admin')?.id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  });

  afterAll(async () => {
    await fake.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(() => {
    fake.requests.length = 0;
  });

  it('P84: AI off — 404/403 first, then 422 AI_NOT_CONFIGURED; the provider gets nothing', async () => {
    expectProblem(await ask('u_admin'), 422, 'AI_NOT_CONFIGURED');
    expectProblem(await ask('u_reader'), 403, 'PERMISSION_DENIED');
    expectProblem(await ask('u_out'), 404, 'NOT_FOUND');
    expect(fake.requests).toEqual([]);

    const configured = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
    });
    expect(configured.statusCode, configured.body).toBe(200);
  });

  it('answers a formula checked like a save on the first answer; nothing stored, ids never sent', async () => {
    const fieldsBefore = (await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/fields`)).body;
    fake.script(answer('[amount] - [cost]'));
    const response = await ask('u_admin', {
      description: DESCRIPTION,
      current: '[amount] -',
      field_id: null,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(aiFormulaSchema.parse(response.json())).toEqual({
      formula: '[amount] - [cost]',
      result_type: { kind: 'number', list: false },
      explanation: 'Profit.',
      attempts: 1,
    });

    expect(chats()).toHaveLength(1);
    const body = chats()[0]?.body ?? {};
    expect(body).toMatchObject({
      model: 'fake-model',
      stream: false,
      max_tokens: 600,
      response_format: { type: 'json_schema', json_schema: { name: 'formula', strict: true } },
    });
    const sent = JSON.stringify(body);
    // Names of every readable table and field; never an id or a record value.
    for (const name of ['Orders', 'amount', 'cost', 'Customers', 'Tickets', 'Trạngˆthái', 'Xong']) {
      expect(sent).toContain(name);
    }
    for (const id of ['fld_', 'tbl_', 'bse_', 'opt_', 'rec_', 'usr_'])
      expect(sent).not.toContain(id);
    expect(lastUserMessage(0)).toContain('<<DATA current_formula');
    expect(lastUserMessage(0).endsWith(DESCRIPTION)).toBe(true);

    expect((await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/fields`)).body).toBe(
      fieldsBefore,
    );
    expect(await lastAudit()).toMatchObject({
      entity_type: 'table',
      entity_id: fx.orders.id,
      table_id: fx.orders.id,
      after: { feature: 'formula', status: 'ok', attempts: 1, output_mode: 'json_schema' },
    });
    const usage = await sql<{ requests: number }>`
      SELECT requests FROM meta.ai_usage_daily
       WHERE organization_id = ${fx.orgId} AND feature = 'formula'`.execute(db.kysely);
    expect(usage.rows).toEqual([{ requests: 1 }]);
    // Never the prompt in the logs (only the host of the provider).
    expect(t.logs.raw()).toContain('ai request');
    expect(t.logs.raw()).not.toContain('tiền trừ chi phí');
    expect(t.logs.raw()).not.toContain('<<DATA');
  });

  it('repairs a formula the engine rejects: the errors go back, 2 calls', async () => {
    fake.script(answer('[amount] -'), answer('[amount] * 2'));
    const response = await ask('u_admin', { description: 'Double the amount' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ formula: '[amount] * 2', attempts: 2 });
    expect(chats()).toHaveLength(2);
    const repair = lastUserMessage(1);
    expect(repair).toContain('Your previous answer cannot be used');
    expect(repair).toMatch(
      /"path":"formula","code":"[A-Z_]+","message":"[^"]+\(at character \d+\)"/u,
    );
    expect(await lastAudit()).toMatchObject({ after: { status: 'ok', attempts: 2 } });
  });

  it('gives up after 2 repair rounds: 422 AI_INVALID_OUTPUT with attempts 3', async () => {
    fake.script(answer('SUM('), answer('[nope]'), answer('[amount] &&'));
    const response = await ask('u_admin');
    expectProblem(response, 422, 'AI_INVALID_OUTPUT');
    expect(problemOf(response.body)['errors']).toEqual([
      expect.objectContaining({ code: 'AI_INVALID_OUTPUT', params: { attempts: 3 } }),
    ]);
    expect(chats()).toHaveLength(3);
    expect(await lastAudit()).toMatchObject({
      after: { feature: 'formula', status: 'AI_INVALID_OUTPUT', attempts: 3 },
    });
  });

  it('P82: for "Sales quản lý" a hidden field is a field that does not exist', async () => {
    // Data blocks have fresh random ids.
    const sentText = () =>
      JSON.stringify(chats().map((request) => request.body)).replace(
        /<<(DATA \w+|END) [0-9a-f]{16}>>/gu,
        '<<$1 ID>>',
      );
    fake.script(
      answer('[amount] - [cost]'),
      answer('[amount] - [cost]'),
      answer('[amount] - [cost]'),
    );
    const hidden = await ask('u_sales1');
    expectProblem(hidden, 422, 'AI_INVALID_OUTPUT');
    expect(chats()).toHaveLength(3);
    const hiddenSent = sentText();
    // The first request (system prompt, digest, description) never names `cost`.
    expect(textOf(0)).not.toContain('cost');
    expect(textOf(0)).not.toContain(fx.fld.cost?.id);
    expect(textOf(0)).toContain('amount');

    fake.requests.length = 0;
    fake.script(answer('[amount] - [lãi]'), answer('[amount] - [lãi]'), answer('[amount] - [lãi]'));
    const missing = await ask('u_sales1');
    expectProblem(missing, 422, 'AI_INVALID_OUTPUT');
    // The same answer and the same prompts and repair problems, the name aside.
    expect(problemOf(missing.body)['errors']).toEqual(problemOf(hidden.body)['errors']);
    expect(sentText()).toBe(hiddenSent.replaceAll('cost', 'lãi'));
  });

  it('P81: reader and editor get 403, the provider gets nothing', async () => {
    expectProblem(await ask('u_reader'), 403, 'PERMISSION_DENIED');
    expectProblem(await ask('u_editor'), 403, 'PERMISSION_DENIED');
    expect(fake.requests).toEqual([]);
  });

  it('P80: another member, another org, a token of base B2, unknown ids → 404, nothing sent', async () => {
    const b2 = await createToken('u_admin', ['schema:read'], { base_ids: [base2] });
    for (const response of [
      await ask('u_out'),
      await ask('stranger'),
      await ask('u_admin', { description: DESCRIPTION }, undefined, b2),
      await ask('u_admin', { description: DESCRIPTION }, newId('tbl')),
      // `field_id`: not a computed field, unknown, of another table.
      await ask('u_admin', { description: DESCRIPTION, field_id: fx.fld.amount?.id }),
      await ask('u_admin', { description: DESCRIPTION, field_id: newId('fld') }),
      await ask('u_admin', { description: DESCRIPTION, field_id: fx.fld.ticketAmount?.id }),
    ]) {
      expectProblem(response, 404, 'NOT_FOUND');
    }
    expect(fake.requests).toEqual([]);
  });

  it('P89: a schema:read token writes formulas; a token without it gets 403 INSUFFICIENT_SCOPE', async () => {
    const schemaOnly = await createToken('u_admin', ['schema:read']);
    fake.script(answer('[amount] * 2'));
    const ok = await ask('u_admin', { description: 'Double the amount' }, undefined, schemaOnly);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(chats()).toHaveLength(1);

    fake.requests.length = 0;
    const recordsOnly = await createToken('u_admin', ['records:read', 'schema:write']);
    const denied = await ask('u_admin', { description: DESCRIPTION }, undefined, recordsOnly);
    expectProblem(denied, 403, 'INSUFFICIENT_SCOPE');
    expect(problemOf(denied.body)['errors']).toEqual([
      expect.objectContaining({ params: { required: ['schema:read'] } }),
    ]);
    expect(fake.requests).toEqual([]);
  });

  it('leaves the field being edited out of the digest and refuses a cycle through it', async () => {
    const created = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'margin',
      type: 'formula',
      options: { expression: '[amount] - [cost]' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const margin = created.json<{ id: Id<'fld'> }>().id;
    fake.requests.length = 0;
    fake.script(answer('[margin] + 1'), answer('[amount] + 1'));
    const response = await ask('u_admin', {
      description: 'Amount plus one',
      current: '[amount] - [cost]',
      field_id: margin,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ formula: '[amount] + 1', attempts: 2 });
    expect(lastUserMessage(0)).not.toContain('margin');
    expect(lastUserMessage(1)).toContain('"code":"CIRCULAR_REFERENCE"');
    // Without `field_id`, the field is in the digest like any other.
    fake.requests.length = 0;
    fake.script(answer('[margin] + 1'));
    expect((await ask('u_admin', { description: 'Margin plus one' })).statusCode).toBe(200);
    expect(lastUserMessage(0)).toContain('margin');
  });

  it('validates the body before calling the provider', async () => {
    for (const body of [
      {},
      { description: '   ' },
      { description: 'x'.repeat(1001) },
      { description: DESCRIPTION, current: 'x'.repeat(4001) },
      { description: DESCRIPTION, field_id: 'nope' },
      { description: DESCRIPTION, extra: true },
    ]) {
      expectProblem(await ask('u_admin', body), 422, 'VALIDATION_FAILED');
    }
    expect(fake.requests).toEqual([]);
  });

  it('stops at the time budget of the request: 504 AI_TIMEOUT', async () => {
    const access = t.app.get(AiAccess);
    access.budgetMs = 400;
    fake.capabilities.delayMs = 250;
    try {
      // Deterministic answers (`"fake"`) never parse: the repair call runs out of time.
      const response = await ask('u_admin');
      expectProblem(response, 504, 'AI_TIMEOUT');
      expect(chats().length).toBeLessThanOrEqual(2);
      expect(await lastAudit()).toMatchObject({ after: { status: 'AI_TIMEOUT' } });
    } finally {
      access.budgetMs = 90_000;
      fake.capabilities.delayMs = 0;
    }
  });
});
