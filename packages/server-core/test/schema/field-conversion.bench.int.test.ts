/**
 * Opt-in bench (BACKLOG T403): `CONVERT_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/schema/field-conversion.bench`.
 * text → number on 200 000 rows: preview time, backfill time (batches of
 * 5 000 + swap), and the latency of an unrelated query while the job runs.
 * Reports numbers; the targets (preview < 2 s, job < 60 s) are checked by
 * humans. The default suite checks the same flow on a few rows.
 */
import { type Id } from '@cellhive/contracts';
import { planFieldConversion } from '@cellhive/field-types';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, type Db } from '../../src/db/index.js';
import { JobsRepository } from '../../src/jobs/index.js';
import {
  MemberDirectoryRepository,
  type ConversionCountsJson,
  previewConversion,
  RecordMutationService,
  RecordQueryService,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  accessOf,
  buildOrdersFixture,
  insertBulk,
  NOW,
  type OrdersFixture,
} from '../records/fixtures.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { userContext } from '../support/schema.js';

const ROWS = 200_000;
const ORG: Id<'org'> = 'org_T403BenchOrgAAAA';

describe.runIf(process.env.CONVERT_BENCH === '1')('field conversion bench (T403)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let schema: SchemaService;
  let query: RecordQueryService;
  let records: RecordMutationService;
  let fx: OrdersFixture;
  const scope = orgScope(ORG);
  const report: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.adminUrl, max: 4 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    records = new RecordMutationService(db, { schema, query, now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG);
  }, 600_000);

  afterAll(async () => {
    // Written in afterAll like the other benches: vitest does not show the
    // console of a passing test (T422).
    process.stdout.write(`\n${report.join('\n')}\n`);
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('converts 200 000 text cells to numbers', async () => {
    const field = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'Bench', type: 'text' },
      userContext(fx.users.u_admin.id),
    );
    const orders = fx.schema.tables[0];
    if (orders !== undefined) {
      fx.schema.tables[0] = {
        ...orders,
        fields: [...orders.fields, { id: field.id, type: 'text' }],
      };
    }
    await insertBulk(pool, fx.orders, [
      {
        name: field.db_column_name as string,
        pgType: 'text',
        values: Array.from({ length: ROWS }, (_, index) =>
          index % 100 === 0 ? 'n/a' : `${String(index)}.000`,
        ),
      },
    ]);

    const plan = planFieldConversion(
      { type: 'text', options: { style: { type: 'plain' } } },
      {
        type: 'number',
        options: {
          style: { type: 'plain', precision: 0, percentage: false, thousands_separator: false },
        },
      },
    );
    const previewStart = performance.now();
    const preview = await previewConversion(
      { query, members: new MemberDirectoryRepository(db) },
      {
        scope,
        tableId: fx.orders.id,
        access: accessOf(fx, 'u_admin'),
        column: field.db_column_name as string,
      },
      plan,
      { locale: 'vi', timeZone: 'UTC' },
    );
    const previewMs = performance.now() - previewStart;
    expect(preview).toMatchObject({ affected: ROWS, lost: ROWS / 100 });

    const started = await schema.startConversion(
      scope,
      field.id,
      {
        expectedFrom: { type: field.type, options: field.options },
        toType: 'number',
        toOptions: {},
        settings: {},
        locale: 'vi',
        timeZone: 'UTC',
      },
      userContext(fx.users.u_admin.id),
    );
    await new JobsRepository(db).markRunning(scope, started.jobId);
    const queryTimes: number[] = [];
    const state = { running: true };
    const probe = (async () => {
      while (state.running) {
        const at = performance.now();
        await query.query(scope, fx.orders.id, accessOf(fx, 'u_admin'), {
          field_key_type: 'id',
          fields: [fx.fld.title.id, field.id],
          limit: 200,
        });
        queryTimes.push(performance.now() - at);
      }
    })();
    const jobStart = performance.now();
    let counts: ConversionCountsJson;
    for (;;) {
      const batch = await records.convertFieldBatch(scope, started.jobId);
      if (batch === undefined) throw new Error('not running');
      counts = batch.counts;
      if (!batch.done) continue;
      if (
        (await schema.finishConversion(scope, started.jobId, {
          status: 'succeeded',
          counts: { ...counts },
        })) === 'finished'
      )
        break;
    }
    const jobMs = performance.now() - jobStart;
    state.running = false;
    await probe;
    queryTimes.sort((a, b) => a - b);
    const p95 = queryTimes[Math.floor(queryTimes.length * 0.95)] ?? 0;
    report.push(
      `T403 bench: preview ${previewMs.toFixed(0)} ms, job ${jobMs.toFixed(0)} ms, ` +
        `${String(queryTimes.length)} queries during the job, p95 ${p95.toFixed(0)} ms`,
    );
    expect(counts).toMatchObject({ affected: ROWS, lost: ROWS / 100 });
  }, 600_000);
});
