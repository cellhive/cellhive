import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  baseImportResultSchema,
  createdApiTokenSchema,
  jobAcceptedSchema,
  jobSchema,
  type ApiTokenScope,
  type BaseImportResult,
  type CreatedApiToken,
  type Id,
  type JobDto,
} from '@cellhive/contracts';
import {
  basePackageKey,
  createStorageDriver,
  OrgMembersRepository,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type Env,
  type StorageDriver,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { runCli } from '../../src/cli/run.js';

import { Browser, seedOrg, seedUser, uniqueIp, type SeededUser } from './auth-support.js';
import {
  buildPackage,
  buildZip,
  field,
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
import { captureLogger, startTestApp, TEST_SESSION_SECRET, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const MIB = 1024 * 1024;
const DAY = 86_400_000;
const IMPORT_SCOPES: ApiTokenScope[] = ['schema:write', 'records:write', 'automations:write'];
const MAX_FIELDS = 30;
const MAX_FILE = 4096;

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

/** A PNG header of `width × height` (no image data: a decoder refuses it, a sniff accepts it). */
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdr,
    Buffer.alloc(4),
  ]);
}

/**
 * BACKLOG T1018 (CONTRACTS §12.2, §5 P122, P123, P125, P127): `POST
 * /workspaces/:id/bases/import` and the `base.import` job on the permission
 * fixture of CONTRACTS §5 — who may import (sessions and API tokens, `404`
 * before `403`, one case per missing scope), users matched by email in
 * another organization, poisoned packages (each fails `INVALID_PACKAGE` and
 * leaves no base, `data.*` table, stored object or meta row behind), files
 * and the default block list, and `cellhive base import`. The API runs with
 * `BASE_PACKAGE_MAX_BYTES` = 32 MiB, `MAX_FIELDS_PER_TABLE` = 30 and
 * `ATTACHMENT_MAX_FILE_BYTES` = 4 KiB.
 */
describe('base import matrix (T1018)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let storage: StorageDriver;
  let tempRoot: string;
  let workspaceId: Id<'wsp'>;
  let foreignWorkspace: Id<'wsp'>;
  let packageOfB: Buffer;
  let orgAdmin: { user: SeededUser; browser: Browser };
  const tk = {} as Record<
    'pkg_i' | 'no_schema' | 'no_records' | 'no_automations' | 'no_request' | 'limited',
    CreatedApiToken
  >;

  const jobOf = (jobId: Id<'job'>, reader: FixtureUser = 'owner') =>
    finishedJob(() => fx.call(reader, 'GET', `/jobs/${jobId}`));

  function importAs(
    user: FixtureUser,
    bytes: Buffer,
    into: Id<'wsp'> = workspaceId,
    filename = 'base.chbase',
  ): Promise<LightMyRequestResponse> {
    return fx.call(
      user,
      'POST',
      `/workspaces/${into}/bases/import`,
      multipart(filename, bytes),
      MULTIPART,
    );
  }

  function bearer(token: CreatedApiToken, bytes: Buffer, into: Id<'wsp'> = workspaceId) {
    return t.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${into}/bases/import`,
      remoteAddress: uniqueIp(),
      headers: { authorization: `Bearer ${token.token}`, ...MULTIPART },
      payload: multipart('base.chbase', bytes),
    });
  }

  async function accepted(
    response: LightMyRequestResponse,
    reader: FixtureUser = 'owner',
  ): Promise<JobDto> {
    expect(response.statusCode, response.body).toBe(202);
    return jobOf(jobAcceptedSchema.parse(response.json()).job_id, reader);
  }

  async function succeeded(
    response: LightMyRequestResponse,
    reader: FixtureUser = 'owner',
  ): Promise<BaseImportResult> {
    const job = await accepted(response, reader);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    return baseImportResultSchema.parse(job.result);
  }

  async function createToken(
    user: FixtureUser,
    scopes: ApiTokenScope[],
    baseIds: Id<'bse'>[] | null = null,
  ): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: `import ${scopes.join(' ')}`,
      scopes,
      base_ids: baseIds,
      expires_at: new Date(Date.now() + 90 * DAY).toISOString(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  const snapshot = () => leftovers(db, { storage: t.storageRoot, temp: tempRoot });

  async function expectNothingLeft(before: Record<string, unknown>) {
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after['hidden bases']).toBe(0);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({
      DATABASE_URL: database.url,
      BASE_PACKAGE_MAX_BYTES: String(32 * MIB),
      MAX_FIELDS_PER_TABLE: String(MAX_FIELDS),
      ATTACHMENT_MAX_FILE_BYTES: String(MAX_FILE),
    });
    fx = await buildRecordFixture(t, db);
    storage = createStorageDriver(t.config);
    tempRoot = await mkdtemp(join(tmpdir(), 'cellhive-base-import-matrix-'));
    const { logger } = captureLogger();
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db,
        logger,
        baseExport: { tempRoot },
        baseImport: { tempRoot },
      }),
    });

    const base = await fx.call('owner', 'GET', `/bases/${fx.baseId}`);
    workspaceId = base.json<{ workspace_id: Id<'wsp'> }>().workspace_id;
    // u_admin: workspace admin; u_editor: a plain member of the workspace.
    for (const [user, role] of [
      ['u_admin', 'admin'],
      ['u_editor', 'member'],
    ] as const) {
      const added = await fx.call('owner', 'POST', `/workspaces/${workspaceId}/members`, {
        principal_id: fx.users[user].id,
        role,
      });
      expect(added.statusCode, added.body).toBe(201);
    }
    const adminUser = await seedUser(db, { memberships: [{ orgId: fx.orgId, role: 'admin' }] });
    const browser = new Browser(t.app);
    expect((await browser.login(adminUser.email)).statusCode).toBe(204);
    orgAdmin = { user: adminUser, browser };
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

    // The package of B: users of the fixture as cell values and creators.
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        { fields: { title: 'r1', amount: 100, owner: [{ id: fx.users.u_sales1.id }] } },
        { fields: { title: 'r2', amount: 200, owner: [{ id: fx.users.u_sales2.id }] } },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    const byEditor = await fx.call('u_editor', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [{ fields: { title: 'r3' } }],
    });
    expect(byEditor.statusCode, byEditor.body).toBe(201);
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'reviewer',
        type: 'user',
        options: { multiple: true, default_value: [{ id: fx.users.u_sales2.id }] },
      },
      systemAuditContext(),
    );
    await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'due',
        type: 'datetime',
        options: {
          reminder: { offset_minutes: 0, recipients: 'users', user_ids: [fx.users.u_sales2.id] },
        },
      },
      systemAuditContext(),
    );
    const exported = await fx.call('owner', 'POST', `/bases/${fx.baseId}/export`);
    const exportJob = await accepted(exported);
    expect(exportJob.status, JSON.stringify(exportJob.error)).toBe('succeeded');
    const stream = await storage.getStream(basePackageKey(fx.orgId, exportJob.id));
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    packageOfB = Buffer.concat(chunks);

    tk.pkg_i = await createToken('u_admin', IMPORT_SCOPES);
    tk.no_schema = await createToken('u_admin', ['records:write', 'automations:write']);
    tk.no_records = await createToken('u_admin', ['schema:write', 'automations:write']);
    tk.no_automations = await createToken('u_admin', ['schema:write', 'records:write']);
    tk.no_request = await createToken('u_admin', ['schema:write']);
    tk.limited = await createToken('u_admin', IMPORT_SCOPES, [fx.baseId]);
  }, 240_000);

  afterAll(async () => {
    await (worker as WorkerHandle | undefined)?.close();
    await storage.close();
    await t.close();
    await db.destroy();
    await database.drop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe('P122 — POST /workspaces/W/bases/import', () => {
    it('P122 workspace admin (u_admin) → 202; the importer is the only owner, no role assigned', async () => {
      const result = await succeeded(await importAs('u_admin', packageOfB));
      const base = await db.kysely
        .selectFrom('meta.bases')
        .selectAll()
        .where('id', '=', result.base_id)
        .executeTakeFirstOrThrow();
      expect(base).toMatchObject({
        owner_id: fx.users.u_admin.id,
        workspace_id: workspaceId,
        deleted_at: null,
        import_job_id: null,
      });
      const members = await db.kysely
        .selectFrom('meta.base_role_members')
        .selectAll()
        .where('base_id', '=', result.base_id)
        .execute();
      expect(members).toEqual([]);
      const roles = await db.kysely
        .selectFrom('meta.base_roles')
        .select('kind')
        .where('base_id', '=', result.base_id)
        .execute();
      // The custom role of B (Sales) comes too (T1019), given to nobody.
      expect(roles.map((role) => role.kind).sort()).toEqual([
        'custom',
        'system_admin',
        'system_editor',
        'system_reader',
      ]);
      // Base admins of the source (u_reader reads B) see nothing of the new base.
      expectProblem(await fx.call('u_reader', 'GET', `/bases/${result.base_id}`), 404, 'NOT_FOUND');
    });

    it('P122 organization owner → 202', async () => {
      await succeeded(await importAs('owner', packageOfB));
    });

    it('P122 organization admin → 202', async () => {
      const response = await orgAdmin.browser.request({
        method: 'POST',
        url: `/api/v1/workspaces/${workspaceId}/bases/import`,
        payload: multipart('base.chbase', packageOfB),
        headers: MULTIPART,
      });
      const result = await succeeded(response);
      const base = await db.kysely
        .selectFrom('meta.bases')
        .select('owner_id')
        .where('id', '=', result.base_id)
        .executeTakeFirstOrThrow();
      expect(base.owner_id).toBe(orgAdmin.user.id);
    });

    it('P122 plain member of the workspace (u_editor) → 403 PERMISSION_DENIED', async () => {
      expectProblem(await importAs('u_editor', packageOfB), 403, 'PERMISSION_DENIED');
    });

    it('P122 member who sees the workspace through a base only (u_reader) → 403', async () => {
      expectProblem(await importAs('u_reader', packageOfB), 403, 'PERMISSION_DENIED');
    });

    it('P122 workspace of another organization → 404', async () => {
      expectProblem(await importAs('u_admin', packageOfB, foreignWorkspace), 404, 'NOT_FOUND');
      expectProblem(await importAs('stranger', packageOfB), 404, 'NOT_FOUND');
    });

    it('P122 unknown workspace id → 404', async () => {
      expectProblem(await importAs('owner', packageOfB, 'wsp_0000000000000000'), 404, 'NOT_FOUND');
    });

    it('P122 tk_pkg_i (schema:write + records:write + automations:write) → 202', async () => {
      const result = await succeeded(await bearer(tk.pkg_i, packageOfB));
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['actor_id', 'via'])
        .where('action', '=', 'base.imported')
        .where('base_id', '=', result.base_id)
        .executeTakeFirstOrThrow();
      expect(audit).toEqual({ actor_id: fx.users.u_admin.id, via: { api_token_id: tk.pkg_i.id } });
    });

    for (const [token, required] of [
      ['no_schema', ['schema:write']],
      ['no_records', ['records:write']],
      ['no_automations', ['automations:write']],
      ['no_request', ['records:write', 'automations:write']],
    ] as const) {
      it(`P122 token without ${required.join(', ')} → 403 INSUFFICIENT_SCOPE listing it`, async () => {
        const response = await bearer(tk[token], packageOfB);
        expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
        expect(response.json<{ errors: { params: unknown }[] }>().errors[0]?.params).toEqual({
          required,
        });
      });
    }

    it('P122 a token without schema:write on a workspace out of its reach → 404 first', async () => {
      expectProblem(await bearer(tk.no_schema, packageOfB, foreignWorkspace), 404, 'NOT_FOUND');
      expectProblem(await bearer(tk.pkg_i, packageOfB, foreignWorkspace), 404, 'NOT_FOUND');
    });

    it('P122 a token limited to some bases → 403 PERMISSION_DENIED', async () => {
      expectProblem(await bearer(tk.limited, packageOfB), 403, 'PERMISSION_DENIED');
    });

    it('P122 the upload: .chbase only (415), multipart only (415), a file part (422), the cap (413)', async () => {
      const before = await snapshot();
      expectProblem(
        await importAs('owner', packageOfB, workspaceId, 'base.zip'),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
      expectProblem(
        await fx.call('owner', 'POST', `/workspaces/${workspaceId}/bases/import`, { a: 1 }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
      const noFile = await fx.call(
        'owner',
        'POST',
        `/workspaces/${workspaceId}/bases/import`,
        Buffer.from(
          '--cellhive-base-import-boundary\r\nContent-Disposition: form-data; name="x"\r\n\r\n' +
            'y\r\n--cellhive-base-import-boundary--\r\n',
        ),
        MULTIPART,
      );
      expectProblem(noFile, 422, 'VALIDATION_FAILED');
      expect(noFile.json<{ errors: { code: string }[] }>().errors[0]?.code).toBe('FILE_REQUIRED');
      const big = await importAs('owner', Buffer.alloc(32 * MIB + 1, 0x61));
      expectProblem(big, 413, 'PAYLOAD_TOO_LARGE');
      expect(big.json<{ errors: unknown[] }>().errors[0]).toMatchObject({
        path: 'file',
        code: 'PACKAGE_TOO_LARGE',
        params: { limit: 32 * MIB },
      });
      await expectNothingLeft(before);
    });

    it('P122 Idempotency-Key is ignored: the same request twice starts two imports', async () => {
      const key = { 'idempotency-key': 'k-import-1', ...MULTIPART };
      const send = () =>
        fx.call(
          'owner',
          'POST',
          `/workspaces/${workspaceId}/bases/import`,
          multipart('b.chbase', packageOfB),
          key,
        );
      const first = await send();
      const second = await send();
      expect(first.statusCode, first.body).toBe(202);
      expect(second.statusCode, second.body).toBe(202);
      expect(first.json<{ job_id: string }>().job_id).not.toBe(
        second.json<{ job_id: string }>().job_id,
      );
      await accepted(first);
      await accepted(second);
    });
  });

  describe('P123 — users by email in another organization', () => {
    let org2: Id<'org'>;
    let result: BaseImportResult;

    beforeAll(async () => {
      org2 = await seedOrg(db, 'Org2');
      const members = new OrgMembersRepository(db);
      await members.add(orgScope(org2), fx.users.u_admin.id, 'owner');
      await members.add(orgScope(org2), fx.users.u_sales1.id, 'member');
      const w2 = await fx.call('u_admin', 'POST', `/orgs/${org2}/workspaces`, { name: 'W2' });
      expect(w2.statusCode, w2.body).toBe(201);
      result = await succeeded(
        await importAs('u_admin', packageOfB, w2.json<{ id: Id<'wsp'> }>().id),
        'u_admin',
      );
    });

    it('P123 a user of both organizations is matched; others leave their cells and creators empty', async () => {
      const orders = await db.kysely
        .selectFrom('meta.tables')
        .selectAll()
        .where('base_id', '=', result.base_id)
        .where('name', '=', 'Orders')
        .executeTakeFirstOrThrow();
      const fields = await db.kysely
        .selectFrom('meta.fields')
        .selectAll()
        .where('table_id', '=', orders.id)
        .execute();
      const column = (name: string) => fields.find((f) => f.name === name)?.db_column_name ?? '';
      const { rows } = await sql<Record<string, unknown>>`
        SELECT * FROM ${sql.table(`data.${orders.db_table_name}`)} ORDER BY __auto
      `.execute(db.kysely);
      expect(
        rows.map((row) => [row[column('title')], row[column('owner')], row['__created_by']]),
      ).toEqual([
        ['r1', [fx.users.u_sales1.id], fx.users.u_admin.id],
        ['r2', null, fx.users.u_admin.id],
        ['r3', null, null],
      ]);
      expect(result.report.unmatched_user_emails).toEqual(
        [fx.users.u_editor.email, fx.users.u_sales2.email].sort(),
      );
      expect(result.report.unmatched_users).toBe(2);
      // A default user and a reminder recipient who are not here are left out.
      const reviewer = fields.find((f) => f.name === 'reviewer');
      expect((reviewer?.options as { default_value?: unknown }).default_value ?? []).toEqual([]);
      const due = fields.find((f) => f.name === 'due');
      expect((due?.options as { reminder?: unknown }).reminder ?? null).toBeNull();
    });

    it('P123 no id of the source (tbl/fld/opt/rec/viw/rol/att, usr of others) in the meta of the new base', async () => {
      const sourceIds = new Set<string>();
      const json = (value: unknown) =>
        JSON.stringify(value, (_key, item: unknown) =>
          typeof item === 'bigint' ? item.toString() : item,
        );
      const add = (value: unknown) => {
        for (const match of json(value).matchAll(
          /\b(?:tbl|fld|opt|rec|viw|clr|dsh|wgt|aut|rol|att)_[0-9A-Za-z]{16}\b/gu,
        )) {
          sourceIds.add(match[0]);
        }
      };
      add(
        await db.kysely
          .selectFrom('meta.tables')
          .selectAll()
          .where('base_id', '=', fx.baseId)
          .execute(),
      );
      add(
        await db.kysely
          .selectFrom('meta.fields')
          .selectAll()
          .where('table_id', 'in', [fx.orders.id, fx.customers.id, fx.tickets.id])
          .execute(),
      );
      add(
        await db.kysely
          .selectFrom('meta.base_roles')
          .selectAll()
          .where('base_id', '=', fx.baseId)
          .execute(),
      );
      for (const table of [fx.orders, fx.customers, fx.tickets]) {
        add(
          (await sql`SELECT * FROM ${sql.table(`data.${table.db_table_name}`)}`.execute(db.kysely))
            .rows,
        );
      }
      for (const user of ['owner', 'u_editor', 'u_reader', 'u_sales2', 'u_out'] as const) {
        sourceIds.add(fx.users[user].id);
      }
      const tables = await db.kysely
        .selectFrom('meta.tables')
        .selectAll()
        .where('base_id', '=', result.base_id)
        .execute();
      const copy: unknown[] = [
        await db.kysely
          .selectFrom('meta.bases')
          .selectAll()
          .where('id', '=', result.base_id)
          .execute(),
        tables,
        await db.kysely
          .selectFrom('meta.fields')
          .selectAll()
          .where(
            'table_id',
            'in',
            tables.map((table) => table.id),
          )
          .execute(),
        await db.kysely
          .selectFrom('meta.views')
          .selectAll()
          .where(
            'table_id',
            'in',
            tables.map((table) => table.id),
          )
          .execute(),
        await db.kysely
          .selectFrom('meta.base_roles')
          .selectAll()
          .where('base_id', '=', result.base_id)
          .execute(),
        await db.kysely
          .selectFrom('meta.attachments')
          .selectAll()
          .where('base_id', '=', result.base_id)
          .execute(),
      ];
      for (const table of tables) {
        copy.push(
          (await sql`SELECT * FROM ${sql.table(`data.${table.db_table_name}`)}`.execute(db.kysely))
            .rows,
        );
      }
      const text = json(copy);
      expect([...sourceIds].filter((id) => text.includes(id))).toEqual([]);
      expect(sourceIds.size).toBeGreaterThan(20);
    });
  });

  describe('P125 — poisoned packages', () => {
    const valid = (): PackageSpec => ({
      tables: [thingsTable()],
      records: { [P.things]: [record(pid('rec', 'One'), 1, { [P.name]: 'a' })] },
    });
    const bomb = () => Buffer.alloc(20 * MIB, 0x61);
    const cases: readonly {
      readonly name: string;
      readonly bytes: () => Buffer;
      readonly code: string;
      readonly timeout?: number;
    }[] = [
      {
        name: 'zip slip ../x',
        bytes: () => buildPackage({ ...valid(), raw: [{ name: '../x', data: Buffer.from('x') }] }),
        code: 'UNSAFE_ENTRY',
      },
      {
        name: 'zip slip absolute path',
        bytes: () =>
          buildPackage({ ...valid(), raw: [{ name: '/etc/passwd', data: Buffer.from('x') }] }),
        code: 'UNSAFE_ENTRY',
      },
      {
        name: 'zip slip backslash',
        bytes: () =>
          buildPackage({ ...valid(), raw: [{ name: 'schema\\..\\x', data: Buffer.from('x') }] }),
        code: 'UNSAFE_ENTRY',
      },
      {
        name: 'symlink',
        bytes: () =>
          buildPackage({
            ...valid(),
            raw: [
              {
                name: 'files/att_Link000000000000',
                data: Buffer.from('/etc/passwd'),
                externalAttributes: (0o120777 << 16) >>> 0,
              },
            ],
          }),
        code: 'UNSAFE_ENTRY',
      },
      {
        name: 'unknown entry',
        bytes: () =>
          buildPackage({ ...valid(), raw: [{ name: 'notes.txt', data: Buffer.from('x') }] }),
        code: 'UNKNOWN_ENTRY',
      },
      {
        name: 'two names equal once NFC-normalized',
        bytes: () =>
          buildPackage({
            ...valid(),
            raw: [
              { name: 'café.txt', data: Buffer.from('x') },
              { name: 'café.txt', data: Buffer.from('y') },
            ],
          }),
        code: 'DUPLICATE_ENTRY',
      },
      {
        name: '100 001 entries',
        bytes: () =>
          buildZip(
            Array.from({ length: 100_001 }, (_, index) => ({
              name: `x${String(index)}`,
              data: Buffer.alloc(0),
              method: 0,
            })),
          ),
        code: 'ARCHIVE_LIMIT_EXCEEDED',
        timeout: 180_000,
      },
      {
        name: 'compression bomb',
        bytes: () =>
          buildPackage({ ...valid(), raw: [{ name: 'files/att_Bomb000000000000', data: bomb() }] }),
        code: 'ARCHIVE_LIMIT_EXCEEDED',
      },
      {
        name: 'an entry larger than it says',
        bytes: () => {
          const att = pid('att', 'Liar');
          const data = Buffer.alloc(4000, 0x62);
          return buildPackage({
            ...valid(),
            fileMetas: [
              {
                id: att,
                kind: 'cell',
                filename: 'liar.txt',
                mime: 'text/plain',
                size: 5,
                sha256: sha256(data),
                table_id: P.things,
                field_id: P.files,
                record_id: pid('rec', 'One'),
              },
            ],
            raw: [{ name: `files/${att}`, data, uncompressedSize: 5 }],
          });
        },
        code: 'ARCHIVE_LIMIT_EXCEEDED|INVALID_ARCHIVE',
      },
      {
        name: 'modified checksum',
        bytes: () =>
          buildPackage({ ...valid(), checksums: { 'schema/tables.json': '0'.repeat(64) } }),
        code: 'CHECKSUM_MISMATCH',
      },
      {
        name: 'format_version 2',
        bytes: () => buildPackage({ ...valid(), manifest: { format_version: 2 } }),
        code: 'UNSUPPORTED_FORMAT_VERSION',
      },
      {
        name: 'dangling reference',
        bytes: () =>
          buildPackage({
            ...valid(),
            tables: [
              thingsTable([
                field(
                  pid('fld', 'Ref'),
                  'Ref',
                  'link',
                  {
                    link_table: pid('tbl', 'Nowhere'),
                    bidirectional: false,
                    bidirectional_link_field_name: null,
                    allow_multiple: true,
                    record_filter: null,
                    symmetric_field_id: null,
                  },
                  { link_side: 'a', position: 3 },
                ),
              ]),
            ],
            links: { [pid('fld', 'Ref')]: [] },
          }),
        code: 'DANGLING_REFERENCE',
      },
      {
        name: 'a formula that cannot be read',
        bytes: () =>
          buildPackage({
            ...valid(),
            tables: [
              thingsTable([
                field(
                  pid('fld', 'Calc'),
                  'Calc',
                  'formula',
                  { expression: `[${P.name}] +` },
                  { position: 3 },
                ),
              ]),
            ],
          }),
        code: 'INVALID_DEFINITION',
      },
      {
        name: 'a filter that is not a filter',
        bytes: () =>
          buildPackage({
            ...valid(),
            tables: [
              thingsTable([
                field(
                  pid('fld', 'Self'),
                  'Self',
                  'link',
                  {
                    link_table: P.things,
                    bidirectional: false,
                    bidirectional_link_field_name: null,
                    allow_multiple: true,
                    record_filter: { op: 'bogus', items: 3 },
                    symmetric_field_id: null,
                  },
                  { link_side: 'a', position: 3 },
                ),
              ]),
            ],
            links: { [pid('fld', 'Self')]: [] },
          }),
        code: 'INVALID_DEFINITION',
      },
      {
        name: 'an automation that is not one',
        bytes: () =>
          buildPackage({
            ...valid(),
            automations: [
              {
                id: pid('aut', 'Bad'),
                name: 'Bad',
                description: '',
                definition: { trigger: { type: 'nope' }, actions: [] },
                detached: [],
              },
            ],
          }),
        code: 'INVALID_DEFINITION',
      },
      {
        name: 'over the column budget',
        bytes: () =>
          buildPackage({
            ...valid(),
            tables: [
              thingsTable(
                Array.from({ length: MAX_FIELDS }, (_, index) =>
                  field(
                    pid('fld', `Ex${String(index).padStart(3, '0')}`),
                    `Extra ${String(index)}`,
                    'number',
                    {},
                    {
                      position: 3 + index,
                    },
                  ),
                ),
              ),
            ],
          }),
        code: 'INVALID_DEFINITION',
      },
      {
        name: 'a user id where a package names users by email',
        bytes: () =>
          buildPackage({
            ...valid(),
            records: {
              [P.things]: [
                record(
                  pid('rec', 'One'),
                  1,
                  { [P.name]: 'a' },
                  { created_by_email: fx.users.owner.id },
                ),
              ],
            },
          }),
        code: 'INVALID_ENTRY',
      },
      {
        name: 'a value that does not fit its field',
        bytes: () =>
          buildPackage({
            ...valid(),
            tables: [thingsTable([field(pid('fld', 'Qty'), 'Qty', 'number', {}, { position: 3 })])],
            records: {
              [P.things]: [
                record(pid('rec', 'One'), 1, { [P.name]: 'a', [pid('fld', 'Qty')]: 'abc' }),
              ],
            },
          }),
        code: 'INVALID_ENTRY',
      },
      {
        name: 'two records with one value of a unique field (found while loading: the base is purged)',
        bytes: () =>
          buildPackage({
            tables: [thingsTable([], { codeUnique: true })],
            records: {
              [P.things]: [
                record(pid('rec', 'One'), 1, { [P.name]: 'a', [P.code]: 'X' }),
                record(pid('rec', 'Two'), 2, { [P.name]: 'b', [P.code]: 'X' }),
              ],
            },
          }),
        code: 'INVALID_ENTRY',
      },
    ];

    for (const poisoned of cases) {
      it(
        `P125 ${poisoned.name} → failed INVALID_PACKAGE, nothing left`,
        async () => {
          const before = await snapshot();
          const job = await accepted(await importAs('owner', poisoned.bytes()));
          expect(job.status).toBe('failed');
          const error = job.error as { code: string; errors: { code: string; path: string }[] };
          expect(error.code, JSON.stringify(error)).toBe('INVALID_PACKAGE');
          const codes = new Set(poisoned.code.split('|'));
          expect(
            error.errors.some((item) => codes.has(item.code)),
            JSON.stringify(error.errors),
          ).toBe(true);
          // Paths name places of the package, never a file system path nor a hostile name.
          for (const item of error.errors) {
            expect(item.path).not.toMatch(/\.\.|^\/|\\|passwd|café/u);
          }
          await expectNothingLeft(before);
        },
        poisoned.timeout ?? 60_000,
      );
    }
  });

  describe('P127 — files', () => {
    const att = {
      exe: pid('att', 'Exe'),
      big: pid('att', 'Big'),
      huge: pid('att', 'Huge'),
      ok: pid('att', 'Ok'),
    };
    const one = pid('rec', 'One');
    const file = (id: string, filename: string, mime: string, data: Buffer, sha?: string) => ({
      meta: {
        id,
        kind: 'cell',
        filename,
        mime,
        size: data.length,
        sha256: sha ?? sha256(data),
        table_id: P.things,
        field_id: P.files,
        record_id: one,
      },
      data,
    });
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
    const big = pngHeader(7750, 7750);
    const huge = Buffer.alloc(MAX_FILE + 1, 0x63);
    const ok = Buffer.from('hello');
    let result: BaseImportResult;

    beforeAll(async () => {
      const cell = [att.exe, att.big, att.huge, att.ok].map((id) => ({
        id,
        name: id,
        size: 1,
        mime: 'application/octet-stream',
      }));
      result = await succeeded(
        await importAs(
          'owner',
          buildPackage({
            tables: [thingsTable()],
            records: { [P.things]: [record(one, 1, { [P.name]: 'with files', [P.files]: cell })] },
            files: [
              file(att.exe, 'setup.exe', 'application/x-msdownload', exe),
              file(att.big, 'big.png', 'image/png', big),
              file(att.huge, 'huge.bin', 'application/octet-stream', huge),
              file(att.ok, 'ok.txt', 'text/plain', ok),
            ],
          }),
        ),
      );
    });

    it('P127 an .exe in a field whose blocked_extensions is [] is still refused (default block list)', () => {
      expect(result.report.files_skipped).toContainEqual({
        filename: 'setup.exe',
        reason: 'blocked_file_type',
      });
    });

    it('P127 a file over ATTACHMENT_MAX_FILE_BYTES is left out', () => {
      expect(result.report.files_skipped).toContainEqual({
        filename: 'huge.bin',
        reason: 'file_too_large',
      });
      expect(result.report.attachments).toBe(2);
    });

    it('P127 the cell keeps the other files; a 60 MP image gets no thumbnail', async () => {
      const rows = await db.kysely
        .selectFrom('meta.attachments')
        .selectAll()
        .where('base_id', '=', result.base_id)
        .orderBy('filename')
        .execute();
      expect(rows.map((row) => [row.filename, row.status])).toEqual([
        ['big.png', 'ready'],
        ['ok.txt', 'ready'],
      ]);
      const image = rows[0];
      const deadline = Date.now() + 30_000;
      let status = image?.thumbnail_status;
      while (status === 'pending' || status === 'running') {
        if (Date.now() > deadline) throw new Error('thumbnail job did not run');
        await new Promise((resolve) => setTimeout(resolve, 200));
        status = (
          await db.kysely
            .selectFrom('meta.attachments')
            .select('thumbnail_status')
            .where('id', '=', image?.id ?? 'att_x')
            .executeTakeFirstOrThrow()
        ).thumbnail_status;
      }
      expect(status).not.toBe('ready');
      expect(await storage.head(`${image?.object_key ?? ''}_t256`)).toBeNull();
    });

    it('P127 an imported file is served like any file: readers of the record only', async () => {
      const okFile = await db.kysely
        .selectFrom('meta.attachments')
        .select('id')
        .where('base_id', '=', result.base_id)
        .where('filename', '=', 'ok.txt')
        .executeTakeFirstOrThrow();
      const owner = await fx.call('owner', 'GET', `/files/${okFile.id}`);
      expect(owner.statusCode, owner.body).toBe(302);
      expectProblem(await fx.call('u_editor', 'GET', `/files/${okFile.id}`), 404, 'NOT_FOUND');
    });

    it('P127 a file whose SHA-256 differs from the manifest → INVALID_PACKAGE, nothing left', async () => {
      const before = await snapshot();
      const job = await accepted(
        await importAs(
          'owner',
          buildPackage({
            tables: [thingsTable()],
            records: { [P.things]: [record(one, 1, { [P.name]: 'x' })] },
            files: [file(att.ok, 'ok.txt', 'text/plain', ok, 'f'.repeat(64))],
          }),
        ),
      );
      expect(job).toMatchObject({ status: 'failed', error: { code: 'INVALID_PACKAGE' } });
      expect((job.error as { errors: { code: string }[] }).errors.map((e) => e.code)).toContain(
        'CHECKSUM_MISMATCH',
      );
      await expectNothingLeft(before);
    });
  });

  describe('cellhive base import', () => {
    function env(): Env {
      return {
        NODE_ENV: 'test',
        PUBLIC_URL: t.config.publicUrl,
        DATABASE_URL: database.url,
        CACHE_URL: inject('cacheUrl'),
        APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
        SESSION_SECRET: TEST_SESSION_SECRET,
        STORAGE_DRIVER: 'local',
        STORAGE_LOCAL_PATH: t.storageRoot,
        BASE_PACKAGE_MAX_BYTES: String(32 * MIB),
        LOG_LEVEL: 'warn',
      };
    }

    async function cli(...argv: string[]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(argv, env(), {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      });
      return { code, out, err };
    }

    it('imports a file as a new base owned by --as, and prints the job and its result', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cellhive-cli-import-'));
      try {
        const path = join(dir, 'b.chbase');
        await writeFile(path, packageOfB);
        const run = await cli(
          'base',
          'import',
          '--workspace',
          workspaceId,
          '--file',
          path,
          '--as',
          fx.users.u_admin.email,
        );
        expect(run.code, run.err.join('\n')).toBe(0);
        const [jobId, json] = run.out;
        expect(jobId).toMatch(/^job_[0-9A-Za-z]{16}$/u);
        const result = baseImportResultSchema.parse(JSON.parse(json ?? '{}'));
        const base = await db.kysely
          .selectFrom('meta.bases')
          .select(['owner_id', 'workspace_id'])
          .where('id', '=', result.base_id)
          .executeTakeFirstOrThrow();
        expect(base).toEqual({ owner_id: fx.users.u_admin.id, workspace_id: workspaceId });
        expect(await storage.head(`${fx.orgId}/base-import-${jobId ?? ''}.chbase`)).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('refuses a bad --file, an unknown --as, and a user who may not create bases', async () => {
      expect(
        (
          await cli(
            'base',
            'import',
            '--workspace',
            workspaceId,
            '--file',
            'x.zip',
            '--as',
            'a@b.c',
          )
        ).code,
      ).toBe(2);
      const dir = await mkdtemp(join(tmpdir(), 'cellhive-cli-import-'));
      try {
        const path = join(dir, 'b.chbase');
        await writeFile(path, packageOfB);
        const unknown = await cli(
          'base',
          'import',
          '--workspace',
          workspaceId,
          '--file',
          path,
          '--as',
          'nobody@example.test',
        );
        expect(unknown.code).toBe(1);
        const editor = await cli(
          'base',
          'import',
          '--workspace',
          workspaceId,
          '--file',
          path,
          '--as',
          fx.users.u_editor.email,
        );
        expect(editor.code).toBe(1);
        expect(editor.err.join('\n')).toContain('may not create bases');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
