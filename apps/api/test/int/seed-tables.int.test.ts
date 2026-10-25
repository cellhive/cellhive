import { recordListResponseSchema, type Id } from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BENCH_AUTOMATION_NAMES } from '../../src/seed/bench-automations.js';
import { seedBench } from '../../src/seed/bench-seed.js';
import {
  BENCH_COMPUTED,
  BENCH_CUSTOMER_LINK_NAME,
  BENCH_LINK_CELL_SIZE,
  BENCH_LINK_FIELD_NAME,
  seedBenchTable,
} from '../../src/seed/bench-table.js';
import { DEMO_COMPUTED_FIELDS, DEMO_TIER_THRESHOLDS } from '../../src/seed/demo-computed.js';
import {
  DEMO_ORDER_FIELDS,
  DEMO_TABLE_COUNTS,
  DEMO_TABLE_NAMES,
  orderLineCountFor,
  seedDemoTables,
} from '../../src/seed/demo-tables.js';
import { seededFaker } from '../../src/seed/record-seeding.js';
import { sampleFiles } from '../../src/seed/sample-attachments.js';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { relaxRateLimits } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

/**
 * T108 seed: the tables part of `pnpm seed:demo` (CONTRACTS §9) and the
 * `seed:bench` table, created through the services and read back over HTTP.
 */
// 17 s alone, but one 60 s timeout seen under a loaded full `test:int` (T709 review): 3 min.
describe('demo and bench tables seed (T108)', { timeout: 180_000 }, () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let orgId: Id<'org'>;
  let baseId: Id<'bse'>;
  let owner: SeededUser;
  let sales: SeededUser[];
  let browser: Browser;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    relaxRateLimits(t);
    orgId = await seedOrg(db, 'Demo');
    owner = await seedUser(db, { memberships: [{ orgId, role: 'owner' }] });
    sales = [
      await seedUser(db, { memberships: [{ orgId, role: 'member' }] }),
      await seedUser(db, { memberships: [{ orgId, role: 'member' }] }),
    ];
    browser = new Browser(t.app);
    expect((await browser.login(owner.email)).statusCode).toBe(204);
    const workspace = await browser.request({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/workspaces`,
      payload: { name: 'Kinh doanh' },
    });
    const base = await browser.request({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace.json<{ id: string }>().id}/bases`,
      payload: { name: 'Chăm sóc khách hàng' },
    });
    baseId = base.json<{ id: Id<'bse'> }>().id;
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  async function tablesByName() {
    const rows = await db.kysely
      .selectFrom('meta.tables')
      .select(['id', 'name'])
      .where('organization_id', '=', orgId)
      .where('deleted_at', 'is', null)
      .execute();
    const id = (name: string) => {
      const found = rows.find((row) => row.name === name)?.id;
      if (found === undefined) throw new Error(`no table ${name}`);
      return found;
    };
    return {
      customers: id(DEMO_TABLE_NAMES.customers),
      tickets: id(DEMO_TABLE_NAMES.tickets),
      orders: id(DEMO_TABLE_NAMES.orders),
      orderLines: id(DEMO_TABLE_NAMES.orderLines),
    };
  }

  /** Every record of a table, 1 000 per page. */
  async function all(tableId: Id<'tbl'>) {
    const records = [];
    for (let offset = 0; ; offset += 1_000) {
      const page = await query(tableId, { offset, limit: 1_000 });
      records.push(...page.records);
      if (page.records.length < 1_000) return records;
    }
  }

  async function query(tableId: Id<'tbl'>, body: object = {}) {
    const response = await browser.request({
      method: 'POST',
      url: `/api/v1/tables/${tableId}/records/query`,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    return recordListResponseSchema.parse(response.json());
  }

  it('creates Customers (200), Tickets (2 000), Orders (5 000) and order lines, deterministically', async () => {
    const input = {
      organizationId: orgId,
      baseId,
      ownerId: owner.id,
      assigneeIds: sales.map((user) => user.id),
      timeZone: 'Asia/Ho_Chi_Minh',
      locale: 'vi',
    };
    const result = await seedDemoTables(t.app, input);
    expect(result.created).toBe(true);

    const customers = await query(result.tables.customers, {
      sort: [{ field: 'Mã khách hàng' }],
      limit: 1,
    });
    expect(customers).toMatchObject({ total: DEMO_TABLE_COUNTS.customers });
    // Fixed faker seed: the first company is always the same.
    expect(customers.records[0]?.fields).toMatchObject({
      Tên: seededFaker().company.name(),
      'Mã khách hàng': 'KH001',
    });

    const tickets = await query(result.tables.tickets, { limit: 3 });
    expect(tickets).toMatchObject({ total: DEMO_TABLE_COUNTS.tickets });
    for (const record of tickets.records) {
      expect(record.fields['Mã ticket']).toMatch(/^TK-\d{8}-\d{4}$/);
      expect(['Mới', 'Đang xử lý', 'Chờ khách', 'Đã xong']).toContain(record.fields['Trạng thái']);
      expect(record.fields['Phụ trách']).toEqual([
        expect.objectContaining({ id: expect.stringMatching(/^usr_/) as unknown }),
      ]);
    }

    const orders = await query(result.tables.orders, {
      filter: { logic: 'and', conditions: [['status', '==', 'Xong']] },
      limit: 1,
    });
    expect(orders.records[0]?.fields).toEqual(
      expect.objectContaining({
        // T421b: Vietnamese names for the title and the customer link.
        [DEMO_ORDER_FIELDS.title]: expect.stringMatching(/^ĐH-\d{5} /) as unknown,
        amount: expect.any(Number) as unknown,
        cost: expect.any(Number) as unknown,
        status: 'Xong',
        // BACKLOG T412: one-way link to Customers, id + title (the owner reads everything).
        [DEMO_ORDER_FIELDS.customer]: [
          { id: expect.stringMatching(/^rec_/) as unknown, title: expect.any(String) as unknown },
        ],
      }),
    );
    expect(await query(result.tables.orders, { limit: 1 })).toMatchObject({
      total: DEMO_TABLE_COUNTS.orders,
    });

    // BACKLOG T412: "Chi tiết đơn hàng", linked to Orders both ways.
    const orderLineCount = orderLineCountFor(DEMO_TABLE_COUNTS.orders);
    const orderLines = await query(result.tables.orderLines, { limit: 1 });
    expect(orderLines).toMatchObject({ total: orderLineCount });
    expect(orderLines.records[0]?.fields).toEqual(
      expect.objectContaining({
        'Sản phẩm': expect.any(String) as unknown,
        'Số lượng': expect.any(Number) as unknown,
        'Đơn giá': expect.any(Number) as unknown,
        'Đơn hàng': [
          { id: expect.stringMatching(/^rec_/) as unknown, title: expect.any(String) as unknown },
        ],
      }),
    );

    // BACKLOG T412: a small sub-record tree and sample attachments on Tickets
    // (two pages: `records/query` caps `limit` at 1 000).
    const ticketRecords = [
      ...(await query(result.tables.tickets, { offset: 0, limit: 1_000 })).records,
      ...(await query(result.tables.tickets, { offset: 1_000, limit: 1_000 })).records,
    ];
    const withParent = ticketRecords.filter((record) => record.fields['Cha'] !== null);
    expect(withParent).toHaveLength(8); // `ticketTreeEdges` of demo-tables.ts
    for (const record of withParent) {
      expect(record.fields['Cha']).toMatchObject({
        id: expect.stringMatching(/^rec_/) as unknown,
        title: expect.any(String) as unknown,
      });
    }
    const withFiles = ticketRecords.filter((record) => {
      const files = record.fields['Tệp đính kèm'];
      return Array.isArray(files) && files.length > 0;
    });
    expect(withFiles).toHaveLength(sampleFiles().length);
    for (const record of withFiles) {
      const files = record.fields['Tệp đính kèm'] as { id: string; url: string }[];
      const download = await browser.request({ method: 'GET', url: files[0]?.url ?? '' });
      expect(download.statusCode, download.body).toBe(302);
    }

    // Every record was written as the owner, with events and audit entries.
    const audit = await db.kysely
      .selectFrom('meta.audit_logs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', orgId)
      .where('action', '=', 'record.created')
      .where('actor_id', '=', owner.id)
      .executeTakeFirstOrThrow();
    expect(Number(audit.n)).toBe(
      DEMO_TABLE_COUNTS.customers +
        DEMO_TABLE_COUNTS.tickets +
        DEMO_TABLE_COUNTS.orders +
        orderLineCount,
    );

    // A second run changes nothing.
    expect(await seedDemoTables(t.app, input)).toEqual({ created: false, tables: result.tables });
  });

  it('adds the S4b formula and lookup fields, computed and ready (T464)', async () => {
    const tables = await tablesByName();
    const names = DEMO_COMPUTED_FIELDS;
    const fields = await db.kysely
      .selectFrom('meta.fields')
      .select(['name', 'type', 'compute_mode', 'compute_state', 'table_id'])
      .where('organization_id', '=', orgId)
      .where('type', 'in', ['formula', 'lookup'])
      .where('deleted_at', 'is', null)
      .execute();
    const mode = (tableId: Id<'tbl'>, name: string) =>
      fields.find((field) => field.table_id === tableId && field.name === name);
    expect(fields).toHaveLength(9);
    for (const field of fields) expect(field.compute_state).toBe('ready');
    expect(mode(tables.orders, names.orders.margin)?.compute_mode).toBe('stored');
    expect(mode(tables.tickets, names.tickets.overdue)?.compute_mode).toBe('virtual');
    expect(mode(tables.tickets, names.tickets.customerName)?.compute_mode).toBe('stored');
    expect(mode(tables.customers, names.customers.revenueFormula)?.compute_mode).toBe('stored');
    // The seed closed every backfill job it computed inline (a worker skips them).
    const jobs = await db.kysely
      .selectFrom('meta.jobs')
      .select(['status'])
      .where('organization_id', '=', orgId)
      .where('type', '=', 'computed.backfill')
      .execute();
    expect(jobs.length).toBeGreaterThan(0);
    expect(new Set(jobs.map((job) => job.status))).toEqual(new Set(['succeeded']));

    const orders = await all(tables.orders);
    const lines = await all(tables.orderLines);
    const customers = await all(tables.customers);
    const tickets = await all(tables.tickets);
    const num = (value: unknown) => (typeof value === 'number' ? value : 0);

    // Same row: margin and line total.
    for (const order of orders) {
      expect(order.fields[names.orders.margin]).toBe(
        num(order.fields['amount']) - num(order.fields['cost']),
      );
    }
    const linesTotal = new Map<string, number>();
    for (const line of lines) {
      const total = num(line.fields['Số lượng']) * num(line.fields['Đơn giá']);
      expect(line.fields[names.orderLines.lineTotal]).toBe(total);
      const order = (line.fields['Đơn hàng'] as { id: string }[])[0]?.id ?? '';
      linesTotal.set(order, (linesTotal.get(order) ?? 0) + total);
    }
    // Lookup `sum` through the two-way link.
    for (const order of orders) {
      expect(order.fields[names.orders.linesTotal]).toBe(linesTotal.get(order.id) ?? 0);
    }

    // Customers: lookups through `customer`, the LET formula, the milestone FILTER.
    const done = new Map<string, number>();
    const count = new Map<string, number>();
    for (const order of orders) {
      const customer = (order.fields[DEMO_ORDER_FIELDS.customer] as { id: string }[])[0]?.id ?? '';
      count.set(customer, (count.get(customer) ?? 0) + 1);
      if (order.fields['status'] === 'Xong') {
        done.set(customer, (done.get(customer) ?? 0) + num(order.fields['amount']));
      }
    }
    const nameCount = new Map<unknown, number>();
    for (const customer of customers) {
      nameCount.set(customer.fields['Tên'], (nameCount.get(customer.fields['Tên']) ?? 0) + 1);
    }
    const tiers = DEMO_TIER_THRESHOLDS;
    const tiered = new Set<unknown>();
    for (const customer of customers) {
      const total = done.get(customer.id) ?? 0;
      expect(customer.fields[names.customers.doneTotal]).toBe(total);
      expect(customer.fields[names.customers.orderCount]).toBe(count.get(customer.id) ?? 0);
      const tier =
        total >= tiers.diamond
          ? 'Kim cương'
          : total >= tiers.gold
            ? 'Vàng'
            : total >= tiers.silver
              ? 'Bạc'
              : 'Thường';
      expect(customer.fields[names.customers.suggestedTier]).toBe(tier);
      tiered.add(tier);
      // By title: equal when no other customer has the same name.
      if (nameCount.get(customer.fields['Tên']) === 1) {
        expect(customer.fields[names.customers.revenueFormula]).toBe(total);
      }
    }
    expect(tiered.size).toBeGreaterThan(1);

    // Tickets: TODAY() (virtual, the organization's zone) and the FILTER without a link.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      new Date(),
    );
    const byCode = new Map(customers.map((item) => [item.fields['Mã khách hàng'], item]));
    const overdue = new Set<unknown>();
    for (const ticket of tickets) {
      const due = String(ticket.fields['Hạn']).slice(0, 10);
      const expected = due < today && ticket.fields['Trạng thái'] !== 'Đã xong';
      expect(ticket.fields[names.tickets.overdue]).toBe(expected);
      overdue.add(expected);
      const customer = byCode.get(ticket.fields['Mã khách hàng']);
      expect(customer).toBeDefined();
      expect(ticket.fields[names.tickets.customerName]).toBe(customer?.fields['Tên']);
      expect(String(ticket.fields['Tiêu đề'])).toContain(String(customer?.fields['Tên']));
    }
    expect(overdue).toEqual(new Set([true, false]));
  });

  it('creates the bench table with 30 fields (2 links) and a 500-link cell', async () => {
    const result = await seedBenchTable(t.app, {
      organizationId: orgId,
      baseId,
      ownerId: owner.id,
      userIds: [owner.id, ...sales.map((user) => user.id)],
      timeZone: 'Asia/Ho_Chi_Minh',
      locale: 'vi',
      rows: 2_000,
    });
    expect(result).toMatchObject({ created: true, rows: 2_000 });
    // 30 fields (2 self-links) + the customer link and code (BACKLOG T464).
    expect(result.fields).toHaveLength(32);
    expect(result.fields.filter((field) => field.type === 'link')).toHaveLength(3);
    const list = await query(result.tableId, { limit: 1 });
    expect(list).toMatchObject({ total: 2_000 });
    expect(Object.keys(list.records[0]?.fields ?? {}).length).toBeGreaterThanOrEqual(30);

    // BACKLOG T464: computed fields, backfilled (`ready`) by the seed itself.
    expect(result.customers).toMatchObject({ rows: 2_000 });
    expect(
      result.computed.map((field) => [field.name, field.compute_mode, field.compute_state]),
    ).toEqual([
      [BENCH_COMPUTED.margin, 'stored', 'ready'],
      [BENCH_COMPUTED.open, 'virtual', 'ready'],
      [BENCH_COMPUTED.total, 'stored', 'ready'],
      [BENCH_COMPUTED.openTotal, 'virtual', 'ready'],
    ]);
    const rows = await all(result.tableId);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      new Date(),
    );
    const byCustomer = new Map<string, { total: number; open: number }>();
    for (const row of rows) {
      const amount = row.fields['Số tiền'] as number;
      expect(row.fields[BENCH_COMPUTED.margin]).toBe(amount - (row.fields['Chi phí'] as number));
      const open = String(row.fields['Hạn']).slice(0, 10) >= today;
      expect(row.fields[BENCH_COMPUTED.open]).toBe(open);
      const customer = (row.fields[BENCH_CUSTOMER_LINK_NAME] as { id: string }[])[0]?.id ?? '';
      const sums = byCustomer.get(customer) ?? { total: 0, open: 0 };
      byCustomer.set(customer, {
        total: sums.total + amount,
        open: sums.open + (open ? amount : 0),
      });
    }
    const customers = await all(result.customers?.tableId ?? ('' as Id<'tbl'>));
    expect(customers).toHaveLength(2_000);
    for (const customer of customers.slice(0, 50)) {
      const sums = byCustomer.get(customer.id) ?? { total: 0, open: 0 };
      expect(customer.fields[BENCH_COMPUTED.total]).toBe(sums.total);
      expect(customer.fields[BENCH_COMPUTED.openTotal]).toBe(sums.open);
    }

    // BACKLOG T412: `seed:bench` also carries a 500-link cell (ADR-28's limit).
    expect(result.bigLinkCell).not.toBeNull();
    const cellRecordId = result.bigLinkCell?.recordId ?? '';
    const record = await browser.request({
      method: 'GET',
      url: `/api/v1/tables/${result.tableId}/records/${cellRecordId}`,
    });
    expect(record.statusCode, record.body).toBe(200);
    const cell = record.json<{ fields: Record<string, { id: string }[] | null> }>().fields[
      BENCH_LINK_FIELD_NAME
    ];
    expect(cell).toHaveLength(BENCH_LINK_CELL_SIZE);
  });

  it('seed:bench settles the events of its records and adds its automations, off (T519)', async () => {
    const first = await seedBench(t.app, { rows: 600 });
    expect(first).toMatchObject({ created: true, rows: 600, automations: 3 });
    // 600 rows + 600 customers and a few links: every record event is settled.
    expect(first.settledEvents).toBeGreaterThan(1_200);
    const pending = async () =>
      (
        await sql<{ events: number; jobs: number }>`
          SELECT (SELECT count(*)::int FROM meta.events
                   WHERE organization_id = ${first.organizationId}
                     AND dispatched_at IS NULL AND type = 'record.created') AS events,
                 (SELECT count(*)::int FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id)
                   WHERE task_identifier = 'events.dispatch'
                     AND payload->>'organization_id' = ${first.organizationId}) AS jobs
        `.execute(db.kysely)
      ).rows[0];
    const after = await pending();
    expect(after?.events).toBe(0);
    // Only the events of the three automations (created after the settlement).
    expect(after?.jobs).toBeLessThan(10);
    const automations = await db.kysely
      .selectFrom('meta.automations')
      .select(['name', 'enabled', 'trigger_type'])
      .where('organization_id', '=', first.organizationId)
      .orderBy('name')
      .execute();
    expect(automations).toEqual(
      [
        { name: BENCH_AUTOMATION_NAMES.bulk, enabled: false, trigger_type: 'record.updated' },
        { name: BENCH_AUTOMATION_NAMES.due, enabled: false, trigger_type: 'record.date_reached' },
        { name: BENCH_AUTOMATION_NAMES.status, enabled: false, trigger_type: 'record.updated' },
      ].sort((a, b) => a.name.localeCompare(b.name)),
    );
    // Run again: nothing new, the automations exist (no settlement possible any more).
    const again = await seedBench(t.app, { rows: 600 });
    expect(again).toMatchObject({ created: false, automations: 0, settledEvents: 0 });
  });
});
