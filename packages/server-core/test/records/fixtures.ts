/**
 * TEST FIXTURES ONLY. Record rows are written straight into `data.*` here
 * because `RecordMutationService` arrives in T107; production code must never
 * write records this way (AGENTS.md rule 1). Identifiers still come from meta
 * (quoted with `pg`'s `escapeIdentifier`), values are always parameters.
 */
import { newId, type Id } from '@cellhive/contracts';
import {
  resolveBaseAccess,
  roleConfigSchema,
  systemRoleConfig,
  type BaseRoleDef,
  type RoleAssignment,
  type RoleConfigInput,
  type SchemaMeta,
} from '@cellhive/permissions';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, typeParsers, type Database, type Db } from '../../src/db/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { seedTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';
import type { RecordAccessContext } from '../../src/records/index.js';

export const TIME_ZONE = 'Asia/Ho_Chi_Minh';
export const LOCALE = 'vi';
/** Pinned clock: 2026-09-23 10:00 in Ho Chi Minh City. */
export const NOW = new Date('2026-09-23T03:00:00.000Z');

const USER_KEYS = ['u_admin', 'u_editor', 'u_reader', 'u_sales1', 'u_sales2', 'u_out'] as const;
export type UserKey = (typeof USER_KEYS)[number];

export interface SeededUser {
  readonly id: Id<'usr'>;
  readonly name: string;
  readonly email: string;
}

/** Inserts users and makes them members of the organization (test fixture). */
export async function seedMembers(
  db: Db,
  orgId: Id<'org'>,
  users: readonly { key: string; name: string }[],
): Promise<Record<string, SeededUser>> {
  const out: Record<string, SeededUser> = {};
  await db.withTx(async (tx) => {
    for (const { key, name } of users) {
      const id = newId('usr');
      const email = `${key}.${id.slice(4, 10).toLowerCase()}@example.test`;
      await tx.insertInto('meta.users').values({ id, email, display_name: name }).execute();
      await tx
        .insertInto('meta.org_members')
        .values({ organization_id: orgId, user_id: id, role: 'member' })
        .execute();
      out[key] = { id, name, email };
    }
  });
  return out;
}

/** Physical columns → values of one record row; system columns may be set too. */
export type RowValues = Record<string, unknown>;

/**
 * TEST FIXTURE: inserts rows into `data.<table>` directly. Returns the ids
 * (`rec_…`) in input order. Column names must come from meta.
 */
export async function insertRows(
  pool: pg.Pool,
  table: TableRow,
  rows: readonly RowValues[],
): Promise<Id<'rec'>[]> {
  const ids: Id<'rec'>[] = [];
  for (const row of rows) {
    const id = (row['__id'] as Id<'rec'> | undefined) ?? newId('rec');
    const values: RowValues = { ...row, __id: id };
    const columns = Object.keys(values);
    const text = `INSERT INTO data.${pg.escapeIdentifier(table.db_table_name)} (${columns
      .map((column) => pg.escapeIdentifier(column))
      .join(', ')}) VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`;
    await pool.query(
      text,
      columns.map((column) => values[column]),
    );
    ids.push(id);
  }
  return ids;
}

/**
 * TEST FIXTURE: many rows in one statement per batch (`INSERT … SELECT FROM
 * unnest(…)`), for the search index and bench tables.
 */
export async function insertBulk(
  pool: pg.Pool,
  table: TableRow,
  columns: readonly {
    name: string;
    /** Element type of the bound array (fixed code, never input). */
    pgType: string;
    /** Cast applied after `unnest`, e.g. `text[]` for a `{…}` literal. */
    castTo?: string;
    values: readonly unknown[];
  }[],
  batchSize = 5_000,
): Promise<void> {
  const count = columns[0]?.values.length ?? 0;
  const names = columns.map((column) => pg.escapeIdentifier(column.name)).join(', ');
  const unnest = columns
    .map((column, index) => `$${String(index + 1)}::${column.pgType}[]`)
    .join(', ');
  const aliases = columns.map((_, index) => `c${String(index)}`);
  const select = columns
    .map((column, index) =>
      column.castTo === undefined ? `u.c${String(index)}` : `u.c${String(index)}::${column.castTo}`,
    )
    .join(', ');
  for (let start = 0; start < count; start += batchSize) {
    const slice = columns.map((column) => column.values.slice(start, start + batchSize));
    const ids = Array.from({ length: slice[0]?.length ?? 0 }, () => newId('rec'));
    await pool.query(
      `INSERT INTO data.${pg.escapeIdentifier(table.db_table_name)} (__id, ${names})
       SELECT u.id, ${select}
         FROM unnest($${String(columns.length + 1)}::text[], ${unnest}) AS u(id, ${aliases.join(', ')})`,
      // `$1…$n` are the columns, `$n+1` the ids.
      [...slice, ids],
    );
  }
}

export interface CapturedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A `Db` test double that records every statement with its parameters, so
 * a test can `EXPLAIN` exactly what the service ran. Same type parsers and
 * UTC session as `createDb`; no timeout handling.
 */
export function capturingDb(url: string): { db: Db; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const pool = new pg.Pool({ connectionString: url, max: 2, types: typeParsers });
  const kysely = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
      onCreateConnection: async (connection) => {
        await connection.executeQuery(sql`SET TIME ZONE 'UTC'`.compile(kysely));
      },
    }),
    log: (event) => {
      queries.push({ sql: event.query.sql, parameters: event.query.parameters });
    },
  });
  const db: Db = {
    kysely,
    withTx: (fn, options = {}) =>
      options.isolationLevel === undefined
        ? kysely.transaction().execute(fn)
        : kysely.transaction().setIsolationLevel(options.isolationLevel).execute(fn),
    destroy: () => kysely.destroy(),
  };
  return { db, queries };
}

/** CONTRACTS §5 fixture on real tables created by `SchemaService` (T102). */
export interface OrdersFixture {
  readonly orgId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly users: Record<UserKey, SeededUser>;
  readonly groupSales: Id<'grp'>;
  readonly orders: TableRow;
  readonly customers: TableRow;
  readonly fld: {
    readonly title: FieldRow;
    readonly amount: FieldRow;
    readonly cost: FieldRow;
    readonly status: FieldRow;
    readonly owner: FieldRow;
    readonly createdBy: FieldRow;
    readonly name: FieldRow;
    readonly phone: FieldRow;
  };
  readonly opt: { readonly new: Id<'opt'>; readonly done: Id<'opt'> };
  /** Mutable so tests can add tables created later (admins get full access to them). */
  readonly schema: { tables: SchemaMeta['tables'][number][]; dashboards: Id<'dsh'>[] };
  readonly roles: Record<'admin' | 'editor' | 'reader' | 'sales', BaseRoleDef>;
  readonly assignments: RoleAssignment[];
}

export async function buildOrdersFixture(
  db: Db,
  schemaService: SchemaService,
  orgId: Id<'org'>,
): Promise<OrdersFixture> {
  const { baseId } = await seedTenant(db, orgId);
  const scope = orgScope(orgId);
  const context = systemAuditContext();
  const users = (await seedMembers(
    db,
    orgId,
    USER_KEYS.map((key) => ({ key, name: key.replace('u_', 'User ') })),
  )) as Record<UserKey, SeededUser>;
  const groupSales = newId('grp');

  const { table: orders, primaryField: title } = await schemaService.createTable(
    scope,
    { baseId, name: 'Orders', primaryFieldName: 'title' },
    context,
  );
  const add = (tableId: Id<'tbl'>, name: string, type: string, options: unknown = {}) =>
    schemaService.addField(scope, tableId, { name, type, options }, context);
  const opt = { new: newId('opt'), done: newId('opt') };
  const amount = await add(orders.id, 'amount', 'number', {
    style: { type: 'currency', currency_code: 'VND' },
  });
  const cost = await add(orders.id, 'cost', 'number');
  const status = await add(orders.id, 'status', 'select', {
    options: [
      { id: opt.new, name: 'Mới' },
      { id: opt.done, name: 'Xong' },
    ],
  });
  const owner = await add(orders.id, 'owner', 'user', { multiple: false });
  const createdBy = await add(orders.id, 'created by', 'created_by');

  const { table: customers, primaryField: name } = await schemaService.createTable(
    scope,
    { baseId, name: 'Customers', primaryFieldName: 'name' },
    context,
  );
  const phone = await add(customers.id, 'phone', 'text', { style: { type: 'phone' } });

  const schema: OrdersFixture['schema'] = {
    tables: [
      {
        id: orders.id,
        fields: [title, amount, cost, status, owner, createdBy].map((f) => ({
          id: f.id,
          type: f.type,
        })),
      },
      { id: customers.id, fields: [name, phone].map((f) => ({ id: f.id, type: f.type })) },
    ],
    dashboards: [],
  };
  const salesConfig: RoleConfigInput = {
    base_rule: { copy: false, download: false, share_link: false },
    tables: {
      [orders.id]: {
        perm: 'edit',
        view_rule: { allow_edit: false, visible_views: null },
        record_rule: {
          operations: ['add'],
          edit_filter: {
            op: 'and',
            items: [{ field: owner.id, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
          },
          read_scope: 'editable',
          read_filter: null,
        },
        field_rule: {
          mode: 'specify',
          fields: { [cost.id]: 'no_perm', [status.id]: 'read' },
          option_edit_fields: [],
          file_download_fields: [],
        },
      },
    },
    dashboards: {},
  };
  const roles = {
    admin: {
      id: newId('rol'),
      kind: 'system_admin',
      name: 'Admin',
      config: systemRoleConfig('admin', schema),
    },
    editor: {
      id: newId('rol'),
      kind: 'system_editor',
      name: 'Editor',
      config: systemRoleConfig('editor', schema),
    },
    reader: {
      id: newId('rol'),
      kind: 'system_reader',
      name: 'Reader',
      config: systemRoleConfig('reader', schema),
    },
    sales: {
      id: newId('rol'),
      kind: 'custom',
      name: 'Sales',
      config: roleConfigSchema.parse(salesConfig),
    },
  } satisfies Record<string, BaseRoleDef>;
  const assignments: RoleAssignment[] = [
    { roleId: roles.admin.id, principalType: 'user', principalId: users.u_admin.id },
    { roleId: roles.editor.id, principalType: 'user', principalId: users.u_editor.id },
    { roleId: roles.reader.id, principalType: 'user', principalId: users.u_reader.id },
    { roleId: roles.sales.id, principalType: 'group', principalId: groupSales },
  ];

  return {
    orgId,
    baseId,
    users,
    groupSales,
    orders,
    customers,
    fld: { title, amount, cost, status, owner, createdBy, name, phone },
    opt,
    schema,
    roles,
    assignments,
  };
}

/**
 * What the api access service (T008) hands to the record services: the
 * resolved access of `user` in the fixture base.
 */
export function accessOf(fx: OrdersFixture, user: UserKey | null): RecordAccessContext {
  const who = user === null ? fx.users.u_reader : fx.users[user];
  const inSales = user === 'u_sales1' || user === 'u_sales2';
  const resolved = resolveBaseAccess({
    principal: {
      userId: who.id,
      groupIds: inSales ? [fx.groupSales] : [],
      orgRole: 'member',
      workspaceRole: 'member',
      isBaseOwner: false,
    },
    roles: Object.values(fx.roles),
    assignments: fx.assignments,
    schema: fx.schema,
  });
  if (resolved === null) throw new Error(`${String(user)} has no access to the fixture base`);
  return {
    baseId: fx.baseId,
    resolved,
    userId: user === null ? null : who.id,
    groupMemberUserIds: inSales ? [fx.users.u_sales1.id, fx.users.u_sales2.id] : [],
    timeZone: TIME_ZONE,
    locale: LOCALE,
  };
}
