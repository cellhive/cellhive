import {
  auditLogListSchema,
  createdApiTokenSchema,
  jobAcceptedSchema,
  jobSchema,
  MAX_AUDIT_FILTER_VALUES,
  recordsResponseSchema,
  type AuditLogList,
  type CreatedApiToken,
  type Id,
  type JobDto,
} from '@cellhive/contracts';
import { AuditWriter, BaseRolesRepository, orgScope, type Db } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CACHE_CLIENT } from '../../src/common/tokens.js';

import { uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';

const DAY = 86_400_000;

async function finishedJob(read: () => Promise<LightMyRequestResponse>): Promise<JobDto> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const job = jobSchema.parse((await read()).json());
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (Date.now() > deadline) throw new Error(`job ${job.id} still ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * T709 (P60, CONTRACTS §11.4): the audit viewer API — repeatable filters,
 * action groups, `via`, `include=refs`, `retention_days`, the base export
 * and the sparse `audit.viewed` — on the permission fixture of CONTRACTS
 * §5 plus a second base B2 that u_admin does not administer.
 */
describe('audit viewer API (T709)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle | undefined;
  let base2: Id<'bse'>;
  let table2: Id<'tbl'>;
  let field2: Id<'fld'>;
  const tk: Record<string, CreatedApiToken> = {};

  const auditRows = (action: string, actorId: string) =>
    db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('organization_id', '=', fx.orgId)
      .where('action', '=', action)
      .where('actor_id', '=', actorId)
      .execute();

  function bearer(token: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
    return t.app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: uniqueIp(),
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function createToken(user: FixtureUser, name: string): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name,
      scopes: ['records:read', 'records:write'],
      expires_at: new Date(Date.now() + 90 * DAY).toISOString(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  async function list(user: FixtureUser, url: string): Promise<AuditLogList> {
    const response = await fx.call(user, 'GET', url);
    expect(response.statusCode, response.body).toBe(200);
    return auditLogListSchema.parse(response.json());
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const orders = `/tables/${fx.orders.id}/records`;
    const created = await fx.call('u_admin', 'POST', orders, {
      records: [
        { fields: { title: 'r1', amount: 100, owner: [{ id: fx.users.u_sales1.id }] } },
        { fields: { title: 'r2', amount: 200, owner: [{ id: fx.users.u_sales2.id }] } },
        ...[3, 4, 5, 6, 7].map((n) => ({ fields: { title: `r${String(n)}`, amount: n } })),
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    const [r1, r2] = recordsResponseSchema.parse(created.json()).records;
    expect(
      (await fx.call('u_admin', 'PATCH', `${orders}/${r1?.id ?? ''}`, { fields: { amount: 110 } }))
        .statusCode,
    ).toBe(200);

    // Writes through API tokens of u_admin and of u_editor (`via.api_token_id`;
    // written here as T705 writes them, so the test does not depend on it).
    tk.admin = await createToken('u_admin', 'Admin sync');
    tk.editor = await createToken('u_editor', 'Editor sync');
    const amountId = fx.fld['amount']?.id as Id<'fld'>;
    await db.withTx(async (tx) => {
      for (const [user, token, amount] of [
        ['u_admin', tk.admin, 120],
        ['u_editor', tk.editor, 130],
      ] as const) {
        await new AuditWriter().write(tx, {
          action: 'record.updated',
          organizationId: fx.orgId,
          baseId: fx.baseId,
          tableId: fx.orders.id,
          entityType: 'record',
          entityId: r2?.id ?? null,
          before: { [amountId]: 200 },
          after: { [amountId]: amount },
          context: {
            actor: { type: 'user', id: fx.users[user].id },
            via: { api_token_id: token?.id as Id<'tok'> },
            batch_id: null,
            request_id: null,
            ip: null,
            user_agent: null,
          },
        });
      }
    });

    // Base B2 with its own table, field and record; u_admin has no role there.
    const workspaces = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/workspaces`);
    const workspaceId = workspaces.json<{ items: { id: Id<'wsp'> }[] }>().items[0]?.id ?? '';
    const b2 = await fx.call('owner', 'POST', `/workspaces/${workspaceId}/bases`, { name: 'B2' });
    expect(b2.statusCode, b2.body).toBe(201);
    base2 = b2.json<{ id: Id<'bse'> }>().id;
    const tableResponse = await fx.call('owner', 'POST', `/bases/${base2}/tables`, {
      name: 'Other',
    });
    expect(tableResponse.statusCode, tableResponse.body).toBe(201);
    table2 = tableResponse.json<{ id: Id<'tbl'> }>().id;
    const fieldResponse = await fx.call('owner', 'POST', `/tables/${table2}/fields`, {
      name: 'Secret note',
      type: 'text',
    });
    expect(fieldResponse.statusCode, fieldResponse.body).toBe(201);
    field2 = fieldResponse.json<{ id: Id<'fld'> }>().id;
    expect(
      (
        await fx.call('owner', 'POST', `/tables/${table2}/records`, {
          records: [{ fields: { 'Secret note': 'x' } }],
        })
      ).statusCode,
    ).toBe(201);
  });

  afterAll(async () => {
    await worker?.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('P60: who may read which log', () => {
    it('u_admin (base admin, not org admin): base B only; org route, editors, members → 404', async () => {
      const page = await list('u_admin', `/bases/${fx.baseId}/audit-logs?limit=200`);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((item) => item.base_id === fx.baseId)).toBe(true);
      expect(page.retention_days).toBe(t.config.limits.auditRetentionDays);
      expect(page.refs).toBeUndefined();
      expectProblem(
        await fx.call('u_admin', 'GET', `/orgs/${fx.orgId}/audit-logs`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('u_admin', 'GET', `/bases/${base2}/audit-logs`),
        404,
        'NOT_FOUND',
      );
      for (const user of ['u_editor', 'u_reader', 'u_sales1', 'u_out', 'stranger'] as const) {
        expectProblem(
          await fx.call(user, 'GET', `/bases/${fx.baseId}/audit-logs?include=refs`),
          404,
          'NOT_FOUND',
        );
        expectProblem(await fx.call(user, 'GET', `/orgs/${fx.orgId}/audit-logs`), 404, 'NOT_FOUND');
      }
    });

    it('refs of the base route: ids of the page only, never another base’s schema', async () => {
      const page = await list('u_admin', `/bases/${fx.baseId}/audit-logs?include=refs&limit=200`);
      const refs = page.refs;
      expect(refs).toBeDefined();
      if (refs === undefined) return;
      const inPage = new Set<string>();
      for (const item of page.items) {
        for (const id of [item.actor.id, item.entity_id, item.table_id, item.via?.api_token_id]) {
          if (typeof id === 'string') inPage.add(id);
        }
        for (const side of [item.before, item.after]) {
          for (const key of Object.keys(side ?? {})) inPage.add(key);
        }
      }
      for (const kind of ['users', 'fields', 'tables', 'api_tokens'] as const) {
        for (const id of Object.keys(refs[kind])) expect(inPage.has(id), id).toBe(true);
      }
      const ownTables = new Set<string>([fx.orders.id, fx.customers.id, fx.tickets.id]);
      for (const [id, table] of Object.entries(refs.tables)) {
        expect(ownTables.has(id), id).toBe(true);
        expect(table.deleted).toBe(false);
      }
      for (const field of Object.values(refs.fields)) {
        expect(ownTables.has(field.table_id)).toBe(true);
      }
      expect(Object.keys(refs.tables)).not.toContain(table2);
      expect(Object.keys(refs.fields)).not.toContain(field2);
      const amount = fx.fld['amount'];
      expect(refs.fields[amount?.id ?? '']).toEqual({
        name: amount?.name,
        table_id: fx.orders.id,
        deleted: false,
      });
      expect(refs.users[fx.users.u_admin.id]).toEqual({ display_name: 'User admin' });
      // u_admin is not an organization admin: only its own token is named, and
      // another user's token is not even listed (its `via` is anonymous, T705).
      expect(refs.api_tokens).toEqual({
        [tk.admin?.id ?? '']: { name: 'Admin sync' },
      });
    });

    it('refs of the organization route: every base, every token named', async () => {
      const page = await list('owner', `/orgs/${fx.orgId}/audit-logs?include=refs&limit=200`);
      expect(page.refs?.tables[table2]).toEqual({ name: 'Other', deleted: false });
      expect(page.refs?.api_tokens).toMatchObject({
        [tk.admin?.id ?? '']: { name: 'Admin sync' },
        [tk.editor?.id ?? '']: { name: 'Editor sync' },
      });
    });
  });

  describe('filters', () => {
    it('repeated action / actor_id are OR; different filters AND', async () => {
      const page = await list(
        'owner',
        `/orgs/${fx.orgId}/audit-logs?action=record.created&action=record.updated` +
          `&actor_id=${fx.users.u_admin.id}&actor_id=${fx.users.u_editor.id}&limit=200`,
      );
      expect(page.items.length).toBeGreaterThan(0);
      for (const item of page.items) {
        expect(['record.created', 'record.updated']).toContain(item.action);
        expect([fx.users.u_admin.id, fx.users.u_editor.id]).toContain(item.actor.id);
      }
      expect(page.items.some((item) => item.actor.id === fx.users.u_editor.id)).toBe(true);
    });

    it('action_prefix groups and via sources', async () => {
      const tables = await list('owner', `/orgs/${fx.orgId}/audit-logs?action_prefix=table.`);
      expect(tables.items.some((item) => item.entity_id === table2)).toBe(true);
      expect(tables.items.every((item) => item.action.startsWith('table.'))).toBe(true);
      const byToken = await list('u_admin', `/bases/${fx.baseId}/audit-logs?via=api_token`);
      // u_editor's token stays anonymous for u_admin (T705): `api_token_id: null`.
      expect(byToken.items.map((item) => item.via?.api_token_id ?? null).sort()).toEqual(
        [tk.admin?.id, null].sort(),
      );
      const both = await list(
        'u_admin',
        `/bases/${fx.baseId}/audit-logs?via=api_token&actor_id=${fx.users.u_editor.id}`,
      );
      expect(both.items.map((item) => item.via?.api_token_id)).toEqual([null]);
      const owner = await list(
        'owner',
        `/bases/${fx.baseId}/audit-logs?via=api_token&actor_id=${fx.users.u_editor.id}`,
      );
      expect(owner.items.map((item) => item.via?.api_token_id)).toEqual([tk.editor?.id]);
    });

    it('rejects more than 20 values, unknown groups and sources', async () => {
      const many = Array.from(
        { length: MAX_AUDIT_FILTER_VALUES + 1 },
        (_v, i) => `action=a.b${String(i)}`,
      ).join('&');
      for (const query of [many, 'action_prefix=records.', 'via=webhook', 'include=all']) {
        expectProblem(
          await fx.call('owner', 'GET', `/orgs/${fx.orgId}/audit-logs?${query}`),
          422,
          'VALIDATION_FAILED',
        );
      }
    });
  });

  describe('audit.viewed', () => {
    it('5 × "Load more" of one view → one audit.viewed; the same filters reordered → none', async () => {
      const before = (await auditRows('audit.viewed', fx.users.u_admin.id)).length;
      const url = `/bases/${fx.baseId}/audit-logs?action=record.updated&action=record.created&limit=1`;
      let page = await list('u_admin', url);
      for (let i = 0; i < 5; i += 1) {
        expect(page.next_cursor).not.toBeNull();
        page = await list('u_admin', `${url}&cursor=${page.next_cursor ?? ''}`);
      }
      expect(await auditRows('audit.viewed', fx.users.u_admin.id)).toHaveLength(before + 1);
      await list(
        'u_admin',
        `/bases/${fx.baseId}/audit-logs?action=record.created&action=record.updated&limit=7`,
      );
      expect(await auditRows('audit.viewed', fx.users.u_admin.id)).toHaveLength(before + 1);
      // Another view of the same scope is another entry.
      await list('u_admin', `/bases/${fx.baseId}/audit-logs?action=record.created`);
      const views = await auditRows('audit.viewed', fx.users.u_admin.id);
      expect(views).toHaveLength(before + 2);
      expect(views.every((row) => row.entity_type === 'base' && row.base_id === fx.baseId)).toBe(
        true,
      );
    });

    it('Valkey failing → the view is still written', async () => {
      const cache = t.app.get<Redis>(CACHE_CLIENT);
      const original = cache.set.bind(cache);
      const spy = vi.spyOn(cache, 'set').mockImplementation(((...args: unknown[]) => {
        if (String(args[0]).includes('audit:viewed:')) {
          return Promise.reject(new Error('valkey down'));
        }
        return (original as (...a: unknown[]) => Promise<unknown>)(...args);
      }) as typeof cache.set);
      try {
        const before = (await auditRows('audit.viewed', fx.users.owner.id)).length;
        await list('owner', `/orgs/${fx.orgId}/audit-logs?entity_type=automation`);
        await list('owner', `/orgs/${fx.orgId}/audit-logs?entity_type=automation`);
        expect(await auditRows('audit.viewed', fx.users.owner.id)).toHaveLength(before + 2);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('base export', () => {
    it('base admin → 202, CSV of that base only; others → 404; base_id in the body → 422', async () => {
      const exportUrl = `/bases/${fx.baseId}/audit-logs/export`;
      for (const user of ['u_editor', 'u_reader', 'u_out', 'stranger'] as const) {
        expectProblem(await fx.call(user, 'POST', exportUrl, { format: 'csv' }), 404, 'NOT_FOUND');
      }
      expectProblem(
        await fx.call('u_admin', 'POST', `/bases/${base2}/audit-logs/export`, { format: 'csv' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('u_admin', 'POST', exportUrl, {
          format: 'csv',
          filters: { base_id: base2 },
        }),
        422,
        'VALIDATION_FAILED',
      );
      const accepted = await fx.call('u_admin', 'POST', exportUrl, {
        format: 'csv',
        filters: { action_prefix: ['record.'] },
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
      const { job_id: jobId } = jobAcceptedSchema.parse(accepted.json());

      const exported = await auditRows('audit.exported', fx.users.u_admin.id);
      expect(exported).toHaveLength(1);
      expect(exported[0]).toMatchObject({
        entity_type: 'job',
        entity_id: jobId,
        base_id: fx.baseId,
        after: { format: 'csv', filters: { action_prefix: ['record.'], base_id: fx.baseId } },
      });

      worker ??= await createWorker(t.config, {
        logger: captureLogger().logger,
        pollIntervalMs: 100,
      });
      const done = await finishedJob(() => fx.call('u_admin', 'GET', `/jobs/${jobId}`));
      expect(done).toMatchObject({ type: 'audit.base_export', status: 'succeeded' });
      const downloadUrl = (done.result?.download_url as string).replace('/api/v1', '');
      const redirect = await fx.call('u_admin', 'GET', downloadUrl);
      expect(redirect.statusCode).toBe(302);
      const location = new URL(redirect.headers.location as string);
      const file = await t.app.inject({
        method: 'GET',
        url: `${location.pathname}${location.search}`,
      });
      expect(file.statusCode).toBe(200);
      const [header, ...lines] = file.body.slice(1).trim().split('\r\n');
      const columns = (header ?? '').split(',');
      const baseColumn = columns.indexOf('base_id');
      const actionColumn = columns.indexOf('action');
      expect(lines.length).toBe(done.result?.rows);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        // Quoted cells (JSON of `via`, `before`, `after`) may hold commas.
        const cells = line.replace(/"(?:[^"]|"")*"/g, '""').split(',');
        expect(cells[baseColumn]).toBe(fx.baseId);
        expect(cells[actionColumn]?.startsWith('record.')).toBe(true);
      }
      expect(file.body).not.toContain(table2);

      // The job and its file: org owners/admins and the creator while base admin; never others.
      expect((await fx.call('owner', 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
      for (const user of ['u_editor', 'stranger'] as const) {
        expectProblem(await fx.call(user, 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
        expectProblem(await fx.call(user, 'GET', downloadUrl), 404, 'NOT_FOUND');
      }
      // API tokens never see audit exports, not even their user's (T704).
      expectProblem(await bearer(tk.admin?.token ?? '', 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
      expectProblem(
        await bearer(tk.admin?.token ?? '', 'POST', exportUrl, { format: 'csv' }),
        403,
        'INSUFFICIENT_SCOPE',
      );
    });

    it('a creator who is no longer admin of the base loses the job and the file', async () => {
      const scope = orgScope(fx.orgId);
      const adminRole = (await new BaseRolesRepository(db).listByBase(scope, base2)).find(
        (role) => role.kind === 'system_admin',
      );
      const assignment = { principal_type: 'user', principal_id: fx.users.u_admin.id };
      const assigned = await fx.call('owner', 'PUT', `/bases/${base2}/role-assignments`, {
        ...assignment,
        role_id: adminRole?.id,
      });
      expect(assigned.statusCode, assigned.body).toBe(200);
      const accepted = await fx.call('u_admin', 'POST', `/bases/${base2}/audit-logs/export`, {
        format: 'csv',
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
      const { job_id: jobId } = jobAcceptedSchema.parse(accepted.json());
      worker ??= await createWorker(t.config, {
        logger: captureLogger().logger,
        pollIntervalMs: 100,
      });
      const done = await finishedJob(() => fx.call('u_admin', 'GET', `/jobs/${jobId}`));
      expect(done.status).toBe('succeeded');
      expect((await fx.call('u_admin', 'GET', `/files/exports/${jobId}`)).statusCode).toBe(302);

      const removed = await fx.call(
        'owner',
        'DELETE',
        `/bases/${base2}/role-assignments`,
        assignment,
      );
      expect(removed.statusCode, removed.body).toBeLessThan(300);
      expectProblem(await fx.call('u_admin', 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
      expectProblem(await fx.call('u_admin', 'GET', `/files/exports/${jobId}`), 404, 'NOT_FOUND');
      expect((await fx.call('owner', 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
    });

    it('needs the CSRF token with a session cookie', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: `/api/v1/bases/${fx.baseId}/audit-logs/export`,
        headers: { cookie: await fx.cookie('u_admin') },
        payload: { format: 'csv' },
      });
      expectProblem(response, 403, 'CSRF_INVALID');
    });
  });
});
