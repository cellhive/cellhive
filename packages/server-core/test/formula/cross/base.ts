/**
 * The base of the cross-table harness (BACKLOG T455): five tables created by
 * `SchemaService` (real columns, junctions and link sides), rows and link
 * rows written directly (test data only), one record and one table moved to
 * the trash. Data: `cases.ts` documents every expected value from it.
 *
 * - Suppliers(Company, Country)
 * - Products(SKU, Price, Supplier → Suppliers one-way)
 * - Customers(Name, Tier, City, Code, Score, Tags, Joined, Owner,
 *   Referrer → Customers one-way self-link, Friends ↔ "Friend of" two-way
 *   self-link, Archived → Archive one-way, "My orders" = reverse of
 *   Orders.Customer)
 * - Orders(Ref, Amount, Status, Date, Code, Labels, Customer ↔ Customers
 *   two-way, Items → Products one-way; BIG links 500 products)
 * - Archive(Name) — in the trash.
 */
import { sql, type RawBuilder } from 'kysely';

import { systemAuditContext } from '../../../src/audit/index.js';
import { orgScope, type Db } from '../../../src/db/index.js';
import {
  loadBaseTables,
  snapshotOfBase,
  type BaseTables,
} from '../../../src/formula/cross/index.js';
import { FieldsRepository } from '../../../src/schema/fields.repository.js';
import { SchemaService } from '../../../src/schema/index.js';
import { migrateAll, type TestDatabase } from '../../support/postgres.js';
import { seedTenant } from '../../support/tenant.js';

import type { FieldRow, TableRow } from '../../../src/db/schema.js';
import type { AnyKysely } from '../harness.js';
import type { Id } from '@cellhive/contracts';
import type { SchemaSnapshot } from '@cellhive/formula-engine';

export const TABLES = ['Suppliers', 'Products', 'Customers', 'Orders', 'Archive'] as const;
export type TableName = (typeof TABLES)[number];

/** Record id of a fixture key (`c1` → `rec_00000000000000c1`). */
export const rid = (key: string): string => `rec_${key.padStart(16, '0')}`;
export const U1 = 'usr_fixtureuser00001';
export const U2 = 'usr_fixtureuser00002';

interface FieldSpec {
  readonly name: string;
  readonly type: string;
  readonly options?: Record<string, unknown>;
}

const opt = (name: string) => ({ id: `opt_${name.toLowerCase().padEnd(16, '0')}`, name });
const TIERS = [opt('Gold'), opt('Silver')];
const TAGS = [opt('VIP'), opt('Si')].map((item, index) =>
  index === 1 ? { ...item, name: 'Sỉ' } : item,
);
export const STATUSES = [opt('New'), opt('Paid'), opt('Shipped')];
const LABELS = [opt('Urgent'), opt('Gift')];
const DATE_ONLY = { style: { format: 'dd/MM/yyyy' } };

const FIELDS: Record<TableName, readonly FieldSpec[]> = {
  Suppliers: [
    { name: 'Company', type: 'text' },
    { name: 'Country', type: 'text' },
  ],
  Products: [
    { name: 'SKU', type: 'text' },
    { name: 'Price', type: 'number' },
  ],
  Customers: [
    { name: 'Name', type: 'text' },
    { name: 'Tier', type: 'select', options: { multiple: false, options: TIERS } },
    { name: 'City', type: 'text' },
    { name: 'Code', type: 'text' },
    { name: 'Score', type: 'number' },
    { name: 'Tags', type: 'select', options: { multiple: true, options: TAGS } },
    { name: 'Joined', type: 'datetime', options: DATE_ONLY },
    { name: 'Owner', type: 'user', options: { multiple: true } },
  ],
  Orders: [
    { name: 'Ref', type: 'text' },
    { name: 'Amount', type: 'number' },
    { name: 'Status', type: 'select', options: { multiple: false, options: STATUSES } },
    { name: 'Date', type: 'datetime', options: DATE_ONLY },
    { name: 'Code', type: 'text' },
    { name: 'Labels', type: 'select', options: { multiple: true, options: LABELS } },
  ],
  Archive: [{ name: 'Name', type: 'text' }],
};

type Row = Readonly<Record<string, unknown>>;

const ORDERS: readonly [string, Row][] = [
  [
    'o1',
    { Ref: 'O1', Amount: 100, Status: 'Paid', Date: '2026-01-05', Code: 'C1', Labels: ['Urgent'] },
  ],
  ['o2', { Ref: 'O2', Amount: 250, Status: 'New', Date: '2026-02-10', Code: 'C1', Labels: [] }],
  [
    'o3',
    {
      Ref: 'O3',
      Amount: 75.5,
      Status: 'Paid',
      Date: '2026-02-11',
      Code: 'C2',
      Labels: ['Gift', 'Urgent'],
    },
  ],
  ['o4', { Ref: 'O4', Amount: 40, Status: 'Shipped', Date: null, Code: 'C2', Labels: [] }],
  ['o5', { Ref: 'O5', Amount: 999, Status: 'Paid', Date: '2026-03-01', Code: 'C1', Labels: [] }],
  [
    'o6',
    { Ref: 'O6', Amount: null, Status: 'New', Date: '2026-03-02', Code: 'C3', Labels: ['Gift'] },
  ],
  ['o7', { Ref: 'O7', Amount: 10, Status: 'Paid', Date: '2026-03-03', Code: 'C4', Labels: [] }],
  ['big', { Ref: 'BIG', Amount: 1, Status: 'New', Date: null, Code: 'C9', Labels: [] }],
];

const CUSTOMERS: readonly [string, Row][] = [
  [
    'c1',
    {
      Name: 'An',
      Tier: 'Gold',
      City: 'HCM',
      Code: 'C1',
      Score: 10,
      Tags: ['VIP'],
      Joined: '2025-01-10',
      Owner: [U1],
    },
  ],
  [
    'c2',
    {
      Name: 'Bình',
      Tier: 'Silver',
      City: 'HN',
      Code: 'C2',
      Score: 5,
      Tags: ['VIP', 'Sỉ'],
      Joined: '2025-03-01',
      Owner: [U2, U1],
    },
  ],
  [
    'c3',
    {
      Name: 'Chi',
      Tier: 'Gold',
      City: 'HCM',
      Code: 'C3',
      Score: null,
      Tags: [],
      Joined: null,
      Owner: [],
    },
  ],
  [
    'c4',
    {
      Name: 'Dũng',
      Tier: 'Silver',
      City: 'HN',
      Code: 'C4',
      Score: 7,
      Tags: [],
      Joined: null,
      Owner: [],
    },
  ],
  [
    'c5',
    {
      Name: 'Em',
      Tier: null,
      City: '',
      Code: 'C5',
      Score: 1,
      Tags: ['Sỉ'],
      Joined: null,
      Owner: [],
    },
  ],
];

const PRODUCTS: [string, Row][] = [
  ['p1', { SKU: 'P1', Price: 1.5 }],
  ['p2', { SKU: 'P2', Price: 2 }],
  ['p3', { SKU: 'P3', Price: 3 }],
  ...Array.from({ length: 500 }, (_, index): [string, Row] => {
    const n = index + 1;
    return [`b${String(n)}`, { SKU: `B${String(n).padStart(3, '0')}`, Price: n }];
  }),
];

/** Records moved to the trash. */
const TRASHED = ['o5', 'c4'];

/** Link cells written on side `a` of each link field (owner → targets in cell order). */
const LINKS: Record<string, readonly [string, readonly string[]][]> = {
  Supplier: [
    ['p1', ['s1']],
    ['p2', ['s2']],
    ['p3', ['s1']],
    ...Array.from({ length: 500 }, (_, index): [string, string[]] => [
      `b${String(index + 1)}`,
      [(index + 1) % 2 === 1 ? 's1' : 's2'],
    ]),
  ],
  Customer: [
    ['o1', ['c1']],
    ['o2', ['c1']],
    ['o3', ['c2']],
    ['o4', ['c2', 'c1']],
    ['o5', ['c1']],
    ['o7', ['c4']],
  ],
  Items: [
    ['o1', ['p2', 'p1']],
    ['o2', ['p3']],
    ['o4', ['p1']],
    ['big', Array.from({ length: 500 }, (_, index) => `b${String(500 - index)}`)],
  ],
  Referrer: [
    ['c2', ['c1']],
    ['c3', ['c2']],
    ['c5', ['c4', 'c3']],
  ],
  Friends: [
    ['c1', ['c3', 'c2']],
    ['c2', ['c3']],
  ],
  Archived: [['c1', ['a1']]],
};

export interface CrossBase {
  readonly baseId: Id<'bse'>;
  readonly tables: Record<TableName, TableRow>;
  /** Models after the trash moves (Archive absent). */
  readonly models: BaseTables;
  /** Snapshot for a formula of `table`, Archive included (formulas written before the trash). */
  snapshot(table: TableName): SchemaSnapshot;
  readonly schema: SchemaService;
  field(table: TableName, name: string): FieldRow;
}

async function insertRows(
  db: AnyKysely,
  table: TableRow,
  fields: readonly FieldRow[],
  rows: readonly [string, Row][],
): Promise<void> {
  for (const [key, values] of rows) {
    const entries = Object.entries(values);
    const columns = [sql.id('__id')];
    const params: RawBuilder<unknown>[] = [sql.val(rid(key))];
    for (const [name, value] of entries) {
      const field = fields.find((item) => item.name === name);
      if (field?.db_column_name == null) throw new Error(`Unknown fixture field ${name}`);
      columns.push(sql.id(field.db_column_name));
      params.push(sql.val(storage(field, value)));
    }
    await sql`INSERT INTO ${sql.id('data', table.db_table_name)} (${sql.join(columns)}) VALUES (${sql.join(params)})`.execute(
      db,
    );
  }
}

function storage(field: FieldRow, value: unknown): unknown {
  if (value === null) return null;
  if (field.type === 'select') {
    const options = (field.options as { options: { id: string; name: string }[] }).options;
    const names = Array.isArray(value) ? (value as string[]) : [value as string];
    return names.map((name) => {
      const option = options.find((item) => item.name === name);
      if (option === undefined) throw new Error(`Unknown option ${name}`);
      return option.id;
    });
  }
  if (field.type === 'number' && typeof value === 'number') return String(value);
  return value;
}

export async function createCrossBase(
  appDb: Db,
  database: TestDatabase,
  db: AnyKysely,
  orgId: Id<'org'>,
  names: Partial<Record<TableName, string>> = {},
): Promise<CrossBase> {
  await migrateAll(database.url, appDb);
  const { baseId } = await seedTenant(appDb, orgId);
  const schema = new SchemaService(appDb, { maxFieldsPerTable: 500 });
  const scope = orgScope(orgId);
  const context = systemAuditContext();
  const tables = {} as Record<TableName, TableRow>;
  const fields = {} as Record<TableName, FieldRow[]>;
  for (const name of TABLES) {
    const [primary, ...rest] = FIELDS[name];
    if (primary === undefined) throw new Error('No primary field');
    const created = await schema.createTable(
      scope,
      { baseId, name: names[name] ?? name, primaryFieldName: primary.name },
      context,
    );
    tables[name] = created.table;
    fields[name] = [created.primaryField];
    for (const spec of rest) {
      fields[name].push(
        await schema.addField(
          scope,
          created.table.id,
          { name: spec.name, type: spec.type, options: spec.options ?? {} },
          context,
        ),
      );
    }
  }
  const link = async (
    table: TableName,
    name: string,
    target: TableName,
    reverse?: string,
  ): Promise<FieldRow> =>
    schema.addField(
      scope,
      tables[table].id,
      {
        name,
        type: 'link',
        options: {
          link_table: tables[target].id,
          ...(reverse === undefined
            ? {}
            : { bidirectional: true, bidirectional_link_field_name: reverse }),
        },
      },
      context,
    );
  const linkFields: Record<string, FieldRow> = {
    Supplier: await link('Products', 'Supplier', 'Suppliers'),
    Customer: await link('Orders', 'Customer', 'Customers', 'My orders'),
    Items: await link('Orders', 'Items', 'Products'),
    Referrer: await link('Customers', 'Referrer', 'Customers'),
    Friends: await link('Customers', 'Friends', 'Customers', 'Friend of'),
    Archived: await link('Customers', 'Archived', 'Archive'),
  };

  await insertRows(db, tables.Suppliers, fields.Suppliers, [
    ['s1', { Company: 'Acme', Country: 'VN' }],
    ['s2', { Company: 'Globex', Country: 'US' }],
  ]);
  await insertRows(db, tables.Products, fields.Products, PRODUCTS);
  await insertRows(db, tables.Customers, fields.Customers, CUSTOMERS);
  await insertRows(db, tables.Orders, fields.Orders, ORDERS);
  await insertRows(db, tables.Archive, fields.Archive, [['a1', { Name: 'Old' }]]);
  for (const [name, cells] of Object.entries(LINKS)) {
    const junction = linkFields[name]?.link_junction;
    if (junction == null) throw new Error(`No junction for ${name}`);
    for (const [owner, targets] of cells) {
      for (const [position, target] of targets.entries()) {
        await sql`INSERT INTO ${sql.id('data', junction)} (a_id, b_id, position) VALUES (${rid(owner)}, ${rid(target)}, ${position})`.execute(
          db,
        );
      }
    }
  }
  const tableOf = (key: string): TableRow =>
    key.startsWith('o') || key === 'big' ? tables.Orders : tables.Customers;
  for (const key of TRASHED) {
    await sql`UPDATE ${sql.id('data', tableOf(key).db_table_name)} SET __deleted_at = now() WHERE __id = ${rid(key)}`.execute(
      db,
    );
  }

  // Formulas are written while Archive still exists (its snapshot is kept).
  const before = await loadBaseTables(appDb, scope, baseId);
  await schema.deleteTable(scope, tables.Archive.id, context);
  const models = await loadBaseTables(appDb, scope, baseId);
  const repository = new FieldsRepository(appDb);
  const byName = new Map<TableName, FieldRow[]>();
  for (const name of TABLES) byName.set(name, await repository.listByTable(scope, tables[name].id));
  return {
    baseId,
    tables,
    models,
    schema,
    snapshot: (table) => snapshotOfBase(before, tables[table].id),
    field(table, name) {
      const field = byName.get(table)?.find((item) => item.name === name);
      if (field === undefined) throw new Error(`Unknown field ${table}.${name}`);
      return field;
    },
  };
}
