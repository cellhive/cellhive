import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  baseExportResultSchema,
  jobAcceptedSchema,
  jobSchema,
  type BaseExportResult,
  type Id,
  type JobDto,
} from '@cellhive/contracts';
import {
  ATTACHMENTS_ENTRY,
  openBasePackage,
  packageAttachmentsSchema,
  packageAutomationsSchema,
  packageManifestSchema,
  packageTablesSchema,
  packageViewsSchema,
  SCHEMA_ENTRIES,
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
import { DEMO_VIEW_NAMES } from '../../src/seed/demo-views.js';
import { DEMO_INCOMING_WEBHOOK } from '../../src/seed/demo-webhooks.js';
import { runSeed } from '../../src/seed/run.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  captureLogger,
  startTestApp,
  TEST_PUBLIC_URL,
  TEST_SESSION_SECRET,
  type TestApp,
} from './support.js';

import type { LightMyRequestResponse } from 'fastify';

async function finishedJob(read: () => Promise<LightMyRequestResponse>): Promise<JobDto> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const response = await read();
    expect(response.statusCode, response.body).toBe(200);
    const job = jobSchema.parse(response.json());
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${job.id} still ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function entryBytes(reader: BasePackageReader, name: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await reader.open(name)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * BACKLOG T1017 (CONTRACTS §12.2, §5 P120; ADR-24 "Hệ quả"): the base of
 * `pnpm seed:demo` (CONTRACTS §9 sizes: customers, tickets, orders and their
 * lines, links, sub-records, files, views — a personal one of u_editor —,
 * share links, a dashboard, automations with a Telegram bot, an HTTP secret
 * and an incoming webhook, the Sales and Kho roles, API tokens) exported by
 * u_admin through the API and the worker, then read back with the reader of
 * T1016: the counts and checksums match the base, and the package holds
 * nothing it must never hold (P120). A record moved to the trash first must
 * not be in it.
 */
describe('base export of seed:demo (T1017)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let worker: WorkerHandle;
  let storageRoot: string;
  let scratch: string;
  let admin: Browser;
  let orgId: Id<'org'>;
  let baseId: Id<'bse'>;
  let trashedId: Id<'rec'>;
  let path: string;
  let result: BaseExportResult;
  let reader: BasePackageReader;
  let manifest: PackageManifest;
  /** Every entry but the files, as text. */
  const texts = new Map<string, string>();

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    admin.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    storageRoot = await mkdtemp(join(tmpdir(), 'cellhive-base-export-demo-'));
    scratch = await mkdtemp(join(tmpdir(), 'cellhive-base-export-demo-out-'));
    const env: Env = {
      NODE_ENV: 'development',
      PUBLIC_URL: TEST_PUBLIC_URL,
      DATABASE_URL: database.url,
      CACHE_URL: `${inject('cacheUrl')}/6`,
      APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SECRET: TEST_SESSION_SECRET,
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_PATH: storageRoot,
      LOG_LEVEL: 'warn',
    };
    const errors: string[] = [];
    const code = await runSeed([], env, { out: () => undefined, err: (line) => errors.push(line) });
    expect(code, errors.join('\n')).toBe(0);

    t = await startTestApp({ DATABASE_URL: database.url, STORAGE_LOCAL_PATH: storageRoot });
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 100 });
    const base = await db.kysely
      .selectFrom('meta.bases')
      .select(['id', 'organization_id'])
      .executeTakeFirstOrThrow();
    baseId = base.id;
    orgId = base.organization_id;
    admin = new Browser(t.app);
    const email = DEMO_USERS.find((user) => user.key === 'u_admin')?.email ?? '';
    expect((await admin.login(email, DEMO_PASSWORD)).statusCode).toBe(204);

    // A record in the trash is never exported.
    const orders = await db.kysely
      .selectFrom('meta.tables')
      .select(['id', 'db_table_name'])
      .where('base_id', '=', baseId)
      .where('name', '=', 'Orders')
      .executeTakeFirstOrThrow();
    const victim = await sql<{ id: Id<'rec'> }>`
      SELECT __id AS id FROM ${sql.id('data', orders.db_table_name)} ORDER BY __auto LIMIT 1
    `.execute(db.kysely);
    trashedId = victim.rows[0]?.id as Id<'rec'>;
    const deleted = await call('DELETE', `/tables/${orders.id}/records/${trashedId}`);
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);

    const accepted = await call('POST', `/bases/${baseId}/export`);
    expect(accepted.statusCode, accepted.body).toBe(202);
    const { job_id: jobId } = jobAcceptedSchema.parse(accepted.json());
    const job = await finishedJob(() => call('GET', `/jobs/${jobId}`));
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    result = baseExportResultSchema.parse(job.result);

    const redirect = await call('GET', (result.download_url ?? '').replace('/api/v1', ''));
    expect(redirect.statusCode).toBe(302);
    const location = new URL(redirect.headers.location as string);
    const file = await t.app.inject({
      method: 'GET',
      url: `${location.pathname}${location.search}`,
    });
    expect(file.statusCode).toBe(200);
    path = join(scratch, 'demo.chbase');
    await writeFile(path, file.rawPayload);
    reader = await openBasePackage(path);
    manifest = reader.manifest;
    for (const entry of reader.entries()) {
      if (entry.name.startsWith('files/att_')) continue;
      texts.set(entry.name, (await entryBytes(reader, entry.name)).toString('utf8'));
    }
  }, 600_000);

  afterAll(async () => {
    reader.close();
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
    await rm(storageRoot, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it('round trip: every checksum matches, and the result is the manifest', async () => {
    await reader.verifyAll();
    expect(Object.keys(manifest.checksums).sort()).toEqual(
      reader
        .entries()
        .map((entry) => entry.name)
        .filter((name) => name !== 'manifest.json')
        .sort(),
    );
    for (const [name, checksum] of Object.entries(manifest.checksums)) {
      expect(sha256(await entryBytes(reader, name)), name).toBe(checksum);
    }
    expect(packageManifestSchema.parse(JSON.parse(texts.get('manifest.json') ?? '{}'))).toEqual(
      manifest,
    );
    expect(result.counts).toEqual(manifest.counts);
    expect(result.size).toBe((await stat(path)).size);
    expect(manifest.base).toEqual({ id: baseId, name: expect.any(String) as string });
    expect(manifest.exported_by_email).toBe(
      DEMO_USERS.find((user) => user.key === 'u_admin')?.email,
    );
  });

  it('round trip: the counts are those of the base (trash and personal views left out)', async () => {
    const tables = await db.kysely
      .selectFrom('meta.tables')
      .select(['id', 'db_table_name'])
      .where('base_id', '=', baseId)
      .where('deleted_at', 'is', null)
      .execute();
    const tableIds = tables.map((table) => table.id);
    const fields = await db.kysely
      .selectFrom('meta.fields')
      .select(['id', 'type', 'link_side', 'link_junction', 'table_id', 'options'])
      .where('table_id', 'in', tableIds)
      .where('deleted_at', 'is', null)
      .execute();
    let records = 0;
    for (const table of tables) {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ${sql.id('data', table.db_table_name)} WHERE __deleted_at IS NULL
      `.execute(db.kysely);
      records += rows[0]?.n ?? 0;
    }
    const tableById = new Map(tables.map((table) => [table.id as string, table.db_table_name]));
    let links = 0;
    for (const field of fields.filter((item) => item.type === 'link' && item.link_side === 'a')) {
      const target = tableById.get((field.options as { link_table?: string }).link_table ?? '');
      const own = tableById.get(field.table_id);
      if (target === undefined || own === undefined || field.link_junction === null) continue;
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ${sql.id('data', field.link_junction)} j
          JOIN ${sql.id('data', own)} a ON a.__id = j.a_id AND a.__deleted_at IS NULL
          JOIN ${sql.id('data', target)} b ON b.__id = j.b_id AND b.__deleted_at IS NULL
      `.execute(db.kysely);
      links += rows[0]?.n ?? 0;
    }
    const views = await db.kysely
      .selectFrom('meta.views')
      .select(['is_personal'])
      .where('table_id', 'in', tableIds)
      .execute();
    const count = async (query: Promise<{ n: string | number | bigint } | undefined>) =>
      Number((await query)?.n ?? 0);
    const dashboards = await db.kysely
      .selectFrom('meta.dashboards')
      .select('id')
      .where('base_id', '=', baseId)
      .where('deleted_at', 'is', null)
      .execute();
    expect(manifest.counts).toEqual({
      tables: tables.length,
      fields: fields.length,
      records,
      links,
      attachments: expect.any(Number) as number,
      views: views.filter((view) => !view.is_personal).length,
      dashboards: dashboards.length,
      widgets: await count(
        db.kysely
          .selectFrom('meta.dashboard_widgets')
          .select((eb) => eb.fn.countAll().as('n'))
          .where(
            'dashboard_id',
            'in',
            dashboards.map((dashboard) => dashboard.id),
          )
          .executeTakeFirst(),
      ),
      automations: await count(
        db.kysely
          .selectFrom('meta.automations')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('base_id', '=', baseId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      ),
      roles: await count(
        db.kysely
          .selectFrom('meta.base_roles')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('base_id', '=', baseId)
          .where('kind', '=', 'custom')
          .executeTakeFirst(),
      ),
    });
    expect(manifest.counts.records).toBeGreaterThan(5000);
    expect(manifest.counts.links).toBeGreaterThan(0);
    const personal = views.filter((view) => view.is_personal).length;
    expect(personal).toBeGreaterThan(0);
    expect(manifest.skipped.personal_views).toBe(personal);
    expect(result.skipped_personal_views).toBe(personal);

    // Files: each one stored in the package as the base holds it.
    const attachments = await reader.readJson(ATTACHMENTS_ENTRY, packageAttachmentsSchema);
    expect(attachments.files).toHaveLength(manifest.counts.attachments);
    expect(attachments.files.length).toBeGreaterThan(0);
    const cells = attachments.files.filter((file) => file.kind === 'cell');
    const rows = await db.kysely
      .selectFrom('meta.attachments')
      .select(['id', 'size', 'sha256'])
      .where(
        'id',
        'in',
        cells.map((file) => file.id),
      )
      .execute();
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    for (const file of cells) {
      const row = byId.get(file.id);
      expect(Number(row?.size), file.id).toBe(file.size);
      if (row?.sha256 !== null && row?.sha256 !== undefined) expect(row.sha256).toBe(file.sha256);
    }
  });

  it('every entry within its compression ratio: 200× NDJSON, 20× JSON and files', async () => {
    const uncompressed = reader
      .entries()
      .reduce((total, entry) => total + entry.uncompressedSize, 0);
    expect(uncompressed).toBeLessThanOrEqual(4 * t.config.limits.basePackageMaxBytes);
    expect(uncompressed / (await stat(path)).size).toBeGreaterThan(1);
    for (const entry of reader.entries()) {
      const ratio = entry.uncompressedSize / Math.max(entry.compressedSize, 1);
      const ndjson = entry.kind.kind === 'data' || entry.kind.kind === 'links';
      expect(ratio, entry.name).toBeLessThanOrEqual(ndjson ? 200 : 20);
    }
  });

  it('P120 the package has cost: a base admin exports every field', async () => {
    const tables = await reader.readJson(SCHEMA_ENTRIES.tables, packageTablesSchema);
    const orders = tables.tables.find((table) => table.name === 'Orders');
    const cost = orders?.fields.find((field) => field.name === 'cost');
    expect(cost).toBeDefined();
    const data = texts.get(`data/${orders?.id ?? ''}.ndjson`) ?? '';
    expect(data).toContain(`"${cost?.id ?? 'missing'}":`);
  });

  it('P120 no record of the trash, no personal view, no user id (emails only)', async () => {
    const views = await reader.readJson(SCHEMA_ENTRIES.views, packageViewsSchema);
    expect(views.views.map((view) => view.name)).not.toContain(
      DEMO_VIEW_NAMES.tickets.editorUrgent,
    );
    const personal = await db.kysely
      .selectFrom('meta.views')
      .select('id')
      .where('is_personal', '=', true)
      .execute();
    for (const [name, text] of texts) {
      expect(text, name).not.toContain(trashedId);
      for (const view of personal) expect(text, name).not.toContain(view.id);
      expect(text, name).not.toMatch(/usr_[0-9A-Za-z]{16}/u);
    }
    const emails = DEMO_USERS.map((user) => user.email);
    expect(emails.some((email) => [...texts.values()].some((text) => text.includes(email)))).toBe(
      true,
    );
  });

  it('P120 no audit, history, event, run, share link, token, secret value, hash, IP, member', async () => {
    const shareLinks = await db.kysely
      .selectFrom('meta.share_links')
      .select(['id', 'token_prefix'])
      .where('base_id', '=', baseId)
      .execute();
    expect(shareLinks.length).toBeGreaterThan(0);
    const tokens = await db.kysely
      .selectFrom('meta.api_tokens')
      .select(['id', 'token_prefix'])
      .where('organization_id', '=', orgId)
      .execute();
    expect(tokens.length).toBeGreaterThan(0);
    const forbidden = [
      DEMO_HTTP_SECRET.value,
      DEMO_TELEGRAM_BOT.token,
      'cht_',
      '$argon2',
      '127.0.0.1',
      ...shareLinks.flatMap((link) => [link.id, link.token_prefix]),
      ...tokens.flatMap((token) => [token.id, token.token_prefix]),
    ];
    const kinds = /(?:aud|evt|run|shl|tok|sec|eid|grp|hok|usr|wsp|org)_[0-9A-Za-z]{16}/u;
    for (const [name, text] of texts) {
      for (const value of forbidden) expect(text, `${name}: ${value}`).not.toContain(value);
      expect(text, name).not.toMatch(kinds);
      expect(text, name).not.toMatch(/"(?:ip|password_hash|principal_id)"\s*:/u);
    }
  });

  it('P120 the Telegram bot and the incoming webhook remain only as names in `detached`', async () => {
    const automations = await reader.readJson(SCHEMA_ENTRIES.automations, packageAutomationsSchema);
    const detached = automations.automations.flatMap((automation) => automation.detached);
    const names = detached.map((item) => item.name);
    expect(names).toEqual(
      expect.arrayContaining([DEMO_TELEGRAM_BOT.name, DEMO_INCOMING_WEBHOOK.name]),
    );
    // The HTTP secret of the demo is named by no automation: not even its name is exported.
    expect(names).not.toContain(DEMO_HTTP_SECRET.name);
    expect(detached.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['secret', 'incoming_webhook']),
    );
    // Outside `detached`, no entry names them.
    for (const [name, text] of texts) {
      if (name === SCHEMA_ENTRIES.automations) continue;
      for (const secret of [DEMO_TELEGRAM_BOT.name, DEMO_HTTP_SECRET.name]) {
        expect(text, name).not.toContain(secret);
      }
    }
    const withoutDetached = JSON.stringify(
      automations.automations.map((automation) => ({ ...automation, detached: [] })),
    );
    for (const secret of [DEMO_TELEGRAM_BOT.name, DEMO_HTTP_SECRET.name]) {
      expect(withoutDetached).not.toContain(secret);
    }
  });
});
