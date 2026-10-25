import { newId, type Id } from '@cellhive/contracts';
import {
  orgScope,
  RecordMutationService,
  SchemaService,
  TablesRepository,
  type Db,
  type FieldRow,
} from '@cellhive/server-core';

import { DB } from '../common/tokens.js';

import { SeedComputedFields } from './computed-seeding.js';
import {
  insertInBatches,
  ownerAccessContext,
  SEED_FAKER_SEED,
  seedAuditContext,
  seededFaker,
} from './record-seeding.js';

import type { INestApplicationContext } from '@nestjs/common';

/** SPEC §21 data set: 200 000 records × 30 fields, 2 of them links (BACKLOG T412). */
export const BENCH_ROWS = 200_000;
export const BENCH_TABLE_NAME = 'Bench 200k';
/** Field of the self-link cell holding 500 links (ADR-28's limit, BACKLOG T412). */
export const BENCH_LINK_FIELD_NAME = 'Liên quan';
export const BENCH_LINK_CELL_SIZE = 500;
/** Customers of the computed-field benches (BACKLOG T464, T455/T457/T458): 20 000 rows. */
export const BENCH_CUSTOMERS_TABLE_NAME = 'Bench Customers';
export const BENCH_CUSTOMER_ROWS = 20_000;
/** Link of each bench row to its customer, and the customer code (FILTER key without link). */
export const BENCH_CUSTOMER_LINK_NAME = 'Khách hàng';
export const BENCH_CUSTOMER_CODE_NAME = 'Mã KH';
/** Computed fields of `seed:bench` (BACKLOG T464). */
export const BENCH_COMPUTED = {
  /** Bench 200k, stored, same row. */
  margin: 'Lãi',
  /** Bench 200k, virtual (`TODAY()`). */
  open: 'Còn hạn',
  /** Bench Customers, stored lookup `sum` through the link. */
  total: 'Tổng tiền',
  /** Bench Customers, virtual cross-table FILTER by code (no link). */
  openTotal: 'Doanh số còn hạn',
} as const;

export interface BenchTableInput {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  /** Organization owner who creates the table and records. */
  readonly ownerId: Id<'usr'>;
  /** Users of the two user fields. */
  readonly userIds: readonly Id<'usr'>[];
  readonly timeZone: string;
  readonly locale: string;
  readonly rows?: number;
  /** Rows of `Bench Customers`; default 20 000, at most `rows`. */
  readonly customerRows?: number;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface BenchTableResult {
  readonly tableId: Id<'tbl'>;
  readonly created: boolean;
  readonly rows: number;
  /** Fields of the bench table besides the computed ones (30 + customer link and code). */
  readonly fields: readonly FieldRow[];
  /** `Bench Customers` (BACKLOG T464); `null` when nothing was created. */
  readonly customers: { readonly tableId: Id<'tbl'>; readonly rows: number } | null;
  /** Formula and lookup fields of both tables, as they ended (`ready`). */
  readonly computed: readonly FieldRow[];
  /** Milliseconds spent inserting records. */
  readonly insertMs: number;
  /** Milliseconds spent adding and backfilling the computed fields. */
  readonly computedMs: number;
  /**
   * The record and link field of the 500-link cell (ADR-28's limit,
   * BACKLOG T412); `null` when there were not enough rows for it (a
   * `--rows` below `BENCH_LINK_CELL_SIZE + 1`, e.g. in tests).
   */
  readonly bigLinkCell: { readonly recordId: Id<'rec'>; readonly fieldName: string } | null;
}

const STATUSES = ['Mới', 'Đang xử lý', 'Chờ duyệt', 'Đã xong', 'Huỷ'];
const REGIONS = ['Miền Bắc', 'Miền Trung', 'Miền Nam', 'Tây Nguyên', 'ĐBSCL'];
const CHANNELS = ['Cửa hàng', 'Website', 'Ứng dụng', 'Điện thoại', 'Đại lý', 'Sàn TMĐT'];
const LEVELS = ['Thấp', 'Trung bình', 'Cao'];
const CATEGORIES = ['Đồ uống', 'Thực phẩm', 'Gia dụng', 'Điện tử', 'Thời trang', 'Văn phòng phẩm'];

interface BenchField {
  readonly name: string;
  readonly type: string;
  readonly options?: unknown;
}

function select(names: readonly string[]) {
  return { options: names.map((name) => ({ id: newId('opt'), name })) };
}

/**
 * 27 plain fields besides the primary `Tên` and the 2 link fields added
 * separately after the table exists (30 in total, S§21, BACKLOG T412).
 */
const BENCH_FIELDS: readonly BenchField[] = [
  { name: 'Mã', type: 'text' },
  { name: 'Email', type: 'text', options: { style: { type: 'email' } } },
  { name: 'Điện thoại', type: 'text', options: { style: { type: 'phone' } } },
  { name: 'Địa chỉ', type: 'text' },
  { name: 'Thành phố', type: 'text' },
  { name: 'Công ty', type: 'text' },
  {
    name: 'Số tiền',
    type: 'number',
    options: { style: { type: 'currency', currency_code: 'VND' } },
  },
  { name: 'Chi phí', type: 'number' },
  { name: 'Số lượng', type: 'number' },
  { name: 'Giảm giá', type: 'number' },
  { name: 'Điểm', type: 'number' },
  { name: 'Tiến độ', type: 'number' },
  { name: 'Cân nặng', type: 'number' },
  { name: 'Xếp hạng', type: 'number' },
  { name: 'Trạng thái', type: 'select', options: select(STATUSES) },
  { name: 'Khu vực', type: 'select', options: select(REGIONS) },
  { name: 'Kênh', type: 'select', options: select(CHANNELS) },
  { name: 'Mức độ', type: 'select', options: select(LEVELS) },
  { name: 'Danh mục', type: 'select', options: select(CATEGORIES) },
  { name: 'Hạn', type: 'datetime', options: { style: { format: 'dd/MM/yyyy' } } },
  { name: 'Ngày tạo đơn', type: 'datetime', options: { style: { format: 'dd/MM/yyyy' } } },
  { name: 'Hẹn gọi lại', type: 'datetime', options: { style: { format: 'dd/MM/yyyy HH:mm' } } },
  { name: 'Đã thanh toán', type: 'checkbox' },
  { name: 'Ưu tiên', type: 'checkbox' },
  { name: 'Phụ trách', type: 'user', options: { multiple: false } },
  { name: 'Theo dõi', type: 'user', options: { multiple: true } },
  { name: 'Số phiếu', type: 'auto_number' },
];

/**
 * `pnpm seed:bench` (CONTRACTS §9, SPEC §21): one table of 200 000 records
 * and 30 fields with Vietnamese values from faker (`vi`, fixed seed), plus
 * (BACKLOG T464) a link and a code to `Bench Customers` (20 000 records)
 * and the computed fields of `addBenchComputed`. Uses
 * `SchemaService` and `RecordMutationService` in batches of 1 000 (AGENTS.md
 * rule 1: no bulk path around the services). Skipped when the base already
 * has the table.
 */
export async function seedBenchTable(
  app: INestApplicationContext,
  input: BenchTableInput,
): Promise<BenchTableResult> {
  const db = app.get<Db>(DB);
  const schema = app.get(SchemaService);
  const records = app.get(RecordMutationService);
  const scope = orgScope(input.organizationId);
  const rows = input.rows ?? BENCH_ROWS;
  if (input.userIds.length === 0) throw new Error('at least one user is required');

  const tables = await new TablesRepository(db).listByBase(scope, input.baseId);
  const existing = tables.find((table) => table.name === BENCH_TABLE_NAME);
  if (existing !== undefined) {
    return {
      tableId: existing.id,
      created: false,
      rows: 0,
      fields: [],
      customers: null,
      computed: [],
      insertMs: 0,
      computedMs: 0,
      bigLinkCell: null,
    };
  }
  if (tables.some((table) => table.name === BENCH_CUSTOMERS_TABLE_NAME)) {
    throw new Error(
      `the bench base has "${BENCH_CUSTOMERS_TABLE_NAME}" without "${BENCH_TABLE_NAME}" (an interrupted run): reset the database`,
    );
  }

  const context = seedAuditContext(input.ownerId);
  const customerRows = Math.min(input.customerRows ?? BENCH_CUSTOMER_ROWS, rows);
  const customersTable = (
    await schema.createTable(
      scope,
      { baseId: input.baseId, name: BENCH_CUSTOMERS_TABLE_NAME, primaryFieldName: 'Tên' },
      context,
    )
  ).table;
  await schema.addField(
    scope,
    customersTable.id,
    { name: BENCH_CUSTOMER_CODE_NAME, type: 'text', options: {} },
    context,
  );
  const { table, primaryField } = await schema.createTable(
    scope,
    { baseId: input.baseId, name: BENCH_TABLE_NAME, primaryFieldName: 'Tên' },
    context,
  );
  const fields: FieldRow[] = [primaryField];
  for (const field of BENCH_FIELDS) {
    fields.push(
      await schema.addField(
        scope,
        table.id,
        { name: field.name, type: field.type, options: field.options ?? {} },
        context,
      ),
    );
  }
  // 2 self-link fields (S§21, BACKLOG T412): `Liên quan` carries the
  // 500-link cell (ADR-28's max), `Bản sao của` a "duplicate of" single
  // link, both one-way (a bidirectional self-link on 200 000 rows is not
  // needed for the bench and adds an extra reverse-side field to size).
  fields.push(
    await schema.addField(
      scope,
      table.id,
      { name: BENCH_LINK_FIELD_NAME, type: 'link', options: { link_table: table.id } },
      context,
    ),
  );
  fields.push(
    await schema.addField(
      scope,
      table.id,
      {
        name: 'Bản sao của',
        type: 'link',
        options: { link_table: table.id, allow_multiple: false },
      },
      context,
    ),
  );

  // BACKLOG T464: each row belongs to a customer — by link (lookup `sum`)
  // and by code (cross-table FILTER without link).
  fields.push(
    await schema.addField(
      scope,
      table.id,
      {
        name: BENCH_CUSTOMER_LINK_NAME,
        type: 'link',
        options: { link_table: customersTable.id, allow_multiple: false },
      },
      context,
    ),
  );
  fields.push(
    await schema.addField(
      scope,
      table.id,
      { name: BENCH_CUSTOMER_CODE_NAME, type: 'text', options: {} },
      context,
    ),
  );

  const access = await ownerAccessContext(db, scope, input.baseId, input.ownerId, input);
  const faker = seededFaker();
  const users = input.userIds;
  const started = Date.now();
  const customerCode = (index: number) => `KH${String(index + 1).padStart(6, '0')}`;
  // Own faker: the bench rows keep the values they had before T464.
  const customerFaker = seededFaker(SEED_FAKER_SEED + 1);
  const customerIds = await insertInBatches({
    records,
    scope,
    tableId: customersTable.id,
    access,
    actorId: input.ownerId,
    count: customerRows,
    row: (index) => ({
      Tên: customerFaker.company.name(),
      [BENCH_CUSTOMER_CODE_NAME]: customerCode(index),
    }),
  });
  const customerOf = (index: number) => index % customerRows;
  const ids = await insertInBatches({
    records,
    scope,
    tableId: table.id,
    access,
    actorId: input.ownerId,
    count: rows,
    onBatch: (done) => input.onProgress?.(done, rows),
    row: (index) => {
      const amount = faker.number.int({ min: 1, max: 2_000 }) * 10_000;
      return {
        Tên: faker.person.fullName(),
        Mã: `KH${String(index + 1).padStart(6, '0')}`,
        Email: `kh${String(index + 1)}@${faker.internet.domainName()}`,
        'Điện thoại': faker.phone.number(),
        'Địa chỉ': faker.location.streetAddress(),
        'Thành phố': faker.location.city(),
        'Công ty': faker.company.name(),
        'Số tiền': amount,
        'Chi phí': Math.round(amount * 0.6),
        'Số lượng': faker.number.int({ min: 1, max: 500 }),
        'Giảm giá': faker.number.int({ min: 0, max: 30 }) / 100,
        Điểm: faker.number.int({ min: 0, max: 1_000 }),
        'Tiến độ': faker.number.int({ min: 0, max: 100 }) / 100,
        'Cân nặng': faker.number.float({ min: 0.1, max: 50, fractionDigits: 1 }),
        'Xếp hạng': faker.number.int({ min: 1, max: 5 }),
        'Trạng thái': faker.helpers.arrayElement(STATUSES),
        'Khu vực': faker.helpers.arrayElement(REGIONS),
        Kênh: faker.helpers.arrayElement(CHANNELS),
        'Mức độ': faker.helpers.arrayElement(LEVELS),
        'Danh mục': faker.helpers.arrayElement(CATEGORIES),
        Hạn: faker.date
          .between({ from: '2025-01-01', to: '2027-12-31' })
          .toISOString()
          .slice(0, 10),
        'Ngày tạo đơn': faker.date
          .between({ from: '2023-01-01', to: '2026-09-01' })
          .toISOString()
          .slice(0, 10),
        'Hẹn gọi lại': faker.date.between({ from: '2026-01-01', to: '2027-01-01' }).toISOString(),
        'Đã thanh toán': faker.datatype.boolean(),
        'Ưu tiên': faker.datatype.boolean({ probability: 0.1 }),
        'Phụ trách': [{ id: users[index % users.length] }],
        'Theo dõi': faker.helpers
          .arrayElements(users, { min: 0, max: Math.min(3, users.length) })
          .map((id) => ({ id })),
        [BENCH_CUSTOMER_LINK_NAME]: [{ id: customerIds[customerOf(index)] }],
        [BENCH_CUSTOMER_CODE_NAME]: customerCode(customerOf(index)),
      };
    },
  });
  const insertMs = Date.now() - started;

  let bigLinkCell: BenchTableResult['bigLinkCell'] = null;
  const first = ids[0];
  if (first !== undefined && ids.length > BENCH_LINK_CELL_SIZE) {
    const related = ids.slice(1, BENCH_LINK_CELL_SIZE + 1);
    const duplicates = ids.slice(1, 6).map((id) => ({
      id,
      fields: { 'Bản sao của': [{ id: first }] },
    }));
    await records.update(
      scope,
      table.id,
      access,
      {
        records: [
          { id: first, fields: { [BENCH_LINK_FIELD_NAME]: related.map((id) => ({ id })) } },
          ...duplicates,
        ],
      },
      seedAuditContext(input.ownerId),
    );
    bigLinkCell = { recordId: first, fieldName: BENCH_LINK_FIELD_NAME };
  }

  const computedStarted = Date.now();
  const computed = await addBenchComputed(app, {
    scope,
    context,
    timeZone: input.timeZone,
    benchTableId: table.id,
    customersTableId: customersTable.id,
    fields,
  });
  const computedMs = Date.now() - computedStarted;

  return {
    tableId: table.id,
    created: true,
    rows,
    fields,
    customers: { tableId: customersTable.id, rows: customerRows },
    computed,
    insertMs,
    computedMs,
    bigLinkCell,
  };
}

/**
 * The computed fields of `seed:bench` (BACKLOG T464, for the T455/T457/T458
 * benches), added after the records and backfilled at once
 * (`SeedComputedFields`): a stored same-row formula and a virtual
 * `TODAY()` formula on the bench table; on `Bench Customers` a stored
 * lookup `sum` through the link and a virtual cross-table FILTER by code
 * without link (virtual because of `TODAY()`: a stored one would scan the
 * 200 000 rows for each of the 20 000 customers in the backfill — BACKLOG
 * S4b open question #11).
 */
async function addBenchComputed(
  app: INestApplicationContext,
  input: {
    readonly scope: ReturnType<typeof orgScope>;
    readonly context: ReturnType<typeof seedAuditContext>;
    readonly timeZone: string;
    readonly benchTableId: Id<'tbl'>;
    readonly customersTableId: Id<'tbl'>;
    readonly fields: readonly FieldRow[];
  },
): Promise<FieldRow[]> {
  const computed = new SeedComputedFields(app, input);
  const fieldId = (name: string) => {
    const field = input.fields.find((item) => item.name === name);
    if (field === undefined) throw new Error(`bench field ${name} is missing`);
    return field.id;
  };
  return [
    await computed.add(input.benchTableId, {
      name: BENCH_COMPUTED.margin,
      type: 'formula',
      options: { expression: '[Số tiền] - [Chi phí]' },
    }),
    await computed.add(input.benchTableId, {
      name: BENCH_COMPUTED.open,
      type: 'formula',
      options: { expression: '[Hạn] >= TODAY()' },
    }),
    await computed.add(input.customersTableId, {
      name: BENCH_COMPUTED.total,
      type: 'lookup',
      options: {
        from: input.benchTableId,
        select: fieldId('Số tiền'),
        where: {
          field: fieldId(BENCH_CUSTOMER_LINK_NAME),
          operator: 'intersects',
          value: { field_ref: '__id' },
        },
        aggregate: 'sum',
        style: { type: 'currency', currency_code: 'VND' },
      },
    }),
    await computed.add(input.customersTableId, {
      name: BENCH_COMPUTED.openTotal,
      type: 'formula',
      options: {
        expression:
          `[${BENCH_TABLE_NAME}].FILTER(CurrentValue.[${BENCH_CUSTOMER_CODE_NAME}] = ` +
          `[${BENCH_CUSTOMER_CODE_NAME}] && CurrentValue.[Hạn] >= TODAY()).[Số tiền].SUM()`,
        style: { type: 'currency', currency_code: 'VND' },
      },
    }),
  ];
}
