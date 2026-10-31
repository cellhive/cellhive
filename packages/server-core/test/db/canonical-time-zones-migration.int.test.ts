import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { AutomationsRepository, AutomationTimeTriggers } from '../../src/automation/index.js';
import { createMigrator, migrateToLatest, orgScope, type Db } from '../../src/db/index.js';
import { up } from '../../src/db/migrations/0055_canonical_time_zones.js';
import { resolveMemberBaseAccess } from '../../src/import/index.js';
import { migrateJobQueue } from '../../src/jobs/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { insertRows } from '../records/fixtures.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_T901CanonTzOrgA1';
const ORG_B: Id<'org'> = 'org_T901CanonTzOrgB1';
const USER_ODD: Id<'usr'> = 'usr_T901CanonTzOdd01';
const AUT_ZONED: Id<'aut'> = 'aut_T901CanonTzSch01';
const AUT_ORG_ZONE: Id<'aut'> = 'aut_T901CanonTzSch02';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STYLE = { format: 'yyyy-MM-dd HH:mm' };

/**
 * BACKLOG T901 (QA S7 H1, L9): migration 0055 on a database whose zones
 * were stored before T819 by the name the browser or the caller sent.
 * `postgres:18` has no tzdata `backward`: `Asia/Saigon` fails in SQL there.
 */
describe('migration 0055_canonical_time_zones (T901)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let schema: SchemaService;
  let mutation: RecordMutationService;
  let a: SeededTenant;
  let b: SeededTenant;
  let table: TableRow;
  const f = {} as Record<'due' | 'start' | 'created' | 'odd' | 'hours', FieldRow>;
  let record: Id<'rec'>;
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();

  const fieldOptions = async (id: Id<'fld'>) =>
    (
      await db.kysely
        .selectFrom('meta.fields')
        .select('options')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).options;

  /** Stored values of `hours` (TEST ONLY: reads the column). */
  async function hours(): Promise<number | null> {
    const field = await db.kysely
      .selectFrom('meta.fields')
      .select(['db_column_name', 'compute_state'])
      .where('id', '=', f.hours.id)
      .executeTakeFirstOrThrow();
    expect(field.compute_state).toBe('ready');
    const { rows } = await sql<{ v: string | null }>`
      SELECT ${sql.id(field.db_column_name ?? '')} AS v
        FROM ${sql.id('data', table.db_table_name)} WHERE __id = ${record}
    `.execute(db.kysely);
    const value = rows[0]?.v;
    return value == null ? null : Number(value);
  }

  /** Writes a stored value as T819-era code did: the name as sent, past today's schemas. */
  const setJson = (target: string, column: string, id: string, path: string, value: unknown) =>
    sql`
      UPDATE ${sql.table(target)}
         SET ${sql.ref(column)} = jsonb_set(${sql.ref(column)}, ${path}::text[], ${JSON.stringify(value)}::jsonb)
       WHERE id = ${id}
    `.execute(db.kysely);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    await migrateJobQueue({ connectionString: database.url });
    const { error } = await createMigrator(db.kysely).migrateTo('0054_ai_settings');
    expect(error).toBeUndefined();

    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const query = new RecordQueryService(db);
    mutation = new RecordMutationService(db, { schema, query });
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: ORG_A, user_id: a.userId, role: 'owner' })
      .execute();
    await db.kysely
      .insertInto('meta.users')
      .values({ id: USER_ODD, email: 'odd@example.test', display_name: 'Odd' })
      .execute();

    ({ table } = await schema.createTable(
      scope,
      { baseId: a.baseId, name: 'Orders', primaryFieldName: 'title' },
      context,
    ));
    const add = (name: string, type: string, options: unknown) =>
      schema.addField(scope, table.id, { name, type, options }, context);
    f.due = await add('due', 'datetime', { style: STYLE, timezone: 'Asia/Ho_Chi_Minh' });
    f.start = await add('start', 'datetime', { style: STYLE });
    f.created = await add('created', 'created_at', { style: STYLE, timezone: 'Europe/Kyiv' });
    // An unknown zone breaks the formulas of its base: in the other organization.
    const { table: notes } = await schema.createTable(
      orgScope(ORG_B),
      { baseId: b.baseId, name: 'Notes', primaryFieldName: 'title' },
      context,
    );
    f.odd = await schema.addField(
      orgScope(ORG_B),
      notes.id,
      { name: 'odd', type: 'datetime', options: { style: STYLE } },
      context,
    );

    // Zones as stored before T819 (today's schemas store the IANA primary name).
    await sql`UPDATE meta.users SET timezone = 'US/Eastern' WHERE id = ${a.userId}`.execute(
      db.kysely,
    );
    await sql`UPDATE meta.users SET timezone = 'asia/saigon' WHERE id = ${b.userId}`.execute(
      db.kysely,
    );
    await sql`UPDATE meta.users SET timezone = 'Mars/Olympus' WHERE id = ${USER_ODD}`.execute(
      db.kysely,
    );
    await setJson('meta.organizations', 'settings', ORG_A, '{timezone}', 'Asia/Saigon');
    await setJson('meta.organizations', 'settings', ORG_B, '{timezone}', 'Europe/Kiev');
    await setJson('meta.bases', 'settings', a.baseId, '{timezone}', 'Asia/Calcutta');
    await setJson('meta.bases', 'settings', b.baseId, '{timezone}', 7);
    await setJson('meta.fields', 'options', f.due.id, '{timezone}', 'Asia/Saigon');
    await setJson('meta.fields', 'options', f.created.id, '{timezone}', 'Europe/Kiev');
    await setJson('meta.fields', 'options', f.odd.id, '{timezone}', 'Mars/Olympus');
    const automations = new AutomationsRepository(db);
    for (const [id, timezone] of [
      [AUT_ZONED, 'Asia/Saigon'],
      [AUT_ORG_ZONE, null],
    ] as const) {
      await automations.insert(scope, {
        id,
        baseId: a.baseId,
        name: id,
        description: '',
        enabled: true,
        definition: { trigger: { type: 'schedule', cron: '0 9 * * *', timezone } },
        triggerType: 'schedule',
        triggerTableId: null,
        createdBy: a.userId,
      });
    }

    // 20:00 UTC on 23 September is 03:00 on the 24th in Ho Chi Minh City.
    [record] = (await insertRows(pool, table, [
      {
        [f.due.db_column_name ?? '']: '2026-09-23T20:00:00Z',
        [f.start.db_column_name ?? '']: '2026-09-23T20:00:00Z',
      },
    ])) as [Id<'rec'>];
    // `due` uses its own zone, `start` the organization's: both `Asia/Saigon` here.
    f.hours = await schema.addField(
      scope,
      table.id,
      {
        name: 'hours',
        type: 'formula',
        options: { expression: 'HOUR([due]) * 100 + HOUR([start])' },
        computed: { timeZone: 'Asia/Saigon' },
      },
      context,
    );
    const backfill = await mutation.backfillComputedBatch(scope, {
      fieldId: f.hours.id,
      afterAuto: 0n,
      limit: 1000,
      statementTimeoutMs: 30_000,
    });
    expect(backfill.status).toBe('done');
    await schema.finishComputedBackfill(scope, f.hours.id, { status: 'ready' });

    // 0055 runs first; later migrations (0056 of T910…) follow it.
    expect((await migrateToLatest(db.kysely))[0]).toBe('0055_canonical_time_zones');
  });

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('rewrites every stored alias to its IANA primary name; unknown names stay', async () => {
    const users = await db.kysely
      .selectFrom('meta.users')
      .select(['id', 'timezone'])
      .where('id', 'in', [a.userId, b.userId, USER_ODD])
      .execute();
    expect(Object.fromEntries(users.map((user) => [user.id, user.timezone]))).toEqual({
      [a.userId]: 'America/New_York',
      [b.userId]: 'Asia/Ho_Chi_Minh',
      [USER_ODD]: 'Mars/Olympus',
    });

    const orgs = await db.kysely
      .selectFrom('meta.organizations')
      .select(['id', 'settings'])
      .where('id', 'in', [ORG_A, ORG_B])
      .execute();
    expect(Object.fromEntries(orgs.map((org) => [org.id, org.settings]))).toEqual({
      [ORG_A]: { timezone: 'Asia/Ho_Chi_Minh' },
      [ORG_B]: { timezone: 'Europe/Kyiv' },
    });
    const bases = await db.kysely
      .selectFrom('meta.bases')
      .select(['id', 'settings'])
      .where('id', 'in', [a.baseId, b.baseId])
      .execute();
    expect(Object.fromEntries(bases.map((base) => [base.id, base.settings]))).toEqual({
      [a.baseId]: { timezone: 'Asia/Kolkata' },
      // Not a string: not a zone, left alone.
      [b.baseId]: { timezone: 7 },
    });

    // Other option keys are kept; a field without a zone gets none.
    expect(await fieldOptions(f.due.id)).toEqual({
      style: STYLE,
      timezone: 'Asia/Ho_Chi_Minh',
    });
    expect(await fieldOptions(f.created.id)).toMatchObject({
      style: STYLE,
      timezone: 'Europe/Kyiv',
    });
    expect(await fieldOptions(f.start.id)).not.toHaveProperty('timezone');
    expect(await fieldOptions(f.odd.id)).toMatchObject({ timezone: 'Mars/Olympus' });

    const automations = await db.kysely
      .selectFrom('meta.automations')
      .select(['id', 'definition'])
      .where('organization_id', '=', ORG_A)
      .execute();
    expect(Object.fromEntries(automations.map((row) => [row.id, row.definition]))).toEqual({
      [AUT_ZONED]: {
        trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'Asia/Ho_Chi_Minh' },
      },
      [AUT_ORG_ZONE]: { trigger: { type: 'schedule', cron: '0 9 * * *', timezone: null } },
    });
  });

  it('a stored formula on a field with an old zone name computes in that zone', async () => {
    // Computed before the migration (beforeAll): `fx.hour(…, 'Asia/Saigon')` used to
    // fail on `postgres:18`. 03:00 in Ho Chi Minh City, for both fields.
    expect(await hours()).toBe(303);
    // The migration recomputes nothing; a later write computes in the migrated zone.
    const access = await resolveMemberBaseAccess(
      db,
      scope,
      { userId: a.userId, baseId: a.baseId },
      { timeZone: 'UTC', locale: 'en' },
    );
    if (access === undefined) throw new Error('the owner has no access');
    await mutation.update(
      scope,
      table.id,
      access.record,
      // 01:30 UTC is 08:30 in Ho Chi Minh City.
      {
        field_key_type: 'id',
        records: [{ id: record, fields: { [f.due.id]: '2026-09-24T01:30:00.000Z' } }],
      },
      context,
    );
    expect(await hours()).toBe(803);
  });

  it('a schedule in a migrated zone fires at its time in that zone', async () => {
    const triggers = new AutomationTimeTriggers(db, {
      defaults: { timeZone: 'UTC', locale: 'en' },
    });
    const tick = (now: number) =>
      triggers.tickSchedule({ organizationId: ORG_A, automationId: AUT_ZONED }, new Date(now));
    // 09:00 in Ho Chi Minh City (UTC+7, no DST) is 02:00 UTC; one a day ahead.
    const nine = Math.ceil(Date.now() / DAY) * DAY + DAY + 2 * HOUR;
    await tick(nine - HOUR); // opens the window (may fire an earlier 09:00)
    expect(await tick(nine - MINUTE)).toMatchObject({ outcome: 'idle', runs: 0 });
    expect(await tick(nine)).toMatchObject({ outcome: 'fired', runs: 1, missed: 0 });
    const runs = await db.kysely
      .selectFrom('meta.automation_runs')
      .select('trigger_key')
      .where('automation_id', '=', AUT_ZONED)
      .execute();
    expect(runs.map((run) => run.trigger_key)).toContain(
      `${AUT_ZONED}:${new Date(nine).toISOString()}`,
    );
  });

  it('running it again changes no row and logs only the count of unknown names', async () => {
    const snapshot = async () =>
      (
        await sql<{ row: string }>`
          SELECT concat_ws(' ', 'u', id, xmin, timezone) AS row FROM meta.users
          UNION ALL SELECT concat_ws(' ', 'o', id, xmin, settings) FROM meta.organizations
          UNION ALL SELECT concat_ws(' ', 'b', id, xmin, settings) FROM meta.bases
          UNION ALL SELECT concat_ws(' ', 'f', id, xmin, options) FROM meta.fields
          UNION ALL SELECT concat_ws(' ', 'a', id, xmin, definition) FROM meta.automations
          ORDER BY 1
        `.execute(db.kysely)
      ).rows.map((row) => row.row);
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(10);

    const notices: string[] = [];
    const again = new pg.Pool({ connectionString: database.url, max: 1 });
    again.on('connect', (client) => {
      client.on('notice', (notice) =>
        notices.push(`${notice.severity ?? ''}: ${notice.message ?? ''}`),
      );
    });
    const kysely = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: again }) });
    try {
      // What the migrator does: `up` in a transaction.
      await kysely.transaction().execute((trx) => up(trx));
    } finally {
      await kysely.destroy();
    }

    expect(await snapshot()).toEqual(before);
    // `Mars/Olympus` of a user and of a field; never the value itself.
    expect(notices).toEqual([
      'WARNING: migration 0055_canonical_time_zones: 2 stored time zone value(s) are not a known zone name, left unchanged',
    ]);
  });
});
