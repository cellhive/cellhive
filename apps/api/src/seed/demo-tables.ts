import { newId, type Id } from '@cellhive/contracts';
import {
  FieldsRepository,
  orgScope,
  RecordMutationService,
  SchemaService,
  TablesRepository,
  type AuditContext,
  type Db,
  type OrgScope,
  type StorageDriver,
} from '@cellhive/server-core';

import { DB, STORAGE_DRIVER } from '../common/tokens.js';

import { seedDemoComputed } from './demo-computed.js';
import {
  insertInBatches,
  ownerAccessContext,
  seedAuditContext,
  seededFaker,
} from './record-seeding.js';
import { createSampleAttachment, sampleFiles } from './sample-attachments.js';

import type { Faker } from '@faker-js/faker';
import type { INestApplicationContext } from '@nestjs/common';

/**
 * Row counts of CONTRACTS §9 (`orderLines`: the count `orderLineCountFor`
 * gives for 5 000 orders — every order gets 1–5 lines, BACKLOG T423).
 */
export const DEMO_TABLE_COUNTS = {
  customers: 200,
  tickets: 2_000,
  orders: 5_000,
  orderLines: 15_000,
} as const;

export const DEMO_TABLE_NAMES = {
  customers: 'Customers',
  tickets: 'Tickets',
  orders: 'Orders',
  /** Order lines, linked to Orders both ways (BACKLOG T412). */
  orderLines: 'Chi tiết đơn hàng',
} as const;

/**
 * Display names of the Orders fields that are not CONTRACTS §5 permission
 * names (T421b: Vietnamese like the rest of the demo; `amount`, `cost`,
 * `status` and `owner` stay, the `Sales` role and the views refer to them).
 */
export const DEMO_ORDER_FIELDS = {
  title: 'Tên đơn hàng',
  customer: 'Khách hàng',
} as const;

export interface DemoTablesInput {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  /** Organization owner who creates everything (the demo `u_admin`). */
  readonly ownerId: Id<'usr'>;
  /** Users tickets and orders are assigned to (e.g. `u_sales1`, `u_sales2`, `u_editor`). */
  readonly assigneeIds: readonly Id<'usr'>[];
  /** Organization zone and locale (`Asia/Ho_Chi_Minh`, `vi`). */
  readonly timeZone: string;
  readonly locale: string;
  /**
   * Smaller `Customers`/`Tickets`/`Orders` tables for tests (default
   * `DEMO_TABLE_COUNTS`). `Chi tiết đơn hàng` is always derived from the
   * `orders` count (`orderLineCountFor`), never given directly.
   */
  readonly counts?: Partial<Record<'customers' | 'tickets' | 'orders', number>>;
  readonly onProgress?: (message: string) => void;
}

export interface DemoTablesResult {
  readonly created: boolean;
  readonly tables: Readonly<Record<keyof typeof DEMO_TABLE_NAMES, Id<'tbl'>>>;
}

const CITIES = ['Hà Nội', 'TP. Hồ Chí Minh', 'Đà Nẵng', 'Hải Phòng', 'Cần Thơ', 'Huế', 'Nha Trang'];
const TIERS = ['Thường', 'Bạc', 'Vàng', 'Kim cương'];
const TICKET_STATUSES = ['Mới', 'Đang xử lý', 'Chờ khách', 'Đã xong'];
const PRIORITIES = ['Thấp', 'Trung bình', 'Cao', 'Khẩn cấp'];
const ORDER_STATUSES = ['Mới', 'Xong'];
const DEVICES = ['Máy POS', 'Máy in hoá đơn', 'Máy quét mã vạch', 'Két tiền', 'Màn hình khách'];
const ISSUES = [
  'lỗi in',
  'không kết nối được mạng',
  'treo khi thanh toán',
  'sai giá sau cập nhật',
  'không đồng bộ đơn hàng',
  'mất cấu hình',
  'báo lỗi giấy',
];

/** Catalogue of `Chi tiết đơn hàng` (BACKLOG T412): name and a base unit price (VND). */
const ORDER_LINE_PRODUCTS: readonly { readonly name: string; readonly unitPrice: number }[] = [
  { name: 'Máy POS X1', unitPrice: 6_500_000 },
  { name: 'Máy in hoá đơn nhiệt', unitPrice: 1_800_000 },
  { name: 'Đầu đọc mã vạch', unitPrice: 950_000 },
  { name: 'Ngăn kéo đựng tiền', unitPrice: 1_200_000 },
  { name: 'Màn hình khách hàng', unitPrice: 2_400_000 },
  { name: 'Giấy in nhiệt (lốc 10 cuộn)', unitPrice: 450_000 },
  { name: 'Phần mềm quản lý bán hàng (gói năm)', unitPrice: 3_000_000 },
  { name: 'Dịch vụ lắp đặt tận nơi', unitPrice: 500_000 },
  { name: 'Bảo trì định kỳ (gói năm)', unitPrice: 1_500_000 },
  { name: 'Đầu đọc thẻ POS', unitPrice: 800_000 },
];

/** `KH001`, `KH002`, … — the code of the customer at `index` (Customers and Tickets). */
function customerCode(index: number): string {
  return `KH${String(index + 1).padStart(3, '0')}`;
}

function options(names: readonly string[]) {
  return { options: names.map((name) => ({ id: newId('opt'), name })) };
}

function dayOf(faker: Faker, from: string, to: string): string {
  return faker.date.between({ from, to }).toISOString().slice(0, 10);
}

/**
 * Rows of `Chi tiết đơn hàng` for `orderCount` orders: a deterministic
 * `(index % 5) + 1` lines per order (average 3, exactly matching
 * `buildOrderLines` — no randomness in the *count*, only in which
 * product/quantity/price each line gets). Every order gets lines since
 * T423 made bulk two-way link writes set-based (T412 had capped them at the
 * first 1 000 orders to keep `pnpm seed:demo` ≤ 10 s).
 */
export function orderLineCountFor(orderCount: number): number {
  const fullGroups = Math.floor(orderCount / 5);
  const remainder = orderCount % 5;
  let remainderSum = 0;
  for (let index = 0; index < remainder; index += 1) remainderSum += index + 1;
  return fullGroups * 15 + remainderSum;
}

interface OrderLineRow {
  readonly orderId: Id<'rec'>;
  readonly product: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

function buildOrderLines(faker: Faker, orderIds: readonly Id<'rec'>[]): OrderLineRow[] {
  const lines: OrderLineRow[] = [];
  orderIds.forEach((orderId, index) => {
    const count = (index % 5) + 1;
    for (let line = 0; line < count; line += 1) {
      const product = faker.helpers.arrayElement(ORDER_LINE_PRODUCTS);
      const fuzz = faker.number.float({ min: 0.9, max: 1.1, fractionDigits: 2 });
      lines.push({
        orderId,
        product: product.name,
        quantity: faker.number.int({ min: 1, max: 10 }),
        unitPrice: Math.round((product.unitPrice * fuzz) / 1_000) * 1_000,
      });
    }
  });
  return lines;
}

/**
 * A small sub-record tree of Tickets (BACKLOG T412), by index among the
 * already-created tickets: root A (0) with a child (1), a grandchild (2)
 * and a great-grandchild (3, depth 4) plus a second child (4); root B (5)
 * with two children (6, 7), one with its own child (8, depth 3); root C (9)
 * with one child (10).
 */
function ticketTreeEdges(
  ticketIds: readonly Id<'rec'>[],
): { id: Id<'rec'>; parentId: Id<'rec'> }[] {
  const id = (index: number): Id<'rec'> => {
    const found = ticketIds[index];
    if (found === undefined) throw new Error('need at least 11 tickets to build the demo tree');
    return found;
  };
  return [
    { id: id(1), parentId: id(0) },
    { id: id(2), parentId: id(1) },
    { id: id(3), parentId: id(2) }, // depth 4
    { id: id(4), parentId: id(0) },
    { id: id(6), parentId: id(5) },
    { id: id(7), parentId: id(5) },
    { id: id(8), parentId: id(7) },
    { id: id(10), parentId: id(9) },
  ];
}

/**
 * The tables part of `pnpm seed:demo` (CONTRACTS §9): `Customers` (200),
 * `Tickets` (2 000: status select, assignee user, auto number
 * `TK-{yyyyMMdd}-{0000}`, a `parent` field with a small tree and a sample
 * attachment on a few tickets — BACKLOG T412), `Orders` (5 000, the
 * CONTRACTS §5 fields — title and `customer` named in Vietnamese, T421b —
 * plus a one-way link to `Customers`) and
 * `Chi tiết đơn hàng` (order lines, linked to Orders both ways: 1–5 lines,
 * average 3, on every order — 15 000 rows, BACKLOG T412/T423), all Vietnamese, generated by faker (`vi`) with a
 * fixed seed. S4b formula and lookup fields (BACKLOG T464,
 * `demo-computed.ts`) are added last, once every record exists.
 *
 * Tables are created through `SchemaService`, records through
 * `RecordMutationService` and sample files through the configured storage
 * driver (AGENTS.md rule 1). Runs once: when the base already has all four
 * tables nothing is created.
 */
export async function seedDemoTables(
  app: INestApplicationContext,
  input: DemoTablesInput,
): Promise<DemoTablesResult> {
  const db = app.get<Db>(DB);
  const schema = app.get(SchemaService);
  const records = app.get(RecordMutationService);
  const storage = app.get<StorageDriver>(STORAGE_DRIVER);
  const scope = orgScope(input.organizationId);
  const progress = input.onProgress ?? (() => undefined);

  const existing = await new TablesRepository(db).listByBase(scope, input.baseId);
  const found = (name: string) => existing.find((table) => table.name === name)?.id;
  const already = {
    customers: found(DEMO_TABLE_NAMES.customers),
    tickets: found(DEMO_TABLE_NAMES.tickets),
    orders: found(DEMO_TABLE_NAMES.orders),
    orderLines: found(DEMO_TABLE_NAMES.orderLines),
  };
  if (Object.values(already).every((id) => id !== undefined)) {
    return { created: false, tables: already as DemoTablesResult['tables'] };
  }
  if (Object.values(already).some((id) => id !== undefined)) {
    throw new Error('the demo base has some of the demo tables but not all of them');
  }

  const counts = { ...DEMO_TABLE_COUNTS, ...input.counts };
  if (input.assigneeIds.length === 0) throw new Error('at least one assignee is required');
  const context = seedAuditContext(input.ownerId);
  const tables = await createDemoSchema(schema, scope, input.baseId, context);
  const access = await ownerAccessContext(db, scope, input.baseId, input.ownerId, input);
  const faker = seededFaker();
  const assignee = (index: number) => [{ id: input.assigneeIds[index % input.assigneeIds.length] }];
  const base = { records, scope, access, actorId: input.ownerId };

  progress(`Customers: ${String(counts.customers)} records`);
  const companies = Array.from({ length: counts.customers }, () => faker.company.name());
  const customerIds = await insertInBatches({
    ...base,
    tableId: tables.customers,
    count: counts.customers,
    row: (index) => ({
      Tên: companies[index],
      'Mã khách hàng': customerCode(index),
      'Điện thoại': faker.phone.number(),
      Email: faker.internet.email().toLowerCase(),
      'Thành phố': faker.helpers.arrayElement(CITIES),
      Hạng: faker.helpers.weightedArrayElement([
        { weight: 6, value: TIERS[0] },
        { weight: 3, value: TIERS[1] },
        { weight: 2, value: TIERS[2] },
        { weight: 1, value: TIERS[3] },
      ]),
      'Ngày tham gia': dayOf(faker, '2022-01-01', '2026-06-30'),
    }),
  });

  progress(`Tickets: ${String(counts.tickets)} records`);
  const ticketIds = await insertInBatches({
    ...base,
    tableId: tables.tickets,
    count: counts.tickets,
    row: (index) => {
      // BACKLOG T464: the ticket names its customer by code too (the key of
      // the cross-table FILTER "Tên khách hàng", no link needed).
      const device = faker.helpers.arrayElement(DEVICES);
      const issue = faker.helpers.arrayElement(ISSUES);
      const customer = faker.number.int({ min: 0, max: companies.length - 1 });
      return {
        'Tiêu đề': `${device} ${issue} – ${companies[customer] ?? ''}`,
        'Mã khách hàng': customerCode(customer),
        'Trạng thái': faker.helpers.arrayElement(TICKET_STATUSES),
        'Ưu tiên': faker.helpers.arrayElement(PRIORITIES),
        'Số tiền': faker.number.int({ min: 0, max: 200 }) * 50_000,
        Hạn: dayOf(faker, '2026-06-01', '2026-12-31'),
        'Phụ trách': assignee(faker.number.int({ min: 0, max: 1_000 }) + index),
        'Mô tả': faker.lorem.sentence(),
      };
    },
  });

  progress(`Orders: ${String(counts.orders)} records`);
  const orderIds = await insertInBatches({
    ...base,
    tableId: tables.orders,
    count: counts.orders,
    row: (index) => {
      const amount = faker.number.int({ min: 2, max: 400 }) * 25_000;
      return {
        [DEMO_ORDER_FIELDS.title]: `ĐH-${String(index + 1).padStart(5, '0')} ${faker.helpers.arrayElement(companies)}`,
        amount,
        cost: Math.round(amount * faker.number.float({ min: 0.4, max: 0.8 })),
        status: faker.helpers.weightedArrayElement([
          { weight: 1, value: ORDER_STATUSES[0] },
          { weight: 3, value: ORDER_STATUSES[1] },
        ]),
        owner: assignee(index),
        [DEMO_ORDER_FIELDS.customer]: [
          customerIds[faker.number.int({ min: 0, max: customerIds.length - 1 })],
        ],
      };
    },
  });

  const orderLines = buildOrderLines(faker, orderIds);
  progress(`Chi tiết đơn hàng: ${String(orderLines.length)} records`);
  await insertInBatches({
    ...base,
    tableId: tables.orderLines,
    count: orderLines.length,
    row: (index) => {
      const line = orderLines[index];
      if (line === undefined) throw new Error('order line index out of range');
      return {
        'Sản phẩm': line.product,
        'Số lượng': line.quantity,
        'Đơn giá': line.unitPrice,
        'Đơn hàng': [line.orderId],
      };
    },
  });

  progress('Tickets: sub-record tree and sample attachments');
  const ticketContext = {
    db,
    storage,
    records,
    scope,
    baseId: input.baseId,
    ticketsId: tables.tickets,
    access,
    ownerId: input.ownerId,
    ticketIds,
  };
  await seedTicketTree(ticketContext);
  await seedTicketAttachments(ticketContext);

  progress('Formula and lookup fields');
  await seedDemoComputed(app, scope, tables, { context, timeZone: input.timeZone });

  return { created: true, tables };
}

interface TicketSeedContext {
  readonly db: Db;
  readonly storage: StorageDriver;
  readonly records: RecordMutationService;
  readonly scope: OrgScope;
  readonly baseId: Id<'bse'>;
  readonly ticketsId: Id<'tbl'>;
  readonly access: Awaited<ReturnType<typeof ownerAccessContext>>;
  readonly ownerId: Id<'usr'>;
  readonly ticketIds: readonly Id<'rec'>[];
}

/** Writes the small demo tree onto a handful of the already-created Tickets (BACKLOG T412). */
async function seedTicketTree(context: TicketSeedContext): Promise<void> {
  const edges = ticketTreeEdges(context.ticketIds);
  await context.records.update(
    context.scope,
    context.ticketsId,
    context.access,
    { records: edges.map((edge) => ({ id: edge.id, fields: {}, parent_id: edge.parentId })) },
    seedAuditContext(context.ownerId),
  );
}

/** Attaches the sample files (`sample-attachments.ts`) to a few Tickets (BACKLOG T412). */
async function seedTicketAttachments(context: TicketSeedContext): Promise<void> {
  const files = sampleFiles();
  if (files.length === 0 || context.ticketIds.length < files.length) return;
  const fieldName = 'Tệp đính kèm';
  const fields = await new FieldsRepository(context.db).listByTable(
    context.scope,
    context.ticketsId,
  );
  const field = fields.find((item) => item.name === fieldName);
  if (field === undefined) throw new Error(`Tickets has no field ${fieldName}`);
  const writes = await Promise.all(
    files.map(async (file, index) => {
      const attachmentId = await createSampleAttachment(
        context.db,
        context.storage,
        context.scope,
        {
          baseId: context.baseId,
          tableId: context.ticketsId,
          fieldId: field.id,
          ownerId: context.ownerId,
          file,
        },
      );
      const ticketId = context.ticketIds[index];
      if (ticketId === undefined) throw new Error('not enough tickets for sample attachments');
      return { id: ticketId, fields: { [fieldName]: [{ id: attachmentId }] } };
    }),
  );
  await context.records.update(
    context.scope,
    context.ticketsId,
    context.access,
    { records: writes },
    seedAuditContext(context.ownerId),
  );
}

async function createDemoSchema(
  schema: SchemaService,
  scope: OrgScope,
  baseId: Id<'bse'>,
  context: AuditContext,
): Promise<DemoTablesResult['tables']> {
  const add = (tableId: Id<'tbl'>, name: string, type: string, fieldOptions: unknown = {}) =>
    schema.addField(scope, tableId, { name, type, options: fieldOptions }, context);
  const date = { style: { format: 'dd/MM/yyyy' } };
  const vnd = { style: { type: 'currency', currency_code: 'VND' } };

  const customers = (
    await schema.createTable(
      scope,
      { baseId, name: DEMO_TABLE_NAMES.customers, primaryFieldName: 'Tên' },
      context,
    )
  ).table.id;
  await add(customers, 'Mã khách hàng', 'text');
  await add(customers, 'Điện thoại', 'text', { style: { type: 'phone' } });
  await add(customers, 'Email', 'text', { style: { type: 'email' } });
  await add(customers, 'Thành phố', 'select', options(CITIES));
  await add(customers, 'Hạng', 'select', options(TIERS));
  await add(customers, 'Ngày tham gia', 'datetime', date);

  const tickets = (
    await schema.createTable(
      scope,
      { baseId, name: DEMO_TABLE_NAMES.tickets, primaryFieldName: 'Tiêu đề' },
      context,
    )
  ).table.id;
  await add(tickets, 'Trạng thái', 'select', options(TICKET_STATUSES));
  await add(tickets, 'Ưu tiên', 'select', options(PRIORITIES));
  await add(tickets, 'Số tiền', 'number', vnd);
  await add(tickets, 'Hạn', 'datetime', date);
  await add(tickets, 'Phụ trách', 'user', { multiple: false });
  await add(tickets, 'Mã ticket', 'auto_number', {
    style: {
      rules: [
        { type: 'text', text: 'TK-' },
        { type: 'created_time', date_format: 'yyyyMMdd' },
        { type: 'text', text: '-' },
        { type: 'incremental_number', length: 4 },
      ],
    },
  });
  await add(tickets, 'Mô tả', 'text');
  // BACKLOG T464: key of the cross-table FILTER "Tên khách hàng" (no link).
  await add(tickets, 'Mã khách hàng', 'text');
  // BACKLOG T412: sub-records (a `parent` field is what "enables" them,
  // CONTRACTS §6 `SUBRECORDS_ALREADY_ENABLED`) and a sample attachment field.
  await add(tickets, 'Cha', 'parent');
  await add(tickets, 'Tệp đính kèm', 'attachment');

  // CONTRACTS §5 names (the `Sales` role of T109 refers to them).
  const orders = (
    await schema.createTable(
      scope,
      { baseId, name: DEMO_TABLE_NAMES.orders, primaryFieldName: DEMO_ORDER_FIELDS.title },
      context,
    )
  ).table.id;
  await add(orders, 'amount', 'number', vnd);
  await add(orders, 'cost', 'number', vnd);
  await add(orders, 'status', 'select', options(ORDER_STATUSES));
  await add(orders, 'owner', 'user', { multiple: false });
  // BACKLOG T412: `customer` ("Khách hàng") → Customers, one-way (fixture CONTRACTS §5;
  // one-way so T404's direction change has something to demo in the UI).
  await add(orders, DEMO_ORDER_FIELDS.customer, 'link', { link_table: customers });

  const orderLines = (
    await schema.createTable(
      scope,
      { baseId, name: DEMO_TABLE_NAMES.orderLines, primaryFieldName: 'Sản phẩm' },
      context,
    )
  ).table.id;
  await add(orderLines, 'Số lượng', 'number');
  await add(orderLines, 'Đơn giá', 'number', vnd);
  // Two-way: Orders gets the reverse field "Chi tiết đơn hàng" (the embedded
  // sub-table BACKLOG T412 configures on the "Tất cả đơn hàng" view).
  await add(orderLines, 'Đơn hàng', 'link', {
    link_table: orders,
    bidirectional: true,
    bidirectional_link_field_name: DEMO_TABLE_NAMES.orderLines,
    // One order line belongs to exactly one order; Orders' reverse field
    // stays `allow_multiple: true` (many lines per order, set by the
    // server regardless of this side, SchemaService.addLinkField).
    allow_multiple: false,
  });

  return { customers, tickets, orders, orderLines };
}
