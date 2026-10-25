/**
 * Dashboard widget queries (BACKLOG T806, CONTRACTS §28.3, P21) on
 * PostgreSQL 18: `RecordQueryService.widgetData` against a TypeScript
 * evaluator over the same records — every dimension kind × bucket × metric,
 * multi-select / multi-user / link groups, the empty group, date buckets in
 * `Asia/Ho_Chi_Minh` and UTC around midnight, ISO weeks, a leap day, top N
 * with "Other", sort by option order — plus KPI comparisons with a pinned
 * clock, the viewer's permissions (read rule, field rules, link rule, linked
 * table), `broken`, `WIDGET_TOO_LARGE` and tenant isolation.
 */
import {
  MAX_WIDGET_GROUPS,
  newId,
  type DateBucket,
  type Id,
  type MetricAggregation,
  type WidgetSort,
} from '@cellhive/contracts';
import { roleConfigSchema, type RoleConfigInput } from '@cellhive/permissions';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type GroupedWidgetQuery,
  type KpiWidgetQuery,
  type RecordAccessContext,
  type WidgetAggregateResult,
  type WidgetQuery,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import {
  accessOf,
  buildOrdersFixture,
  insertBulk,
  NOW,
  TIME_ZONE,
  type OrdersFixture,
  type UserKey,
} from './fixtures.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T806WidgetOrgAAA';
const ORG_B: Id<'org'> = 'org_T806WidgetOrgBBB';
const UTC = 'UTC';

// ---------------------------------------------------------------------------
// The records (also the input of the evaluator)

type Tag = 'X' | 'Y' | 'Z';
type Customer = 0 | 1 | 2;

interface ItemInput {
  readonly title: string;
  readonly region: string | null;
  readonly amount: number | null;
  readonly qty: number | null;
  readonly due: string | null;
  readonly at: string | null;
  readonly done: boolean;
  readonly status: 'A' | 'B' | null;
  readonly tags: readonly Tag[];
  readonly people: readonly UserKey[];
  readonly customer: readonly Customer[];
}

const ITEMS: readonly ItemInput[] = [
  // Leap day; two tags, two people.
  {
    title: 'a',
    region: 'north',
    amount: 100,
    qty: 1,
    due: '2024-02-29',
    at: '2024-02-29T10:00:00.000Z',
    done: true,
    status: 'A',
    tags: ['X', 'Y'],
    people: ['u_admin', 'u_editor'],
    customer: [0],
  },
  // 2026-01-01 01:00 in Ho Chi Minh City, still 2025 in UTC.
  {
    title: 'b',
    region: 'south',
    amount: 250.5,
    qty: 2,
    due: '2024-03-01',
    at: '2025-12-31T18:00:00.000Z',
    done: false,
    status: 'B',
    tags: ['Y'],
    people: ['u_admin'],
    customer: [0, 1],
  },
  // Sunday 2021-01-03 is in the ISO week of Monday 2020-12-28; Sunday 18:00 UTC is Monday in HCM.
  {
    title: 'c',
    region: 'north',
    amount: -50,
    qty: 3,
    due: '2021-01-03',
    at: '2026-01-04T18:00:00.000Z',
    done: true,
    status: 'A',
    tags: ['Z'],
    people: ['u_reader'],
    customer: [1],
  },
  // Empty everywhere.
  {
    title: 'd',
    region: null,
    amount: null,
    qty: null,
    due: null,
    at: null,
    done: false,
    status: null,
    tags: [],
    people: [],
    customer: [],
  },
  // February in HCM, January in UTC.
  {
    title: 'e',
    region: 'east',
    amount: 0,
    qty: 1,
    due: '2026-01-01',
    at: '2026-01-31T17:30:00.000Z',
    done: false,
    status: 'B',
    tags: ['X'],
    people: ['u_sales1'],
    customer: [2],
  },
  // 23:59 in HCM on the last day of Q1.
  {
    title: 'f',
    region: 'south',
    amount: 999,
    qty: 5,
    due: '2025-12-29',
    at: '2026-03-31T16:59:00.000Z',
    done: true,
    status: 'A',
    tags: ['X', 'Z'],
    people: ['u_editor', 'u_sales1'],
    customer: [0],
  },
  // 00:00 in HCM on the first day of Q2.
  {
    title: 'g',
    region: 'east',
    amount: 120,
    qty: 2,
    due: '2026-03-31',
    at: '2026-03-31T17:00:00.000Z',
    done: false,
    status: null,
    tags: ['Y', 'Z'],
    people: [],
    customer: [2],
  },
  // September in HCM (the current month of the pinned clock), August in UTC.
  {
    title: 'h',
    region: 'north',
    amount: 75.25,
    qty: 4,
    due: '2026-09-01',
    at: '2026-08-31T17:30:00.000Z',
    done: true,
    status: 'B',
    tags: [],
    people: ['u_admin'],
    customer: [],
  },
  // August 31 23:30 in HCM.
  {
    title: 'i',
    region: 'west',
    amount: 10,
    qty: 1,
    due: '2026-08-31',
    at: '2026-08-31T16:30:00.000Z',
    done: false,
    status: 'A',
    tags: ['X'],
    people: ['u_reader'],
    customer: [1],
  },
  {
    title: 'j',
    region: 'west',
    amount: 300,
    qty: 2,
    due: '2026-09-23',
    at: '2026-09-22T17:00:00.000Z',
    done: true,
    status: 'B',
    tags: ['Y'],
    people: ['u_editor'],
    customer: [0],
  },
  {
    title: 'k',
    region: 'south',
    amount: 45,
    qty: 3,
    due: '2026-08-15',
    at: '2026-08-15T05:00:00.000Z',
    done: false,
    status: 'A',
    tags: ['Z'],
    people: ['u_sales2'],
    customer: [1],
  },
  // 23:59 in HCM on the last day of September.
  {
    title: 'l',
    region: 'north',
    amount: 500,
    qty: 1,
    due: '2026-09-30',
    at: '2026-09-30T16:59:00.000Z',
    done: true,
    status: 'A',
    tags: ['X', 'Y', 'Z'],
    people: ['u_admin', 'u_reader'],
    customer: [0, 2],
  },
];

const CUSTOMER_NAMES = ['Alpha', 'Beta', 'Gamma'] as const;

// ---------------------------------------------------------------------------
// TypeScript evaluator

type Key = string | number | boolean | null;

/** A record as the evaluator sees it (ids resolved). */
interface EvalRow {
  readonly region: string | null;
  readonly amount: number | null;
  readonly qty: number | null;
  readonly double: number | null;
  readonly due: string | null;
  readonly at: string | null;
  readonly done: boolean;
  readonly status: string | null;
  readonly tags: readonly string[];
  readonly people: readonly string[];
  readonly customer: readonly string[];
}

type FieldName = keyof EvalRow;

interface Lookup {
  /** Option ids in option order (natural order of select). */
  readonly statusIds: readonly string[];
  readonly tagIds: readonly string[];
  readonly optionNames: ReadonlyMap<string, string>;
  readonly userNames: ReadonlyMap<string, string>;
  /** Customer ids in creation order. */
  readonly customerIds: readonly string[];
  readonly customerNames: ReadonlyMap<string, string>;
}

function localDate(iso: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function truncate(date: string, bucket: DateBucket): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (bucket) {
    case 'day':
      return date;
    case 'week': {
      const time = Date.parse(`${date}T00:00:00Z`);
      const weekday = (new Date(time).getUTCDay() + 6) % 7; // Monday = 0
      return new Date(time - weekday * 86_400_000).toISOString().slice(0, 10);
    }
    case 'month':
      return `${String(y)}-${pad(m)}-01`;
    case 'quarter':
      return `${String(y)}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
    case 'year':
      return `${String(y)}-01-01`;
  }
}

interface EvalDimension {
  readonly field: FieldName;
  readonly bucket?: DateBucket;
  readonly width?: number;
}

const LIST_FIELDS: ReadonlySet<FieldName> = new Set(['tags', 'people', 'customer']);
const NUMBER_FIELDS: ReadonlySet<FieldName> = new Set(['amount', 'qty', 'double']);

function keysOf(row: EvalRow, dim: EvalDimension, zone: string): Key[] {
  const value = row[dim.field];
  if (LIST_FIELDS.has(dim.field)) {
    const list = value as readonly string[];
    return list.length === 0 ? [null] : [...list];
  }
  if (value === null) return [null];
  if (NUMBER_FIELDS.has(dim.field)) {
    const number = value as number;
    return [dim.width === undefined ? number : Math.floor(number / dim.width) * dim.width];
  }
  if (dim.field === 'due') return [truncate(value as string, dim.bucket ?? 'day')];
  if (dim.field === 'at') return [truncate(localDate(value as string, zone), dim.bucket ?? 'day')];
  if (dim.field === 'region') return [value === '' ? null : (value as string)];
  return [value as Key];
}

interface EvalMetric {
  readonly aggregation: MetricAggregation;
  readonly field?: FieldName;
}

function aggregate(rows: readonly EvalRow[], metric: EvalMetric): number | null {
  if (metric.aggregation === 'count') return rows.length;
  const field = metric.field as FieldName;
  if (metric.aggregation === 'count_distinct') {
    const seen = new Set<string>();
    for (const row of rows) {
      const value = row[field];
      const items: readonly (string | number | boolean | null)[] = Array.isArray(value)
        ? (value as readonly string[])
        : [value as string | number | boolean | null];
      for (const item of items) {
        if (item === null || item === '') continue;
        seen.add(String(item));
      }
    }
    return seen.size;
  }
  const numbers = rows.map((row) => row[field] as number | null).filter((n) => n !== null);
  if (numbers.length === 0) return null;
  switch (metric.aggregation) {
    case 'sum':
      return numbers.reduce((sum, n) => sum + n, 0);
    case 'avg':
      return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
  }
}

/** Natural order key of a group value (as `naturalOrder` in SQL). */
function natural(dim: EvalDimension, key: Key, lookup: Lookup): Key {
  if (key === null) return null;
  switch (dim.field) {
    case 'status':
      return lookup.statusIds.indexOf(key as string) + 1;
    case 'tags':
      return lookup.tagIds.indexOf(key as string) + 1;
    case 'people':
      return lookup.userNames.get(key as string) ?? null;
    case 'customer':
      return lookup.customerIds.indexOf(key as string) + 1;
    default:
      return key;
  }
}

/** Ascending, `NULL` last (`ASC NULLS LAST`). */
function compareKeys(a: Key, b: Key): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a ? 1 : -1;
  return String(a) < String(b) ? -1 : 1;
}

function labelOf(dim: EvalDimension, key: Key, lookup: Lookup): string | null {
  if (typeof key !== 'string') return null;
  switch (dim.field) {
    case 'status':
    case 'tags':
      return lookup.optionNames.get(key) ?? null;
    case 'people':
      return lookup.userNames.get(key) ?? null;
    case 'customer':
      return lookup.customerNames.get(key) ?? null;
    default:
      return null;
  }
}

interface EvalCase {
  readonly name: string;
  readonly dimension: EvalDimension;
  readonly series?: EvalDimension;
  readonly metrics: readonly EvalMetric[];
  readonly sort?: WidgetSort;
  readonly limit?: number;
  readonly others?: boolean;
  readonly zone?: string;
}

interface Expected {
  readonly rows: unknown[][];
  readonly other?: { groups: number; rows: unknown[][] };
  readonly total: (number | null)[];
}

function evaluate(rows: readonly EvalRow[], test: EvalCase, lookup: Lookup): Expected {
  const zone = test.zone ?? TIME_ZONE;
  const limit = test.limit ?? 20;
  const sort = test.sort ?? 'metric_desc';
  const elements = rows.flatMap((row) =>
    keysOf(row, test.dimension, zone).flatMap((d) =>
      (test.series === undefined ? [null] : keysOf(row, test.series, zone)).map((s) => ({
        d,
        s,
        row,
      })),
    ),
  );
  const dims = [...new Set(elements.map((item) => item.d))];
  const first = test.metrics[0] as EvalMetric;
  const keyOfDim = new Map(
    dims.map((d) => [
      d,
      aggregate(
        elements.filter((item) => item.d === d).map((item) => item.row),
        first,
      ),
    ]),
  );
  const byDimension = (a: Key, b: Key, direction: 1 | -1) => {
    if ((a === null) !== (b === null)) return a === null ? 1 : -1;
    const na = natural(test.dimension, a, lookup);
    const nb = natural(test.dimension, b, lookup);
    if ((na === null) !== (nb === null)) return na === null ? 1 : -1;
    const order = compareKeys(na, nb) * direction;
    return order !== 0 ? order : compareKeys(a, b) * direction;
  };
  const ranked = [...dims].sort((a, b) => {
    if (sort === 'dimension_asc') return byDimension(a, b, 1);
    if (sort === 'dimension_desc') return byDimension(a, b, -1);
    const ka = keyOfDim.get(a) ?? null;
    const kb = keyOfDim.get(b) ?? null;
    if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1;
    const order =
      ka === kb ? 0 : ((ka as number) - (kb as number)) * (sort === 'metric_desc' ? -1 : 1);
    return order !== 0 ? order : byDimension(a, b, 1);
  });
  const top = ranked.slice(0, limit);
  const seriesOrder = (a: Key, b: Key) => {
    if ((a === null) !== (b === null)) return a === null ? 1 : -1;
    if (test.series === undefined) return 0;
    const order = compareKeys(natural(test.series, a, lookup), natural(test.series, b, lookup));
    return order !== 0 ? order : compareKeys(a, b);
  };
  const cell = (dim: EvalDimension, key: Key) => ({ value: key, label: labelOf(dim, key, lookup) });
  const rowsOf = (items: typeof elements, dimensionCell: (d: Key) => unknown) => {
    const series = [...new Set(items.map((item) => item.s))].sort(seriesOrder);
    return series.map((s) => {
      const group = items.filter((item) => item.s === s);
      return [
        dimensionCell(group[0]?.d ?? null),
        ...(test.series === undefined ? [] : [cell(test.series, s)]),
        ...test.metrics.map((metric) =>
          aggregate(
            group.map((item) => item.row),
            metric,
          ),
        ),
      ];
    });
  };
  const out: unknown[][] = top.flatMap((d) =>
    rowsOf(
      elements.filter((item) => item.d === d),
      (key) => cell(test.dimension, key),
    ),
  );
  const rest = elements.filter((item) => !top.includes(item.d));
  return {
    rows: out,
    ...(test.others === true && dims.length > limit
      ? { other: { groups: dims.length - limit, rows: rowsOf(rest, () => null) } }
      : {}),
    total: test.metrics.map((metric) => aggregate(rows, metric)),
  };
}

/** Numbers rounded (averages) so SQL `numeric` and JS floats compare. */
function rounded(value: unknown): unknown {
  if (typeof value === 'number') return Math.round(value * 1e9) / 1e9;
  if (Array.isArray(value)) return value.map(rounded);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item)]));
  }
  return value;
}

// ---------------------------------------------------------------------------

describe('dashboard widget queries (T806, P21)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let schema: SchemaService;
  let query: RecordQueryService;
  let mutation: RecordMutationService;
  let fx: OrdersFixture;
  let fxB: OrdersFixture;
  let items: TableRow;
  let many: TableRow;
  const fld: Record<string, FieldRow> = {};
  const opt = {
    A: newId('opt'),
    B: newId('opt'),
    X: newId('opt'),
    Y: newId('opt'),
    Z: newId('opt'),
  };
  let customers: Id<'rec'>[] = [];
  let evalRows: EvalRow[] = [];
  let lookup: Lookup;
  let orderCustomer: FieldRow;
  let r1: Id<'rec'>;
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();

  const admin = (): RecordAccessContext => accessOf(fx, 'u_admin');
  const audit = (): AuditContext => {
    const requestId = newId('req');
    return {
      actor: { type: 'user', id: fx.users.u_admin.id },
      via: null,
      batch_id: requestId,
      request_id: requestId,
      ip: null,
      user_agent: 'vitest',
    };
  };
  const F = (name: string) => (fld[name] as FieldRow).id;
  const dimensionOf = (dim: EvalDimension) => ({
    field: F(dim.field),
    dateBucket: dim.bucket ?? null,
    bucketWidth: dim.width ?? null,
  });
  const groupedQuery = (test: EvalCase): GroupedWidgetQuery => ({
    kind: 'grouped',
    tableId: items.id,
    filter: null,
    dimension: dimensionOf(test.dimension),
    series: test.series === undefined ? null : dimensionOf(test.series),
    metrics: test.metrics.map((metric, index) => ({
      id: `m${String(index + 1)}`,
      aggregation: metric.aggregation,
      field: metric.field === undefined ? null : F(metric.field),
    })),
    sort: test.sort ?? 'metric_desc',
    limit: test.limit ?? 20,
    groupOthers: test.others ?? false,
  });
  const run = (widget: WidgetQuery, access = admin(), zone = TIME_ZONE) =>
    query.widgetData(scope, access, widget, { timeZone: zone });

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW, defaultTimeZone: TIME_ZONE });
    mutation = new RecordMutationService(db, {
      schema,
      query,
      now: () => NOW,
      defaultTimeZone: TIME_ZONE,
    });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    fxB = await buildOrdersFixture(db, schema, ORG_B);

    const created = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Items', primaryFieldName: 'title' },
      context,
    );
    items = created.table;
    fld['title'] = created.primaryField;
    const add = async (name: string, type: string, options: unknown = {}) => {
      fld[name] = await schema.addField(scope, items.id, { name, type, options }, context);
    };
    await add('region', 'text');
    await add('amount', 'number', { style: { type: 'currency', currency_code: 'VND' } });
    await add('qty', 'number');
    await add('due', 'datetime', { style: { format: 'dd/MM/yyyy' } });
    await add('at', 'datetime', { style: { format: 'yyyy-MM-dd HH:mm' } });
    await add('done', 'checkbox');
    await add('status', 'select', {
      options: [
        { id: opt.A, name: 'A' },
        { id: opt.B, name: 'B' },
      ],
    });
    await add('tags', 'select', {
      multiple: true,
      options: [
        { id: opt.X, name: 'X' },
        { id: opt.Y, name: 'Y' },
        { id: opt.Z, name: 'Z' },
      ],
    });
    await add('people', 'user');
    await add('customer', 'link', { link_table: fx.customers.id });
    fld['double'] = await schema.addField(
      scope,
      items.id,
      {
        name: 'double',
        type: 'formula',
        options: { expression: '[amount] * 2' },
        computed: { timeZone: TIME_ZONE },
      },
      context,
    );
    fx.schema.tables.push({
      id: items.id,
      fields: Object.values(fld).map((field) => ({ id: field.id, type: field.type })),
    });

    customers = (
      await mutation.create(
        scope,
        fx.customers.id,
        admin(),
        { records: CUSTOMER_NAMES.map((name) => ({ fields: { name } })) },
        audit(),
      )
    ).records.map((record) => record.id);
    await mutation.create(
      scope,
      items.id,
      admin(),
      {
        typecast: true,
        records: ITEMS.map((item) => ({
          fields: {
            title: item.title,
            region: item.region,
            amount: item.amount,
            qty: item.qty,
            due: item.due,
            at: item.at,
            done: item.done,
            status: item.status,
            tags: [...item.tags],
            people: item.people.map((key) => ({ id: fx.users[key].id })),
            customer: item.customer.map((index) => customers[index]),
          },
        })),
      },
      audit(),
    );
    if (fld['double'].compute_mode === 'stored') {
      let cursor = 0n;
      for (;;) {
        const result = await mutation.backfillComputedBatch(scope, {
          fieldId: F('double'),
          afterAuto: cursor,
          limit: 1000,
          statementTimeoutMs: 30_000,
          timeZone: TIME_ZONE,
        });
        if (result.status !== 'more') break;
        cursor = result.cursor;
      }
      await schema.finishComputedBackfill(scope, F('double'), { status: 'ready' });
    }

    // The formula values as `records/query` reads them (the evaluator's input).
    const read = await query.query(scope, items.id, admin(), {
      field_key_type: 'name',
      fields: ['title', 'double'],
      limit: 100,
      include_total: false,
    });
    const doubles = new Map(
      read.records.map((record) => [record.fields['title'], record.fields['double']]),
    );
    evalRows = ITEMS.map((item) => ({
      region: item.region,
      amount: item.amount,
      qty: item.qty,
      double: (doubles.get(item.title) as number | null | undefined) ?? null,
      due: item.due,
      at: item.at,
      done: item.done,
      status: item.status === null ? null : opt[item.status],
      tags: item.tags.map((tag) => opt[tag]),
      people: item.people.map((key) => fx.users[key].id),
      customer: item.customer.map((index) => customers[index] as string),
    }));
    lookup = {
      statusIds: [opt.A, opt.B],
      tagIds: [opt.X, opt.Y, opt.Z],
      optionNames: new Map(
        (['A', 'B', 'X', 'Y', 'Z'] as const).map((name) => [opt[name] as string, name]),
      ),
      userNames: new Map(Object.values(fx.users).map((user) => [user.id as string, user.name])),
      customerIds: customers,
      customerNames: new Map(
        customers.map((id, index) => [id as string, CUSTOMER_NAMES[index] as string]),
      ),
    };

    // Orders of CONTRACTS §5 (P21): r1 of u_sales1, r2 of u_sales2, r3 of u_editor.
    orderCustomer = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'customer', type: 'link', options: { link_table: fx.customers.id } },
      context,
    );
    const orders = fx.schema.tables.find((table) => table.id === fx.orders.id);
    if (orders === undefined) throw new Error('no Orders in the fixture schema');
    orders.fields = [...orders.fields, { id: orderCustomer.id, type: orderCustomer.type }];
    [r1] = (
      await mutation.create(
        scope,
        fx.orders.id,
        admin(),
        {
          typecast: true,
          records: [
            {
              fields: {
                title: 'r1',
                amount: 100,
                cost: 10,
                status: 'Mới',
                owner: [{ id: fx.users.u_sales1.id }],
                customer: [customers[0]],
              },
            },
            {
              fields: {
                title: 'r2',
                amount: 200,
                cost: 20,
                status: 'Xong',
                owner: [{ id: fx.users.u_sales2.id }],
                customer: [customers[1]],
              },
            },
            {
              fields: {
                title: 'r3',
                amount: 300,
                cost: 30,
                status: 'Mới',
                owner: [{ id: fx.users.u_editor.id }],
              },
            },
          ],
        },
        audit(),
      )
    ).records.map((record) => record.id) as [Id<'rec'>];

    // 1 001 distinct values (WIDGET_TOO_LARGE). TEST FIXTURE: written directly.
    const manyTable = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Many', primaryFieldName: 'name' },
      context,
    );
    many = manyTable.table;
    fld['many.name'] = manyTable.primaryField;
    fx.schema.tables.push({
      id: many.id,
      fields: [{ id: manyTable.primaryField.id, type: manyTable.primaryField.type }],
    });
    await insertBulk(pool, many, [
      {
        name: manyTable.primaryField.db_column_name as string,
        pgType: 'text',
        values: Array.from({ length: MAX_WIDGET_GROUPS + 1 }, (_, index) => `v${String(index)}`),
      },
    ]);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  // ≥ 40 table-driven cases against the evaluator.
  const CASES: readonly EvalCase[] = [
    { name: 'select × count', dimension: { field: 'status' }, metrics: [{ aggregation: 'count' }] },
    {
      name: 'select × sum',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
    },
    {
      name: 'select × avg',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'avg', field: 'amount' }],
    },
    {
      name: 'select × min',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'min', field: 'amount' }],
    },
    {
      name: 'select × max',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'max', field: 'amount' }],
    },
    {
      name: 'select × count_distinct text',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'count_distinct', field: 'region' }],
    },
    {
      name: 'select × five metrics',
      dimension: { field: 'status' },
      metrics: [
        { aggregation: 'count' },
        { aggregation: 'sum', field: 'amount' },
        { aggregation: 'avg', field: 'qty' },
        { aggregation: 'min', field: 'qty' },
        { aggregation: 'max', field: 'amount' },
      ],
    },
    {
      name: 'select by option order',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'select by option order, desc',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_desc',
    },
    {
      name: 'multi-select × count',
      dimension: { field: 'tags' },
      metrics: [{ aggregation: 'count' }],
    },
    {
      name: 'multi-select × sum',
      dimension: { field: 'tags' },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
    },
    {
      name: 'multi-select × count_distinct users',
      dimension: { field: 'tags' },
      metrics: [{ aggregation: 'count_distinct', field: 'people' }],
    },
    {
      name: 'multi-select by option order',
      dimension: { field: 'tags' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'multi-user × count',
      dimension: { field: 'people' },
      metrics: [{ aggregation: 'count' }],
    },
    {
      name: 'multi-user × sum',
      dimension: { field: 'people' },
      metrics: [{ aggregation: 'sum', field: 'qty' }],
    },
    {
      name: 'multi-user by name',
      dimension: { field: 'people' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    { name: 'checkbox × count', dimension: { field: 'done' }, metrics: [{ aggregation: 'count' }] },
    {
      name: 'checkbox × avg',
      dimension: { field: 'done' },
      metrics: [{ aggregation: 'avg', field: 'qty' }],
      sort: 'dimension_asc',
    },
    {
      name: 'text × count, metric_asc',
      dimension: { field: 'region' },
      metrics: [{ aggregation: 'count' }],
      sort: 'metric_asc',
    },
    {
      name: 'text by value',
      dimension: { field: 'region' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'text by value, desc',
      dimension: { field: 'region' },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
      sort: 'dimension_desc',
    },
    {
      name: 'number ranges of 100',
      dimension: { field: 'amount', width: 100 },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'number ranges of 2.5',
      dimension: { field: 'qty', width: 2.5 },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
      sort: 'dimension_asc',
    },
    { name: 'number values', dimension: { field: 'qty' }, metrics: [{ aggregation: 'count' }] },
    {
      name: 'date day (leap day)',
      dimension: { field: 'due', bucket: 'day' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'date ISO week',
      dimension: { field: 'due', bucket: 'week' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'date month',
      dimension: { field: 'due', bucket: 'month' },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
      sort: 'dimension_asc',
    },
    {
      name: 'date quarter',
      dimension: { field: 'due', bucket: 'quarter' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_desc',
    },
    {
      name: 'date year',
      dimension: { field: 'due', bucket: 'year' },
      metrics: [{ aggregation: 'count' }],
    },
    {
      name: 'datetime day, HCM',
      dimension: { field: 'at', bucket: 'day' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'datetime day, UTC',
      dimension: { field: 'at', bucket: 'day' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
      zone: UTC,
    },
    {
      name: 'datetime ISO week, HCM',
      dimension: { field: 'at', bucket: 'week' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'datetime ISO week, UTC',
      dimension: { field: 'at', bucket: 'week' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
      zone: UTC,
    },
    {
      name: 'datetime month, HCM',
      dimension: { field: 'at', bucket: 'month' },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
      sort: 'dimension_asc',
    },
    {
      name: 'datetime month, UTC',
      dimension: { field: 'at', bucket: 'month' },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
      sort: 'dimension_asc',
      zone: UTC,
    },
    {
      name: 'datetime quarter, HCM',
      dimension: { field: 'at', bucket: 'quarter' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'datetime quarter, UTC',
      dimension: { field: 'at', bucket: 'quarter' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
      zone: UTC,
    },
    {
      name: 'datetime year, HCM',
      dimension: { field: 'at', bucket: 'year' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'datetime year, UTC',
      dimension: { field: 'at', bucket: 'year' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
      zone: UTC,
    },
    { name: 'link × count', dimension: { field: 'customer' }, metrics: [{ aggregation: 'count' }] },
    {
      name: 'link × sum, by creation',
      dimension: { field: 'customer' },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
      sort: 'dimension_asc',
    },
    {
      name: 'count_distinct of a link',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'count_distinct', field: 'customer' }],
    },
    {
      name: 'count_distinct of a multi-select',
      dimension: { field: 'done' },
      metrics: [{ aggregation: 'count_distinct', field: 'tags' }],
    },
    {
      name: 'formula metric',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'sum', field: 'double' }],
    },
    {
      name: 'formula dimension (ranges)',
      dimension: { field: 'double', width: 500 },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'top 1 + Other',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'count' }],
      limit: 1,
      others: true,
    },
    {
      name: 'top 2 of a multi-select + Other',
      dimension: { field: 'tags' },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
      limit: 2,
      others: true,
    },
    {
      name: '"Other" recomputes distinct counts',
      dimension: { field: 'region' },
      metrics: [
        { aggregation: 'count_distinct', field: 'tags' },
        { aggregation: 'avg', field: 'amount' },
      ],
      limit: 2,
      others: true,
    },
    {
      name: 'top 3 without Other',
      dimension: { field: 'region' },
      metrics: [{ aggregation: 'count' }],
      limit: 3,
    },
    {
      name: 'series: select × multi-select',
      dimension: { field: 'status' },
      series: { field: 'tags' },
      metrics: [{ aggregation: 'count' }],
    },
    {
      name: 'series: checkbox × select',
      dimension: { field: 'done' },
      series: { field: 'status' },
      metrics: [{ aggregation: 'sum', field: 'amount' }],
      sort: 'dimension_asc',
    },
    {
      name: 'series: month × select (line)',
      dimension: { field: 'at', bucket: 'month' },
      series: { field: 'status' },
      metrics: [{ aggregation: 'count' }],
      sort: 'dimension_asc',
    },
    {
      name: 'series: users × link + Other',
      dimension: { field: 'people' },
      series: { field: 'customer' },
      metrics: [{ aggregation: 'count' }],
      limit: 2,
      others: true,
    },
  ];

  it.each(CASES)('$name', async (test) => {
    const result = await run(groupedQuery(test), admin(), test.zone ?? TIME_ZONE);
    const expected = evaluate(evalRows, test, lookup);
    expect(result.status).toBe('ok');
    expect(rounded(result.rows)).toEqual(rounded(expected.rows));
    expect(rounded(result.other)).toEqual(rounded(expected.other));
    expect(rounded(result.total)).toEqual(rounded(expected.total));
  });

  it('has at least 40 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it('describes its columns', async () => {
    const result = await run(
      groupedQuery({
        name: '',
        dimension: { field: 'at', bucket: 'week' },
        series: { field: 'status' },
        metrics: [{ aggregation: 'sum', field: 'amount' }],
      }),
    );
    expect(result.columns).toEqual([
      {
        key: 'dimension',
        role: 'dimension',
        field_id: F('at'),
        field_type: 'datetime',
        aggregation: null,
        date_bucket: 'week',
        bucket_width: null,
      },
      {
        key: 'series',
        role: 'series',
        field_id: F('status'),
        field_type: 'select',
        aggregation: null,
        date_bucket: null,
        bucket_width: null,
      },
      {
        key: 'm1',
        role: 'metric',
        field_id: F('amount'),
        field_type: null,
        aggregation: 'sum',
        date_bucket: null,
        bucket_width: null,
      },
    ]);
  });

  it('applies the saved filter; nothing left is `empty`', async () => {
    const base = groupedQuery({
      name: '',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'count' }],
    });
    const filtered = await run({
      ...base,
      filter: { op: 'and', items: [{ field: F('region'), operator: 'eq', value: 'north' }] },
    });
    expect(filtered.total).toEqual([4]);
    const none = await run({
      ...base,
      filter: { op: 'and', items: [{ field: F('amount'), operator: 'gt', value: 1_000_000 }] },
    });
    expect(none).toMatchObject({ status: 'empty', rows: [] });
    expect(none.columns).toHaveLength(2);
  });

  describe('KPI', () => {
    const kpi = (
      aggregation: MetricAggregation,
      field: string | null,
      compare: KpiWidgetQuery['compare'] = null,
    ): KpiWidgetQuery => ({
      kind: 'kpi',
      tableId: items.id,
      filter: null,
      metric: { id: 'm1', aggregation, field: field === null ? null : F(field) },
      compare,
    });

    it('one metric over every record', async () => {
      expect((await run(kpi('count', null))).rows).toEqual([[12]]);
      const sum = await run(kpi('sum', 'amount'));
      expect(rounded(sum.rows)).toEqual([
        [evalRows.reduce((total, row) => total + (row.amount ?? 0), 0)],
      ]);
      expect((await run(kpi('count_distinct', 'tags'))).rows).toEqual([[3]]);
    });

    it('compares this month with the previous one at the pinned clock (HCM vs UTC)', async () => {
      const at = { dateField: F('at'), period: 'month' as const };
      // 2026-09-23 10:00 in HCM: September = h, j, l; August = i, k.
      const hcm = await run(kpi('sum', 'amount', at));
      expect(rounded(hcm.rows)).toEqual([[875.25]]);
      expect(rounded(hcm.compare)).toEqual(
        rounded({
          previous: 55,
          change: (875.25 - 55) / 55,
          current_period: { from: '2026-08-31T17:00:00.000Z', to: '2026-09-30T17:00:00.000Z' },
          previous_period: { from: '2026-07-31T17:00:00.000Z', to: '2026-08-31T17:00:00.000Z' },
        }),
      );
      // In UTC h moves to August: September = j, l; August = h, i, k.
      const utc = await run(kpi('count', null, at), admin(), UTC);
      expect(utc.rows).toEqual([[2]]);
      expect(utc.compare).toMatchObject({
        previous: 3,
        current_period: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      });
    });

    it('compares date-only fields by ISO week and year; no previous value → no change', async () => {
      const week = await run(kpi('count', null, { dateField: F('due'), period: 'week' }));
      expect(week.rows).toEqual([[1]]);
      expect(week.compare).toEqual({
        previous: 0,
        change: null,
        current_period: { from: '2026-09-21', to: '2026-09-28' },
        previous_period: { from: '2026-09-14', to: '2026-09-21' },
      });
      const year = await run(kpi('count', null, { dateField: F('due'), period: 'year' }));
      expect(year.rows).toEqual([[7]]);
      expect(year.compare).toMatchObject({ previous: 1, change: 6 });
      const quarter = await run(kpi('max', 'amount', { dateField: F('due'), period: 'quarter' }));
      // Q3 2026: h, i, j, k, l → 500; Q2: none.
      expect(quarter.rows).toEqual([[500]]);
      expect(quarter.compare).toMatchObject({ previous: null, change: null });
      const day = await run(kpi('count', null, { dateField: F('at'), period: 'day' }));
      // 2026-09-23 in HCM: j (00:00).
      expect(day.rows).toEqual([[1]]);
    });

    it('is `empty` when no record falls in either period', async () => {
      const result = await run({
        ...kpi('count', null, { dateField: F('due'), period: 'day' }),
        filter: { op: 'and', items: [{ field: F('region'), operator: 'eq', value: 'nowhere' }] },
      });
      expect(result).toMatchObject({ status: 'empty', rows: [] });
    });
  });

  describe("the viewer's permissions (P21)", () => {
    const ordersQuery = (patch: Partial<GroupedWidgetQuery> = {}): GroupedWidgetQuery => ({
      kind: 'grouped',
      tableId: fx.orders.id,
      filter: null,
      dimension: { field: fx.fld.status.id, dateBucket: null, bucketWidth: null },
      series: null,
      metrics: [{ id: 'm1', aggregation: 'count', field: null }],
      sort: 'metric_desc',
      limit: 20,
      groupOthers: false,
      ...patch,
    });
    const count: KpiWidgetQuery = {
      kind: 'kpi',
      tableId: '' as Id<'tbl'>,
      filter: null,
      metric: { id: 'm1', aggregation: 'count', field: null },
      compare: null,
    };

    it('P21: u_sales1 counts only r1, u_admin all three', async () => {
      const widget = { ...count, tableId: fx.orders.id };
      expect((await run(widget, accessOf(fx, 'u_sales1'))).rows).toEqual([[1]]);
      expect((await run(widget, accessOf(fx, 'u_sales2'))).rows).toEqual([[1]]);
      expect((await run(widget, admin())).rows).toEqual([[3]]);
      const byStatus = await run(ordersQuery(), accessOf(fx, 'u_sales1'));
      expect(byStatus.rows).toEqual([[{ value: fx.opt.new, label: 'Mới' }, 1]]);
      expect(byStatus.total).toEqual([1]);
    });

    it('a hidden field anywhere in the widget is `no_permission`, never a number', async () => {
      const sales = accessOf(fx, 'u_sales1');
      const cost = fx.fld.cost.id;
      const cases: WidgetQuery[] = [
        { ...count, tableId: fx.orders.id, metric: { id: 'm1', aggregation: 'sum', field: cost } },
        ordersQuery({ metrics: [{ id: 'm1', aggregation: 'max', field: cost }] }),
        ordersQuery({ dimension: { field: cost, dateBucket: null, bucketWidth: 10 } }),
        ordersQuery({ series: { field: cost, dateBucket: null, bucketWidth: null } }),
        // A saved filter on `cost` is not set aside (that would count more).
        ordersQuery({
          filter: { op: 'and', items: [{ field: cost, operator: 'gt', value: 100 }] },
        }),
        {
          ...count,
          tableId: fx.orders.id,
          filter: { op: 'and', items: [{ field: cost, operator: 'is_not_empty' }] },
        },
        {
          kind: 'records',
          tableId: fx.orders.id,
          filter: null,
          fields: [fx.fld.title.id, cost],
          sort: null,
          limit: 10,
        },
        {
          kind: 'records',
          tableId: fx.orders.id,
          filter: null,
          fields: [fx.fld.title.id],
          sort: { field: cost, direction: 'desc' },
          limit: 10,
        },
        // A field that does not exist answers the same.
        ordersQuery({ metrics: [{ id: 'm1', aggregation: 'sum', field: newId('fld') }] }),
        // A table the viewer cannot read.
        { ...count, tableId: items.id },
      ];
      for (const widget of cases) {
        expect(await run(widget, sales)).toEqual({
          status: 'no_permission',
          columns: [],
          rows: [],
        });
      }
      // The same widgets compute for the admin.
      expect((await run(cases[0] as WidgetQuery, admin())).rows).toEqual([[60]]);
      expect((await run(cases[4] as WidgetQuery, admin())).status).toBe('empty');
    });

    it('a link dimension needs the linked table: Sales does not read Customers (P20 rule)', async () => {
      const widget = ordersQuery({
        dimension: { field: orderCustomer.id, dateBucket: null, bucketWidth: null },
      });
      expect(await run(widget, accessOf(fx, 'u_sales1'))).toMatchObject({
        status: 'no_permission',
        rows: [],
      });
      const asAdmin = await run(widget, admin());
      expect(asAdmin.rows).toEqual([
        [{ value: customers[0], label: 'Alpha' }, 1],
        [{ value: customers[1], label: 'Beta' }, 1],
        [{ value: null, label: null }, 1],
      ]);
    });

    it('a read rule on a link field (T710) applies', async () => {
      const c1Rule = { field: orderCustomer.id, operator: 'has_any_of', value: [customers[0]] };
      const variant: RoleConfigInput = {
        tables: {
          [fx.orders.id]: {
            perm: 'read_only',
            record_rule: {
              operations: [],
              edit_filter: null,
              read_scope: 'filter',
              read_filter: c1Rule,
            },
          },
          [fx.customers.id]: { perm: 'read_only' },
        },
      };
      const saved = fx.roles.sales;
      fx.roles.sales = { ...saved, config: roleConfigSchema.parse(variant) };
      try {
        const sales = accessOf(fx, 'u_sales1');
        expect((await run({ ...count, tableId: fx.orders.id }, sales)).rows).toEqual([[1]]);
        const byCustomer = await run(
          ordersQuery({
            dimension: { field: orderCustomer.id, dateBucket: null, bucketWidth: null },
          }),
          sales,
        );
        expect(byCustomer.rows).toEqual([[{ value: customers[0], label: 'Alpha' }, 1]]);
      } finally {
        fx.roles.sales = saved;
      }
    });

    it('records mode reads through records/query: columns the viewer reads', async () => {
      const widget: WidgetQuery = {
        kind: 'records',
        tableId: fx.orders.id,
        filter: null,
        fields: [fx.fld.title.id, fx.fld.amount.id],
        sort: { field: fx.fld.amount.id, direction: 'desc' },
        limit: 10,
      };
      const sales = await run(widget, accessOf(fx, 'u_sales1'));
      expect(sales.rows).toEqual([[r1, 'r1', 100]]);
      expect(sales.columns.map((column) => [column.role, column.key])).toEqual([
        ['record_id', 'record_id'],
        ['field', fx.fld.title.id],
        ['field', fx.fld.amount.id],
      ]);
      const all = await run(widget, admin());
      expect(all.rows.map((row) => row[1])).toEqual(['r3', 'r2', 'r1']);
    });
  });

  it('`broken` when a date dimension has no bucket or the saved filter no longer validates', async () => {
    const base = groupedQuery({
      name: '',
      dimension: { field: 'due', bucket: 'day' },
      metrics: [{ aggregation: 'count' }],
    });
    expect(
      await run({ ...base, dimension: { ...base.dimension, dateBucket: null } }),
    ).toMatchObject({
      status: 'broken',
    });
    expect(
      await run({
        ...base,
        filter: { op: 'and', items: [{ field: F('done'), operator: 'contains', value: 'x' }] },
      }),
    ).toMatchObject({ status: 'broken' });
  });

  it('more than 1 000 groups is 422 WIDGET_TOO_LARGE', async () => {
    const widget: GroupedWidgetQuery = {
      kind: 'grouped',
      tableId: many.id,
      filter: null,
      dimension: { field: F('many.name'), dateBucket: null, bucketWidth: null },
      series: null,
      metrics: [{ id: 'm1', aggregation: 'count', field: null }],
      sort: 'metric_desc',
      limit: 20,
      groupOthers: true,
    };
    const error: unknown = await run(widget).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION_FAILED');
    expect((error as AppError).errors).toEqual([
      expect.objectContaining({
        code: 'WIDGET_TOO_LARGE',
        params: { groups: MAX_WIDGET_GROUPS + 1, limit: MAX_WIDGET_GROUPS },
      }),
    ]);
    // A filter that leaves 1 000 groups computes.
    const ok: WidgetAggregateResult = await run({
      ...widget,
      filter: { op: 'and', items: [{ field: F('many.name'), operator: 'neq', value: 'v0' }] },
    });
    expect(ok.rows).toHaveLength(20);
    expect(ok.other).toMatchObject({ groups: MAX_WIDGET_GROUPS - 20 });
  });

  it('tenant isolation: another organization reads nothing of org A', async () => {
    const widget = groupedQuery({
      name: '',
      dimension: { field: 'status' },
      metrics: [{ aggregation: 'count' }],
    });
    expect(
      await query.widgetData(orgScope(ORG_B), accessOf(fxB, 'u_admin'), widget, { timeZone: UTC }),
    ).toEqual({ status: 'no_permission', columns: [], rows: [] });
  });
});
