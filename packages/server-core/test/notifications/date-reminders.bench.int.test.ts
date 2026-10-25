/**
 * Opt-in bench (BACKLOG T547): `DATE_REMINDER_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/notifications/date-reminders.bench`.
 *
 * 20 `datetime` fields with a reminder on one table of 200 000 rows (one
 * value per minute per field, test data straight into the data table), the
 * cursors one minute behind: one `notifications.date_reminder_scan` pass
 * (`DateReminderScanner.scanAll`, scan indexes created by the warm-up) reads
 * a one-minute window per field and queues one reminder per field. Target:
 * under 2 s in total — asserted only when the machine is not overloaded
 * (load average of the last minute < 2 × CPUs), always printed.
 *
 * T560 (QA S5b M7): many records due at one instant — a date-only field
 * whose `DATE_REMINDER_BENCH_SAME_DAY` (default `5000,20000`) records share
 * one date, scanned tick after tick (at most 1 000 reminders per tick) until
 * all are reminded of: the time of each tick is printed (each tick reads the
 * whole boundary again). Never asserts timings.
 */
import { cpus, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { DateReminderScanner } from '../../src/notifications/index.js';
import { RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

const ORG: Id<'org'> = 'org_T547ReminderBnch';
const FIELDS = 20;
const ROWS = Number(process.env['DATE_REMINDER_BENCH_ROWS'] ?? '200000');
const MINUTE = 60_000;
const START = Date.parse('2027-01-01T00:00:00Z');
const SAME_DAY = (process.env['DATE_REMINDER_BENCH_SAME_DAY'] ?? '5000,20000')
  .split(',')
  .map(Number)
  .filter((n) => Number.isSafeInteger(n) && n > 0);
/** The shared date of the same-instant tables: before START, so the 20 fields stay idle. */
const SAME_DATE = Date.parse('2026-06-01T00:00:00Z');

describe.runIf(process.env['DATE_REMINDER_BENCH'] === '1')('date reminder bench (T547)', () => {
  let database: TestDatabase;
  let db: Db;
  let tenant: SeededTenant;
  let table: TableRow;
  const fields: FieldRow[] = [];
  let scanner: DateReminderScanner;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    tenant = await seedTenant(db, ORG);
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: ORG, user_id: tenant.userId, role: 'owner' })
      .execute();
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const scope = orgScope(ORG);
    table = (
      await schema.createTable(
        scope,
        { baseId: tenant.baseId, name: 'Bench', primaryFieldName: 'title' },
        systemAuditContext(),
      )
    ).table;
    for (let n = 0; n < FIELDS; n += 1) {
      fields.push(
        await schema.addField(
          scope,
          table.id,
          {
            name: `due ${String(n)}`,
            type: 'datetime',
            options: {
              style: { format: 'yyyy-MM-dd HH:mm' },
              reminder: { recipients: 'users', user_ids: [tenant.userId] },
            },
          },
          systemAuditContext(),
        ),
      );
    }
    // Test data straight into the data table: field n holds START + row + n seconds.
    const columns = fields.map((field) => sql.id(field.db_column_name ?? ''));
    const values = fields.map(
      (_, n) => sql`${new Date(START)}::timestamptz + make_interval(mins => g.n, secs => ${n})`,
    );
    await sql`
      INSERT INTO ${sql.id('data', table.db_table_name)} (__id, ${sql.join(columns)})
      SELECT 'rec_' || lpad(g.n::text, 16, '0'), ${sql.join(values)}
        FROM generate_series(1, ${ROWS}) AS g(n)
    `.execute(db.kysely);
    await sql`ANALYZE ${sql.id('data', table.db_table_name)}`.execute(db.kysely);
    scanner = new DateReminderScanner(db, {
      defaults: { timeZone: 'UTC', locale: 'en' },
      records: new RecordQueryService(db, { defaultTimeZone: 'UTC' }),
      schema,
    });
  }, 600_000);

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it(`scans ${String(FIELDS)} fields × ${String(ROWS)} rows, one minute each, in under 2 s`, async () => {
    const middle = START + Math.floor(ROWS / 2) * MINUTE;
    const behind = async (now: number) => {
      await sql`UPDATE meta.date_reminder_cursors SET scanned_until = ${new Date(now - MINUTE)}
                 WHERE organization_id = ${ORG}`.execute(db.kysely);
    };
    // Warm-up: creates the scan indexes.
    await behind(middle);
    const warm = await scanner.scanAll(new Date(middle));
    expect(warm.fields).toBe(FIELDS);
    const times: number[] = [];
    for (let n = 1; n <= 3; n += 1) {
      const now = middle + n * 7 * MINUTE;
      await behind(now);
      const began = performance.now();
      const tick = await scanner.scanAll(new Date(now));
      times.push(performance.now() - began);
      expect(tick.fields).toBe(FIELDS);
      expect(tick.reminders).toBe(FIELDS);
    }
    times.sort((x, y) => x - y);
    const median = times[1] ?? Infinity;
    const load = loadavg()[0] ?? 0;
    process.stdout.write(
      `T547 date reminder scan, ${String(FIELDS)} fields × ${String(ROWS)} rows: ` +
        `median ${median.toFixed(1)} ms (runs ${times.map((x) => x.toFixed(1)).join(', ')} ms, ` +
        `load ${load.toFixed(1)} / ${String(cpus().length)} CPUs)\n`,
    );
    if (load < 2 * cpus().length) expect(median).toBeLessThan(2000);
  }, 600_000);

  for (const rows of SAME_DAY) {
    it(`reminds of ${String(rows)} records due at one instant, tick after tick (T560, M7)`, async () => {
      const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
      const scope = orgScope(ORG);
      const sameDay = (
        await schema.createTable(
          scope,
          { baseId: tenant.baseId, name: `Same day ${String(rows)}`, primaryFieldName: 'title' },
          systemAuditContext(),
        )
      ).table;
      const due = await schema.addField(
        scope,
        sameDay.id,
        {
          name: 'due',
          type: 'datetime',
          options: {
            style: { format: 'yyyy-MM-dd' },
            // Due at midnight (UTC) of the shared date.
            reminder: { recipients: 'users', user_ids: [tenant.userId], time_of_day: '00:00' },
          },
        },
        systemAuditContext(),
      );
      await sql`
        INSERT INTO ${sql.id('data', sameDay.db_table_name)} (__id, ${sql.id(due.db_column_name ?? '')})
        SELECT 'rec_s' || lpad(g.n::text, 15, '0'), ${new Date(SAME_DATE)}::timestamptz
          FROM generate_series(1, ${rows}) AS g(n)
      `.execute(db.kysely);
      await sql`ANALYZE ${sql.id('data', sameDay.db_table_name)}`.execute(db.kysely);
      const item = { organizationId: ORG, fieldId: due.id };
      const from = new Date(SAME_DATE - MINUTE);
      await sql`UPDATE meta.date_reminder_cursors
                   SET armed_at = ${from}, scanned_until = ${from},
                       boundary_due_at = NULL, boundary_record_ids = '{}'
                 WHERE organization_id = ${ORG} AND field_id = ${due.id}`.execute(db.kysely);
      // Warm-up before the instant (idle): creates the scan index.
      expect((await scanner.scanField(item, new Date(SAME_DATE - 1))).reminders).toBe(0);
      const startLoad = loadavg()[0] ?? 0;
      const ticks: { ms: number; reminders: number }[] = [];
      let total = 0;
      for (let tick = 1; tick <= Math.ceil(rows / 1000) + 2; tick += 1) {
        // The worker drains the fan-out jobs between ticks in production; left
        // queued here, 1,000 more rows a tick would be measured instead of the scan.
        await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
        const began = performance.now();
        const result = await scanner.scanField(item, new Date(SAME_DATE + tick * MINUTE));
        ticks.push({ ms: performance.now() - began, reminders: result.reminders });
        total += result.reminders;
        if (result.reminders === 0) break;
      }
      const busy = ticks.filter((tick) => tick.reminders > 0);
      process.stdout.write(
        `T560 same-instant reminders, ${String(rows)} records on one date: ${String(total)} reminders in ` +
          `${String(busy.length)} ticks; per tick ${busy.map((tick) => tick.ms.toFixed(0)).join(', ')} ms ` +
          `(first ${busy[0]?.ms.toFixed(0) ?? '?'} ms, last ${busy.at(-1)?.ms.toFixed(0) ?? '?'} ms, ` +
          `sum ${busy.reduce((sum, tick) => sum + tick.ms, 0).toFixed(0)} ms; ` +
          `load ${startLoad.toFixed(1)} → ${(loadavg()[0] ?? 0).toFixed(1)} / ${String(cpus().length)} CPUs)\n`,
      );
      expect(total).toBe(rows);
    }, 1_800_000);
  }
});
