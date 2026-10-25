/**
 * Opt-in bench (BACKLOG T458): `RECOMPUTE_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/computed/recompute.bench`.
 *
 * 1. `PATCH` of one order's amount, p95 with and without a lookup `sum` on
 *    Customers reading it (target: + < 50 ms);
 * 2. `PATCH` of one cell with 500 two-way links, 2 lookups on each side
 *    (target < 1 s);
 * 3. the T423 bulk write (10 000 lines → 5 000 orders, two-way link, 1 000
 *    per call) with a lookup on Orders summing its lines: write time
 *    (target ≤ S4 + 50 %, S4 = 2.6–5.0 s) and the job catching up (< 30 s);
 * 4. the job recomputing every row of a 200 000-row table (< 60 s).
 *
 * Reports numbers; never fails on them (BACKLOG S4b "Hiệu năng"). Measured
 * only when the 1-minute load is below 8, else reported as pending.
 */
import os from 'node:os';

import { newId, type Id } from '@cellhive/contracts';
import { LINK_MAX_PER_CELL } from '@cellhive/field-types';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { ComputedRecomputeService } from '../../src/computed/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
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

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG: Id<'org'> = 'org_T458BenchOrgAAAA';
const ORDERS = 5_000;
const LINES = 10_000;
const BATCH = 1_000;
const BIG = 200_000;
const RUNS = Number(process.env['RECOMPUTE_BENCH_RUNS'] ?? '30');
const LOAD_LIMIT = 8;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const load = () => os.loadavg()[0] ?? 0;

describe.skipIf(process.env['RECOMPUTE_BENCH'] !== '1')(
  'incremental recompute bench (T458)',
  () => {
    let database: TestDatabase;
    let db: Db;
    let pool: pg.Pool;
    let fx: OrdersFixture;
    let schema: SchemaService;
    let mutation: RecordMutationService;
    const report: string[] = [];
    const scope = orgScope(ORG);
    const context = systemAuditContext();
    let pending = false;

    const audit = (): AuditContext => {
      const id = newId('req');
      return {
        actor: { type: 'user', id: fx.users.u_admin.id },
        via: null,
        batch_id: id,
        request_id: id,
        ip: null,
        user_agent: 'bench',
      };
    };

    async function refreshSchema(tables: readonly TableRow[] = []): Promise<void> {
      for (const table of tables) {
        if (!fx.schema.tables.some((item) => item.id === table.id)) {
          fx.schema.tables.push({ id: table.id, fields: [] });
        }
      }
      for (const table of fx.schema.tables) {
        table.fields = await db.kysely
          .selectFrom('meta.fields')
          .select(['id', 'type'])
          .where('table_id', '=', table.id)
          .where('deleted_at', 'is', null)
          .execute();
      }
    }

    async function backfill(field: FieldRow): Promise<void> {
      let cursor = 0n;
      for (;;) {
        const result = await mutation.backfillComputedBatch(scope, {
          fieldId: field.id,
          afterAuto: cursor,
          limit: 5000,
          statementTimeoutMs: 120_000,
        });
        if (result.status !== 'more') break;
        cursor = result.cursor;
      }
      await schema.finishComputedBackfill(scope, field.id, { status: 'ready' });
    }

    async function drain(): Promise<number> {
      const started = performance.now();
      for (let guard = 0; guard < 10_000; guard += 1) {
        const queued = await db.kysely
          .selectFrom('meta.computed_recompute_queue')
          .select('field_id')
          .distinct()
          .where('organization_id', '=', ORG)
          .execute();
        if (queued.length === 0) break;
        for (const row of queued) {
          for (;;) {
            const batch = await mutation.recomputeComputedBatch(scope, row.field_id, {
              statementTimeoutMs: 120_000,
            });
            if (batch.status !== 'more') break;
          }
        }
      }
      return performance.now() - started;
    }

    async function lookup(
      table: TableRow,
      name: string,
      options: Record<string, unknown>,
    ): Promise<FieldRow> {
      const field = await schema.addField(
        scope,
        table.id,
        { name, type: 'lookup', options, computed: { timeZone: 'UTC' } },
        context,
      );
      await backfill(field);
      return field;
    }

    beforeAll(async () => {
      pending = load() >= LOAD_LIMIT;
      if (pending) return;
      database = await createTestDatabase();
      db = createTestDb(database.url);
      await migrateAll(database.url, db);
      pool = new pg.Pool({ connectionString: database.url, max: 2 });
      schema = new SchemaService(db, { maxFieldsPerTable: 500 });
      mutation = new RecordMutationService(db, {
        schema,
        query: new RecordQueryService(db, { now: () => NOW }),
        now: () => NOW,
      });
      fx = await buildOrdersFixture(db, schema, ORG);
    }, 600_000);

    afterAll(async () => {
      const header = pending
        ? `load ${load().toFixed(1)} ≥ ${String(LOAD_LIMIT)}: measurement pending`
        : `load at the end ${load().toFixed(1)}`;
      process.stdout.write(`\nT458 recompute bench (${header})\n${report.join('\n')}\n`);
      if (pending) return;
      await pool.end();
      await db.destroy();
      await database.drop();
    });

    it('PATCH p95 of an amount, without then with a lookup sum reading it', async () => {
      if (pending) return;
      const customer = await schema.addField(
        scope,
        fx.orders.id,
        { name: 'customer', type: 'link', options: { link_table: fx.customers.id } },
        context,
      );
      await refreshSchema();
      const access = accessOf(fx, 'u_admin');
      const [c] = (
        await mutation.create(
          scope,
          fx.customers.id,
          access,
          { field_key_type: 'id', records: [{ fields: { [fx.fld.name.id]: 'An' } }] },
          audit(),
        )
      ).records;
      const created = await mutation.create(
        scope,
        fx.orders.id,
        access,
        {
          field_key_type: 'id',
          records: Array.from({ length: 200 }, (_, i) => ({
            fields: {
              [fx.fld.title.id]: `o${String(i)}`,
              [fx.fld.amount.id]: i,
              [customer.id]: [c?.id],
            },
          })),
        },
        audit(),
        { readBack: false },
      );
      expect(created.records).toEqual([]);
      const target = (
        await pool.query<{ __id: Id<'rec'> }>(
          `SELECT __id FROM data.${pg.escapeIdentifier(fx.orders.db_table_name)} LIMIT 1`,
        )
      ).rows[0]?.__id as Id<'rec'>;
      const patch = async (): Promise<number[]> => {
        const samples: number[] = [];
        for (let run = 0; run < RUNS; run += 1) {
          const start = performance.now();
          await mutation.update(
            scope,
            fx.orders.id,
            access,
            {
              field_key_type: 'id',
              records: [{ id: target, fields: { [fx.fld.amount.id]: run } }],
            },
            audit(),
          );
          samples.push(performance.now() - start);
        }
        return samples;
      };
      const without = await patch();
      await lookup(fx.customers, 'total', {
        from: fx.orders.id,
        select: fx.fld.amount.id,
        where: { field: customer.id, operator: 'intersects', value: { field_ref: '__id' } },
        aggregate: 'sum',
      });
      const withLookup = await patch();
      report.push(
        `PATCH amount p95: ${percentile(without, 95).toFixed(1)} ms without, ` +
          `${percentile(withLookup, 95).toFixed(1)} ms with the lookup sum ` +
          `(+${(percentile(withLookup, 95) - percentile(without, 95)).toFixed(1)} ms, target < 50)`,
      );
    }, 600_000);

    it('PATCH 500 two-way links with 2 lookups on each side; T423 bulk with a lookup', async () => {
      if (pending) return;
      const { table: lines } = await schema.createTable(
        scope,
        { baseId: fx.baseId, name: 'Lines', primaryFieldName: 'Sản phẩm' },
        context,
      );
      const qty = await schema.addField(scope, lines.id, { name: 'qty', type: 'number' }, context);
      const link = await schema.addField(
        scope,
        lines.id,
        { name: 'order', type: 'link', options: { link_table: fx.orders.id, bidirectional: true } },
        context,
      );
      const reverse = await db.kysely
        .selectFrom('meta.fields')
        .selectAll()
        .where('table_id', '=', fx.orders.id)
        .where('link_junction', '=', link.link_junction)
        .executeTakeFirstOrThrow();
      await refreshSchema([lines]);
      await insertBulk(pool, fx.orders, [
        {
          name: fx.fld.title.db_column_name as string,
          pgType: 'text',
          values: Array.from({ length: ORDERS }, (_, i) => `ĐH-${String(i + 1).padStart(5, '0')}`),
        },
        {
          name: fx.fld.amount.db_column_name as string,
          pgType: 'numeric',
          values: Array.from({ length: ORDERS }, (_, i) => i % 100),
        },
      ]);
      const orderIds = (
        await pool.query<{ __id: Id<'rec'> }>(
          `SELECT __id FROM data.${pg.escapeIdentifier(fx.orders.db_table_name)} ORDER BY __auto DESC LIMIT ${String(ORDERS)}`,
        )
      ).rows.map((row) => row.__id);
      // Orders: sum and count of their lines; Lines: amount and title of their order.
      const lineSum = await lookup(fx.orders, 'lineQty', {
        from: lines.id,
        select: qty.id,
        where: { field: link.id, operator: 'intersects', value: { field_ref: '__id' } },
        aggregate: 'sum',
      });
      await lookup(fx.orders, 'lineCount', {
        from: lines.id,
        select: qty.id,
        where: { field: link.id, operator: 'intersects', value: { field_ref: '__id' } },
        aggregate: 'counta',
      });
      await lookup(lines, 'orderAmount', {
        from: fx.orders.id,
        select: fx.fld.amount.id,
        where: { field: reverse.id, operator: 'intersects', value: { field_ref: '__id' } },
        aggregate: 'sum',
      });
      await lookup(lines, 'orderCount', {
        from: fx.orders.id,
        select: fx.fld.amount.id,
        where: { field: reverse.id, operator: 'intersects', value: { field_ref: '__id' } },
        aggregate: 'counta',
      });
      await refreshSchema([lines]);
      const access = accessOf(fx, 'u_admin');

      const start = performance.now();
      const perCall: number[] = [];
      for (let from = 0; from < LINES; from += BATCH) {
        const begin = performance.now();
        await mutation.create(
          scope,
          lines.id,
          access,
          {
            field_key_type: 'id',
            records: Array.from({ length: BATCH }, (_, k) => {
              const i = from + k;
              return {
                fields: { [qty.id]: (i % 10) + 1, [link.id]: [orderIds[i % ORDERS]] },
              };
            }),
          },
          audit(),
          { readBack: false },
        );
        perCall.push(performance.now() - begin);
      }
      const written = performance.now() - start;
      const caughtUp = await drain();
      report.push(
        `T423 bulk ${String(LINES)} lines → ${String(ORDERS)} orders with 2 lookups per side: ` +
          `write ${written.toFixed(0)} ms (per call ${Math.min(...perCall).toFixed(0)}–` +
          `${Math.max(...perCall).toFixed(0)} ms; S4 2 600–5 000 ms), job ${caughtUp.toFixed(0)} ms (< 30 s)`,
      );
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM data.${pg.escapeIdentifier(fx.orders.db_table_name)} WHERE ${pg.escapeIdentifier(lineSum.db_column_name as string)} IS NOT NULL`,
      );
      expect(Number(rows[0]?.n)).toBeGreaterThan(0);

      const [line] = (
        await mutation.create(
          scope,
          lines.id,
          access,
          { field_key_type: 'id', records: [{ fields: { [qty.id]: 1 } }] },
          audit(),
        )
      ).records;
      const patchStart = performance.now();
      await mutation.update(
        scope,
        lines.id,
        access,
        {
          field_key_type: 'id',
          records: [
            {
              id: line?.id as Id<'rec'>,
              fields: { [link.id]: orderIds.slice(0, LINK_MAX_PER_CELL) },
            },
          ],
        },
        audit(),
      );
      const patched = performance.now() - patchStart;
      const patchJob = await drain();
      report.push(
        `PATCH 500 two-way links, 2 lookups per side: ${patched.toFixed(0)} ms (< 1 s), ` +
          `job for the rest ${patchJob.toFixed(0)} ms`,
      );
    }, 1_200_000);

    it(`job recomputing every row of ${String(BIG)} rows`, async () => {
      if (pending) return;
      const { table: big, primaryField: name } = await schema.createTable(
        scope,
        { baseId: fx.baseId, name: 'Big', primaryFieldName: 'name' },
        context,
      );
      const n = await schema.addField(scope, big.id, { name: 'n', type: 'number' }, context);
      await insertBulk(pool, big, [
        {
          name: name.db_column_name as string,
          pgType: 'text',
          values: Array.from({ length: BIG }, (_, i) => `r${String(i)}`),
        },
        {
          name: n.db_column_name as string,
          pgType: 'numeric',
          values: Array.from({ length: BIG }, (_, i) => i % 1000),
        },
      ]);
      const formula = await schema.addField(
        scope,
        big.id,
        {
          name: 'f',
          type: 'formula',
          options: { expression: 'IF([n] > 500, [n] * 0.1, 0)' },
          computed: { timeZone: 'UTC' },
        },
        context,
      );
      await backfill(formula);
      await db.withTx((tx) =>
        new ComputedRecomputeService(db).enqueue(tx, {
          organizationId: ORG,
          changes: [{ kind: 'fields', baseId: fx.baseId, tableId: big.id, fieldIds: [n.id] }],
        }),
      );
      const elapsed = await drain();
      report.push(`job over every row of ${String(BIG)}: ${elapsed.toFixed(0)} ms (< 60 s)`);
    }, 1_200_000);
  },
);
