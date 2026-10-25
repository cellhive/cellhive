import { cpus, loadavg } from 'node:os';

import { automationSchema, type AutomationDto, type Id } from '@cellhive/contracts';
import {
  AppError,
  AutomationTimeTriggers,
  orgScope,
  RecordQueryService,
  resolveMemberBaseAccess,
  SchemaService,
  systemAuditContext,
  type Db,
  type TimeTriggerResult,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface RunRow {
  readonly id: Id<'run'>;
  readonly status: string;
  readonly depth: number;
  readonly trigger_key: string | null;
  readonly trigger_unit: string;
  readonly trigger_event_id: string | null;
  readonly input: {
    readonly trigger: {
      readonly type: string;
      readonly record_id: string | null;
      readonly data: Record<string, string>;
      readonly missed?: number;
    };
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * BACKLOG T508 through the real API, the scanner with an injected clock and
 * the real worker running the runs: `schedule` (08:00 Asia/Ho_Chi_Minh, one
 * run per fire time, missed fire times after a downtime fired once) and
 * `record.date_reached` (once per value, again for a new value, nothing for
 * dates passed before turning on or trashed records, catch-up after a
 * stopped worker, date-only values at `time_of_day` in the field's zone,
 * the read rule of `run_as`), the `422` of a cron firing every minute, the
 * organization scope, and the scan time over 200 000 rows.
 */
describe('time triggers (T508)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let triggers: AutomationTimeTriggers;
  let deadline: Id<'fld'>;
  let day: Id<'fld'>;
  const created: Id<'aut'>[] = [];
  /** Far enough from the real clock that the worker's own crons never reach it. */
  let base: number;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const item = (automationId: Id<'aut'>) => ({ organizationId: fx.orgId, automationId });

  async function automation(definition: object, name = 'T508'): Promise<AutomationDto> {
    const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name,
      enabled: true,
      definition,
    });
    expect(response.statusCode, response.body).toBe(201);
    const dto = automationSchema.parse(response.json());
    created.push(dto.id);
    return dto;
  }

  async function createOrder(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  async function patchOrder(id: Id<'rec'>, fields: Record<string, unknown>): Promise<void> {
    const response = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ id, fields }] },
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  async function runsOf(id: Id<'aut'>): Promise<RunRow[]> {
    const { rows } = await sql<RunRow>`
      SELECT id, status, depth, trigger_key, trigger_unit, trigger_event_id, input
        FROM meta.automation_runs WHERE automation_id = ${id} ORDER BY created_at, id
    `.execute(db.kysely);
    return rows;
  }

  async function settled(): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ runs: number }>`
        SELECT count(*)::int AS runs FROM meta.automation_runs
         WHERE status IN ('queued', 'running')
           AND automation_id = ANY(${[...created]}::text[])
      `.execute(db.kysely);
      return rows[0]?.runs === 0;
    }, 'runs settled');
  }

  /** A date trigger on the orders whose title contains `tag` (each scenario its own records). */
  const dateTrigger = (fieldId: Id<'fld'>, tag: string, extra: object = {}) => ({
    trigger: { type: 'record.date_reached', table_id: fx.orders.id, field_id: fieldId, ...extra },
    condition: { field: F('title'), operator: 'contains', value: tag },
    actions: [
      {
        id: 'act_1',
        type: 'update_record',
        config: {
          table_id: fx.orders.id,
          record_id: null,
          fields: { [F('amount')]: { literal: 7 } },
        },
      },
    ],
  });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    deadline = (
      await schema.addField(
        scope,
        fx.orders.id,
        { name: 'deadline', type: 'datetime', options: { style: { format: 'yyyy-MM-dd HH:mm' } } },
        systemAuditContext(),
      )
    ).id;
    day = (
      await schema.addField(
        scope,
        fx.orders.id,
        {
          name: 'day',
          type: 'datetime',
          options: { style: { format: 'yyyy-MM-dd' }, timezone: 'Asia/Ho_Chi_Minh' },
        },
        systemAuditContext(),
      )
    ).id;
    triggers = new AutomationTimeTriggers(db, {
      defaults: { timeZone: t.config.defaults.timezone, locale: t.config.defaults.locale },
      schema,
    });
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
    base = Math.ceil((Date.now() + 2 * DAY) / HOUR) * HOUR;
  });

  afterEach(async () => {
    await settled();
    for (const id of created.splice(0)) {
      await db.kysely
        .updateTable('meta.automations')
        .set({ enabled: false })
        .where('id', '=', id)
        .execute();
    }
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('schedule `0 8 * * *` in Asia/Ho_Chi_Minh fires at 08:00 once; a downtime fires the latest once', async () => {
    const flow = await automation({
      trigger: { type: 'schedule', cron: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' },
      actions: [
        {
          id: 'act_1',
          type: 'create_record',
          config: { table_id: fx.orders.id, fields: { [F('title')]: { literal: 'daily' } } },
        },
      ],
    });
    // 08:00 in Ho Chi Minh City (UTC+7, no DST) is 01:00 UTC: the first one
    // more than 10 minutes ahead of the real clock (the worker's own cron
    // ticks with it meanwhile and must not reach it).
    const eight = Math.ceil((Date.now() + 10 * MINUTE - HOUR) / DAY) * DAY + HOUR;
    const tick = (now: number) => triggers.tickSchedule(item(flow.id), new Date(now));

    expect(await tick(eight - MINUTE)).toMatchObject({ outcome: 'idle', runs: 0 });
    expect(await tick(eight)).toMatchObject({ outcome: 'fired', runs: 1, missed: 0 });
    expect(await tick(eight)).toMatchObject({ outcome: 'idle' });
    expect(await tick(eight + MINUTE)).toMatchObject({ outcome: 'idle' });
    // Even with the cursor moved back, the fire time runs once (dedupe key).
    await sql`UPDATE meta.automation_time_cursors SET scanned_until = ${new Date(eight - MINUTE)}
               WHERE automation_id = ${flow.id}`.execute(db.kysely);
    expect(await tick(eight + MINUTE)).toMatchObject({ outcome: 'duplicate', runs: 0 });

    // The worker was down for three days: one run, for the latest 08:00, two missed.
    const later = eight + 3 * DAY;
    expect(await tick(later + 5 * MINUTE)).toMatchObject({ outcome: 'fired', runs: 1, missed: 2 });

    const runs = await runsOf(flow.id);
    expect(runs.map((run) => run.input.trigger.data['fired_at'])).toEqual([iso(eight), iso(later)]);
    expect(runs.map((run) => run.trigger_key)).toEqual([
      `${flow.id}:${iso(eight)}`,
      `${flow.id}:${iso(later)}`,
    ]);
    expect(runs[1]).toMatchObject({
      depth: 0,
      trigger_event_id: null,
      trigger_unit: `schedule:${iso(later)}`,
      input: { trigger: { type: 'schedule', record_id: null, missed: 2 } },
    });
    await eventually(
      async () => (await runsOf(flow.id)).every((run) => run.status === 'succeeded'),
      'schedule runs succeeded',
    );

    // Another organization's scope never reaches it.
    const stranger = await triggers.tickSchedule(
      { organizationId: 'org_SomeOtherOrg0001', automationId: flow.id },
      new Date(later + DAY),
    );
    expect(stranger).toMatchObject({ outcome: 'turned_off', runs: 0 });
  });

  it('schedule more often than every 5 minutes or in an unknown zone → 422', async () => {
    const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'too often',
      definition: {
        trigger: { type: 'schedule', cron: '*/1 * * * *', timezone: 'Mars/Olympus' },
        actions: [],
      },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'AUTOMATION_INVALID',
      errors: [
        {
          path: 'definition.trigger.cron',
          code: 'CRON_TOO_FREQUENT',
          params: { min_interval_minutes: 5, interval_minutes: 1 },
        },
        { path: 'definition.trigger.timezone', code: 'INVALID_TIME_ZONE' },
      ],
    });
  });

  it('record.date_reached fires once per value, again for a new value, never for past or trashed dates', async () => {
    const due = base + 10 * MINUTE;
    const a = await createOrder({ [F('title')]: 'once A', [deadline]: iso(due) });
    const past = await createOrder({
      [F('title')]: 'once past',
      [deadline]: iso(Date.now() - HOUR),
    });
    const trashed = await createOrder({ [F('title')]: 'once trashed', [deadline]: iso(due) });
    const removed = await fx.call(
      'u_admin',
      'DELETE',
      `/tables/${fx.orders.id}/records/${trashed}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    const flow = await automation(dateTrigger(deadline, 'once'));
    const scan = (now: number) => triggers.scanDate(item(flow.id), new Date(now));

    expect(await scan(due - MINUTE)).toMatchObject({ outcome: 'idle', runs: 0 });
    expect(await scan(due)).toMatchObject({ outcome: 'fired', runs: 1 });
    expect(await scan(due + MINUTE)).toMatchObject({ outcome: 'idle', runs: 0 });
    await sql`UPDATE meta.automation_time_cursors SET scanned_until = ${new Date(due - HOUR)}
               WHERE automation_id = ${flow.id}`.execute(db.kysely);
    expect(await scan(due + MINUTE)).toMatchObject({ runs: 0 });

    // A new value fires again when it passes.
    const moved = due + 20 * MINUTE;
    await patchOrder(a, { [deadline]: iso(moved) });
    expect(await scan(moved - MINUTE)).toMatchObject({ runs: 0 });
    expect(await scan(moved)).toMatchObject({ outcome: 'fired', runs: 1 });

    const runs = await runsOf(flow.id);
    expect(runs.map((run) => run.input.trigger.record_id)).toEqual([a, a]);
    expect(runs.map((run) => run.input.trigger.data['due_at'])).toEqual([iso(due), iso(moved)]);
    expect(runs.map((run) => run.trigger_key)).toEqual([
      `${flow.id}:${a}:${iso(due)}`,
      `${flow.id}:${a}:${iso(moved)}`,
    ]);
    expect(
      runs.some((run) => [past, trashed].includes(run.input.trigger.record_id as Id<'rec'>)),
    ).toBe(false);
    await eventually(
      async () => (await runsOf(flow.id)).every((run) => run.status === 'succeeded'),
      'date runs succeeded',
    );
    const record = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.orders.id}/records/${a}?field_key_type=id`,
    );
    expect(record.json<{ fields: Record<string, unknown> }>().fields[F('amount')]).toBe(7);

    // The scan index exists on the column (SPEC §11.2: scanned by index).
    const { rows } = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'data' AND indexname LIKE ${'%_due'}
    `.execute(db.kysely);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('a stopped worker catches up: each record due meanwhile fires exactly once', async () => {
    const start = base + 2 * HOUR;
    const ids: Id<'rec'>[] = [];
    for (let n = 1; n <= 5; n += 1) {
      ids.push(
        await createOrder({
          [F('title')]: `late ${String(n)}`,
          [deadline]: iso(start + n * MINUTE),
        }),
      );
    }
    const flow = await automation(dateTrigger(deadline, 'late', { offset_minutes: 0 }));
    const scan = (now: number) => triggers.scanDate(item(flow.id), new Date(now));
    expect(await scan(start)).toMatchObject({ runs: 0 });
    // Ten minutes without a scan.
    expect(await scan(start + 10 * MINUTE)).toMatchObject({ outcome: 'fired', runs: 5 });
    expect(await scan(start + 11 * MINUTE)).toMatchObject({ runs: 0 });
    const runs = await runsOf(flow.id);
    expect(runs.map((run) => run.input.trigger.record_id).sort()).toEqual([...ids].sort());
  });

  it('caps the runs of one scan and fires the rest next scan', async () => {
    const start = base + 4 * HOUR;
    for (let n = 1; n <= 3; n += 1) {
      await createOrder({ [F('title')]: `cap ${String(n)}`, [deadline]: iso(start + MINUTE) });
    }
    const flow = await automation(dateTrigger(deadline, 'cap'));
    const capped = new AutomationTimeTriggers(db, {
      defaults: { timeZone: t.config.defaults.timezone, locale: t.config.defaults.locale },
      maxRunsPerScan: 2,
    });
    const scan = (now: number) => capped.scanDate(item(flow.id), new Date(now));
    expect(await scan(start)).toMatchObject({ runs: 0 });
    expect(await scan(start + 2 * MINUTE)).toMatchObject({ outcome: 'capped', runs: 2 });
    expect(await scan(start + 3 * MINUTE)).toMatchObject({ outcome: 'fired', runs: 1 });
    expect(await scan(start + 4 * MINUTE)).toMatchObject({ runs: 0 });
    expect(await runsOf(flow.id)).toHaveLength(3);
  });

  it('an automation whose scan fails does not stop the others (QA T559 H2)', async () => {
    const start = base + 5 * HOUR;
    await createOrder({ [F('title')]: 'iso fails', [day]: '2000-01-01' });
    const ok = await createOrder({ [F('title')]: 'iso ok', [deadline]: iso(start + MINUTE) });
    const failing = await automation(dateTrigger(day, 'iso fails'));
    const healthy = await automation(dateTrigger(deadline, 'iso ok'));
    // A statement timeout (huge table, database error…) on one automation's field.
    class TimingOut extends RecordQueryService {
      override async scanDue(...args: Parameters<RecordQueryService['scanDue']>) {
        if (args[3].fieldId === day) throw new AppError('QUERY_TIMEOUT', { detail: 'timeout' });
        return super.scanDue(...args);
      }
    }
    const isolated = new AutomationTimeTriggers(db, {
      defaults: { timeZone: t.config.defaults.timezone, locale: t.config.defaults.locale },
      records: new TimingOut(db),
    });
    await isolated.scanDate(item(failing.id), new Date(start)).catch(() => undefined);
    await isolated.scanDate(item(healthy.id), new Date(start));
    const tick = await isolated.scanDates(new Date(start + 2 * MINUTE));
    const outcome = (id: Id<'aut'>) => tick.results.find((result) => result.automationId === id);
    expect(outcome(failing.id)).toMatchObject({ outcome: 'error', errorCode: 'QUERY_TIMEOUT' });
    expect(outcome(healthy.id)).toMatchObject({ outcome: 'fired', runs: 1 });
    expect((await runsOf(healthy.id)).map((run) => run.input.trigger.record_id)).toEqual([ok]);
  });

  it('date-only values fire at time_of_day in the field’s zone, with the offset', async () => {
    // A day well ahead, in Ho Chi Minh City.
    const date = new Date(base + 3 * DAY).toISOString().slice(0, 10);
    const record = await createOrder({ [F('title')]: 'by day', [day]: date });
    const flow = await automation(
      dateTrigger(day, 'by day', { time_of_day: '07:30', offset_minutes: -30 }),
    );
    // 07:30 − 30 min = 07:00 in UTC+7 = 00:00 UTC that day.
    const due = Date.parse(`${date}T00:00:00Z`);
    const scan = (now: number) => triggers.scanDate(item(flow.id), new Date(now));
    expect(await scan(due - MINUTE)).toMatchObject({ runs: 0 });
    expect(await scan(due)).toMatchObject({ outcome: 'fired', runs: 1 });
    const [run] = await runsOf(flow.id);
    expect(run?.input.trigger).toMatchObject({
      type: 'record.date_reached',
      record_id: record,
      data: { due_at: iso(due), fired_at: iso(due) },
    });
    expect(run?.trigger_key).toBe(`${flow.id}:${record}:${date}`);
  });

  it('only records run_as reads fire; run_as without access fires nothing', async () => {
    const due = base + 6 * HOUR;
    const mine = await createOrder({
      [F('title')]: 'sales1',
      [deadline]: iso(due),
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
    });
    await createOrder({
      [F('title')]: 'sales2',
      [deadline]: iso(due),
      [F('owner')]: [{ id: fx.users.u_sales2.id }],
    });
    const flow = await automation(dateTrigger(deadline, 'sales'));
    // Sales reads only the orders it owns (CONTRACTS §5 role Sales, read scope `editable`).
    await sql`UPDATE meta.automations SET run_as_user_id = ${fx.users.u_sales1.id}
               WHERE id = ${flow.id}`.execute(db.kysely);
    const scan = (now: number) => triggers.scanDate(item(flow.id), new Date(now));
    expect(await scan(due - MINUTE)).toMatchObject({ runs: 0 });
    expect(await scan(due)).toMatchObject({ runs: 1 });
    expect((await runsOf(flow.id)).map((run) => run.input.trigger.record_id)).toEqual([mine]);

    // run_as no longer in the organization: nothing fires, the window is used up.
    const second = await automation(dateTrigger(deadline, 'sales'), 'outsider');
    await sql`UPDATE meta.automations SET run_as_user_id = ${fx.users.u_out.id}
               WHERE id = ${second.id}`.execute(db.kysely);
    await sql`DELETE FROM meta.org_members WHERE user_id = ${fx.users.u_out.id}`.execute(db.kysely);
    const result: TimeTriggerResult = await triggers.scanDate(item(second.id), new Date(due));
    expect(result).toMatchObject({ outcome: 'run_as_without_access', runs: 0 });
  });

  it('scans 200 000 rows by the column index in under 200 ms', async () => {
    const table = await db.kysely
      .selectFrom('meta.tables')
      .select('db_table_name')
      .where('id', '=', fx.orders.id)
      .executeTakeFirstOrThrow();
    const column = await db.kysely
      .selectFrom('meta.fields')
      .select('db_column_name')
      .where('id', '=', deadline)
      .executeTakeFirstOrThrow();
    const start = base + 30 * DAY;
    // Test data straight into the data table (one minute apart, ~139 days).
    await sql`
      INSERT INTO ${sql.id('data', table.db_table_name)} (__id, ${sql.id(column.db_column_name ?? '')})
      SELECT 'rec_' || lpad(n::text, 16, '0'),
             ${new Date(start)}::timestamptz + make_interval(mins => n)
        FROM generate_series(1, 200000) AS n
    `.execute(db.kysely);
    const schema = t.app.get(SchemaService);
    // Usually created by an earlier scan; the optional index keeps the schema consistent.
    expect(['exists', 'created']).toContain(
      await schema.ensureDueIndex(orgScope(fx.orgId), deadline),
    );
    expect(await schema.ensureDueIndex(orgScope(fx.orgId), deadline)).toBe('exists');
    expect(await schema.ensureDueIndex(orgScope(fx.orgId), F('title'))).toBe('not_applicable');
    expect(await schema.checkConsistency(orgScope(fx.orgId), fx.orders.id)).toEqual([]);
    await sql`ANALYZE ${sql.id('data', table.db_table_name)}`.execute(db.kysely);
    const access = await resolveMemberBaseAccess(
      db,
      orgScope(fx.orgId),
      { userId: fx.users.u_admin.id, baseId: fx.baseId },
      { timeZone: 'UTC', locale: 'en' },
    );
    if (access === undefined) throw new Error('no access');
    const records = new RecordQueryService(db, { defaultTimeZone: 'UTC' });
    const window = (from: number) => ({
      fieldId: deadline,
      lower: { value: iso(from), inclusive: false },
      upper: iso(from + MINUTE),
      after: null,
      limit: 500,
    });
    // Warm-up, then the median of 5 one-minute windows.
    await records.scanDue(orgScope(fx.orgId), fx.orders.id, access.record, window(start));
    const times: number[] = [];
    for (let n = 1; n <= 5; n += 1) {
      const began = performance.now();
      const page = await records.scanDue(
        orgScope(fx.orgId),
        fx.orders.id,
        access.record,
        window(start + n * 20_000 * MINUTE),
      );
      times.push(performance.now() - began);
      expect(page.rows).toHaveLength(1);
    }
    times.sort((x, y) => x - y);
    const median = times[2] ?? Infinity;
    // Recorded in the T508 report; asserted only when the machine is not overloaded (S4b-review §7.1).
    process.stdout.write(`T508 date scan over 200 000 rows: median ${median.toFixed(1)} ms\n`);
    if ((loadavg()[0] ?? 0) < 2 * cpus().length) expect(median).toBeLessThan(200);
    const plan = await sql<{ 'QUERY PLAN': string }>`
      EXPLAIN SELECT __id FROM ${sql.id('data', table.db_table_name)}
       WHERE __deleted_at IS NULL
         AND ${sql.id(column.db_column_name ?? '')} > ${iso(start + MINUTE)}::timestamptz
         AND ${sql.id(column.db_column_name ?? '')} <= ${iso(start + 2 * MINUTE)}::timestamptz
    `.execute(db.kysely);
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toMatch(/_due/u);
    // Clean up: these rows are not part of the other scenarios.
    await sql`DELETE FROM ${sql.id('data', table.db_table_name)} WHERE __id LIKE 'rec_0%'`.execute(
      db.kysely,
    );
  });
});
