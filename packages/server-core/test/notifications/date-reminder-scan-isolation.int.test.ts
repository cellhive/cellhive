/**
 * QA T559 H2: a date reminder field whose scan fails (statement timeout,
 * database error…) no longer stops `scanAll`: the fields listed after it —
 * other organizations' — are scanned on time; the failing field keeps its
 * cursor and is tried again next scan.
 */
import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import { resolveMemberBaseAccess } from '../../src/import/member-access.js';
import {
  DateReminderCursorsRepository,
  DateReminderScanner,
} from '../../src/notifications/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

const ORG_A: Id<'org'> = 'org_T559QaRemindOrgA';
const ORG_B: Id<'org'> = 'org_T559QaRemindOrgB';
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };
const at = (iso: string) => new Date(iso);

describe('date reminder scan: one failing field (QA T559 H2)', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('a failing field does not stop the fields of other organizations', async () => {
    const context = systemAuditContext();
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const query = new RecordQueryService(db);
    const mutation = new RecordMutationService(db, { schema, query });
    const a = await seedTenant(db, ORG_A);
    const b = await seedTenant(db, ORG_B);
    await db.kysely
      .insertInto('meta.org_members')
      .values([
        { organization_id: ORG_A, user_id: a.userId, role: 'owner' as const },
        { organization_id: ORG_B, user_id: b.userId, role: 'owner' as const },
      ])
      .execute();
    const withReminder = (userId: Id<'usr'>) => ({
      style: { format: 'yyyy-MM-dd HH:mm' },
      reminder: { recipients: 'users', user_ids: [userId] },
    });
    const tableA = (
      await schema.createTable(
        orgScope(ORG_A),
        { baseId: a.baseId, name: 'A', primaryFieldName: 'title' },
        context,
      )
    ).table;
    const tableB = (
      await schema.createTable(
        orgScope(ORG_B),
        { baseId: b.baseId, name: 'B', primaryFieldName: 'title' },
        context,
      )
    ).table;
    await schema.addField(
      orgScope(ORG_A),
      tableA.id,
      { name: 'due', type: 'datetime', options: withReminder(a.userId) },
      context,
    );
    const healthy = await schema.addField(
      orgScope(ORG_B),
      tableB.id,
      { name: 'due', type: 'datetime', options: withReminder(b.userId) },
      context,
    );
    const access = await resolveMemberBaseAccess(
      db,
      orgScope(ORG_B),
      { userId: b.userId, baseId: b.baseId },
      DEFAULTS,
    );
    const requestId = newId('req');
    await mutation.create(
      orgScope(ORG_B),
      tableB.id,
      (access ?? expect.fail('no access')).record,
      { records: [{ fields: { title: 'b', due: '2027-07-01T10:00:00.000Z' } }] },
      {
        actor: { type: 'user', id: b.userId },
        via: null,
        batch_id: requestId,
        request_id: requestId,
        ip: null,
        user_agent: 'vitest',
      },
    );

    // ORG_A's scan times out (statement timeout on a huge table whose scan
    // index could not be built, a database error, …): ORG_A sorts first.
    class TimingOut extends RecordQueryService {
      override async scanDue(...args: Parameters<RecordQueryService['scanDue']>) {
        if (args[1] === tableA.id) {
          throw new AppError('QUERY_TIMEOUT', { detail: 'statement timeout' });
        }
        return super.scanDue(...args);
      }
    }
    const scanner = new DateReminderScanner(db, { defaults: DEFAULTS, records: new TimingOut(db) });
    const tick = await scanner.scanAll(at('2027-07-01T10:00:00.000Z'));
    expect(tick.results.map((item) => [item.organizationId, item.outcome, item.errorCode])).toEqual(
      [
        [ORG_A, 'error', 'QUERY_TIMEOUT'],
        [ORG_B, 'reminded', undefined],
      ],
    );
    // ORG_B's reminder (due 10:00) is queued and its cursor moved past it.
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM graphile_worker.jobs
       WHERE task_identifier = 'notifications.fanout'`.execute(db.kysely);
    expect(rows[0]?.n).toBe('1');
    const cursor = await new DateReminderCursorsRepository(db).get(orgScope(ORG_B), healthy.id);
    expect(cursor?.scannedUntil.getTime()).toBe(at('2027-07-01T10:00:00.000Z').getTime());
  });
});
