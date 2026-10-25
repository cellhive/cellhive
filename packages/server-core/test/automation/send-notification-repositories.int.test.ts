import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AutomationMessageQuotaRepository,
  checkSendNotificationRecipients,
  SUMMARY_GROUP_KEY_PREFIX,
} from '../../src/automation/index.js';
import {
  GroupsRepository,
  orgScope,
  OrgMembersRepository,
  type Db,
  type OrgScope,
  withTxScope,
} from '../../src/db/index.js';
import {
  NotificationsRepository,
  NotificationWriter,
  type PreparedNotification,
} from '../../src/notifications/index.js';
import { FieldsRepository, TablesRepository } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { AutomationDefinition, Id } from '@cellhive/contracts';

const ORG_A = 'org_SendNoteOrgA0001';
const ORG_B = 'org_SendNoteOrgB0001';
const AUT: Id<'aut'> = 'aut_SendNoteAuto0001';
const TABLE: Id<'tbl'> = 'tbl_SendNoteTable001';
const FIELD: Id<'fld'> = 'fld_SendNoteField001';
const REC: Id<'rec'> = 'rec_SendNoteRecord01';
const OTHER_REC: Id<'rec'> = 'rec_SendNoteRecord02';

/**
 * BACKLOG T515 repositories: the hourly count of `automation.message` and
 * the summary rows, the purge of notifications about records, the
 * save-time check of fixed users and groups — all scoped to their
 * organization (AGENTS.md rule 5).
 */
describe('send_notification repositories (T515)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    const members = new OrgMembersRepository(db);
    await members.add(scopeA, a.userId, 'member');
    await members.add(scopeB, b.userId, 'member');
    // The user of A is also a member of B.
    await members.add(scopeB, a.userId, 'member');
    await db.withTx(async (tx) => {
      const txScope = withTxScope(scopeA, tx);
      await new TablesRepository(db).insert(txScope, {
        id: TABLE,
        baseId: a.baseId,
        name: 'Orders',
        description: null,
        dbTableName: 't_sendnote0001',
        collation: 'und-x-icu',
        position: 0,
      });
      await new FieldsRepository(db).insert(txScope, {
        id: FIELD,
        tableId: TABLE,
        name: 'Name',
        type: 'text',
        dbColumnName: 'f_sendnote0001',
        options: {},
        isPrimary: true,
        required: false,
        uniqueValues: false,
        description: null,
        position: 0,
      });
      await new TablesRepository(db).update(txScope, TABLE, { primaryFieldId: FIELD });
    });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  const message = (
    userId: Id<'usr'>,
    baseId: Id<'bse'>,
    overrides: Partial<PreparedNotification> = {},
  ): PreparedNotification => ({
    userId,
    type: 'automation.message',
    baseId,
    tableId: null,
    entityType: 'automation',
    entityId: AUT,
    actor: { type: 'automation', id: AUT },
    groupKey: null,
    data: { automation_id: AUT, run_id: 'run_SendNoteRun00001', title: 'T', body: '' },
    ...overrides,
  });

  const write = (org: Id<'org'>, items: PreparedNotification[]) =>
    db.withTx((tx) => new NotificationWriter(db, { emailEnabled: false }).write(tx, org, items));

  it('counts the messages of the past hour per user, summaries excluded, per organization', async () => {
    const quota = new AutomationMessageQuotaRepository(db);
    await write(ORG_A, [
      message(a.userId, a.baseId),
      message(a.userId, a.baseId),
      message(a.userId, a.baseId, { groupKey: `${SUMMARY_GROUP_KEY_PREFIX}${AUT}:x` }),
      message(a.userId, a.baseId, {
        type: 'automation.batch_overflow',
        data: { automation_id: AUT, run_id: 'run_SendNoteRun00001', batch_id: 'b', limit: 1 },
      }),
    ]);
    await write(ORG_B, [message(a.userId, b.baseId)]);
    const since = new Date(Date.now() - 60 * 60 * 1000);
    expect(await quota.countSince(scopeA, [a.userId, b.userId], since)).toEqual(
      new Map([[a.userId, 2]]),
    );
    expect(await quota.countSince(scopeB, [a.userId], since)).toEqual(new Map([[a.userId, 1]]));
    expect(await quota.countSince(scopeA, [a.userId], new Date(Date.now() + 1000))).toEqual(
      new Map(),
    );
  });

  it('locks and replaces summaries of its organization only', async () => {
    const quota = new AutomationMessageQuotaRepository(db);
    const key = `${SUMMARY_GROUP_KEY_PREFIX}${AUT}:2026-10-05T08`;
    const [written] = await write(ORG_A, [
      message(a.userId, a.baseId, {
        groupKey: key,
        data: {
          automation_id: AUT,
          run_id: 'run_SendNoteRun00001',
          title: '1',
          body: '',
          summary_count: 1,
        },
      }),
    ]);
    const id = written?.id as Id<'ntf'>;
    await db.withTx(async (tx) => {
      const inB = await quota.lockSummaries(orgScope(ORG_B, tx), [a.userId], key);
      expect(inB.size).toBe(0);
      expect(await quota.deleteSummaries(orgScope(ORG_B, tx), [id])).toBe(0);
      const inA = await quota.lockSummaries(orgScope(ORG_A, tx), [a.userId], key);
      expect(inA.get(a.userId)).toMatchObject({ id, payload: { summary_count: 1 } });
    });
    // Only summaries are deleted, never a message.
    const [plain] = await write(ORG_A, [message(a.userId, a.baseId, { groupKey: 'run_x:act_1' })]);
    expect(await quota.deleteSummaries(scopeA, [plain?.id as Id<'ntf'>])).toBe(0);
    expect(await quota.deleteSummaries(scopeA, [id])).toBe(1);
  });

  it('deletes notifications about records of a purged table, per organization', async () => {
    const repo = new NotificationsRepository(db);
    const onRecord = (recordId: Id<'rec'>) =>
      message(a.userId, a.baseId, { tableId: TABLE, entityType: 'record', entityId: recordId });
    await write(ORG_A, [onRecord(REC), onRecord(OTHER_REC)]);
    expect(await repo.deleteRecordsOfTable(scopeB, TABLE)).toBe(0);
    expect(await repo.deleteByEntity(scopeB, 'record', [REC])).toBe(0);
    expect(await repo.deleteByEntity(scopeA, 'record', [REC])).toBe(1);
    expect(await repo.deleteRecordsOfTable(scopeA, TABLE)).toBe(1);
    const left = await db.kysely
      .selectFrom('meta.notifications')
      .select('entity_id')
      .where('organization_id', '=', ORG_A)
      .where('entity_type', '=', 'record')
      .execute();
    expect(left).toEqual([]);
  });

  it('checks fixed users and groups against the organization', async () => {
    const group = await new GroupsRepository(db).create(scopeA, { name: 'Kho' });
    const groupB = await new GroupsRepository(db).create(scopeB, { name: 'Kho' });
    const definition = {
      trigger: { type: 'schedule', cron: '0 8 * * *', timezone: null },
      condition: null,
      actions: [
        {
          id: 'act_note',
          type: 'send_notification',
          config: {
            recipients: [
              { user_ids: [a.userId, b.userId] },
              { group_id: group.id },
              { group_id: groupB.id },
            ],
            title: { template: 'x' },
            body: { template: '' },
            link_record: 'trigger',
            skip_actor: false,
          },
        },
      ],
    } as unknown as AutomationDefinition;
    const errors = await checkSendNotificationRecipients(db, scopeA, definition);
    expect(errors.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: 'definition.actions[0].config.recipients[0].user_ids[1]', code: 'USER_NOT_FOUND' },
      { path: 'definition.actions[0].config.recipients[2].group_id', code: 'GROUP_NOT_FOUND' },
    ]);
  });
});
