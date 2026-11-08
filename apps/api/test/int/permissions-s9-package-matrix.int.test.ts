import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  baseExportResultSchema,
  baseImportResultSchema,
  createdApiTokenSchema,
  jobAcceptedSchema,
  jobSchema,
  newId,
  type ApiTokenScope,
  type BaseImportResult,
  type CreatedApiToken,
  type Id,
  type JobDto,
} from '@cellhive/contracts';
import {
  AutomationsRepository,
  BaseRolesRepository,
  OrgMembersRepository,
  openBasePackage,
  orgScope,
  type BaseImportTarget,
  type Db,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedOrg, uniqueIp } from './auth-support.js';
import {
  buildPackage,
  leftovers,
  MULTIPART,
  multipart,
  P,
  pid,
  record,
  sha256,
  thingsTable,
  type PackageSpec,
} from './chbase-packages.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const MIB = 1024 * 1024;
const DAY = 86_400_000;
const EXPORT_SCOPES: ApiTokenScope[] = ['records:read', 'schema:read', 'automations:read'];
const IMPORT_SCOPES: ApiTokenScope[] = ['schema:write', 'records:write', 'automations:write'];
const SECRET_VALUE = 'Bearer s9-matrix-secret-value-0123456789';
const SECRET_NAME = 'CRM key (P124)';

/**
 * BACKLOG T1020 (CONTRACTS §5, "Phụ lục ma trận quyền S9" P119–P127): every
 * row of the `.chbase` matrix over HTTP on one stack — the permission
 * fixture of CONTRACTS §5 (base B, users, tokens), a second organization
 * with workspace W2 where u_admin is owner and u_sales1 a member (the
 * others are members of org 1 only), the real API and a real worker. The
 * package travels like a user's: exported by `POST /bases/B/export`,
 * downloaded through `GET /files/exports/:jobId` and its `302`, uploaded to
 * `POST /workspaces/:id/bases/import`; jobs are read with `GET /jobs/:id`.
 *
 * Each row is checked here on its main paths; the exhaustive cases stay in
 * the files of the tasks that built them, which `pnpm test:matrix` runs and
 * counts too:
 * - P119, P121 — `base-export.int.test.ts` (every missing scope, demoted
 *   creator, expiry, CLI);
 * - P120 — `base-export-demo.int.test.ts` (`seed:demo`: Telegram bot,
 *   incoming webhook, share links, every forbidden kind of id);
 * - P122, P123, P125, P127 — `base-import-matrix.int.test.ts` (upload
 *   errors, 19 poisoned packages, default block list, 60 MP image, CLI);
 * - P124 — `base-package-roundtrip.int.test.ts` (`seed:demo` into another
 *   organization and a new instance: bot, HTTP secret, sending identity,
 *   webhook, enabling → 422, no run);
 * - P126 — `base-import.int.test.ts` (WebSocket channel, failure after
 *   table 2 and after the files, cancel, a worker that dies).
 *
 * The API runs with `BASE_PACKAGE_MAX_BYTES` = 32 MiB.
 */
describe('permission matrix S9: .chbase packages over HTTP (P119–P127, T1020)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let tempRoot: string;
  let workspace: Id<'wsp'>;
  let foreignWorkspace: Id<'wsp'>;
  let org2: Id<'org'>;
  let w2: Id<'wsp'>;
  let base2: Id<'bse'>;
  let trashedRecord: Id<'rec'>;
  let personalView: Id<'viw'>;
  let automationId: Id<'aut'>;
  /** The package of B as downloaded by u_admin. */
  let packageOfB: Buffer;
  let exportJob: Id<'job'>;
  /** Stops the next import after its first table (P126). */
  let hold: { reached: (baseId: Id<'bse'>) => void; gate: Promise<void> } | null = null;
  const tk = {} as Record<
    'pkg_x' | 'admin_b2' | 'sales_r' | 'export_no_auto' | 'pkg_i' | 'import_no_records',
    CreatedApiToken
  >;

  async function finishedJob(read: () => Promise<LightMyRequestResponse>): Promise<JobDto> {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const response = await read();
      expect(response.statusCode, response.body).toBe(200);
      const job = jobSchema.parse(response.json());
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
      if (Date.now() > deadline) throw new Error(`job ${job.id} still ${job.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const jobOf = (jobId: Id<'job'>, reader: FixtureUser = 'owner') =>
    finishedJob(() => fx.call(reader, 'GET', `/jobs/${jobId}`));

  function bearer(
    token: CreatedApiToken,
    method: 'GET' | 'POST',
    url: string,
    payload?: Buffer | object,
    headers: Record<string, string> = {},
  ) {
    return t.app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: uniqueIp(),
      headers: { authorization: `Bearer ${token.token}`, ...headers },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function createToken(
    user: FixtureUser,
    scopes: ApiTokenScope[],
    baseIds: Id<'bse'>[] | null = null,
  ): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: `matrix ${scopes.join(' ')}`,
      scopes,
      base_ids: baseIds,
      expires_at: new Date(Date.now() + 90 * DAY).toISOString(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  function importAs(user: FixtureUser, bytes: Buffer, into: Id<'wsp'> = workspace) {
    return fx.call(
      user,
      'POST',
      `/workspaces/${into}/bases/import`,
      multipart('base.chbase', bytes),
      MULTIPART,
    );
  }

  async function accepted(response: LightMyRequestResponse, reader: FixtureUser = 'owner') {
    expect(response.statusCode, response.body).toBe(202);
    return jobOf(jobAcceptedSchema.parse(response.json()).job_id, reader);
  }

  async function imported(
    response: LightMyRequestResponse,
    reader: FixtureUser = 'owner',
  ): Promise<BaseImportResult & { jobId: Id<'job'> }> {
    const job = await accepted(response, reader);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    return { ...baseImportResultSchema.parse(job.result), jobId: job.id };
  }

  const snapshot = () => leftovers(db, { storage: t.storageRoot, temp: tempRoot });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({
      DATABASE_URL: database.url,
      BASE_PACKAGE_MAX_BYTES: String(32 * MIB),
    });
    fx = await buildRecordFixture(t, db);
    tempRoot = await mkdtemp(join(tmpdir(), 'cellhive-s9-package-matrix-'));
    const { logger } = captureLogger();
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db,
        logger,
        baseExport: { tempRoot },
        baseImport: {
          tempRoot,
          target: (own) => {
            const held = hold;
            hold = null;
            if (held === null) return own;
            return new Proxy(own, {
              get(target, key, receiver) {
                if (key === 'createTable') {
                  return async (
                    baseId: Id<'bse'>,
                    input: Parameters<BaseImportTarget['createTable']>[1],
                  ) => {
                    await target.createTable(baseId, input);
                    held.reached(baseId);
                    await held.gate;
                  };
                }
                const value: unknown = Reflect.get(target, key, receiver);
                return typeof value === 'function'
                  ? (value as (...args: unknown[]) => unknown).bind(target)
                  : value;
              },
            });
          },
        },
      }),
    });

    const base = await fx.call('owner', 'GET', `/bases/${fx.baseId}`);
    workspace = base.json<{ workspace_id: Id<'wsp'> }>().workspace_id;
    // u_admin: base admin (fixture) and workspace admin; u_editor: a plain workspace member.
    for (const [user, role] of [
      ['u_admin', 'admin'],
      ['u_editor', 'member'],
    ] as const) {
      const added = await fx.call('owner', 'POST', `/workspaces/${workspace}/members`, {
        principal_id: fx.users[user].id,
        role,
      });
      expect(added.statusCode, added.body).toBe(201);
    }
    const strangerOrg = (
      await db.kysely
        .selectFrom('meta.org_members')
        .select('organization_id')
        .where('user_id', '=', fx.users.stranger.id)
        .executeTakeFirstOrThrow()
    ).organization_id;
    const foreign = await fx.call('stranger', 'POST', `/orgs/${strangerOrg}/workspaces`, {
      name: 'Theirs',
    });
    expect(foreign.statusCode, foreign.body).toBe(201);
    foreignWorkspace = foreign.json<{ id: Id<'wsp'> }>().id;

    // B2: another base of the workspace, u_admin its admin too (`tk_admin_b2`).
    const second = await fx.call('owner', 'POST', `/workspaces/${workspace}/bases`, { name: 'B2' });
    expect(second.statusCode, second.body).toBe(201);
    base2 = second.json<{ id: Id<'bse'> }>().id;
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

    // What B holds (P120, P123): orders of sales1/sales2 with a cost, one in the trash,
    // u_editor's personal view, an HTTP secret named by an automation (P124).
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        { fields: { title: 'r1', amount: 100, cost: 60, owner: [{ id: fx.users.u_sales1.id }] } },
        { fields: { title: 'r2', amount: 200, cost: 90, owner: [{ id: fx.users.u_sales2.id }] } },
        { fields: { title: 'trashed', amount: 1, cost: 1 } },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    trashedRecord = created.json<{ records: { id: Id<'rec'> }[] }>().records[2]?.id ?? 'rec_x';
    const trashed = await fx.call('u_admin', 'DELETE', `/tables/${fx.orders.id}/records`, {
      ids: [trashedRecord],
    });
    expect(trashed.statusCode, trashed.body).toBeLessThan(300);
    const view = await fx.call('u_editor', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Mine (P120)',
      type: 'grid',
      is_personal: true,
    });
    expect(view.statusCode, view.body).toBe(201);
    personalView = view.json<{ id: Id<'viw'> }>().id;
    const secret = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'http_header',
      name: SECRET_NAME,
      value: SECRET_VALUE,
      allowed_hosts: ['api.crm.example.com'],
    });
    expect(secret.statusCode, secret.body).toBe(201);
    automationId = newId('aut');
    await new AutomationsRepository(db).insert(orgScope(fx.orgId), {
      id: automationId,
      baseId: fx.baseId,
      name: 'Send orders to the CRM',
      description: '',
      enabled: false,
      definition: {
        trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: false },
        condition: null,
        actions: [
          {
            id: 'act_http',
            type: 'http_request',
            config: {
              method: 'POST',
              url: { literal: 'https://api.crm.example.com/orders' },
              query: [],
              headers: [],
              auth: { header_name: 'Authorization', secret_id: secret.json<{ id: string }>().id },
              body: null,
              signing_secret_id: null,
              fail_on_http_error: true,
            },
          },
        ],
      },
      triggerType: 'record.created',
      triggerTableId: fx.orders.id,
      createdBy: fx.users.u_admin.id,
    });

    // Org 2 with W2: u_admin owner, u_sales1 member.
    org2 = await seedOrg(db, 'Org2');
    const members = new OrgMembersRepository(db);
    await members.add(orgScope(org2), fx.users.u_admin.id, 'owner');
    await members.add(orgScope(org2), fx.users.u_sales1.id, 'member');
    const created2 = await fx.call('u_admin', 'POST', `/orgs/${org2}/workspaces`, { name: 'W2' });
    expect(created2.statusCode, created2.body).toBe(201);
    w2 = created2.json<{ id: Id<'wsp'> }>().id;

    tk.pkg_x = await createToken('u_admin', EXPORT_SCOPES);
    tk.admin_b2 = await createToken('u_admin', EXPORT_SCOPES, [base2]);
    tk.sales_r = await createToken('u_sales1', ['records:read', 'schema:read']);
    tk.export_no_auto = await createToken('u_admin', ['records:read', 'schema:read']);
    tk.pkg_i = await createToken('u_admin', IMPORT_SCOPES);
    tk.import_no_records = await createToken('u_admin', ['schema:write', 'automations:write']);
  }, 240_000);

  afterAll(async () => {
    await (worker as WorkerHandle | undefined)?.close();
    await t.close();
    await db.destroy();
    await database.drop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe('P119 — POST /bases/B/export', () => {
    it('P119 u_admin (base admin) → 202; the package of the matrix', async () => {
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/export`);
      expect(response.statusCode, response.body).toBe(202);
      exportJob = jobAcceptedSchema.parse(response.json()).job_id;
      const job = await jobOf(exportJob, 'u_admin');
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    });

    it('P119 org owner (not a base member) and tk_pkg_x → 202', async () => {
      for (const response of [
        await fx.call('owner', 'POST', `/bases/${fx.baseId}/export`),
        await bearer(tk.pkg_x, 'POST', `/bases/${fx.baseId}/export`),
      ]) {
        const job = await accepted(response);
        expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      }
    });

    it('P119 u_editor, u_reader, u_sales1 → 403 PERMISSION_DENIED', async () => {
      for (const user of ['u_editor', 'u_reader', 'u_sales1'] as const) {
        expectProblem(
          await fx.call(user, 'POST', `/bases/${fx.baseId}/export`),
          403,
          'PERMISSION_DENIED',
        );
      }
    });

    it('P119 u_out, another organization, an unknown id, outside base_ids → 404 first', async () => {
      expectProblem(await fx.call('u_out', 'POST', `/bases/${fx.baseId}/export`), 404, 'NOT_FOUND');
      expectProblem(
        await fx.call('stranger', 'POST', `/bases/${fx.baseId}/export`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('owner', 'POST', `/bases/${newId('bse')}/export`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await bearer(tk.admin_b2, 'POST', `/bases/${fx.baseId}/export`),
        404,
        'NOT_FOUND',
      );
    });

    it('P119 a token lacking a scope → 403 INSUFFICIENT_SCOPE listing it', async () => {
      const salesR = await bearer(tk.sales_r, 'POST', `/bases/${fx.baseId}/export`);
      expectProblem(salesR, 403, 'INSUFFICIENT_SCOPE');
      expect(JSON.stringify(salesR.json())).toContain('automations:read');
      const noAuto = await bearer(tk.export_no_auto, 'POST', `/bases/${fx.baseId}/export`);
      expectProblem(noAuto, 403, 'INSUFFICIENT_SCOPE');
      expect(JSON.stringify(noAuto.json())).toContain('automations:read');
    });
  });

  describe('P121 — GET /jobs/:id, GET /files/exports/:jobId of the export', () => {
    it('P121 the creator → 200 and 302 to "B.chbase"; the package downloads over HTTP', async () => {
      const job = await finishedJob(() => fx.call('u_admin', 'GET', `/jobs/${exportJob}`));
      const result = baseExportResultSchema.parse(job.result);
      expect(result.download_url).toBe(`/api/v1/files/exports/${exportJob}`);
      const redirect = await fx.call('u_admin', 'GET', `/files/exports/${exportJob}`);
      expect(redirect.statusCode).toBe(302);
      const location = new URL(redirect.headers.location as string);
      const file = await t.app.inject({
        method: 'GET',
        url: `${location.pathname}${location.search}`,
      });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-disposition']).toContain('B.chbase');
      packageOfB = file.rawPayload;
      expect(packageOfB.length).toBe(result.size);
    });

    it('P121 the org owner → 200 and 302; u_editor, another organization → 404', async () => {
      expect((await fx.call('owner', 'GET', `/jobs/${exportJob}`)).statusCode).toBe(200);
      expect((await fx.call('owner', 'GET', `/files/exports/${exportJob}`)).statusCode).toBe(302);
      for (const user of ['u_editor', 'stranger'] as const) {
        expectProblem(await fx.call(user, 'GET', `/jobs/${exportJob}`), 404, 'NOT_FOUND');
        expectProblem(await fx.call(user, 'GET', `/files/exports/${exportJob}`), 404, 'NOT_FOUND');
      }
    });

    it("P121 the creator's token reaching B → 200; outside base_ids → 404", async () => {
      expect((await bearer(tk.pkg_x, 'GET', `/jobs/${exportJob}`)).statusCode).toBe(200);
      expectProblem(await bearer(tk.admin_b2, 'GET', `/jobs/${exportJob}`), 404, 'NOT_FOUND');
      expectProblem(
        await bearer(tk.admin_b2, 'GET', `/files/exports/${exportJob}`),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('P120 — what the package of B holds', () => {
    let texts: Map<string, string>;

    beforeAll(async () => {
      const path = join(tempRoot, 'p120.chbase');
      await writeFile(path, packageOfB);
      const reader = await openBasePackage(path);
      texts = new Map();
      try {
        await reader.verifyAll();
        for (const entry of reader.entries()) {
          if (entry.name.startsWith('files/att_')) continue;
          const chunks: Buffer[] = [];
          for await (const chunk of await reader.open(entry.name)) chunks.push(chunk as Buffer);
          texts.set(entry.name, Buffer.concat(chunks).toString('utf8'));
        }
      } finally {
        reader.close();
        await rm(path, { force: true });
      }
    });

    it('P120 cost is in the package: a base admin exports every field', () => {
      const orders = texts.get(`data/${fx.orders.id}.ndjson`) ?? '';
      expect(orders).toContain(`"${fx.fld['cost']?.id ?? 'missing'}":60`);
    });

    it('P120 no record of the trash, personal view, user id, token, secret value, group or hash', () => {
      const tokens = Object.values(tk).flatMap((token) => [token.id, token.token]);
      for (const [name, text] of texts) {
        expect(text, name).not.toContain(trashedRecord);
        expect(text, name).not.toContain(personalView);
        expect(text, name).not.toMatch(/(?:usr|tok|sec|grp|aud|evt|run|shl)_[0-9A-Za-z]{16}/u);
        expect(text, name).not.toContain(SECRET_VALUE);
        expect(text, name).not.toContain('g_sales');
        expect(text, name).not.toContain('$argon2');
        for (const value of tokens) expect(text, name).not.toContain(value);
      }
      // Users by email only.
      expect(texts.get(`data/${fx.orders.id}.ndjson`)).toContain(fx.users.u_sales1.email);
    });

    it('P120 the secret remains only as a name in `detached`', () => {
      const automations = texts.get('schema/automations.json') ?? '';
      expect(automations).toContain(SECRET_NAME);
      for (const [name, text] of texts) {
        if (name !== 'schema/automations.json') expect(text, name).not.toContain(SECRET_NAME);
      }
    });
  });

  describe('P122 — POST /workspaces/:id/bases/import', () => {
    it('P122 workspace admin (u_admin) → 202; the importer is the only owner, no role assigned', async () => {
      const result = await imported(await importAs('u_admin', packageOfB), 'u_admin');
      const base = await fx.call('u_admin', 'GET', `/bases/${result.base_id}`);
      expect(base.statusCode, base.body).toBe(200);
      expect(base.json<{ owner_id: string; workspace_id: string }>()).toMatchObject({
        owner_id: fx.users.u_admin.id,
        workspace_id: workspace,
      });
      const assigned = await db.kysely
        .selectFrom('meta.base_role_members')
        .select('principal_id')
        .where('base_id', '=', result.base_id)
        .execute();
      expect(assigned).toEqual([]);
      // Members of B who are not admins of the workspace do not reach the copy.
      for (const user of ['u_editor', 'u_reader', 'u_sales1'] as const) {
        expectProblem(await fx.call(user, 'GET', `/bases/${result.base_id}`), 404, 'NOT_FOUND');
      }
    });

    it('P122 organization owner and tk_pkg_i → 202', async () => {
      await imported(await importAs('owner', packageOfB));
      await imported(
        await bearer(
          tk.pkg_i,
          'POST',
          `/workspaces/${workspace}/bases/import`,
          multipart('base.chbase', packageOfB),
          MULTIPART,
        ),
      );
    });

    it('P122 plain member of the workspace → 403; another organization, an unknown id → 404', async () => {
      expectProblem(await importAs('u_editor', packageOfB), 403, 'PERMISSION_DENIED');
      expectProblem(await importAs('owner', packageOfB, foreignWorkspace), 404, 'NOT_FOUND');
      expectProblem(await importAs('owner', packageOfB, newId('wsp')), 404, 'NOT_FOUND');
    });

    it('P122 a token without records:write → 403 INSUFFICIENT_SCOPE listing it', async () => {
      const response = await bearer(
        tk.import_no_records,
        'POST',
        `/workspaces/${workspace}/bases/import`,
        multipart('base.chbase', packageOfB),
        MULTIPART,
      );
      expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
      expect(JSON.stringify(response.json())).toContain('records:write');
    });

    it('P122 GET /jobs/:id of the import: importer and org owner → 200; others → 404', async () => {
      const response = await importAs('u_admin', packageOfB);
      const jobId = jobAcceptedSchema.parse(response.json()).job_id;
      const job = await jobOf(jobId, 'u_admin');
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect((await fx.call('owner', 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
      for (const user of ['u_editor', 'u_sales1', 'stranger'] as const) {
        expectProblem(await fx.call(user, 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
      }
      // An import job has nothing to download.
      expectProblem(await fx.call('u_admin', 'GET', `/files/exports/${jobId}`), 404, 'NOT_FOUND');
    });
  });

  describe('P123 and P124 — the package of B imported into W2 (org 2)', () => {
    let result: BaseImportResult;

    beforeAll(async () => {
      result = await imported(await importAs('u_admin', packageOfB, w2), 'u_admin');
    });

    it('P123 u_sales1 (in both organizations) is matched; the others leave empty cells', async () => {
      const tables = await fx.call('u_admin', 'GET', `/bases/${result.base_id}/tables`);
      expect(tables.statusCode, tables.body).toBe(200);
      const orders = tables
        .json<{ items: { id: string; name: string }[] }>()
        .items.find((table) => table.name === 'Orders');
      const query = await fx.call('u_admin', 'POST', `/tables/${orders?.id ?? ''}/records/query`, {
        sort: [{ field: 'title', direction: 'asc' }],
      });
      expect(query.statusCode, query.body).toBe(200);
      const rows = query
        .json<{ records: { fields: Record<string, unknown> }[] }>()
        .records.map((row) => [row.fields['title'], row.fields['owner'], row.fields['cost']]);
      expect(rows).toEqual([
        ['r1', [expect.objectContaining({ id: fx.users.u_sales1.id })], 60],
        ['r2', null, 90],
      ]);
      expect(result.report.unmatched_user_emails).toContain(fx.users.u_sales2.email);
      expect(result.report.unmatched_user_emails).not.toContain(fx.users.u_sales1.email);
      expect(result.report.unmatched_user_emails).not.toContain(fx.users.u_admin.email);
    });

    it('P123 no id of B (tbl/fld/opt/rec/viw/rol/aut) in what the API answers about the copy', async () => {
      const sourceIds = new Set<string>([
        fx.baseId,
        fx.orders.id,
        fx.customers.id,
        fx.tickets.id,
        automationId,
        ...Object.values(fx.fld).map((field) => field.id),
      ]);
      const { rows } = await sql<{ id: string }>`
        SELECT __id AS id FROM ${sql.table(`data.${fx.orders.db_table_name}`)}
      `.execute(db.kysely);
      for (const row of rows) sourceIds.add(row.id);
      const answers: string[] = [];
      const tables = await fx.call('u_admin', 'GET', `/bases/${result.base_id}/tables`);
      answers.push(tables.body);
      for (const table of tables.json<{ items: { id: string }[] }>().items) {
        answers.push((await fx.call('u_admin', 'GET', `/tables/${table.id}/fields`)).body);
        answers.push((await fx.call('u_admin', 'GET', `/tables/${table.id}/views`)).body);
        answers.push(
          (await fx.call('u_admin', 'POST', `/tables/${table.id}/records/query`, {})).body,
        );
      }
      answers.push((await fx.call('u_admin', 'GET', `/bases/${result.base_id}/automations`)).body);
      answers.push((await fx.call('u_admin', 'GET', `/bases/${result.base_id}/roles`)).body);
      const text = answers.join('\n');
      expect([...sourceIds].filter((id) => text.includes(id))).toEqual([]);
      expect(sourceIds.size).toBeGreaterThan(10);
    });

    it('P124 the automation is off, runs as the importer, its secret reported by name', async () => {
      expect(result.report.automations_disabled).toBe(1);
      expect(result.report.secrets_to_reconnect).toEqual([
        {
          kind: 'secret',
          name: SECRET_NAME,
          automations: [
            { id: expect.stringMatching(/^aut_/u) as unknown, name: 'Send orders to the CRM' },
          ],
        },
      ]);
      const copy = result.report.secrets_to_reconnect[0]?.automations[0]?.id ?? 'aut_x';
      const automation = await fx.call('u_admin', 'GET', `/automations/${copy}`);
      expect(automation.statusCode, automation.body).toBe(200);
      expect(automation.json<{ enabled: boolean; run_as: { id: string } | null }>()).toMatchObject({
        enabled: false,
        run_as: { id: fx.users.u_admin.id },
      });
      expect(automation.body).not.toMatch(/sec_[0-9A-Za-z]{16}/u);
    });

    it('P124 turning it on before the secret is set again → 422; a new record runs nothing', async () => {
      const copy = result.report.secrets_to_reconnect[0]?.automations[0]?.id ?? 'aut_x';
      expectProblem(
        await fx.call('u_admin', 'POST', `/automations/${copy}/enable`),
        422,
        'AUTOMATION_INVALID',
      );
      const tables = await fx.call('u_admin', 'GET', `/bases/${result.base_id}/tables`);
      const orders = tables
        .json<{ items: { id: string; name: string }[] }>()
        .items.find((table) => table.name === 'Orders');
      const created = await fx.call('u_admin', 'POST', `/tables/${orders?.id ?? ''}/records`, {
        records: [{ fields: { title: 'after import' } }],
      });
      expect(created.statusCode, created.body).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const runs = await db.kysely
        .selectFrom('meta.automation_runs')
        .select('id')
        .where('automation_id', '=', copy)
        .execute();
      expect(runs).toEqual([]);
    });
  });

  describe('P125 — poisoned packages over HTTP', () => {
    const valid = (): PackageSpec => ({
      tables: [thingsTable()],
      records: { [P.things]: [record(pid('rec', 'One'), 1, { [P.name]: 'a' })] },
    });

    for (const [name, bytes, code] of [
      [
        'zip slip ../x',
        () => buildPackage({ ...valid(), raw: [{ name: '../x', data: Buffer.from('x') }] }),
        'UNSAFE_ENTRY',
      ],
      [
        'a checksum changed',
        () => buildPackage({ ...valid(), checksums: { 'schema/tables.json': '0'.repeat(64) } }),
        'CHECKSUM_MISMATCH',
      ],
      ['not a zip at all', () => Buffer.from('not a zip'), 'INVALID_ARCHIVE'],
    ] as const) {
      it(`P125 ${name} → failed INVALID_PACKAGE with the place in the package; nothing left`, async () => {
        const before = await snapshot();
        const job = await accepted(await importAs('u_admin', bytes()), 'u_admin');
        expect(job.status).toBe('failed');
        const error = job.error as { code: string; errors: { code: string; path: string }[] };
        expect(error.code).toBe('INVALID_PACKAGE');
        expect(error.errors.map((item) => item.code)).toContain(code);
        for (const item of error.errors) expect(item.path).not.toMatch(/\.\.|^\//u);
        const after = await snapshot();
        expect(after).toEqual(before);
        expect(after['hidden bases']).toBe(0);
      });
    }
  });

  describe('P126 — the base while it is imported', () => {
    it('P126 hidden: 404 for the importer and the org owner, in no list, until it is done', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<Id<'bse'>>((resolve) => {
        hold = { reached: resolve, gate };
      });
      const response = await importAs('u_admin', packageOfB);
      expect(response.statusCode, response.body).toBe(202);
      const jobId = jobAcceptedSchema.parse(response.json()).job_id;
      const hidden = await reached;
      try {
        const running = await fx.call('u_admin', 'GET', `/jobs/${jobId}`);
        expect(jobSchema.parse(running.json())).toMatchObject({ status: 'running', result: null });
        for (const user of ['u_admin', 'owner'] as const) {
          expectProblem(await fx.call(user, 'GET', `/bases/${hidden}`), 404, 'NOT_FOUND');
          for (const query of ['', '?include_deleted=true']) {
            const list = await fx.call(user, 'GET', `/workspaces/${workspace}/bases${query}`);
            expect(list.statusCode, list.body).toBe(200);
            expect(
              list.json<{ items: { id: string }[] }>().items.map((base) => base.id),
            ).not.toContain(hidden);
          }
        }
        expectProblem(
          await fx.call('u_admin', 'POST', `/bases/${hidden}/restore`),
          404,
          'NOT_FOUND',
        );
      } finally {
        release();
      }
      const job = await jobOf(jobId, 'u_admin');
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect(baseImportResultSchema.parse(job.result).base_id).toBe(hidden);
      expect((await fx.call('u_admin', 'GET', `/bases/${hidden}`)).statusCode).toBe(200);
    });
  });

  describe('P127 — files of a package', () => {
    it('P127 an .exe in a field with blocked_extensions [] is still refused; the cell keeps the rest', async () => {
      const one = pid('rec', 'One');
      const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
      const ok = Buffer.from('hello');
      const meta = (id: string, filename: string, mime: string, data: Buffer) => ({
        meta: {
          id,
          kind: 'cell',
          filename,
          mime,
          size: data.length,
          sha256: sha256(data),
          table_id: P.things,
          field_id: P.files,
          record_id: one,
        },
        data,
      });
      const att = { exe: pid('att', 'Exe'), ok: pid('att', 'Ok') };
      const result = await imported(
        await importAs(
          'u_admin',
          buildPackage({
            tables: [thingsTable()],
            records: {
              [P.things]: [
                record(one, 1, {
                  [P.name]: 'with files',
                  [P.files]: [att.exe, att.ok].map((id) => ({
                    id,
                    name: id,
                    size: 1,
                    mime: 'application/octet-stream',
                  })),
                }),
              ],
            },
            files: [
              meta(att.exe, 'setup.exe', 'application/x-msdownload', exe),
              meta(att.ok, 'ok.txt', 'text/plain', ok),
            ],
          }),
        ),
        'u_admin',
      );
      expect(result.report.files_skipped).toEqual([
        { filename: 'setup.exe', reason: 'blocked_file_type' },
      ]);
      expect(result.report.attachments).toBe(1);
      // Served like any file: the importer reads it, a member of the org without the base does not.
      const file = await db.kysely
        .selectFrom('meta.attachments')
        .select('id')
        .where('base_id', '=', result.base_id)
        .executeTakeFirstOrThrow();
      expect((await fx.call('u_admin', 'GET', `/files/${file.id}`)).statusCode).toBe(302);
      expectProblem(await fx.call('u_editor', 'GET', `/files/${file.id}`), 404, 'NOT_FOUND');
    });
  });
});
