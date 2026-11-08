import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  baseExportResultSchema,
  baseImportResultSchema,
  jobAcceptedSchema,
  jobSchema,
  newId,
  type BaseImportResult,
  type Id,
  type JobDto,
} from '@cellhive/contracts';
import {
  AutomationsRepository,
  createStorageDriver,
  openBasePackage,
  orgScope,
  OrgMembersRepository,
  PACKAGE_ID_PREFIXES,
  type BasePackageReader,
  type Db,
  type Env,
  type PackageManifest,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { DEMO_TELEGRAM_BOT } from '../../src/seed/demo-automations.js';
import { DEMO_PASSWORD, DEMO_USERS } from '../../src/seed/demo-fixture.js';
import { DEMO_HTTP_SECRET } from '../../src/seed/demo-s6.js';
import { DEMO_INCOMING_WEBHOOK } from '../../src/seed/demo-webhooks.js';
import { runSeed } from '../../src/seed/run.js';

import { Browser, seedOrg, seedUser } from './auth-support.js';
import { MULTIPART, multipart } from './chbase-packages.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  captureLogger,
  startTestApp,
  TEST_PUBLIC_URL,
  TEST_SESSION_SECRET,
  type TestApp,
} from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/** Seeding, exporting and importing a base of ~22 000 records takes minutes on CI. */
const SETUP_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = 120_000;
const ZONE = 'Asia/Ho_Chi_Minh';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const ADMIN_EMAIL = DEMO_USERS.find((user) => user.key === 'u_admin')?.email ?? '';
const SALES1_EMAIL = DEMO_USERS.find((user) => user.key === 'u_sales1')?.email ?? '';

/** One instance: its database, application, worker and a signed-in person. */
interface Instance {
  readonly database: TestDatabase;
  readonly db: Db;
  readonly t: TestApp;
  readonly worker: WorkerHandle;
  readonly storageRoot: string;
  readonly browser: Browser;
}

/** A base on one instance, as the comparison reads it. */
interface Side {
  readonly instance: Instance;
  readonly baseId: Id<'bse'>;
}

async function finishedJob(read: () => Promise<LightMyRequestResponse>): Promise<JobDto> {
  const deadline = Date.now() + 600_000;
  for (;;) {
    const response = await read();
    expect(response.statusCode, response.body).toBe(200);
    const job = jobSchema.parse(response.json());
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${job.id} still ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function call(
  instance: Instance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> {
  return instance.browser.request({
    method,
    url: `/api/v1${url}`,
    ...(payload === undefined ? {} : { payload }),
  });
}

async function startInstance(
  database: TestDatabase,
  storageRoot: string,
  cacheIndex: number,
): Promise<Omit<Instance, 'browser'> & { browser?: Browser }> {
  const db = createTestDb(database.url);
  const t = await startTestApp({
    DATABASE_URL: database.url,
    STORAGE_LOCAL_PATH: storageRoot,
    CACHE_URL: `${inject('cacheUrl')}/${String(cacheIndex)}`,
  });
  const worker = await createWorker(t.config, {
    logger: captureLogger().logger,
    pollIntervalMs: 100,
  });
  return { database, db, t, worker, storageRoot };
}

async function stopInstance(instance: Omit<Instance, 'browser'> | undefined): Promise<void> {
  if (instance === undefined) return;
  await instance.worker.close();
  await instance.t.close();
  await instance.db.destroy();
  await instance.database.drop();
  await rm(instance.storageRoot, { recursive: true, force: true });
}

async function importInto(
  instance: Instance,
  workspaceId: Id<'wsp'>,
  bytes: Buffer,
): Promise<BaseImportResult> {
  const accepted = await instance.browser.request({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/bases/import`,
    payload: multipart('demo.chbase', bytes),
    headers: MULTIPART,
  });
  expect(accepted.statusCode, accepted.body).toBe(202);
  const { job_id: jobId } = jobAcceptedSchema.parse(accepted.json());
  const job = await finishedJob(() => call(instance, 'GET', `/jobs/${jobId}`));
  expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
  return baseImportResultSchema.parse(job.result);
}

// --- Reading a base ------------------------------------------------------------------

interface BaseRows {
  readonly tables: { id: Id<'tbl'>; name: string; db_table_name: string; position: number }[];
  readonly fields: {
    id: Id<'fld'>;
    table_id: Id<'tbl'>;
    name: string;
    type: string;
    options: unknown;
    db_column_name: string | null;
    link_junction: string | null;
    link_side: string | null;
    compute_mode: string | null;
    compute_state: string | null;
    position: number;
  }[];
}

async function rowsOf(side: Side): Promise<BaseRows> {
  const { db } = side.instance;
  const tables = await db.kysely
    .selectFrom('meta.tables')
    .select(['id', 'name', 'db_table_name', 'position'])
    .where('base_id', '=', side.baseId)
    .where('deleted_at', 'is', null)
    .orderBy('position')
    .execute();
  const fields =
    tables.length === 0
      ? []
      : await db.kysely
          .selectFrom('meta.fields')
          .select([
            'id',
            'table_id',
            'name',
            'type',
            'options',
            'db_column_name',
            'link_junction',
            'link_side',
            'compute_mode',
            'compute_state',
            'position',
          ])
          .where(
            'table_id',
            'in',
            tables.map((table) => table.id),
          )
          .where('deleted_at', 'is', null)
          .orderBy('position')
          .execute();
  return { tables, fields };
}

async function dataOf(side: Side, table: string): Promise<Record<string, unknown>[]> {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT * FROM ${sql.id('data', table)} WHERE __deleted_at IS NULL ORDER BY __auto
  `.execute(side.instance.db.kysely);
  return rows;
}

async function emailsOf(instance: Instance): Promise<Map<string, string>> {
  const users = await instance.db.kysely.selectFrom('meta.users').select(['id', 'email']).execute();
  return new Map(users.map((user) => [user.id as string, user.email.toLowerCase()]));
}

/** Every record of the base through the API (names as keys), by table name, in creation order. */
async function apiRecordsOf(side: Side, rows: BaseRows): Promise<Map<string, unknown[]>> {
  const out = new Map<string, unknown[]>();
  for (const table of rows.tables) {
    const records: unknown[] = [];
    for (let offset = 0; ; offset += 1000) {
      const response = await call(
        side.instance,
        'GET',
        `/tables/${table.id}/records?limit=1000&offset=${String(offset)}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json<{ records: { fields: Record<string, unknown> }[] }>().records;
      records.push(...page.map((record) => record.fields));
      if (page.length < 1000) break;
    }
    out.set(table.name, records);
  }
  return out;
}

/** A JSON value with every id (`xxx_` + 16 base62) replaced by `<id>`. */
function withoutIds(value: unknown): string {
  return JSON.stringify(value).replace(/\b[a-z]{3}_[0-9A-Za-z]{16}\b/gu, '<id>');
}

// --- The comparison ------------------------------------------------------------------

interface Mapping {
  readonly tables: Map<string, string>;
  readonly fields: Map<string, string>;
  readonly records: Map<string, string>;
}

/**
 * Maps the source base onto its copy by structure — tables by name, fields
 * by name in their table, records by creation order — and checks every
 * stored value: plain cells (options by name, users by email), creation
 * and change times, `__auto`, auto numbers, files (name, type, size,
 * SHA-256 and the bytes in storage), junction rows with their position and
 * parents. Returns the id mapping.
 */
async function compareBases(
  source: Side,
  copy: Side,
  options: { readonly matchedEmails: ReadonlySet<string> },
): Promise<Mapping> {
  const [from, to] = await Promise.all([rowsOf(source), rowsOf(copy)]);
  expect(to.tables.map((table) => table.name)).toEqual(from.tables.map((table) => table.name));
  const mapping: Mapping = { tables: new Map(), fields: new Map(), records: new Map() };
  const sourceEmails = await emailsOf(source.instance);
  const copyEmails = await emailsOf(copy.instance);
  const copyUserByEmail = new Map([...copyEmails].map(([id, email]) => [email, id]));
  const userOf = (id: unknown): string | null => {
    if (typeof id !== 'string') return null;
    const email = sourceEmails.get(id);
    if (email === undefined || !options.matchedEmails.has(email)) return null;
    return copyUserByEmail.get(email) ?? null;
  };

  for (const table of from.tables) {
    const other = to.tables.find((item) => item.name === table.name);
    if (other === undefined) throw new Error(`no table ${table.name}`);
    mapping.tables.set(table.id, other.id);
    const sourceFields = from.fields.filter((field) => field.table_id === table.id);
    const copyFields = to.fields.filter((field) => field.table_id === other.id);
    expect(copyFields.map((field) => [field.name, field.type])).toEqual(
      sourceFields.map((field) => [field.name, field.type]),
    );
    for (const field of sourceFields) {
      const twin = copyFields.find((item) => item.name === field.name);
      if (twin !== undefined) mapping.fields.set(field.id, twin.id);
    }
    const [a, b] = await Promise.all([
      dataOf(source, table.db_table_name),
      dataOf(copy, other.db_table_name),
    ]);
    expect(b.length, table.name).toBe(a.length);
    for (const [index, row] of a.entries()) {
      mapping.records.set(row['__id'] as string, b[index]?.['__id'] as string);
    }
    for (const [index, row] of a.entries()) {
      const twin = b[index] as Record<string, unknown>;
      const at = `${table.name}[${String(index)}]`;
      expect(String(twin['__auto']), at).toBe(String(row['__auto']));
      expect((twin['__created_at'] as Date).toISOString(), at).toBe(
        (row['__created_at'] as Date).toISOString(),
      );
      expect((twin['__updated_at'] as Date).toISOString(), at).toBe(
        (row['__updated_at'] as Date).toISOString(),
      );
      expect(twin['__created_by'] ?? null, at).toBe(userOf(row['__created_by']));
      for (const field of sourceFields) {
        const copyField = copyFields.find((item) => item.name === field.name);
        if (field.db_column_name === null || copyField?.db_column_name == null) continue;
        if (field.type === 'formula' || field.type === 'lookup') continue;
        const value = row[field.db_column_name];
        const copied = twin[copyField.db_column_name];
        const cell = `${at}.${field.name}`;
        switch (field.type) {
          case 'select': {
            const names = (options: unknown) =>
              new Map(
                ((options as { options?: { id: string; name: string }[] }).options ?? []).map(
                  (option) => [option.id, option.name],
                ),
              );
            const sourceNames = names(field.options);
            const copyNames = names(copyField.options);
            const read = (cellValue: unknown, labels: Map<string, string>) =>
              cellValue === null || cellValue === undefined
                ? null
                : (Array.isArray(cellValue) ? cellValue : [cellValue]).map((id) =>
                    labels.get(String(id)),
                  );
            expect(read(copied, copyNames), cell).toEqual(read(value, sourceNames));
            break;
          }
          case 'user': {
            const users = (cellValue: unknown) =>
              cellValue === null || cellValue === undefined
                ? []
                : (Array.isArray(cellValue) ? cellValue : [cellValue]).map(String);
            const expected = users(value)
              .map((id) => userOf(id))
              .filter((id): id is string => id !== null);
            expect(users(copied), cell).toEqual(expected);
            break;
          }
          case 'attachment':
            // Compared below, file by file.
            break;
          default:
            expect(copied ?? null, cell).toEqual(value ?? null);
        }
      }
      const parent = row['__parent_id'];
      if (parent !== undefined) {
        expect(twin['__parent_id'] ?? null, `${at}.__parent_id`).toBe(
          parent === null ? null : (mapping.records.get(parent as string) ?? null),
        );
      }
    }
  }

  // Links: every junction row of side `a`, both records mapped, with its position.
  for (const field of from.fields.filter(
    (item) => item.type === 'link' && item.link_side === 'a',
  )) {
    const twinId = mapping.fields.get(field.id);
    const twin = to.fields.find((item) => item.id === twinId);
    if (field.link_junction === null || twin?.link_junction == null) {
      throw new Error(`link ${field.name} has no junction`);
    }
    const junction = async (side: Side, name: string) =>
      (
        await sql<{ a_id: string; b_id: string; position: number }>`
          SELECT a_id, b_id, position FROM ${sql.id('data', name)} ORDER BY a_id, position, b_id
        `.execute(side.instance.db.kysely)
      ).rows;
    const a = await junction(source, field.link_junction);
    const b = await junction(copy, twin.link_junction);
    const live = a.filter((row) => mapping.records.has(row.a_id) && mapping.records.has(row.b_id));
    const expected = live
      .map(
        (row) =>
          `${mapping.records.get(row.a_id) ?? ''}>${mapping.records.get(row.b_id) ?? ''}@${String(row.position)}`,
      )
      .sort();
    expect(
      b.map((row) => `${row.a_id}>${row.b_id}@${String(row.position)}`).sort(),
      field.name,
    ).toEqual(expected);
  }

  // Files of cells: same names, types, sizes and checksums, and the bytes in storage.
  const files = async (side: Side) =>
    side.instance.db.kysely
      .selectFrom('meta.attachments')
      .select(['record_id', 'field_id', 'filename', 'mime', 'size', 'sha256', 'object_key'])
      .where('base_id', '=', side.baseId)
      .where('status', '=', 'ready')
      .execute();
  const sourceFiles = await files(source);
  const copyFiles = await files(copy);
  const key = (file: { record_id: string | null; field_id: string; filename: string }) =>
    `${file.record_id ?? ''}/${file.field_id}/${file.filename}`;
  const live = sourceFiles.filter(
    (file) => file.record_id !== null && mapping.records.has(file.record_id),
  );
  expect(copyFiles.length).toBe(live.length);
  const copyByKey = new Map(copyFiles.map((file) => [key(file), file]));
  for (const file of live) {
    const twin = copyByKey.get(
      key({
        record_id: mapping.records.get(file.record_id ?? '') ?? null,
        field_id: mapping.fields.get(file.field_id) ?? '',
        filename: file.filename,
      }),
    );
    expect(twin, file.filename).toBeDefined();
    expect(twin?.sha256).toBe(file.sha256);
    expect(twin?.mime).toBe(file.mime);
    expect(Number(twin?.size)).toBe(Number(file.size));
    const bytes = await storedBytes(copy.instance, twin?.object_key ?? '');
    expect(sha256(bytes)).toBe(file.sha256);
  }
  return mapping;
}

/** The bytes of an object in an instance's storage. */
async function storedBytes(instance: Instance, key: string): Promise<Buffer> {
  const storage = createStorageDriver(instance.t.config);
  try {
    const stream = await storage.getStream(key);
    if (stream === null) throw new Error(`no object ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } finally {
    await storage.close();
  }
}

/** Every id of a package (tables, fields, options, views, …, records, files). */
async function packageIds(reader: BasePackageReader): Promise<Set<string>> {
  const ids = new Set<string>();
  const pattern = new RegExp(`\\b(?:${PACKAGE_ID_PREFIXES.join('|')})_[0-9A-Za-z]{16}\\b`, 'gu');
  for (const entry of reader.entries()) {
    if (entry.name.startsWith('files/att_')) {
      ids.add(entry.name.slice('files/'.length));
      continue;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of await reader.open(entry.name)) chunks.push(chunk as Buffer);
    for (const match of Buffer.concat(chunks).toString('utf8').matchAll(pattern)) ids.add(match[0]);
  }
  return ids;
}

/** Meta rows of a base, as text (everything the base owns). */
async function metaTextOf(side: Side): Promise<string> {
  const { db } = side.instance;
  const base = side.baseId;
  const tables = await db.kysely
    .selectFrom('meta.tables')
    .selectAll()
    .where('base_id', '=', base)
    .execute();
  const tableIds = tables.map((table) => table.id);
  const none: Id<'tbl'>[] = ['tbl_None000000000000'];
  const ids = tableIds.length === 0 ? none : tableIds;
  const automations = await db.kysely
    .selectFrom('meta.automations')
    .selectAll()
    .where('base_id', '=', base)
    .execute();
  const dashboards = await db.kysely
    .selectFrom('meta.dashboards')
    .selectAll()
    .where('base_id', '=', base)
    .execute();
  const parts: unknown[] = [
    await db.kysely.selectFrom('meta.bases').selectAll().where('id', '=', base).execute(),
    tables,
    await db.kysely.selectFrom('meta.fields').selectAll().where('table_id', 'in', ids).execute(),
    await db.kysely.selectFrom('meta.views').selectAll().where('table_id', 'in', ids).execute(),
    dashboards,
    dashboards.length === 0
      ? []
      : await db.kysely
          .selectFrom('meta.dashboard_widgets')
          .selectAll()
          .where(
            'dashboard_id',
            'in',
            dashboards.map((dashboard) => dashboard.id),
          )
          .execute(),
    automations,
    automations.length === 0
      ? []
      : await db.kysely
          .selectFrom('meta.email_assets')
          .selectAll()
          .where(
            'automation_id',
            'in',
            automations.map((automation) => automation.id),
          )
          .execute(),
    await db.kysely.selectFrom('meta.base_roles').selectAll().where('base_id', '=', base).execute(),
    await db.kysely
      .selectFrom('meta.attachments')
      .selectAll()
      .where('base_id', '=', base)
      .execute(),
    await db.kysely
      .selectFrom('meta.form_covers')
      .selectAll()
      .where('base_id', '=', base)
      .execute(),
    await db.kysely
      .selectFrom('meta.field_dependencies')
      .selectAll()
      .where('base_id', '=', base)
      .execute(),
  ];
  return JSON.stringify(parts, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/**
 * BACKLOG T1019 (ADR-24 "Hệ quả", CONTRACTS §12.2, §5 P124): the base of
 * `pnpm seed:demo` exported, then imported into another organization of
 * the same instance and into a fresh instance (its own database, storage
 * and cache). Each copy keeps every table, field, record value, time,
 * creator, `__auto`, auto number, link with its position, parent and file
 * (SHA-256 and bytes), computes the same formula and lookup results, shows
 * the same views, dashboards and widget numbers, has the custom roles
 * assigned to nobody and every automation off (P124: secrets, sending
 * identities and webhooks reported, turning one on is `422
 * AUTOMATION_INVALID`, nothing runs), and no meta row of it holds an id of
 * the package.
 */
describe('base package round trip of seed:demo (T1019)', () => {
  let source: Instance;
  let fresh: Instance;
  let freshRoot: string;
  let sourceBase: Id<'bse'>;
  let packageBytes: Buffer;
  let reader: BasePackageReader;
  let manifest: PackageManifest;
  let scratch: string;
  let sameInstance: { result: BaseImportResult; side: Side };
  let otherInstance: { result: BaseImportResult; side: Side };
  let importerId: Id<'usr'>;
  let freshImporterId: Id<'usr'>;

  beforeAll(async () => {
    const database = await createMigratedDatabase();
    const storageRoot = await mkdtemp(join(tmpdir(), 'cellhive-roundtrip-a-'));
    scratch = await mkdtemp(join(tmpdir(), 'cellhive-roundtrip-out-'));
    const env: Env = {
      NODE_ENV: 'development',
      PUBLIC_URL: TEST_PUBLIC_URL,
      DATABASE_URL: database.url,
      CACHE_URL: `${inject('cacheUrl')}/7`,
      APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SECRET: TEST_SESSION_SECRET,
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_PATH: storageRoot,
      LOG_LEVEL: 'warn',
    };
    const errors: string[] = [];
    const code = await runSeed([], env, { out: () => undefined, err: (line) => errors.push(line) });
    expect(code, errors.join('\n')).toBe(0);
    const started = await startInstance(database, storageRoot, 7);
    source = { ...started, browser: new Browser(started.t.app) };
    expect((await source.browser.login(ADMIN_EMAIL, DEMO_PASSWORD)).statusCode).toBe(204);
    const base = await source.db.kysely
      .selectFrom('meta.bases')
      .select(['id', 'organization_id'])
      .executeTakeFirstOrThrow();
    sourceBase = base.id;

    // P124: an `http_request` with an `http_header` secret and a `send_email` from a
    // sending identity (the demo's automations use neither), off like any test fixture.
    const secret = await source.db.kysely
      .selectFrom('meta.secrets')
      .select('id')
      .where('name', '=', DEMO_HTTP_SECRET.name)
      .executeTakeFirstOrThrow();
    const identity = await source.db.kysely
      .selectFrom('meta.email_identities')
      .select(['id', 'display_name', 'email'])
      .orderBy('id')
      .executeTakeFirstOrThrow();
    const orders = await source.db.kysely
      .selectFrom('meta.tables')
      .select('id')
      .where('base_id', '=', sourceBase)
      .where('name', '=', 'Orders')
      .executeTakeFirstOrThrow();
    const admin = await source.db.kysely
      .selectFrom('meta.users')
      .select('id')
      .where('email', '=', ADMIN_EMAIL)
      .executeTakeFirstOrThrow();
    await new AutomationsRepository(source.db).insert(orgScope(base.organization_id), {
      id: newId('aut'),
      baseId: sourceBase,
      name: 'P124 HTTP and email',
      description: '',
      enabled: false,
      definition: {
        trigger: { type: 'record.created', table_id: orders.id, skip_bulk: false },
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
              auth: { header_name: 'Authorization', secret_id: secret.id },
              body: null,
              signing_secret_id: null,
              fail_on_http_error: true,
            },
          },
          {
            id: 'act_mail',
            type: 'send_email',
            config: {
              identity_id: identity.id,
              to: [{ literal: ADMIN_EMAIL }],
              subject: { template: 'New order' },
              body: { format: 'markdown', template: 'A new order.' },
            },
          },
        ],
      },
      triggerType: 'record.created',
      triggerTableId: orders.id,
      createdBy: admin.id,
    });

    // Export through the API and the worker, as u_admin.
    const exported = await call(source, 'POST', `/bases/${sourceBase}/export`);
    expect(exported.statusCode, exported.body).toBe(202);
    const exportJob = await finishedJob(() =>
      call(source, 'GET', `/jobs/${jobAcceptedSchema.parse(exported.json()).job_id}`),
    );
    expect(exportJob.status, JSON.stringify(exportJob.error)).toBe('succeeded');
    const exportResult = baseExportResultSchema.parse(exportJob.result);
    const redirect = await call(
      source,
      'GET',
      (exportResult.download_url ?? '').replace('/api/v1', ''),
    );
    expect(redirect.statusCode).toBe(302);
    const location = new URL(redirect.headers.location as string);
    const file = await source.t.app.inject({
      method: 'GET',
      url: `${location.pathname}${location.search}`,
    });
    expect(file.statusCode).toBe(200);
    packageBytes = file.rawPayload;
    const path = join(scratch, 'demo.chbase');
    await writeFile(path, packageBytes);
    reader = await openBasePackage(path);
    manifest = reader.manifest;

    // 1. Another organization of the same instance: u_admin owns it, u_sales1 is a member.
    const org2 = await seedOrg(source.db, 'Org2');
    importerId = admin.id;
    const members = new OrgMembersRepository(source.db);
    await members.add(orgScope(org2), admin.id, 'owner');
    const sales1 = await source.db.kysely
      .selectFrom('meta.users')
      .select('id')
      .where('email', '=', SALES1_EMAIL)
      .executeTakeFirstOrThrow();
    await members.add(orgScope(org2), sales1.id, 'member');
    const w2 = await call(source, 'POST', `/orgs/${org2}/workspaces`, { name: 'W2' });
    expect(w2.statusCode, w2.body).toBe(201);
    const imported = await importInto(source, w2.json<{ id: Id<'wsp'> }>().id, packageBytes);
    sameInstance = { result: imported, side: { instance: source, baseId: imported.base_id } };

    // 2. A fresh instance: only its owner, who has the email of u_admin.
    const freshDatabase = await createMigratedDatabase();
    freshRoot = await mkdtemp(join(tmpdir(), 'cellhive-roundtrip-b-'));
    const startedFresh = await startInstance(freshDatabase, freshRoot, 8);
    fresh = { ...startedFresh, browser: new Browser(startedFresh.t.app) };
    const freshOrg = await seedOrg(fresh.db, 'Fresh');
    const owner = await seedUser(fresh.db, {
      email: ADMIN_EMAIL,
      password: DEMO_PASSWORD,
      memberships: [{ orgId: freshOrg, role: 'owner' }],
    });
    freshImporterId = owner.id;
    expect((await fresh.browser.login(ADMIN_EMAIL, DEMO_PASSWORD)).statusCode).toBe(204);
    const wf = await call(fresh, 'POST', `/orgs/${freshOrg}/workspaces`, { name: 'Imported' });
    expect(wf.statusCode, wf.body).toBe(201);
    const freshImport = await importInto(fresh, wf.json<{ id: Id<'wsp'> }>().id, packageBytes);
    otherInstance = { result: freshImport, side: { instance: fresh, baseId: freshImport.base_id } };
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    reader.close();
    await stopInstance(source);
    await stopInstance(fresh);
    await rm(scratch, { recursive: true, force: true });
  });

  const sourceSide = (): Side => ({ instance: source, baseId: sourceBase });
  const copies = () =>
    [
      ['another organization', sameInstance, new Set([ADMIN_EMAIL, SALES1_EMAIL])],
      ['a fresh instance', otherInstance, new Set([ADMIN_EMAIL])],
    ] as const;

  it(
    'the report counts what the package holds; every automation is off',
    () => {
      for (const [, copy] of copies()) {
        const { report } = copy.result;
        expect({
          tables: report.tables,
          fields: report.fields,
          records: report.records,
          links: report.links,
          attachments: report.attachments,
          views: report.views,
          dashboards: report.dashboards,
          widgets: report.widgets,
          automations: report.automations,
          roles: report.roles,
        }).toEqual(manifest.counts);
        expect(report.automations_disabled).toBe(report.automations);
        expect(report.skipped_personal_views).toBe(manifest.skipped.personal_views);
        expect(report.files_skipped).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'every cell, time, creator, auto number, link with its position, parent and file is kept',
    async () => {
      for (const [name, copy, matched] of copies()) {
        try {
          await compareBases(sourceSide(), copy.side, { matchedEmails: matched });
        } catch (error) {
          throw new Error(`${name}: ${String(error)}`, { cause: error });
        }
      }
    },
    TEST_TIMEOUT_MS * 3,
  );

  it(
    'formula and lookup fields compute the same results; AI fields keep their values',
    async () => {
      const from = await rowsOf(sourceSide());
      const sourceRecords = await apiRecordsOf(sourceSide(), from);
      const isComputed = (field: BaseRows['fields'][number]) =>
        field.type === 'formula' || field.type === 'lookup';
      const byTable = (rows: BaseRows) =>
        rows.tables.flatMap((table) =>
          rows.fields.filter((field) => field.table_id === table.id && isComputed(field)),
        );
      const computed = byTable(from);
      expect(computed.length).toBeGreaterThan(0);
      for (const [name, copy] of copies()) {
        const to = await rowsOf(copy.side);
        expect(
          byTable(to).map((field) => [field.name, field.compute_mode, field.compute_state]),
          name,
        ).toEqual(computed.map((field) => [field.name, field.compute_mode, 'ready']));
        const copyRecords = await apiRecordsOf(copy.side, to);
        for (const table of from.tables) {
          const names = computed
            .filter((field) => field.table_id === table.id)
            .map((field) => field.name);
          const pick = (records: unknown[] | undefined) =>
            (records ?? []).map((fields) =>
              withoutIds(names.map((field) => (fields as Record<string, unknown>)[field] ?? null)),
            );
          expect(pick(copyRecords.get(table.name)), `${name}: ${table.name}`).toEqual(
            pick(sourceRecords.get(table.name)),
          );
        }
      }
    },
    TEST_TIMEOUT_MS * 3,
  );

  it(
    'views, dashboards and widgets show the same as the source',
    async () => {
      const from = await rowsOf(sourceSide());
      for (const [name, copy] of copies()) {
        const to = await rowsOf(copy.side);
        for (const table of from.tables) {
          const twin = to.tables.find((item) => item.name === table.name);
          const list = async (side: Side, tableId: string) => {
            const response = await call(side.instance, 'GET', `/tables/${tableId}/views?limit=200`);
            expect(response.statusCode, response.body).toBe(200);
            return response
              .json<{
                items: {
                  id: string;
                  name: string;
                  type: string;
                  is_personal: boolean;
                  config: unknown;
                }[];
              }>()
              .items.filter((view) => !view.is_personal);
          };
          const a = await list(sourceSide(), table.id);
          const b = await list(copy.side, twin?.id ?? '');
          expect(
            b.map((view) => [view.name, view.type]),
            `${name}: ${table.name}`,
          ).toEqual(a.map((view) => [view.name, view.type]));
          for (const [index, view] of a.entries()) {
            const other = b[index];
            const count = async (side: Side, tableId: string, viewId: string) => {
              const response = await call(
                side.instance,
                'GET',
                `/tables/${tableId}/records?view_id=${viewId}&limit=1`,
              );
              expect(response.statusCode, response.body).toBe(200);
              const body = response.json<{ total?: number; total_estimate?: number }>();
              return body.total ?? body.total_estimate;
            };
            expect(
              await count(copy.side, twin?.id ?? '', other?.id ?? ''),
              `${name}: ${table.name} / ${view.name}`,
            ).toBe(await count(sourceSide(), table.id, view.id));
          }
        }
        const dashboards = async (side: Side) => {
          const response = await call(side.instance, 'GET', `/bases/${side.baseId}/dashboards`);
          expect(response.statusCode, response.body).toBe(200);
          return response.json<{ items: { id: string; name: string }[] }>().items;
        };
        const a = await dashboards(sourceSide());
        const b = await dashboards(copy.side);
        expect(b.map((item) => item.name)).toEqual(a.map((item) => item.name));
        expect(a.length).toBeGreaterThan(0);
        for (const [index, dashboard] of a.entries()) {
          const read = async (side: Side, id: string) => {
            const response = await call(side.instance, 'GET', `/dashboards/${id}`);
            expect(response.statusCode, response.body).toBe(200);
            return response.json<{
              widgets: {
                id: string;
                type: string;
                title: string;
                status: string;
                layout: unknown;
              }[];
            }>();
          };
          const one = await read(sourceSide(), dashboard.id);
          const two = await read(copy.side, b[index]?.id ?? '');
          const shape = (widgets: typeof one.widgets) =>
            widgets
              .map((widget) => [
                widget.type,
                widget.title,
                widget.status,
                JSON.stringify(widget.layout),
              ])
              .sort();
          expect(shape(two.widgets), `${name}: ${dashboard.name}`).toEqual(shape(one.widgets));
          for (const widget of one.widgets) {
            const twin = two.widgets.find(
              (item) => JSON.stringify(item.layout) === JSON.stringify(widget.layout),
            );
            const data = async (side: Side, id: string) => {
              const response = await call(side.instance, 'POST', `/widgets/${id}/data`, {
                filters: [],
                timezone: ZONE,
              });
              if (response.statusCode !== 200) return { status: response.statusCode, body: null };
              // When and how it was computed differ; the numbers must not.
              const body = response.json<Record<string, unknown>>();
              delete body['computed_at'];
              delete body['cache'];
              // Grouped by people: those who are not members here leave their cells empty.
              const columns = (body['columns'] ?? []) as { field_type?: string | null }[];
              if (columns.some((column) => column.field_type === 'user')) {
                return { status: response.statusCode, body: withoutIds(body['total'] ?? null) };
              }
              return { status: response.statusCode, body: withoutIds(body) };
            };
            expect(await data(copy.side, twin?.id ?? ''), `${name}: ${widget.title}`).toEqual(
              await data(sourceSide(), widget.id),
            );
          }
        }
      }
    },
    TEST_TIMEOUT_MS * 3,
  );

  it(
    'custom roles are created and given to nobody; the importer owns the base',
    async () => {
      const roles = async (side: Side) =>
        side.instance.db.kysely
          .selectFrom('meta.base_roles')
          .select(['id', 'name', 'kind'])
          .where('base_id', '=', side.baseId)
          .orderBy('position')
          .execute();
      const custom = (await roles(sourceSide())).filter((role) => role.kind === 'custom');
      expect(custom.length).toBeGreaterThan(0);
      for (const [name, copy] of copies()) {
        const copied = (await roles(copy.side)).filter((role) => role.kind === 'custom');
        expect(
          copied.map((role) => role.name),
          name,
        ).toEqual(custom.map((role) => role.name));
        const assigned = await copy.side.instance.db.kysely
          .selectFrom('meta.base_role_members')
          .select('role_id')
          .where(
            'role_id',
            'in',
            copied.map((role) => role.id),
          )
          .execute();
        expect(assigned, name).toEqual([]);
        const response = await call(copy.side.instance, 'GET', `/bases/${copy.side.baseId}`);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<{ owner_id: string }>().owner_id).toBe(
          copy === sameInstance ? importerId : freshImporterId,
        );
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'P124 automations are off, run as the importer, their secrets, identities and webhooks detached and reported',
    async () => {
      for (const [name, copy] of copies()) {
        const { report } = copy.result;
        const reconnect = report.secrets_to_reconnect.map((item) => [item.kind, item.name]);
        expect(reconnect, name).toEqual(
          expect.arrayContaining([
            ['secret', DEMO_TELEGRAM_BOT.name],
            ['secret', DEMO_HTTP_SECRET.name],
            ['email_identity', expect.any(String)],
          ]),
        );
        expect(
          report.webhooks_to_recreate.map((item) => [item.kind, item.name]),
          name,
        ).toEqual([['incoming_webhook', DEMO_INCOMING_WEBHOOK.name]]);
        for (const item of [...report.secrets_to_reconnect, ...report.webhooks_to_recreate]) {
          expect(item.automations.length, item.name).toBeGreaterThan(0);
        }
        const list = await call(
          copy.side.instance,
          'GET',
          `/bases/${copy.side.baseId}/automations?limit=200`,
        );
        expect(list.statusCode, list.body).toBe(200);
        const items = list.json<{
          items: {
            id: string;
            name: string;
            enabled: boolean;
            run_as: { id: string } | null;
            created_by: { id: string } | null;
          }[];
        }>().items;
        expect(items.length).toBe(report.automations);
        const importer = copy === sameInstance ? importerId : freshImporterId;
        for (const automation of items) {
          expect(automation.enabled, automation.name).toBe(false);
          expect(automation.run_as?.id, automation.name).toBe(importer);
          expect(automation.created_by?.id, automation.name).toBe(importer);
        }
        // Turning on one whose secret is not set again: 422, nothing changes.
        const detached = [...report.secrets_to_reconnect, ...report.webhooks_to_recreate].flatMap(
          (item) => item.automations.map((automation) => automation.id),
        );
        for (const id of new Set(detached)) {
          const enabled = await call(copy.side.instance, 'POST', `/automations/${id}/enable`);
          expect(enabled.statusCode, `${name}: ${enabled.body}`).toBe(422);
          expect(enabled.json<{ code: string }>().code).toBe('AUTOMATION_INVALID');
        }
        // A record created in the copy starts nothing: no run before an automation is on.
        const tables = await rowsOf(copy.side);
        const orders = tables.tables.find((table) => table.name === 'Orders');
        const created = await call(
          copy.side.instance,
          'POST',
          `/tables/${orders?.id ?? ''}/records`,
          {
            records: [{ fields: {} }],
          },
        );
        expect(created.statusCode, created.body).toBe(201);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const runs = await copy.side.instance.db.kysely
          .selectFrom('meta.automation_runs')
          .select('id')
          .where(
            'automation_id',
            'in',
            items.map((automation) => automation.id as Id<'aut'>),
          )
          .execute();
        expect(runs, name).toEqual([]);
        const stored = await copy.side.instance.db.kysely
          .selectFrom('meta.automations')
          .select(['definition'])
          .where('base_id', '=', copy.side.baseId)
          .execute();
        const text = JSON.stringify(stored);
        expect(text).not.toMatch(/(?:sec|eid|grp|hok)_[0-9A-Za-z]{16}/u);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'no meta row of the copies holds an id of the package; AI fields are reported',
    async () => {
      const ids = await packageIds(reader);
      expect(ids.size).toBeGreaterThan(100);
      for (const [name, copy] of copies()) {
        const text = await metaTextOf(copy.side);
        const found = [...ids].filter((id) => text.includes(id));
        expect(found, name).toEqual([]);
        const fields = await rowsOf(copy.side);
        const ai = fields.fields.filter(
          (field) =>
            typeof field.options === 'object' &&
            field.options !== null &&
            'ai' in (field.options as Record<string, unknown>),
        );
        expect(copy.result.report.ai_fields.map((item) => item.field_id).sort(), name).toEqual(
          ai.map((field) => field.id).sort(),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});
