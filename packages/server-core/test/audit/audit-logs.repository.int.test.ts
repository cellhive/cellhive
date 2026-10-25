import { type Id } from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditLogsRepository,
  AuditWriter,
  type AuditContext,
  type AuditEntryInput,
} from '../../src/audit/index.js';
import { decodeCursor, orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

const ORG_A: Id<'org'> = 'org_AudRepoOrgA00001';
const ORG_B: Id<'org'> = 'org_AudRepoOrgB00001';
const TABLE: Id<'tbl'> = 'tbl_AudRepoTable0001';
const RECORD: Id<'rec'> = 'rec_AudRepoRecord001';
const FIELD_A = 'fld_AudRepoFieldA001';
const FIELD_B = 'fld_AudRepoFieldB001';
const BATCH: Id<'req'> = 'req_AudRepoBatch0001';

function context(userId: Id<'usr'>, batchId: Id<'req'> | null = null): AuditContext {
  return {
    actor: { type: 'user', id: userId },
    via: null,
    batch_id: batchId,
    request_id: batchId,
    ip: '203.0.113.9',
    user_agent: 'vitest',
  };
}

/**
 * `AuditLogsRepository` (T111): history filtering, batch counts, admin list
 * filters and cursor, view dedup lookup and redaction — and tenant
 * isolation of every method (AGENTS.md rule 5): the same ids written in
 * organization B are never returned, counted nor redacted through A.
 */
describe('AuditLogsRepository', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: AuditLogsRepository;
  let a: OrgScope;
  let b: OrgScope;
  let userA: Id<'usr'>;
  let userB: Id<'usr'>;
  const writer = new AuditWriter();
  const ids: Record<string, Id<'aud'>> = {};

  async function write(key: string, entry: AuditEntryInput): Promise<void> {
    ids[key] = (await db.withTx((tx) => writer.write(tx, entry))).id;
  }

  function recordEntry(
    org: Id<'org'>,
    user: Id<'usr'>,
    action: AuditEntryInput['action'],
    before: Record<string, number> | null,
    after: Record<string, number> | null,
    batch: Id<'req'> | null = null,
  ): AuditEntryInput {
    return {
      action,
      organizationId: org,
      tableId: TABLE,
      entityType: 'record',
      entityId: RECORD,
      before,
      after,
      context: context(user, batch),
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    userA = (await seedTenant(db, ORG_A)).userId;
    userB = (await seedTenant(db, ORG_B)).userId;
    repo = new AuditLogsRepository(db);
    a = orgScope(ORG_A);
    b = orgScope(ORG_B);

    // Same table/record/batch ids in both organizations.
    for (const [org, user, prefix] of [
      [ORG_A, userA, 'a'],
      [ORG_B, userB, 'b'],
    ] as const) {
      await write(
        `${prefix}Created`,
        recordEntry(org, user, 'record.created', null, { [FIELD_A]: 1 }),
      );
      await write(
        `${prefix}OnlyB`,
        recordEntry(org, user, 'record.updated', { [FIELD_B]: 1 }, { [FIELD_B]: 2 }, BATCH),
      );
      await write(
        `${prefix}Both`,
        recordEntry(
          org,
          user,
          'record.updated',
          { [FIELD_A]: 1, [FIELD_B]: 2 },
          { [FIELD_A]: 3, [FIELD_B]: 4 },
          BATCH,
        ),
      );
      await write(`${prefix}Deleted`, recordEntry(org, user, 'record.deleted', null, null));
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('getById: only entries of the scope organization', async () => {
    expect((await repo.getById(a, ids.aBoth as string))?.id).toBe(ids.aBoth);
    expect(await repo.getById(a, ids.bBoth as string)).toBeUndefined();
    expect(await repo.getById(b, ids.aBoth as string)).toBeUndefined();
    const row = await repo.getById(a, ids.aBoth as string);
    expect(row).toMatchObject({ actor_name: expect.any(String) as unknown, ip: '203.0.113.9' });
  });

  it('listRecordHistory: drops entries whose fields are all hidden, keeps deletes', async () => {
    const page = await repo.listRecordHistory(
      a,
      { tableId: TABLE, recordId: RECORD, visibleFieldIds: [FIELD_A] },
      { cursor: null, limit: 50 },
    );
    expect(page.items.map((row) => row.id)).toEqual([ids.aDeleted, ids.aBoth, ids.aCreated]);
    expect(page.nextCursor).toBeNull();

    const onlyB = await repo.listRecordHistory(
      a,
      { tableId: TABLE, recordId: RECORD, visibleFieldIds: [FIELD_A, FIELD_B], fieldId: FIELD_B },
      { cursor: null, limit: 50 },
    );
    expect(onlyB.items.map((row) => row.id)).toEqual([ids.aBoth, ids.aOnlyB]);
  });

  it('listRecordHistory: keyset cursor walks every page once', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repo.listRecordHistory(
        a,
        { tableId: TABLE, recordId: RECORD, visibleFieldIds: [FIELD_A, FIELD_B] },
        { cursor: cursor === null ? null : decodeCursor(cursor), limit: 1 },
      );
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([ids.aDeleted, ids.aBoth, ids.aOnlyB, ids.aCreated]);
  });

  it('countRecordBatches: counts only the scope organization', async () => {
    expect(await repo.countRecordBatches(a, [BATCH])).toEqual(new Map([[BATCH, 2]]));
    expect(await repo.countRecordBatches(b, [BATCH])).toEqual(new Map([[BATCH, 2]]));
    expect(await repo.countRecordBatches(a, [])).toEqual(new Map());
  });

  it('list: filters and cursor stay inside the organization', async () => {
    const all = await repo.list(a, {}, { cursor: null, limit: 50 });
    expect(all.items.every((row) => row.organization_id === ORG_A)).toBe(true);
    expect(all.items).toHaveLength(4);
    const batch = await repo.list(
      a,
      { batchId: BATCH, actorIds: [userA] },
      { cursor: null, limit: 1 },
    );
    expect(batch.items.map((row) => row.id)).toEqual([ids.aBoth]);
    expect(batch.nextCursor).not.toBeNull();
    const next = await repo.list(
      a,
      { batchId: BATCH },
      { cursor: decodeCursor(batch.nextCursor ?? undefined), limit: 5 },
    );
    expect(next.items.map((row) => row.id)).toEqual([ids.aOnlyB]);
    expect((await repo.list(a, { actorIds: [userB] }, { cursor: null, limit: 50 })).items).toEqual(
      [],
    );
    const future = new Date(Date.now() + 60_000);
    expect((await repo.list(a, { from: future }, { cursor: null, limit: 50 })).items).toEqual([]);
    expect((await repo.list(a, { to: future }, { cursor: null, limit: 50 })).items).toHaveLength(4);
  });

  it('redact: changes only the scope organization and skips the requester', async () => {
    // userA requests in org B: nothing of org A changes; org B entries by userB are redacted.
    const count = await db.withTx((tx) =>
      repo.redact(orgScope(ORG_B, tx), userA, { entityType: 'record', entityIds: [RECORD] }),
    );
    expect(count).toBe(4);
    expect((await repo.getById(b, ids.bBoth as string))?.before).toEqual({ redacted: true });
    expect((await repo.getById(a, ids.aBoth as string))?.before).toEqual({
      [FIELD_A]: 1,
      [FIELD_B]: 2,
    });
    // The requester's own entries are never redacted.
    const own = await db.withTx((tx) =>
      repo.redact(orgScope(ORG_A, tx), userA, { entityType: 'record', entityIds: [RECORD] }),
    );
    expect(own).toBe(0);
  });
});
