import { createHash } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditLogsRepository,
  AuditRefsRepository,
  AuditWriter,
  type AuditContext,
  type AuditEntryInput,
} from '../../src/audit/index.js';
import { orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import {
  actorOf,
  captureQueries,
  createPartitions,
  explain,
  insertAuditVolume,
} from './audit-volume.js';

import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_AudViewOrgA00001';
const ORG_B: Id<'org'> = 'org_AudViewOrgB00001';
const ORG_V: Id<'org'> = 'org_AudViewOrgV00001';

function context(
  userId: Id<'usr'>,
  via: AuditContext['via'] = null,
  actorType: 'user' | 'automation' = 'user',
): AuditContext {
  return {
    actor: { type: actorType, id: userId },
    via,
    batch_id: null,
    request_id: null,
    ip: null,
    user_agent: null,
  };
}

/**
 * T709: the audit viewer's repository side — repeatable filters, action
 * groups, `via`, the `refs` lookups and the base of a base export, each
 * proven inside one organization (the same ids written in another
 * organization are never returned, named nor counted), and the query
 * plans: keyset pages on the actor/action indexes, partitions pruned by
 * `from`.
 */
describe('audit viewer repository (T709)', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: AuditLogsRepository;
  let refs: AuditRefsRepository;
  let a: SeededTenant;
  let b: SeededTenant;
  let sa: OrgScope;
  let sb: OrgScope;
  const writer = new AuditWriter();
  const ids: Record<string, Id<'aud'>> = {};
  // Schema ids of organization A ('A') and B ('B'); a field id named by an
  // entry that no longer exists.
  const TABLE = (label: string) => `tbl_AudViewTable000${label}` as Id<'tbl'>;
  const FIELD = (label: string) => `fld_AudViewField000${label}` as Id<'fld'>;
  const TOKEN = (label: string) => `tok_AudViewToken000${label}` as Id<'tok'>;
  const GONE_FIELD: Id<'fld'> = 'fld_AudViewFieldGone';

  async function write(key: string, entry: AuditEntryInput): Promise<void> {
    ids[key] = (await db.withTx((tx) => writer.write(tx, entry))).id;
  }

  async function seedSchema(tenant: SeededTenant, label: string): Promise<void> {
    await sql`INSERT INTO meta.org_members (organization_id, user_id, role)
              VALUES (${tenant.orgId}, ${tenant.userId}, 'owner')`.execute(db.kysely);
    await sql`INSERT INTO meta.tables (id, organization_id, base_id, name, db_table_name, "collation")
              VALUES (${TABLE(label)}, ${tenant.orgId}, ${tenant.baseId}, ${`Orders ${label}`},
                      ${`t_audview0000${label.toLowerCase()}`}, 'und-x-icu')`.execute(db.kysely);
    await sql`INSERT INTO meta.fields (id, organization_id, table_id, name, type)
              VALUES (${FIELD(label)}, ${tenant.orgId}, ${TABLE(label)}, ${`Amount ${label}`},
                      'number')`.execute(db.kysely);
    await sql`INSERT INTO meta.api_tokens
                (id, organization_id, user_id, name, token_prefix, token_hash, scopes)
              VALUES (${TOKEN(label)}, ${tenant.orgId}, ${tenant.userId}, ${`Sync ${label}`},
                      ${`${label}aaaaaaa`},
                      ${createHash('sha256').update(label).digest()}, ARRAY['records:read'])`.execute(
      db.kysely,
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    repo = new AuditLogsRepository(db);
    refs = new AuditRefsRepository(db);
    sa = orgScope(ORG_A);
    sb = orgScope(ORG_B);
    await seedSchema(a, 'A');
    await seedSchema(b, 'B');

    for (const [tenant, prefix, label] of [
      [a, 'a', 'A'],
      [b, 'b', 'B'],
    ] as const) {
      const record = (action: AuditEntryInput['action'], via: AuditContext['via'] = null) => ({
        action,
        organizationId: tenant.orgId,
        baseId: tenant.baseId,
        tableId: TABLE(label),
        entityType: 'record',
        entityId: 'rec_AudViewRecord001',
        before: { [FIELD(label)]: 1 },
        after: { [FIELD(label)]: 2, [GONE_FIELD]: 3 },
        context: context(tenant.userId, via),
      });
      await write(`${prefix}Created`, record('record.created'));
      await write(`${prefix}ByToken`, record('record.updated', { api_token_id: TOKEN(label) }));
      await write(
        `${prefix}Imported`,
        record('record.created', { import_job_id: 'job_AudViewImport001' }),
      );
      await write(`${prefix}FieldUpdated`, {
        action: 'field.updated',
        organizationId: tenant.orgId,
        baseId: tenant.baseId,
        tableId: TABLE(label),
        entityType: 'field',
        entityId: FIELD(label),
        context: context(tenant.userId),
      });
      await write(`${prefix}Login`, {
        action: 'auth.login',
        organizationId: tenant.orgId,
        entityType: 'user',
        entityId: tenant.userId,
        context: context(tenant.userId),
      });
      await write(`${prefix}Exported`, {
        action: 'audit.exported',
        organizationId: tenant.orgId,
        baseId: tenant.baseId,
        entityType: 'job',
        entityId: 'job_AudViewExport001',
        after: { format: 'csv', filters: { base_id: tenant.baseId } },
        context: context(tenant.userId),
      });
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  const listIds = async (scope: OrgScope, filter: Parameters<AuditLogsRepository['list']>[1]) =>
    (await repo.list(scope, filter, { cursor: null, limit: 50 })).items.map((row) => row.id);

  it('list: several actors / actions are OR, different filters AND', async () => {
    expect(await listIds(sa, { actions: ['record.created', 'field.updated'] })).toEqual([
      ids.aFieldUpdated,
      ids.aImported,
      ids.aCreated,
    ]);
    expect(
      await listIds(sa, { actions: ['record.created', 'field.updated'], entityType: 'field' }),
    ).toEqual([ids.aFieldUpdated]);
    expect(await listIds(sa, { actorIds: [a.userId, b.userId], actions: ['auth.login'] })).toEqual([
      ids.aLogin,
    ]);
    expect(await listIds(sb, { actorIds: [a.userId] })).toEqual([]);
    expect(await listIds(sa, { actions: [] })).toEqual([]);
  });

  it('list: action groups expand to their actions; with actions, both must hold', async () => {
    expect(await listIds(sa, { actionPrefixes: ['record.'] })).toEqual([
      ids.aImported,
      ids.aByToken,
      ids.aCreated,
    ]);
    expect(await listIds(sa, { actionPrefixes: ['auth.', 'field.'] })).toEqual([
      ids.aLogin,
      ids.aFieldUpdated,
    ]);
    expect(
      await listIds(sa, { actionPrefixes: ['record.'], actions: ['record.updated', 'auth.login'] }),
    ).toEqual([ids.aByToken]);
    expect(await listIds(sa, { actionPrefixes: ['record.'], actions: ['auth.login'] })).toEqual([]);
    expect(await listIds(sb, { actionPrefixes: ['auth.'] })).toEqual([ids.bLogin]);
  });

  it('list: via matches the source key of `via`', async () => {
    expect(await listIds(sa, { via: ['api_token'] })).toEqual([ids.aByToken]);
    expect(await listIds(sa, { via: ['import', 'api_token'] })).toEqual([
      ids.aImported,
      ids.aByToken,
    ]);
    expect(await listIds(sa, { via: ['share_link'] })).toEqual([]);
    expect(await listIds(sb, { via: ['api_token'] })).toEqual([ids.bByToken]);
  });

  it('exportedBaseOf: the base of the audit.exported entry, in the organization only', async () => {
    expect(await repo.exportedBaseOf(sa, 'job_AudViewExport001')).toBe(a.baseId);
    expect(await repo.exportedBaseOf(sb, 'job_AudViewExport001')).toBe(b.baseId);
    expect(await repo.exportedBaseOf(sa, 'job_AudViewUnknown01')).toBeNull();
  });

  it('refs: users of the organization only', async () => {
    const stranger = await seedTenant(db, ORG_V);
    const named = await refs.users(sa, [a.userId, b.userId, stranger.userId]);
    expect(named).toEqual([{ id: a.userId, display_name: a.userId.slice(4) }]);
    expect(await refs.users(sb, [a.userId])).toEqual([]);
    expect(await refs.users(sa, [])).toEqual([]);
  });

  it('refs: fields and tables of the organization, of the base when asked', async () => {
    expect(await refs.fields(sa, [FIELD('A'), FIELD('B'), GONE_FIELD], null)).toEqual([
      { id: FIELD('A'), name: 'Amount A', table_id: TABLE('A'), deleted: false },
    ]);
    expect(await refs.fields(sb, [FIELD('A'), FIELD('B')], null)).toEqual([
      { id: FIELD('B'), name: 'Amount B', table_id: TABLE('B'), deleted: false },
    ]);
    expect(await refs.fields(sa, [FIELD('A')], a.baseId)).toHaveLength(1);
    // Another base than the field's: not named.
    expect(await refs.fields(sa, [FIELD('A')], b.baseId)).toEqual([]);
    expect(await refs.tables(sa, [TABLE('A'), TABLE('B')], null)).toEqual([
      { id: TABLE('A'), name: 'Orders A', deleted: false },
    ]);
    expect(await refs.tables(sb, [TABLE('A'), TABLE('B')], b.baseId)).toEqual([
      { id: TABLE('B'), name: 'Orders B', deleted: false },
    ]);
    expect(await refs.tables(sa, [TABLE('A')], b.baseId)).toEqual([]);
    await sql`UPDATE meta.fields SET deleted_at = now() WHERE id = ${FIELD('A')}`.execute(
      db.kysely,
    );
    expect(await refs.fields(sa, [FIELD('A')], a.baseId)).toEqual([
      { id: FIELD('A'), name: 'Amount A', table_id: TABLE('A'), deleted: true },
    ]);
  });

  it('refs: API tokens of the organization, with their owner', async () => {
    expect(await refs.apiTokens(sa, [TOKEN('A'), TOKEN('B')])).toEqual([
      { id: TOKEN('A'), name: 'Sync A', user_id: a.userId },
    ]);
    expect(await refs.apiTokens(sb, [TOKEN('A'), TOKEN('B')])).toEqual([
      { id: TOKEN('B'), name: 'Sync B', user_id: b.userId },
    ]);
    expect(await refs.apiTokens(orgScope(ORG_V), [TOKEN('A')])).toEqual([]);
  });

  describe('query plans', () => {
    const PLAN_ORG: Id<'org'> = 'org_AudViewPlanOrg01';
    const OTHER_ORG: Id<'org'> = 'org_AudViewPlanOrg02';
    const BASES: [Id<'bse'>, Id<'bse'>] = ['bse_AudViewPlanBase1', 'bse_AudViewPlanBase2'];
    const days = 100;

    beforeAll(async () => {
      await seedTenant(db, PLAN_ORG);
      await seedTenant(db, OTHER_ORG);
      await createPartitions(db, 4);
      await insertAuditVolume(db, {
        orgId: PLAN_ORG,
        count: 60_000,
        actors: 40,
        days,
        baseIds: BASES,
      });
      await insertAuditVolume(db, {
        orgId: OTHER_ORG,
        count: 20_000,
        actors: 40,
        days,
        baseIds: BASES,
      });
      await sql`ANALYZE meta.audit_logs`.execute(db.kysely);
    });

    const planOf = async (filter: Parameters<AuditLogsRepository['list']>[1]) => {
      const captured = await captureQueries(database.url, PLAN_ORG, (scope) =>
        repo.list(scope, filter, { cursor: null, limit: 50 }),
      );
      expect(captured).toHaveLength(1);
      return explain(db, database.url, captured[0] as (typeof captured)[number]);
    };
    const allPartitions = async () =>
      (
        await sql<{ name: string }>`
          SELECT c.relname AS name FROM pg_inherits AS i
            JOIN pg_class AS c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'meta.audit_logs'::regclass`.execute(db.kysely)
      ).rows.length;

    it('an actor over 7 days: audit_logs_actor_idx, only the partitions of those days', async () => {
      const plan = await planOf({
        actorIds: [actorOf(PLAN_ORG, 3)],
        from: new Date(Date.now() - 7 * 86_400_000),
      });
      expect(plan.indexes).toEqual(['audit_logs_actor_idx']);
      expect(plan.seqScan).toBe(false);
      expect(plan.partitions.length).toBeGreaterThan(0);
      expect(plan.partitions.length).toBeLessThanOrEqual(2);
      expect(await allPartitions()).toBeGreaterThan(plan.partitions.length + 2);
    });

    it('a rare action over 7 days: audit_logs_action_idx, partitions pruned', async () => {
      const plan = await planOf({
        actions: ['role.updated'],
        from: new Date(Date.now() - 7 * 86_400_000),
      });
      expect(plan.indexes).toEqual(['audit_logs_action_idx']);
      expect(plan.seqScan).toBe(false);
      expect(plan.partitions.length).toBeLessThanOrEqual(2);
    });

    it('a rare action group without dates: audit_logs_action_idx', async () => {
      // `api_token.*` (3 actions) never occurs in the volume: walking the
      // organization index would read every entry.
      const plan = await planOf({ actionPrefixes: ['api_token.'] });
      expect(plan.indexes).toEqual(['audit_logs_action_idx']);
      expect(plan.seqScan).toBe(false);
    });

    it('a common action group: an index, never a sequential scan', async () => {
      const plan = await planOf({ actionPrefixes: ['auth.', 'role.'] });
      expect(plan.seqScan).toBe(false);
      expect(plan.indexes.length).toBeGreaterThan(0);
    });

    it('several actors: still an index, never a sequential scan', async () => {
      const plan = await planOf({
        actorIds: [actorOf(PLAN_ORG, 1), actorOf(PLAN_ORG, 2), actorOf(PLAN_ORG, 5)],
        from: new Date(Date.now() - 7 * 86_400_000),
      });
      expect(plan.seqScan).toBe(false);
      expect(plan.indexes.length).toBeGreaterThan(0);
    });

    it('no filter (first page): the organization index, newest partitions first', async () => {
      const plan = await planOf({});
      expect(plan.indexes).toEqual(['audit_logs_org_created_idx']);
      expect(plan.seqScan).toBe(false);
    });
  });
});
