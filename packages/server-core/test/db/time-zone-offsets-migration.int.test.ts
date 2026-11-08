import { canonicalTimeZone, IANA_PRIMARY } from '@cellhive/contracts';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { AutomationsRepository } from '../../src/automation/index.js';
import { createMigrator, orgScope, type Db } from '../../src/db/index.js';
import { up } from '../../src/db/migrations/0058_time_zone_offsets.js';
import { migrateJobQueue } from '../../src/jobs/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_T1005TzOffOrgA01';
const ORG_B: Id<'org'> = 'org_T1005TzOffOrgB01';
const ORG_C: Id<'org'> = 'org_T1005TzOffOrgC01';
const STYLE = { format: 'yyyy-MM-dd HH:mm' };
const MIGRATION = '0058_time_zone_offsets';
const WARNING = (count: number) =>
  `WARNING: migration ${MIGRATION}: ${String(count)} stored UTC offset(s) without a whole-hour ` +
  'time zone were reset (users: to the organization zone; elsewhere: to UTC)';

/** `+07:00` → `Etc/GMT-7`: the fixed zone of a whole-hour offset has the POSIX sign. */
function etcZoneOf(hours: number): string {
  if (hours === 0) return 'UTC';
  return `Etc/GMT${hours > 0 ? '-' : '+'}${String(Math.abs(hours))}`;
}

/** Whole hours of tzdata's `Etc/GMT±N`, each spelt one way an API caller could have stored it. */
const WHOLE_HOURS = Array.from({ length: 27 }, (_, index) => index - 12).map((hours) => {
  const sign = hours < 0 ? '-' : '+';
  const hh = String(Math.abs(hours)).padStart(2, '0');
  const spellings = [`${sign}${hh}:00`, `${sign}${hh}00`, `${sign}${hh}`];
  return { stored: spellings[(hours + 12) % spellings.length] as string, hours };
});

/** Offsets without a fixed zone: reset. */
const OTHER_OFFSETS = ['+05:30', '-0930', '+13:45', '-13:00', '+23:00'] as const;

/**
 * BACKLOG T1005: migration 0058 on a database with UTC offsets and legacy
 * names stored in every place a zone is kept.
 */
describe('migration 0058_time_zone_offsets (T1005)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let c: SeededTenant;
  const f = {} as Record<'hour' | 'half' | 'legacy' | 'plain' | 'none' | 'other', FieldRow>;
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();
  const users = new Map<Id<'usr'>, { stored: string; expected: string | null }>();
  const automations = new Map<Id<'aut'>, { stored: string | null; expected: string | null }>();
  const firstRun: string[] = [];

  /** A Kysely whose connections record the server's notices into `notices`. */
  function listening(notices: string[]): Kysely<unknown> {
    const pool = new pg.Pool({ connectionString: database.url, max: 1 });
    pool.on('connect', (client) => {
      client.on('notice', (notice) => {
        notices.push(`${notice.severity ?? ''}: ${notice.message ?? ''}`);
      });
    });
    return new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  }

  const setJson = (target: string, column: string, id: string, path: string, value: unknown) =>
    sql`
      UPDATE ${sql.table(target)}
         SET ${sql.ref(column)} = jsonb_set(${sql.ref(column)}, ${path}::text[], ${JSON.stringify(value)}::jsonb)
       WHERE id = ${id}
    `.execute(db.kysely);

  const fieldOptions = async (id: Id<'fld'>) =>
    (
      await db.kysely
        .selectFrom('meta.fields')
        .select('options')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).options;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateJobQueue({ connectionString: database.url });
    const { error } = await createMigrator(db.kysely).migrateTo('0057_ai_generation_queue_job_idx');
    expect(error).toBeUndefined();

    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    c = await seedTenant(db, ORG_C);

    // Users: every whole hour, the other offsets, every legacy name (some in lower case).
    let n = 0;
    const addUser = async (stored: string, expected: string | null) => {
      n += 1;
      const id: Id<'usr'> = `usr_T1005TzUser${String(n).padStart(5, '0')}`;
      await db.kysely
        .insertInto('meta.users')
        .values({ id, email: `tz${String(n)}@example.test`, display_name: id, timezone: stored })
        .execute();
      users.set(id, { stored, expected });
    };
    for (const { stored, hours } of WHOLE_HOURS) await addUser(stored, etcZoneOf(hours));
    await addUser('−07:00', 'Etc/GMT+7');
    await addUser('UTC+7', 'Etc/GMT-7');
    await addUser('GMT-05:00', 'Etc/GMT+5');
    await addUser('-00:00', 'UTC');
    for (const stored of OTHER_OFFSETS) await addUser(stored, null);
    for (const [index, name] of Object.keys(IANA_PRIMARY).entries()) {
      if (!/^[A-Z]{2,3}\d|^[A-Z]{3}$|^SystemV\//u.test(name)) continue; // CLDR ids: 0055.
      await addUser(index % 2 === 0 ? name : name.toLowerCase(), canonicalTimeZone(name));
    }
    // Left as they are: names, unknown names, the fixed zones.
    await addUser('Asia/Ho_Chi_Minh', 'Asia/Ho_Chi_Minh');
    await addUser('Etc/GMT-7', 'Etc/GMT-7');
    await addUser('Mars/Olympus', 'Mars/Olympus');

    await setJson('meta.organizations', 'settings', ORG_A, '{timezone}', '+07:00');
    await setJson('meta.organizations', 'settings', ORG_B, '{timezone}', '+05:30');
    await setJson('meta.organizations', 'settings', ORG_C, '{timezone}', 'EST5EDT');
    await setJson('meta.bases', 'settings', a.baseId, '{timezone}', 'SystemV/YST9YDT');
    await setJson('meta.bases', 'settings', b.baseId, '{timezone}', '+09:30');
    await setJson('meta.bases', 'settings', c.baseId, '{timezone}', '-0300');

    const { table } = await schema.createTable(
      scope,
      { baseId: a.baseId, name: 'Orders', primaryFieldName: 'title' },
      context,
    );
    const add = (name: string, type: string, options: unknown) =>
      schema.addField(scope, table.id, { name, type, options }, context);
    f.hour = await add('hour', 'datetime', { style: STYLE, timezone: 'UTC' });
    f.half = await add('half', 'datetime', { style: STYLE, timezone: 'UTC' });
    f.legacy = await add('legacy', 'created_at', { style: STYLE, timezone: 'UTC' });
    f.plain = await add('plain', 'datetime', { style: STYLE, timezone: 'Asia/Ho_Chi_Minh' });
    f.none = await add('none', 'datetime', { style: STYLE });
    f.other = await add('other', 'number', {});
    await setJson('meta.fields', 'options', f.hour.id, '{timezone}', '+0900');
    await setJson('meta.fields', 'options', f.half.id, '{timezone}', '-03:30');
    await setJson('meta.fields', 'options', f.legacy.id, '{timezone}', 'PST8PDT');
    // A deleted field is rewritten too.
    await sql`UPDATE meta.fields SET deleted_at = now() WHERE id = ${f.legacy.id}`.execute(
      db.kysely,
    );

    const repository = new AutomationsRepository(db);
    const schedules: [Id<'aut'>, string | null, string | null][] = [
      ['aut_T1005TzOffSch001', '+07', 'Etc/GMT-7'],
      ['aut_T1005TzOffSch002', '+10:30', 'UTC'],
      ['aut_T1005TzOffSch003', 'cst6cdt', 'America/Chicago'],
      ['aut_T1005TzOffSch004', null, null],
      ['aut_T1005TzOffSch005', 'Asia/Ho_Chi_Minh', 'Asia/Ho_Chi_Minh'],
    ];
    for (const [id, timezone, expected] of schedules) {
      await repository.insert(scope, {
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
      automations.set(id, { stored: timezone, expected });
    }

    // What the migrator does, on connections that keep the notices.
    const kysely = listening(firstRun);
    try {
      const { error: failed, results } = await createMigrator(kysely).migrateTo(MIGRATION);
      expect(failed).toBeUndefined();
      expect(results?.map((result) => result.migrationName)).toEqual([MIGRATION]);
    } finally {
      await kysely.destroy();
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('turns whole-hour offsets into Etc/GMT∓N, legacy names into primary names; other offsets of users into no zone', async () => {
    const rows = await db.kysely
      .selectFrom('meta.users')
      .select(['id', 'timezone'])
      .where('id', 'in', [...users.keys()])
      .execute();
    const actual = Object.fromEntries(rows.map((row) => [row.id, row.timezone]));
    const expected = Object.fromEntries([...users].map(([id, user]) => [id, user.expected]));
    expect(actual).toEqual(expected);
    // Every legacy name of `IANA_PRIMARY` outside the CLDR ids: 7 POSIX-style + 13 SystemV/*.
    expect(
      [...users.values()].filter((user) =>
        /^[A-Z]{2,3}\d|^[A-Z]{3}$|^systemv\//iu.test(user.stored),
      ),
    ).toHaveLength(20);
  });

  it('a migrated offset is the same offset in PostgreSQL (POSIX sign of Etc/GMT)', async () => {
    const zones = WHOLE_HOURS.map(({ hours }) => ({ zone: etcZoneOf(hours), hours }));
    const { rows } = await sql<{ name: string; hours: number }>`
      SELECT name, extract(epoch FROM utc_offset)::int / 3600 AS hours
        FROM pg_timezone_names WHERE name = ANY(${zones.map((item) => item.zone)}::text[])
    `.execute(db.kysely);
    expect(Object.fromEntries(rows.map((row) => [row.name, row.hours]))).toEqual(
      Object.fromEntries(zones.map((item) => [item.zone, item.hours])),
    );
  });

  it('rewrites organizations, bases, fields (deleted too) and schedules; other offsets become UTC', async () => {
    const orgs = await db.kysely
      .selectFrom('meta.organizations')
      .select(['id', 'settings'])
      .where('id', 'in', [ORG_A, ORG_B, ORG_C])
      .execute();
    expect(Object.fromEntries(orgs.map((org) => [org.id, org.settings]))).toEqual({
      [ORG_A]: { timezone: 'Etc/GMT-7' },
      [ORG_B]: { timezone: 'UTC' },
      [ORG_C]: { timezone: 'America/New_York' },
    });
    const bases = await db.kysely
      .selectFrom('meta.bases')
      .select(['id', 'settings'])
      .where('id', 'in', [a.baseId, b.baseId, c.baseId])
      .execute();
    expect(Object.fromEntries(bases.map((base) => [base.id, base.settings]))).toEqual({
      [a.baseId]: { timezone: 'America/Anchorage' },
      [b.baseId]: { timezone: 'UTC' },
      [c.baseId]: { timezone: 'Etc/GMT+3' },
    });

    expect(await fieldOptions(f.hour.id)).toEqual({ style: STYLE, timezone: 'Etc/GMT-9' });
    expect(await fieldOptions(f.half.id)).toEqual({ style: STYLE, timezone: 'UTC' });
    expect(await fieldOptions(f.legacy.id)).toMatchObject({
      style: STYLE,
      timezone: 'America/Los_Angeles',
    });
    expect(await fieldOptions(f.plain.id)).toEqual({ style: STYLE, timezone: 'Asia/Ho_Chi_Minh' });
    expect(await fieldOptions(f.none.id)).not.toHaveProperty('timezone');
    expect(await fieldOptions(f.other.id)).not.toHaveProperty('timezone');

    const rows = await db.kysely
      .selectFrom('meta.automations')
      .select(['id', 'definition'])
      .where('organization_id', '=', ORG_A)
      .execute();
    expect(Object.fromEntries(rows.map((row) => [row.id, row.definition]))).toEqual(
      Object.fromEntries(
        [...automations].map(([id, { expected }]) => [
          id,
          { trigger: { type: 'schedule', cron: '0 9 * * *', timezone: expected } },
        ]),
      ),
    );
  });

  it('logs only the count of reset offsets, never a value', () => {
    // Users: 5 other offsets; organization B, base B, field `half`, schedule 02.
    expect(firstRun).toEqual([WARNING(OTHER_OFFSETS.length + 4)]);
  });

  it('running it again changes no row and logs nothing', async () => {
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
    expect(before.length).toBeGreaterThan(70);

    const notices: string[] = [];
    const kysely = listening(notices);
    try {
      // What the migrator does: `up` in a transaction.
      await kysely.transaction().execute((trx) => up(trx));
    } finally {
      await kysely.destroy();
    }

    expect(await snapshot()).toEqual(before);
    expect(notices).toEqual([]);
  });
});
