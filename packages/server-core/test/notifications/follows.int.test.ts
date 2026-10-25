/**
 * BACKLOG T543 (CONTRACTS §22.5; ADR-29 §1, ADR-34 §2): following records on
 * PostgreSQL — the repository (tenant isolation, composite foreign keys,
 * cascades), `RecordFollowService` (read access now or `404`, idempotency,
 * the cap, "unfollowing by hand wins"), the automatic follow of the creator
 * (`RecordMutationService.create` → `RecordFollowHooks.afterCreate`: one
 * record by a user acting directly, `auto_follow_created`), the shared rule of
 * automatic sources (`autoFollow`, used by T544) and the purges.
 */
import { MAX_RECORD_FOLLOWS_PER_USER, newId, TOO_MANY_FOLLOWS, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  NotificationBufferRepository,
  NotificationSettingsRepository,
  RecordFollowHooks,
  RecordFollowService,
  RecordFollowsRepository,
  type AfterCreateInput,
} from '../../src/notifications/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  accessOf,
  buildOrdersFixture,
  NOW,
  seedMembers,
  type OrdersFixture,
} from '../records/fixtures.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import type { Causation } from '../../src/events/event.js';

const ORG_A: Id<'org'> = 'org_T543FollowsOrgA0';
const ORG_B: Id<'org'> = 'org_T543FollowsOrgB0';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('record follows (T543)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let query: RecordQueryService;
  let mutation: RecordMutationService;
  let follows: RecordFollowService;
  let repository: RecordFollowsRepository;
  let hooks: RecordFollowHooks;
  let settings: NotificationSettingsRepository;
  let fx: OrdersFixture;
  let fxB: OrdersFixture;
  const scope: OrgScope = orgScope(ORG_A);
  const scopeB: OrgScope = orgScope(ORG_B);
  /** r1: owner u_sales1 (Sales reads it); r2: owner u_sales2 (u_sales1 cannot read it). */
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;

  const user = (key: keyof OrdersFixture['users']) => fx.users[key].id;

  function auditOf(
    key: keyof OrdersFixture['users'],
    via: AuditContext['via'] = null,
  ): AuditContext {
    return auditOfId(user(key), via);
  }

  function auditOfId(userId: Id<'usr'>, via: AuditContext['via'] = null): AuditContext {
    const requestId = newId('req');
    return {
      actor: { type: 'user', id: userId },
      via,
      batch_id: requestId,
      request_id: requestId,
      ip: null,
      user_agent: 'vitest',
    };
  }

  async function createOne(
    key: keyof OrdersFixture['users'],
    title: string,
    options: Parameters<RecordMutationService['create']>[5] = { autoFollow: true },
    audit: AuditContext = auditOf(key),
  ): Promise<Id<'rec'>> {
    const result = await mutation.create(
      scope,
      fx.orders.id,
      accessOf(fx, key === 'u_out' ? 'u_admin' : key),
      {
        records: [
          {
            fields: {
              title,
              owner: [{ id: key === 'u_sales2' ? user('u_sales2') : user('u_sales1') }],
            },
          },
        ],
      },
      audit,
      options,
    );
    return result.records[0]?.id as Id<'rec'>;
  }

  async function rowsOf(recordIds: readonly Id<'rec'>[]) {
    if (recordIds.length === 0) return [];
    return db.kysely
      .selectFrom('meta.record_follows')
      .select(['organization_id', 'table_id', 'record_id', 'user_id', 'source', 'muted'])
      .where('record_id', 'in', [...recordIds])
      .orderBy('record_id')
      .orderBy('user_id')
      .execute();
  }

  const target = (recordId: Id<'rec'>, key: keyof OrdersFixture['users']) => ({
    tableId: fx.orders.id,
    recordId,
    userId: user(key),
  });

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    mutation = new RecordMutationService(db, { schema, query, now: () => NOW });
    follows = new RecordFollowService(db, query);
    repository = new RecordFollowsRepository(db);
    hooks = new RecordFollowHooks(db);
    settings = new NotificationSettingsRepository(db);
    fx = await buildOrdersFixture(db, schema, ORG_A);
    fxB = await buildOrdersFixture(db, schema, ORG_B);
    r1 = await createOne('u_admin', 'Đơn R1', {});
    r2 = await createOne('u_sales2', 'Đơn R2', {});
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  describe('catalog', () => {
    it('references org_members and tables with composite, cascading foreign keys', async () => {
      const { rows } = await sql<{ name: string; definition: string }>`
        SELECT conname AS name, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid = 'meta.record_follows'::regclass
           AND contype <> 'n' -- PostgreSQL 18 lists NOT NULL constraints too
         ORDER BY conname
      `.execute(db.kysely);
      expect(rows).toEqual([
        {
          name: 'record_follows_member_fkey',
          definition:
            'FOREIGN KEY (organization_id, user_id) REFERENCES meta.org_members(organization_id, user_id) ON DELETE CASCADE',
        },
        {
          name: 'record_follows_pkey',
          definition: 'PRIMARY KEY (organization_id, table_id, record_id, user_id)',
        },
        {
          name: 'record_follows_record_check',
          definition: "CHECK ((record_id ~~ 'rec\\_%'::text))",
        },
        {
          name: 'record_follows_source_check',
          definition:
            "CHECK ((source = ANY (ARRAY['manual'::text, 'created'::text, 'assigned'::text])))",
        },
        {
          name: 'record_follows_table_fkey',
          definition:
            'FOREIGN KEY (organization_id, table_id) REFERENCES meta.tables(organization_id, id) ON DELETE CASCADE',
        },
      ]);
    });

    it('adds the auto-follow switches to notification settings, on by default', async () => {
      const { rows } = await sql<{ name: string; type: string; nullable: string; def: string }>`
        SELECT column_name AS name, data_type AS type, is_nullable AS nullable,
               column_default AS def
          FROM information_schema.columns
         WHERE table_schema = 'meta' AND table_name = 'notification_settings'
           AND column_name LIKE 'auto_follow_%'
         ORDER BY column_name
      `.execute(db.kysely);
      expect(rows).toEqual([
        { name: 'auto_follow_assigned', type: 'boolean', nullable: 'NO', def: 'true' },
        { name: 'auto_follow_created', type: 'boolean', nullable: 'NO', def: 'true' },
      ]);
    });
  });

  describe('RecordFollowService (P39, API part)', () => {
    it('u_sales1: r2 (not readable) → 404 for get, follow and unfollow; r1 → followed (manual)', async () => {
      const sales1 = accessOf(fx, 'u_sales1');
      for (const call of [
        () => follows.status(scope, fx.orders.id, r2, sales1),
        () => follows.follow(scope, fx.orders.id, r2, sales1),
        () => follows.unfollow(scope, fx.orders.id, r2, sales1),
      ]) {
        expect(await appError(call())).toMatchObject({ code: 'NOT_FOUND' });
      }
      expect(await rowsOf([r2])).toEqual([]);

      expect(await follows.status(scope, fx.orders.id, r1, sales1)).toEqual({
        following: false,
        source: null,
      });
      await follows.follow(scope, fx.orders.id, r1, sales1);
      expect(await follows.status(scope, fx.orders.id, r1, sales1)).toEqual({
        following: true,
        source: 'manual',
      });
      // Idempotent.
      await follows.follow(scope, fx.orders.id, r1, sales1);
      expect((await rowsOf([r1])).filter((row) => row.user_id === user('u_sales1'))).toEqual([
        {
          organization_id: ORG_A,
          table_id: fx.orders.id,
          record_id: r1,
          user_id: user('u_sales1'),
          source: 'manual',
          muted: false,
        },
      ]);
    });

    it('a reader follows any record they read; another organization or a missing record is 404', async () => {
      const reader = accessOf(fx, 'u_reader');
      await follows.follow(scope, fx.orders.id, r2, reader);
      expect(await follows.status(scope, fx.orders.id, r2, reader)).toMatchObject({
        following: true,
      });
      // The table of organization A seen from organization B (tenant isolation).
      expect(
        await appError(follows.follow(scopeB, fx.orders.id, r1, accessOf(fxB, 'u_admin'))),
      ).toMatchObject({ code: 'NOT_FOUND' });
      // A record id of another table, an unknown id.
      expect(
        await appError(follows.follow(scope, fx.customers.id, r1, accessOf(fx, 'u_admin'))),
      ).toMatchObject({ code: 'NOT_FOUND' });
      expect(
        await appError(follows.follow(scope, fx.orders.id, newId('rec'), reader)),
      ).toMatchObject({ code: 'NOT_FOUND' });
      // Anonymous readers (share links) never follow.
      expect(
        await appError(
          follows.follow(scope, fx.orders.id, r1, { ...accessOf(fx, 'u_reader'), userId: null }),
        ),
      ).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a record in the trash is 404; restored, the follow is still there', async () => {
      const rec = await createOne('u_admin', 'Trash me', {});
      const reader = accessOf(fx, 'u_reader');
      await follows.follow(scope, fx.orders.id, rec, reader);
      await mutation.delete(
        scope,
        fx.orders.id,
        accessOf(fx, 'u_admin'),
        { ids: [rec] },
        auditOf('u_admin'),
      );
      for (const call of [
        () => follows.status(scope, fx.orders.id, rec, reader),
        () => follows.follow(scope, fx.orders.id, rec, reader),
        () => follows.unfollow(scope, fx.orders.id, rec, reader),
      ]) {
        expect(await appError(call())).toMatchObject({ code: 'NOT_FOUND' });
      }
      await mutation.restore(
        scope,
        fx.orders.id,
        accessOf(fx, 'u_admin'),
        { ids: [rec] },
        auditOf('u_admin'),
      );
      expect(await follows.status(scope, fx.orders.id, rec, reader)).toEqual({
        following: true,
        source: 'manual',
      });
    });

    it('following again keeps the source; unfollowing mutes, automatic sources never follow again', async () => {
      const editor = accessOf(fx, 'u_editor');
      const rec = await createOne('u_editor', 'Mine');
      expect(await follows.status(scope, fx.orders.id, rec, editor)).toEqual({
        following: true,
        source: 'created',
      });
      await follows.follow(scope, fx.orders.id, rec, editor);
      expect(await follows.status(scope, fx.orders.id, rec, editor)).toEqual({
        following: true,
        source: 'created',
      });

      await follows.unfollow(scope, fx.orders.id, rec, editor);
      await follows.unfollow(scope, fx.orders.id, rec, editor); // idempotent
      expect(await follows.status(scope, fx.orders.id, rec, editor)).toEqual({
        following: false,
        source: null,
      });
      expect((await rowsOf([rec]))[0]).toMatchObject({ muted: true });

      // Editing the record, then automatic sources: still not following.
      await mutation.update(
        scope,
        fx.orders.id,
        editor,
        { records: [{ id: rec, fields: { title: 'Mine, edited' } }] },
        auditOf('u_editor'),
      );
      await db.withTx(async (tx) => {
        const txScope = orgScope(ORG_A, tx);
        for (const source of ['created', 'assigned'] as const) {
          expect(
            await hooks.autoFollow(txScope, {
              tableId: fx.orders.id,
              userId: user('u_editor'),
              recordIds: [rec],
              source,
            }),
          ).toEqual([]);
        }
      });
      expect(await follows.status(scope, fx.orders.id, rec, editor)).toEqual({
        following: false,
        source: null,
      });

      // Only following by hand clears it.
      await follows.follow(scope, fx.orders.id, rec, editor);
      expect(await follows.status(scope, fx.orders.id, rec, editor)).toEqual({
        following: true,
        source: 'manual',
      });
    });

    it(`the cap: ${String(MAX_RECORD_FOLLOWS_PER_USER)} follows, the next one is 422 TOO_MANY_FOLLOWS`, async () => {
      const sales2 = accessOf(fx, 'u_sales2');
      const rec = await createOne('u_sales2', 'Capped', {});
      await sql`
        INSERT INTO meta.record_follows (organization_id, table_id, record_id, user_id, source)
        SELECT ${ORG_A}, ${fx.customers.id}, 'rec_' || lpad(i::text, 16, '0'), ${user('u_sales2')}, 'manual'
          FROM generate_series(1, ${MAX_RECORD_FOLLOWS_PER_USER}) AS i
      `.execute(db.kysely);
      expect(await repository.countForUser(scope, user('u_sales2'))).toBe(
        MAX_RECORD_FOLLOWS_PER_USER,
      );
      const error = await appError(follows.follow(scope, fx.orders.id, rec, sales2));
      expect(error).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [
          {
            path: 'record_id',
            code: TOO_MANY_FOLLOWS,
            params: { maximum: MAX_RECORD_FOLLOWS_PER_USER },
          },
        ],
      });
      expect(await rowsOf([rec])).toEqual([]);
      // Automatic follows past the cap are skipped silently.
      expect(
        await db.withTx((tx) =>
          hooks.autoFollow(orgScope(ORG_A, tx), {
            tableId: fx.orders.id,
            userId: user('u_sales2'),
            recordIds: [rec],
            source: 'assigned',
          }),
        ),
      ).toEqual([]);
      const created = await createOne('u_sales2', 'Created past the cap');
      expect(await rowsOf([created])).toEqual([]);
      // A record already followed is still fine (idempotent, nothing new).
      await follows.unfollow(scope, fx.orders.id, rec, sales2);

      // Muted rows do not count: unfollowing one makes room for one more.
      await repository.unfollow(scope, {
        tableId: fx.customers.id,
        recordId: `rec_${'1'.padStart(16, '0')}`,
        userId: user('u_sales2'),
      });
      await follows.follow(scope, fx.orders.id, rec, sales2);
      expect(await follows.status(scope, fx.orders.id, rec, sales2)).toEqual({
        following: true,
        source: 'manual',
      });
      expect(await appError(follows.follow(scope, fx.orders.id, r2, sales2))).toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await db.kysely
        .deleteFrom('meta.record_follows')
        .where('table_id', '=', fx.customers.id)
        .execute();
    });

    it('concurrent follows of one person cannot pass the cap together', async () => {
      const sales2 = accessOf(fx, 'u_sales2');
      const a = await createOne('u_sales2', 'Race A', {});
      const b = await createOne('u_sales2', 'Race B', {});
      const room = MAX_RECORD_FOLLOWS_PER_USER - 1;
      const already = await repository.countForUser(scope, user('u_sales2'));
      await sql`
        INSERT INTO meta.record_follows (organization_id, table_id, record_id, user_id, source)
        SELECT ${ORG_A}, ${fx.customers.id}, 'rec_' || lpad(i::text, 16, '0'), ${user('u_sales2')}, 'manual'
          FROM generate_series(1, ${room - already}) AS i
      `.execute(db.kysely);
      const results = await Promise.allSettled([
        follows.follow(scope, fx.orders.id, a, sales2),
        follows.follow(scope, fx.orders.id, b, sales2),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await repository.countForUser(scope, user('u_sales2'))).toBe(
        MAX_RECORD_FOLLOWS_PER_USER,
      );
      await db.kysely
        .deleteFrom('meta.record_follows')
        .where('table_id', '=', fx.customers.id)
        .execute();
    });
  });

  describe('following the records one creates (afterCreate)', () => {
    it('one record created by hand: the creator follows it (created); nobody else', async () => {
      const rec = await createOne('u_editor', 'By hand');
      expect(await rowsOf([rec])).toEqual([
        expect.objectContaining({ user_id: user('u_editor'), source: 'created', muted: false }),
      ]);
    });

    it('auto_follow_created off: no follow; auto_follow_assigned does not matter for creating', async () => {
      await settings.upsert(scope, user('u_reader'), {
        emailFrequency: 'immediate',
        dailyHour: 8,
        autoFollowCreated: false,
      });
      const off = await createOne('u_admin', 'Admin, on', {});
      expect(await rowsOf([off])).toEqual([]);
      // u_reader cannot add records: use the hook with u_reader as the creator.
      await db.withTx(async (tx) => {
        await hooks.afterCreate(orgScope(ORG_A, tx), {
          tableId: fx.orders.id,
          recordIds: [r1],
          context: auditOf('u_reader'),
          causation: undefined,
          options: { autoFollow: true },
        });
      });
      expect((await rowsOf([r1])).map((row) => row.user_id)).not.toContain(user('u_reader'));

      await settings.upsert(scope, user('u_admin'), {
        emailFrequency: 'immediate',
        dailyHour: 8,
        autoFollowCreated: true,
        autoFollowAssigned: false,
      });
      const on = await createOne('u_admin', 'Admin, assigned off');
      expect(await rowsOf([on])).toEqual([
        expect.objectContaining({ user_id: user('u_admin'), source: 'created' }),
      ]);
      // And assigned is off for u_admin.
      expect(
        await db.withTx((tx) =>
          hooks.autoFollow(orgScope(ORG_A, tx), {
            tableId: fx.orders.id,
            userId: user('u_admin'),
            recordIds: [r2],
            source: 'assigned',
          }),
        ),
      ).toEqual([]);
      // Turning the switch off later keeps existing follows (only new ones stop).
      await settings.upsert(scope, user('u_admin'), {
        emailFrequency: 'immediate',
        dailyHour: 8,
        autoFollowCreated: false,
      });
      expect(await rowsOf([on])).toHaveLength(1);
      const later = await createOne('u_admin', 'Admin, off');
      expect(await rowsOf([later])).toEqual([]);
      // Email settings saved without the switches keep them.
      const kept = await settings.upsert(scope, user('u_admin'), {
        emailFrequency: 'daily',
        dailyHour: 6,
      });
      expect(kept).toMatchObject({ auto_follow_created: false, auto_follow_assigned: false });
      await settings.upsert(scope, user('u_admin'), {
        emailFrequency: 'immediate',
        dailyHour: 8,
        autoFollowCreated: true,
        autoFollowAssigned: true,
      });
    });

    it('two records in one call (paste), imports, forms, share links, automations: nobody follows', async () => {
      const editor = accessOf(fx, 'u_editor');
      const pasted = await mutation.create(
        scope,
        fx.orders.id,
        editor,
        { records: [{ fields: { title: 'Paste 1' } }, { fields: { title: 'Paste 2' } }] },
        auditOf('u_editor'),
        { autoFollow: true },
      );
      expect(await rowsOf(pasted.records.map((r) => r.id))).toEqual([]);

      const jobId = newId('job');
      const imported = await createOne(
        'u_editor',
        'Imported',
        { autoFollow: true, importCells: true, readBack: true },
        { ...auditOf('u_editor', { import_job_id: jobId }), batch_id: jobId },
      );
      expect(await rowsOf([imported])).toEqual([]);

      // A member form submission: a user acting directly, but not by the record API.
      const form = await createOne('u_editor', 'Form, member', {});
      expect(await rowsOf([form])).toEqual([]);

      const viaLink = await createOne(
        'u_editor',
        'Form, link',
        { autoFollow: true },
        {
          ...auditOf('u_editor'),
          via: { share_link_id: newId('shl') },
        },
      );
      expect(await rowsOf([viaLink])).toEqual([]);

      const runId = newId('run');
      const automationId = newId('aut');
      const causation: Causation = {
        root_event_id: newId('evt'),
        depth: 1,
        automation_chain: [automationId],
      };
      const byAutomation = await createOne(
        'u_admin',
        'Automation',
        { autoFollow: true, causation },
        {
          ...auditOf('u_admin', { automation_id: automationId, run_id: runId }),
          actor: { type: 'automation', id: automationId },
          batch_id: runId,
        },
      );
      expect(await rowsOf([byAutomation])).toEqual([]);

      // System writes.
      const system = await createOne(
        'u_admin',
        'System',
        { autoFollow: true },
        systemAuditContext(),
      );
      expect(await rowsOf([system])).toEqual([]);
    });

    it('the hook alone: every condition of a write by hand is needed', async () => {
      const [hooked] = Object.values(
        await seedMembers(db, ORG_A, [{ key: 'u_hooked', name: 'Hooked' }]),
      );
      const hookedId = hooked?.id as Id<'usr'>;
      const base: AfterCreateInput = {
        tableId: fx.orders.id,
        recordIds: [r2],
        context: auditOfId(hookedId),
        causation: undefined,
        options: { autoFollow: true },
      };
      const rowsOfHooked = async () =>
        (await rowsOf([r1, r2])).filter((row) => row.user_id === hookedId);
      const cases: Partial<AfterCreateInput>[] = [
        { options: {} },
        { options: { autoFollow: false } },
        { options: { autoFollow: true, importCells: true } },
        { options: { autoFollow: true, formUpload: {} } },
        { recordIds: [r1, r2] },
        { recordIds: [] },
        { causation: { root_event_id: newId('evt'), depth: 1, automation_chain: [] } },
        { context: auditOfId(hookedId, { api_token_id: newId('tok') }) },
        { context: auditOfId(hookedId, { share_link_id: newId('shl') }) },
        { context: auditOfId(hookedId, { import_job_id: newId('job') }) },
        { context: auditOfId(hookedId, { reverted_from: newId('aud') }) },
        {
          context: {
            ...auditOfId(hookedId, { automation_id: newId('aut'), run_id: newId('run') }),
            actor: { type: 'automation', id: newId('aut') },
          },
        },
        { context: { ...auditOfId(hookedId), actor: { type: 'api_token', id: newId('tok') } } },
        { context: { ...auditOfId(hookedId), actor: { type: 'share_link', id: newId('shl') } } },
        { context: systemAuditContext() },
      ];
      for (const change of cases) {
        await db.withTx(async (tx) => {
          await hooks.afterCreate(orgScope(ORG_A, tx), { ...base, ...change });
        });
        expect(await rowsOfHooked(), JSON.stringify(change)).toEqual([]);
      }
      // A person who is not a member of this organization never follows (no FK error).
      const [stranger] = Object.values(
        await seedMembers(db, ORG_B, [{ key: 'u_stranger', name: 'Stranger' }]),
      );
      await db.withTx(async (tx) => {
        await hooks.afterCreate(orgScope(ORG_A, tx), {
          ...base,
          context: auditOfId(stranger?.id as Id<'usr'>),
        });
      });
      expect((await rowsOf([r2])).map((row) => row.user_id)).not.toContain(stranger?.id);

      // The positive control: every condition met.
      await db.withTx(async (tx) => {
        await hooks.afterCreate(orgScope(ORG_A, tx), base);
      });
      expect(await rowsOfHooked()).toEqual([
        expect.objectContaining({ record_id: r2, source: 'created', muted: false }),
      ]);
      // Automatic follows need the caller's transaction.
      await expect(
        hooks.autoFollow(scope, {
          tableId: fx.orders.id,
          userId: hookedId,
          recordIds: [r1],
          source: 'assigned',
        }),
      ).rejects.toThrow(TypeError);
    });

    it('autoFollow (assigned, T544): several records, existing follows keep their source', async () => {
      const a = await createOne('u_admin', 'Assigned A', {});
      const b = await createOne('u_admin', 'Assigned B', {});
      await follows.follow(scope, fx.orders.id, a, accessOf(fx, 'u_sales1'));
      const followed = await db.withTx((tx) =>
        hooks.autoFollow(orgScope(ORG_A, tx), {
          tableId: fx.orders.id,
          userId: user('u_sales1'),
          recordIds: [a, b, b],
          source: 'assigned',
        }),
      );
      expect(followed).toEqual([b]);
      expect((await rowsOf([a, b])).map((row) => [row.record_id, row.user_id, row.source])).toEqual(
        [
          [a, user('u_sales1'), 'manual'],
          [b, user('u_sales1'), 'assigned'],
        ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
    });

    it('a failing create leaves no follow (same transaction)', async () => {
      const before = await repository.countForUser(scope, user('u_editor'));
      await expect(
        mutation.create(
          scope,
          fx.orders.id,
          accessOf(fx, 'u_editor'),
          { records: [{ fields: { title: 'Fails' } }] },
          auditOf('u_editor'),
          {
            autoFollow: true,
            beforeCommit: () => Promise.reject(new Error('rollback')),
          },
        ),
      ).rejects.toThrow('rollback');
      expect(await repository.countForUser(scope, user('u_editor'))).toBe(before);
    });
  });

  describe('purges and memberships', () => {
    it('purging records (trash, retention) deletes their follows in the same transaction', async () => {
      const manual = await createOne('u_editor', 'Purge me');
      const retained = await createOne('u_editor', 'Retention');
      await follows.follow(scope, fx.orders.id, manual, accessOf(fx, 'u_reader'));
      await follows.unfollow(scope, fx.orders.id, manual, accessOf(fx, 'u_reader')); // a muted row too
      expect(await rowsOf([manual, retained])).toHaveLength(3);
      const admin = accessOf(fx, 'u_admin');
      await mutation.delete(
        scope,
        fx.orders.id,
        admin,
        { ids: [manual, retained] },
        auditOf('u_admin'),
      );
      // Trashed records keep their follows (a restore brings them back).
      expect(await rowsOf([manual, retained])).toHaveLength(3);
      await mutation.purge(scope, fx.orders.id, admin, { ids: [manual] }, auditOf('u_admin'));
      expect(await rowsOf([manual])).toEqual([]);
      expect(await rowsOf([retained])).toHaveLength(1);
      await mutation.purgeExpired(scope, fx.orders.id, {
        before: new Date(Date.now() + 60_000),
        auditContext: systemAuditContext(),
      });
      expect(await rowsOf([retained])).toEqual([]);
    });

    it('purging a table deletes the follows of its records; leaving the organization deletes the person’s', async () => {
      const context = systemAuditContext();
      const { table } = await schema.createTable(
        scope,
        { baseId: fx.baseId, name: 'Temporary', primaryFieldName: 'name' },
        context,
      );
      const [leaver] = Object.values(
        await seedMembers(db, ORG_A, [{ key: 'u_leaver', name: 'Leaver' }]),
      );
      const leaverId = leaver?.id as Id<'usr'>;
      const rec: Id<'rec'> = `rec_${'7'.padStart(16, '0')}`;
      await repository.follow(
        scope,
        { tableId: table.id, recordId: rec, userId: user('u_reader') },
        'manual',
      );
      await repository.follow(
        scope,
        { tableId: table.id, recordId: rec, userId: leaverId },
        'manual',
      );
      await repository.follow(
        scope,
        { tableId: fx.orders.id, recordId: r1, userId: leaverId },
        'manual',
      );
      expect(await rowsOf([rec])).toHaveLength(2);
      // T560 (T543 note): rows waiting for a grouped notification about either table.
      const buffer = new NotificationBufferRepository(db);
      const buffered = (tableId: Id<'tbl'>, recordId: Id<'rec'>) => ({
        userId: user('u_reader'),
        tableId,
        recordId,
        fieldIds: [],
        actor: null,
      });
      await buffer.append(scope, 'assigned', 'T560:purge', [
        buffered(table.id, rec),
        buffered(fx.orders.id, r1),
      ]);
      const bufferedTables = async () =>
        (
          await db.kysely
            .selectFrom('meta.notification_buffer')
            .select('table_id')
            .where('organization_id', '=', ORG_A)
            .where('group_key', '=', 'T560:purge')
            .execute()
        ).map((row) => row.table_id);
      expect(await buffer.deleteForTable(scopeB, table.id)).toBe(0);

      await db.kysely
        .deleteFrom('meta.org_members')
        .where('organization_id', '=', ORG_A)
        .where('user_id', '=', leaverId)
        .execute();
      expect((await rowsOf([rec, r1])).map((row) => row.user_id)).not.toContain(leaverId);

      await schema.deleteTable(scope, table.id, context);
      expect(await rowsOf([rec])).toHaveLength(1); // the trash keeps them
      await schema.purgeTable(
        scope,
        table.id,
        { reason: 'manual', confirmName: 'Temporary' },
        context,
      );
      expect(await rowsOf([rec])).toEqual([]);
      expect((await rowsOf([r1])).length).toBeGreaterThan(0); // other tables untouched
      expect(await bufferedTables()).toEqual([fx.orders.id]);
    });
  });

  describe('tenant isolation', () => {
    it('isolates the repository by organization', async () => {
      const recA = await createOne('u_admin', 'Tenant A', {});
      const inA = { tableId: fx.orders.id, recordId: recA, userId: user('u_reader') };
      expect(await repository.follow(scope, inA, 'manual')).toBe(true);
      expect(await repository.follow(scope, inA, 'manual')).toBe(false);
      expect(await repository.isFollowing(scope, inA)).toEqual({
        following: true,
        source: 'manual',
      });
      expect(await repository.isFollowing(scopeB, inA)).toEqual({ following: false, source: null });
      expect(await repository.followersOf(scopeB, fx.orders.id, [recA])).toEqual(new Map());
      expect(await repository.countForUser(scopeB, user('u_reader'))).toBe(0);
      expect(await repository.unfollow(scopeB, inA)).toBe(false);
      expect(await repository.deleteForRecords(scopeB, fx.orders.id, [recA])).toBe(0);
      expect(await repository.deleteForTable(scopeB, fx.orders.id)).toBe(0);
      expect(
        await db.withTx((tx) =>
          repository.followMany(orgScope(ORG_B, tx), {
            tableId: fxB.orders.id,
            userId: fxB.users.u_reader.id,
            recordIds: [recA],
            source: 'assigned',
            limit: 10,
          }),
        ),
      ).toEqual([recA]); // a row of organization B, about B's table
      expect(await repository.isFollowing(scope, inA)).toEqual({
        following: true,
        source: 'manual',
      });
      expect(await repository.followersOf(scope, fx.orders.id, [recA])).toEqual(
        new Map([[recA, [user('u_reader')]]]),
      );
      expect(await repository.deleteForRecords(scopeB, fxB.orders.id, [recA])).toBe(1);

      // A table or a person of another organization cannot be referenced (composite FKs).
      await expect(repository.follow(scopeB, inA, 'manual')).rejects.toMatchObject({
        code: '23503',
      });
      await expect(
        repository.follow(
          scope,
          { tableId: fx.orders.id, recordId: recA, userId: fxB.users.u_reader.id },
          'manual',
        ),
      ).rejects.toMatchObject({ code: '23503' });
      // Locking needs a transaction.
      await expect(repository.lockUser(scope, user('u_reader'))).rejects.toThrow(TypeError);
    });

    it('followersOf: following members by record, muted rows left out', async () => {
      const a = await createOne('u_admin', 'Followers A', {});
      const b = await createOne('u_admin', 'Followers B', {});
      for (const key of ['u_reader', 'u_editor', 'u_sales1'] as const) {
        await repository.follow(scope, target(a, key), 'manual');
      }
      await repository.follow(scope, target(b, 'u_editor'), 'created');
      await repository.unfollow(scope, target(a, 'u_editor'));
      const map = await repository.followersOf(scope, fx.orders.id, [a, b, newId('rec')]);
      expect(map).toEqual(
        new Map([
          [a, [user('u_reader'), user('u_sales1')].sort()],
          [b, [user('u_editor')]],
        ]),
      );
      expect(await repository.followersOf(scope, fx.orders.id, [])).toEqual(new Map());
    });
  });
});
