import {
  auditLogListSchema,
  createdApiTokenSchema,
  createUploadResponseSchema,
  recordHistoryResponseSchema,
  type ApiTokenScope,
  type AuditLogEntryDto,
  type CreatedApiToken,
  type Id,
  type RecordHistoryEntry,
} from '@cellhive/contracts';
import {
  auditExportKey,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type FieldRow,
  type StorageDriver,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  relaxRateLimits,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import {
  captureLogger,
  problemOf,
  startTestApp,
  TEST_PUBLIC_URL,
  type TestApp,
} from './support.js';

import type { LightMyRequestResponse } from 'fastify';
import type { Readable } from 'node:stream';

const ALL_SCOPES: ApiTokenScope[] = [
  'records:read',
  'records:write',
  'schema:read',
  'schema:write',
  'automations:read',
  'automations:write',
];
const DAY = 86_400_000;
const BOUNDARY = 'cellhive-t705-boundary';
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function multipart(filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/csv\r\n\r\n',
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function textOf(stream: Readable | null): Promise<string> {
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream as Readable) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * BACKLOG T705 (ADR-36 §1, S6 decisions #5, #19, #20; CONTRACTS §11.1,
 * §11.4, §18–§21, §26.3; P59): the source of a change made through an API
 * token — actor = its user, `via.api_token_id` in audit, event and record
 * history, named only to organization owners/admins and the token owner —
 * and export, files, import and automations through a token. Public share
 * routes ignore `Authorization`.
 */
describe('API token sources (T705)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle | undefined;
  let files: FieldRow;
  const ids = {} as Record<'r1' | 'r2', Id<'rec'>>;
  const tk = {} as Record<'editor' | 'sales_r' | 'sales_w' | 'sales_r2' | 'admin', CreatedApiToken>;

  const orders = () => `/tables/${fx.orders.id}/records`;
  const history = (recordId: Id<'rec'>) => `${orders()}/${recordId}/history`;

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
      remoteAddress: uniqueIp(),
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  async function createToken(
    user: FixtureUser,
    name: string,
    scopes: ApiTokenScope[],
  ): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name,
      scopes,
      expires_at: new Date(Date.now() + 90 * DAY).toISOString(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  function expectScope(response: LightMyRequestResponse, required: string): void {
    expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
    const problem = problemOf(response.body) as {
      errors?: { code: string; params?: { required?: unknown } }[];
    };
    expect(problem.errors?.[0]).toMatchObject({ params: { required: [required] } });
  }

  async function historyAs(user: FixtureUser, recordId: Id<'rec'>) {
    const response = await fx.call(user, 'GET', history(recordId));
    expect(response.statusCode, response.body).toBe(200);
    return recordHistoryResponseSchema.parse(response.json()).items;
  }

  /** The newest history entry that changed `amount`. */
  const amountEntry = (items: RecordHistoryEntry[]) =>
    items.find((item) => 'amount' in item.changes);

  async function auditRows(where: { action: string; entityId?: string }) {
    const { rows } = await sql<{
      actor_type: string;
      actor_id: string | null;
      via: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>`
      SELECT actor_type, actor_id, via, after FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND action = ${where.action}
         AND (${where.entityId ?? null}::text IS NULL OR entity_id = ${where.entityId ?? null})
       ORDER BY created_at DESC, id DESC
    `.execute(db.kysely);
    return rows;
  }

  const startWorker = async () => {
    worker ??= await createWorker(t.config, {
      logger: captureLogger().logger,
      pollIntervalMs: 100,
    });
  };

  async function finishedJob(user: FixtureUser, jobId: string) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const job = (await fx.call(user, 'GET', `/jobs/${jobId}`)).json<{
        status: string;
        result: Record<string, unknown> | null;
        error: unknown;
      }>();
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
      if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    relaxRateLimits(t);
    fx = await buildRecordFixture(t, db);
    files = await t.app
      .get(SchemaService)
      .addField(
        orgScope(fx.orgId),
        fx.orders.id,
        { name: 'files', type: 'attachment', options: {} },
        systemAuditContext(),
      );
    const created = await fx.call('u_admin', 'POST', orders(), {
      records: [
        { fields: { title: 'r1', amount: 100, cost: 60, owner: [{ id: fx.users.u_sales1.id }] } },
        { fields: { title: 'r2', amount: 200, cost: 120, owner: [{ id: fx.users.u_sales2.id }] } },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    const [r1, r2] = created.json<{ records: { id: Id<'rec'> }[] }>().records;
    ids.r1 = r1?.id as Id<'rec'>;
    ids.r2 = r2?.id as Id<'rec'>;

    tk.editor = await createToken('u_editor', 'Editor CRM sync', ALL_SCOPES);
    tk.sales_r = await createToken('u_sales1', 'Sales reader', ['records:read', 'schema:read']);
    tk.sales_r2 = await createToken('u_sales1', 'Sales jobs', ['records:read']);
    tk.sales_w = await createToken('u_sales1', 'Sales writer', ['records:write']);
    tk.admin = await createToken('u_admin', 'Admin automation', ALL_SCOPES);
  });

  afterAll(async () => {
    await worker?.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('P59: record history', () => {
    beforeAll(async () => {
      const patched = await bearer(tk.editor.token, 'PATCH', orders(), {
        records: [{ id: ids.r1, fields: { amount: 150 } }],
      });
      expect(patched.statusCode, patched.body).toBe(200);
    });

    it('stores actor = u_editor and via.api_token_id in the audit entry and the event', async () => {
      const [entry] = await auditRows({ action: 'record.updated', entityId: ids.r1 });
      expect(entry).toMatchObject({
        actor_type: 'user',
        actor_id: fx.users.u_editor.id,
        via: { api_token_id: tk.editor.id },
      });
      const { rows: events } = await sql<{ actor_id: string; payload: { via?: unknown } }>`
        SELECT actor_id, payload FROM meta.events
         WHERE organization_id = ${fx.orgId} AND type = 'record.updated' AND entity_id = ${ids.r1}
         ORDER BY created_at DESC, id DESC LIMIT 1
      `.execute(db.kysely);
      expect(events[0]?.actor_id).toBe(fx.users.u_editor.id);
      expect(events[0]?.payload.via).toEqual({ api_token_id: tk.editor.id });
    });

    it('names the token to its owner (session and token) and to the organization owner', async () => {
      const shown = { api_token_id: tk.editor.id, api_token_name: 'Editor CRM sync' };
      for (const user of ['u_editor', 'owner'] as const) {
        const entry = amountEntry(await historyAs(user, ids.r1));
        expect(entry, user).toMatchObject({
          actor: { type: 'user', id: fx.users.u_editor.id },
          via: shown,
          changes: { amount: { from: 100, to: 150 } },
        });
        expect(entry?.actor.name, user).not.toBeNull();
      }
      const viaToken = await bearer(tk.editor.token, 'GET', history(ids.r1));
      expect(viaToken.statusCode, viaToken.body).toBe(200);
      expect(amountEntry(recordHistoryResponseSchema.parse(viaToken.json()).items)?.via).toEqual(
        shown,
      );
    });

    it('u_reader and the base admin see "an API token" without id or name', async () => {
      for (const user of ['u_reader', 'u_admin'] as const) {
        const entry = amountEntry(await historyAs(user, ids.r1));
        expect(entry?.actor.id, user).toBe(fx.users.u_editor.id);
        expect(entry?.via, user).toEqual({ api_token_id: null, api_token_name: null });
        const raw = JSON.stringify(await historyAs(user, ids.r1));
        expect(raw, user).not.toContain(tk.editor.id);
        expect(raw, user).not.toContain('Editor CRM sync');
      }
    });

    it('a renamed token shows its current name; a deleted one keeps the id without a name', async () => {
      const renamed = await fx.call('u_editor', 'PATCH', `/api-tokens/${tk.editor.id}`, {
        name: 'Editor CRM v2',
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(amountEntry(await historyAs('owner', ids.r1))?.via).toEqual({
        api_token_id: tk.editor.id,
        api_token_name: 'Editor CRM v2',
      });
      // A write through another token that is then deleted (cron cleanup).
      const gone = await createToken('u_editor', 'Short-lived', ['records:write']);
      const patched = await bearer(gone.token, 'PATCH', orders(), {
        records: [{ id: ids.r1, fields: { amount: 160 } }],
      });
      expect(patched.statusCode, patched.body).toBe(200);
      await sql`DELETE FROM meta.api_tokens WHERE id = ${gone.id}`.execute(db.kysely);
      for (const user of ['u_editor', 'owner'] as const) {
        expect(amountEntry(await historyAs(user, ids.r1))?.via, user).toEqual({
          api_token_id: gone.id,
          api_token_name: null,
        });
      }
      expect(amountEntry(await historyAs('u_reader', ids.r1))?.via).toEqual({
        api_token_id: null,
        api_token_name: null,
      });
    });

    it('a revert through a token carries both reverted_from and api_token_id', async () => {
      const entry = amountEntry(await historyAs('u_editor', ids.r1));
      const record = await fx.call('u_editor', 'GET', `${orders()}/${ids.r1}`);
      const version = record.json<{ version: number }>().version;
      const reverted = await bearer(tk.editor.token, 'POST', `${orders()}/${ids.r1}/revert`, {
        audit_id: entry?.id,
        version,
      });
      expect(reverted.statusCode, reverted.body).toBe(200);
      const [latest] = await historyAs('u_editor', ids.r1);
      expect(latest?.via).toEqual({
        reverted_from: entry?.id,
        api_token_id: tk.editor.id,
        api_token_name: 'Editor CRM v2',
      });
    });
  });

  describe('P59: audit log', () => {
    const entriesOf = (response: LightMyRequestResponse): AuditLogEntryDto[] => {
      expect(response.statusCode, response.body).toBe(200);
      return auditLogListSchema.parse(response.json()).items;
    };

    it('actor_id = u_editor lists the changes made through the token, named for the org owner', async () => {
      const items = entriesOf(
        await fx.call(
          'owner',
          'GET',
          `/orgs/${fx.orgId}/audit-logs?actor_id=${fx.users.u_editor.id}&action=record.updated`,
        ),
      );
      const viaToken = items.filter((item) => item.via?.api_token_id === tk.editor.id);
      expect(viaToken.length).toBeGreaterThanOrEqual(2);
      expect(viaToken[0]?.via?.api_token_name).toBe('Editor CRM v2');
      expect(viaToken.every((item) => item.actor.id === fx.users.u_editor.id)).toBe(true);
      const byVia = entriesOf(
        await fx.call('owner', 'GET', `/orgs/${fx.orgId}/audit-logs?via=api_token&include=refs`),
      );
      expect(byVia.length).toBeGreaterThan(0);
      expect(byVia.every((item) => item.via?.api_token_id !== undefined)).toBe(true);
    });

    it('a base admin who is not org admin sees only own tokens, in via and in refs', async () => {
      const own = await bearer(tk.admin.token, 'PATCH', orders(), {
        records: [{ id: ids.r2, fields: { amount: 210 } }],
      });
      expect(own.statusCode, own.body).toBe(200);
      const response = await fx.call(
        'u_admin',
        'GET',
        `/bases/${fx.baseId}/audit-logs?via=api_token&include=refs`,
      );
      const list = auditLogListSchema.parse(response.json());
      const editors = list.items.filter((item) => item.actor.id === fx.users.u_editor.id);
      const admins = list.items.filter((item) => item.actor.id === fx.users.u_admin.id);
      expect(editors.length).toBeGreaterThan(0);
      for (const item of editors) {
        expect(item.via).toMatchObject({ api_token_id: null, api_token_name: null });
      }
      expect(admins[0]?.via).toEqual({
        api_token_id: tk.admin.id,
        api_token_name: 'Admin automation',
      });
      expect(Object.keys(list.refs?.api_tokens ?? {})).toEqual([tk.admin.id]);
      expect(response.body).not.toContain(tk.editor.id);
      // The organization owner sees both.
      const owner = entriesOf(
        await fx.call('owner', 'GET', `/bases/${fx.baseId}/audit-logs?via=api_token`),
      );
      expect(owner.some((item) => item.via?.api_token_id === tk.editor.id)).toBe(true);
    });

    it('the base audit export writes the via column with the same rule', async () => {
      await startWorker();
      const exportAs = async (user: FixtureUser) => {
        const started = await fx.call(user, 'POST', `/bases/${fx.baseId}/audit-logs/export`, {
          format: 'csv',
          filters: { via: ['api_token'] },
        });
        expect(started.statusCode, started.body).toBe(202);
        const jobId = started.json<{ job_id: Id<'job'> }>().job_id;
        const job = await finishedJob(user, jobId);
        expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
        const storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
        return textOf(await storage.getStream(auditExportKey(fx.orgId, jobId)));
      };
      const adminCsv = await exportAs('u_admin');
      expect(adminCsv).toContain(tk.admin.id);
      expect(adminCsv).not.toContain(tk.editor.id);
      expect(adminCsv).not.toContain('Editor CRM');
      expect(adminCsv).toContain('""api_token_id"":null');
      const ownerCsv = await exportAs('owner');
      expect(ownerCsv).toContain(tk.editor.id);
      expect(ownerCsv).toContain('Editor CRM v2');
    });
  });

  describe('P59: export through a token', () => {
    it('tk_sales_r (records:read, download = false) → 403, like the session', async () => {
      expectProblem(
        await bearer(tk.sales_r.token, 'GET', `/tables/${fx.orders.id}/export`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/export`),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('tk_editor → the CSV of u_editor, export.created carries via', async () => {
      const viaToken = await bearer(tk.editor.token, 'GET', `/tables/${fx.orders.id}/export`);
      expect(viaToken.statusCode, viaToken.body).toBe(200);
      expect(viaToken.headers['content-type']).toContain('text/csv');
      const session = await fx.call('u_editor', 'GET', `/tables/${fx.orders.id}/export`);
      expect(viaToken.body).toBe(session.body);
      expect(viaToken.body.split('\r\n')[0]).toContain('cost');
      const [sessionAudit, viaTokenAudit] = await auditRows({ action: 'export.created' });
      expect(sessionAudit).toMatchObject({ actor_id: fx.users.u_editor.id, via: null });
      expect(viaTokenAudit).toMatchObject({
        actor_type: 'user',
        actor_id: fx.users.u_editor.id,
        via: { api_token_id: tk.editor.id },
        after: { format: 'csv' },
      });
    });

    it('a token without records:read cannot export', async () => {
      expectScope(
        await bearer(tk.sales_w.token, 'GET', `/tables/${fx.orders.id}/export`),
        'records:read',
      );
    });
  });

  describe('files through a token', () => {
    let fileId: Id<'att'>;

    it('upload needs records:write; the cell write carries via', async () => {
      const body = {
        table_id: fx.orders.id,
        field_id: files.id,
        filename: 'contract.pdf',
        size: PDF.length,
        mime: 'application/pdf',
      };
      expectScope(await bearer(tk.sales_r.token, 'POST', '/files/uploads', body), 'records:write');
      const started = await bearer(tk.editor.token, 'POST', '/files/uploads', body);
      expect(started.statusCode, started.body).toBe(201);
      const { id, upload } = createUploadResponseSchema.parse(started.json());
      const url = new URL(upload.url);
      expect(url.origin).toBe(TEST_PUBLIC_URL);
      const put = await t.app.inject({
        method: 'PUT',
        url: url.pathname + url.search,
        headers: upload.headers,
        payload: PDF,
      });
      expect(put.statusCode).toBe(200);
      const done = await bearer(tk.editor.token, 'POST', `/files/uploads/${id}/complete`);
      expect(done.statusCode, done.body).toBe(200);
      const written = await bearer(tk.editor.token, 'PATCH', `${orders()}?field_key_type=id`, {
        records: [{ id: ids.r1, fields: { [files.id]: [{ id }] } }],
      });
      expect(written.statusCode, written.body).toBe(200);
      fileId = id;
    });

    it('download needs records:read + file_download_fields', async () => {
      // u_sales1 reads r1 but the Sales role has no file_download_fields.
      expectProblem(
        await bearer(tk.sales_r.token, 'GET', `/files/${fileId}`),
        403,
        'PERMISSION_DENIED',
      );
      expectScope(await bearer(tk.sales_w.token, 'GET', `/files/${fileId}`), 'records:read');
      const editor = await bearer(tk.editor.token, 'GET', `/files/${fileId}`);
      expect(editor.statusCode, editor.body).toBe(302);
      // Not an image: no thumbnail, whoever asks.
      expectProblem(
        await bearer(tk.editor.token, 'GET', `/files/${fileId}/thumbnail`),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('import through a token', () => {
    const upload = (token: string, bytes: Buffer) =>
      bearer(token, 'POST', `/bases/${fx.baseId}/imports/uploads`, multipart('o.csv', bytes), {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      });

    it('creating a table needs schema:write on top of records:write', async () => {
      const file = await upload(tk.sales_w.token, Buffer.from('title\r\nA\r\n'));
      expect(file.statusCode, file.body).toBe(201);
      const response = await bearer(tk.sales_w.token, 'POST', `/bases/${fx.baseId}/imports`, {
        upload_id: file.json<{ id: string }>().id,
        mode: 'create_table',
        table: { name: 'Imported', columns: [{ column: 0, name: 'title', type: 'text' }] },
      });
      expectScope(response, 'schema:write');
    });

    it('appends with records:write; another token of the user reads the job; writes carry via', async () => {
      await startWorker();
      const writer = await createToken('u_editor', 'Editor import', ['records:write']);
      const reader = await createToken('u_editor', 'Editor jobs', ['records:read']);
      const file = await upload(writer.token, Buffer.from('title\r\nFrom token\r\n'));
      expect(file.statusCode, file.body).toBe(201);
      const started = await bearer(writer.token, 'POST', `/bases/${fx.baseId}/imports`, {
        upload_id: file.json<{ id: string }>().id,
        mode: 'append',
        table_id: fx.orders.id,
        mapping: [{ column: 0, field_id: fx.fld['title']?.id }],
      });
      expect(started.statusCode, started.body).toBe(202);
      const jobId = started.json<{ job_id: Id<'job'> }>().job_id;
      // `meta.jobs.created_by` is the user: any token of the user reads it, others' do not.
      expect((await bearer(reader.token, 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
      expectProblem(await bearer(tk.sales_r2.token, 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
      const job = await finishedJob('u_editor', jobId);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      const { rows } = await sql<{ actor_id: string; via: unknown }>`
        SELECT actor_id, via FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND action = 'record.created' AND batch_id = ${jobId}
      `.execute(db.kysely);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        actor_id: fx.users.u_editor.id,
        via: { import_job_id: jobId, api_token_id: writer.id },
      });
    });
  });

  describe('automations through a token', () => {
    it('run_as is the token user; automation.run_as_changed carries via', async () => {
      const created = await bearer(tk.admin.token, 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Via token',
        definition: {
          trigger: { type: 'record.created', table_id: fx.orders.id },
          actions: [
            {
              id: 'act_1',
              type: 'update_record',
              config: {
                table_id: fx.orders.id,
                fields: { [fx.fld['amount']?.id as string]: { literal: 1 } },
              },
            },
          ],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const automation = created.json<{ id: Id<'aut'>; run_as: { id: string } | null }>();
      expect(automation.run_as?.id).toBe(fx.users.u_admin.id);
      for (const action of ['automation.created', 'automation.run_as_changed']) {
        const [entry] = await auditRows({ action, entityId: automation.id });
        expect(entry, action).toMatchObject({
          actor_type: 'user',
          actor_id: fx.users.u_admin.id,
          via: { api_token_id: tk.admin.id },
        });
      }
      expectScope(
        await bearer(tk.sales_r.token, 'PATCH', `/automations/${automation.id}`, { name: 'x' }),
        'automations:write',
      );
    });
  });

  describe('field conversions started through a token (async jobs)', () => {
    it('a type change: field.converted carries via.api_token_id', async () => {
      await startWorker();
      const added = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'score',
        type: 'number',
      });
      expect(added.statusCode, added.body).toBe(201);
      const fieldId = added.json<{ id: Id<'fld'> }>().id;
      const put = await bearer(tk.admin.token, 'PUT', `/fields/${fieldId}`, { type: 'text' });
      expect(put.statusCode, put.body).toBe(202);
      const jobId = put.json<{ job_id: Id<'job'> | null }>().job_id;
      expect(jobId).not.toBeNull();
      const job = await finishedJob('u_admin', jobId as string);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      const [converted] = await auditRows({ action: 'field.converted', entityId: fieldId });
      expect(converted).toMatchObject({
        actor_type: 'user',
        actor_id: fx.users.u_admin.id,
        via: { api_token_id: tk.admin.id },
      });
    });

    it('a link to_single: the cut cells carry via in audit and history, masked for others', async () => {
      await startWorker();
      const added = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      });
      expect(added.statusCode, added.body).toBe(201);
      const fieldId = added.json<{ id: Id<'fld'> }>().id;
      const customers = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Bình Minh' } }],
      });
      expect(customers.statusCode, customers.body).toBe(201);
      const [c1, c2] = customers.json<{ records: { id: Id<'rec'> }[] }>().records;
      const linked = await fx.call('u_admin', 'PATCH', `${orders()}?field_key_type=id`, {
        records: [{ id: ids.r2, fields: { [fieldId]: [{ id: c1?.id }, { id: c2?.id }] } }],
      });
      expect(linked.statusCode, linked.body).toBe(200);
      const put = await bearer(tk.admin.token, 'PUT', `/fields/${fieldId}`, {
        type: 'link',
        options: { allow_multiple: false },
        confirm: true,
      });
      expect(put.statusCode, put.body).toBe(202);
      const jobId = put.json<{ job_id: Id<'job'> }>().job_id;
      const job = await finishedJob('u_admin', jobId);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      const { rows } = await sql<{ entity_id: string; actor_id: string; via: unknown }>`
        SELECT entity_id, actor_id, via FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND action = 'record.updated' AND batch_id = ${jobId}
      `.execute(db.kysely);
      expect(rows).toEqual([
        { entity_id: ids.r2, actor_id: fx.users.u_admin.id, via: { api_token_id: tk.admin.id } },
      ]);
      const [converted] = await auditRows({ action: 'field.converted', entityId: fieldId });
      expect(converted?.via).toEqual({ api_token_id: tk.admin.id });
      const cutOf = (items: RecordHistoryEntry[]) =>
        items.find((item) => 'customer' in item.changes);
      expect(cutOf(await historyAs('u_admin', ids.r2))?.via).toEqual({
        api_token_id: tk.admin.id,
        api_token_name: 'Admin automation',
      });
      expect(cutOf(await historyAs('u_reader', ids.r2))?.via).toEqual({
        api_token_id: null,
        api_token_name: null,
      });
    });
  });

  describe('auto-follow (CONTRACTS §22.5)', () => {
    const followsOf = async (recordId: Id<'rec'>) =>
      (
        await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM meta.record_follows
           WHERE record_id = ${recordId} AND user_id = ${fx.users.u_editor.id}
        `.execute(db.kysely)
      ).rows[0]?.n;
    const createOne = async (response: Promise<LightMyRequestResponse>) => {
      const created = await response;
      expect(created.statusCode, created.body).toBe(201);
      return created.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
    };

    it('creating one record through a token does not follow it; by hand it does', async () => {
      const byHand = await createOne(
        fx.call('u_editor', 'POST', orders(), { records: [{ fields: { title: 'mine' } }] }),
      );
      expect(await followsOf(byHand)).toBe(1);
      const byToken = await createOne(
        bearer(tk.editor.token, 'POST', orders(), { records: [{ fields: { title: 'sync' } }] }),
      );
      expect(await followsOf(byToken)).toBe(0);
    });
  });

  describe('public share routes ignore Bearer (lock)', () => {
    let publicToken: string;
    let orgToken: string;
    let unused: CreatedApiToken;

    beforeAll(async () => {
      // One link per view (a new one replaces it): a view of each table.
      const link = async (tableId: Id<'tbl'>, audience: 'public' | 'org') => {
        const views = await fx.call('owner', 'GET', `/tables/${tableId}/views`);
        const viewId = views.json<{ items: { id: Id<'viw'> }[] }>().items[0]?.id as Id<'viw'>;
        const response = await fx.call('owner', 'POST', `/views/${viewId}/share-links`, {
          audience,
        });
        expect(response.statusCode, response.body).toBe(201);
        return response.json<{ token: string }>().token;
      };
      publicToken = await link(fx.orders.id, 'public');
      orgToken = await link(fx.customers.id, 'org');
      unused = await createToken('u_sales1', 'Never used', ['records:read']);
    });

    it('a public link opens with any Bearer, as for an anonymous reader', async () => {
      const anonymous = await t.app.inject({
        method: 'GET',
        url: `/api/v1/shares/${publicToken}/meta`,
      });
      expect(anonymous.statusCode, anonymous.body).toBe(200);
      for (const authorization of [`Bearer ${tk.editor.token}`, 'Bearer cht_nonsense']) {
        const response = await t.app.inject({
          method: 'GET',
          url: `/api/v1/shares/${publicToken}/meta`,
          remoteAddress: uniqueIp(),
          headers: { authorization },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['www-authenticate']).toBeUndefined();
        expect(response.json()).toEqual(anonymous.json());
      }
    });

    it('an org link is 401 with only a Bearer of a member, and the token is not used', async () => {
      const response = await bearer(unused.token, 'GET', `/shares/${orgToken}/meta`);
      expectProblem(response, 401, 'UNAUTHENTICATED');
      expect(response.headers['www-authenticate']).toBeUndefined();
      const used = await sql<{ last_used_at: Date | null }>`
        SELECT last_used_at FROM meta.api_tokens WHERE id = ${unused.id}
      `.execute(db.kysely);
      expect(used.rows[0]?.last_used_at).toBeNull();
      // The session of the same member opens it.
      expect((await fx.call('u_sales1', 'GET', `/shares/${orgToken}/meta`)).statusCode).toBe(200);
    });
  });
});
