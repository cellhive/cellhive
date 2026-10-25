/**
 * Group ordering through a view (BACKLOG T302) on the fixture of the filter
 * equivalence harness (T105): 360 records with empty lists, NULLs, users
 * and extreme numbers. `records/query` through a view grouped on three
 * levels (single select, checkbox, single user) and sorted by a number
 * must return exactly the in-memory order, and `records/group-counts` the
 * run lengths of that order.
 */
import { newId, type Id } from '@cellhive/contracts';
import {
  resolveBaseAccess,
  systemRoleConfig,
  type BaseRoleDef,
  type SchemaMeta,
} from '@cellhive/permissions';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { RecordQueryService, type RecordAccessContext } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { configJson, defaultViewConfig, ViewsRepository } from '../../src/views/index.js';
import {
  buildRecords,
  COLLATION,
  columnOf,
  FIELD_LIST,
  fields,
  usr,
} from '../query/filter-fixture.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import { insertRows } from './fixtures.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG: Id<'org'> = 'org_T302GroupHarness';
/** Display names of the fixture users: distinct, so name order is total. */
const NAMES: Readonly<Record<string, string>> = {
  [usr.an]: 'Anh',
  [usr.binh]: 'Binh',
  [usr.chi]: 'Chi',
  [usr.dung]: 'Dung',
  [usr.giang]: 'Giang',
};
const STATUS_ORDER = (fields.status.options as { options: { id: string }[] }).options.map(
  (option) => option.id,
);

interface Row {
  readonly id: string;
  readonly auto: number;
  readonly status: string | null;
  readonly done: boolean | null;
  readonly assignee: string | null;
  readonly rating: number | null;
}

/** Empty cells last in both directions, like the server (CONTRACTS §1.4). */
function compareNullable<T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b);
}

const byNumber = (a: number, b: number) => a - b;
const desc =
  <T>(cmp: (a: T, b: T) => number) =>
  (a: T, b: T) =>
    cmp(b, a);

describe('group + sort through a view on the harness fixture (T302)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let table: TableRow;
  let real: Map<string, FieldRow>;
  let access: RecordAccessContext;
  let viewId: Id<'viw'>;
  let expected: Row[];
  const scope = orgScope(ORG);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    const { baseId, userId } = await seedTenant(db, ORG, { collation: COLLATION });
    await db.withTx(async (tx) => {
      for (const [id, name] of Object.entries(NAMES)) {
        await tx
          .insertInto('meta.users')
          .values({
            id: id as Id<'usr'>,
            email: `${name.toLowerCase()}@example.test`,
            display_name: name,
          })
          .execute();
        await tx
          .insertInto('meta.org_members')
          .values({ organization_id: ORG, user_id: id as Id<'usr'>, role: 'member' })
          .execute();
      }
    });

    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const context = systemAuditContext();
    const created = await schema.createTable(
      scope,
      { baseId, name: 'Harness', primaryFieldName: fields.title.name },
      context,
    );
    table = created.table;
    real = new Map([[fields.title.id, created.primaryField]]);
    for (const item of FIELD_LIST) {
      if (item.id === fields.title.id) continue;
      real.set(
        item.id,
        await schema.addField(
          scope,
          table.id,
          { name: item.name, type: item.type, options: item.options },
          context,
        ),
      );
    }
    const renamed = new Map(
      FIELD_LIST.filter((item) => real.get(item.id)?.db_column_name != null).map((item) => [
        columnOf(item),
        real.get(item.id)?.db_column_name as string,
      ]),
    );
    const rows = buildRecords().map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([column, value]) => [renamed.get(column) ?? column, value]),
      ),
    );
    await insertRows(pool, table, rows);

    const idOf = (item: { id: string }) => real.get(item.id)?.id as Id<'fld'>;
    viewId = (
      await new ViewsRepository(db).insert(scope, {
        id: newId('viw'),
        tableId: table.id,
        type: 'grid',
        name: 'Grouped',
        config: configJson({
          ...defaultViewConfig('grid'),
          group: [
            { field: idOf(fields.status), direction: 'asc' },
            { field: idOf(fields.done), direction: 'desc' },
            { field: idOf(fields.assignee), direction: 'asc' },
          ],
          sort: [{ field: idOf(fields.rating), direction: 'desc' }],
        }),
        position: 1,
        ownerId: null,
      })
    ).id;

    const schemaMeta: SchemaMeta = {
      tables: [
        {
          id: table.id,
          fields: [...real.values()].map((field) => ({ id: field.id, type: field.type })),
        },
      ],
      dashboards: [],
    };
    const admin: BaseRoleDef = {
      id: newId('rol'),
      kind: 'system_admin',
      name: 'Admin',
      config: systemRoleConfig('admin', schemaMeta),
    };
    const resolved = resolveBaseAccess({
      principal: {
        userId,
        groupIds: [],
        orgRole: 'member',
        workspaceRole: 'member',
        isBaseOwner: false,
      },
      roles: [admin],
      assignments: [{ roleId: admin.id, principalType: 'user', principalId: userId }],
      schema: schemaMeta,
    });
    if (resolved === null) throw new Error('no access');
    access = {
      baseId,
      resolved,
      userId,
      groupMemberUserIds: [],
      timeZone: 'Asia/Ho_Chi_Minh',
      locale: 'en',
    };

    // The in-memory expectation, from what the database stores.
    const column = (item: { id: string }) =>
      pg.escapeIdentifier(real.get(item.id)?.db_column_name as string);
    const stored = await pool.query<{
      id: string;
      auto: string;
      status: string[] | null;
      done: boolean | null;
      assignee: string[] | null;
      rating: string | null;
    }>(
      `SELECT __id AS id, __auto AS auto, ${column(fields.status)} AS status,
              ${column(fields.done)} AS done, ${column(fields.assignee)} AS assignee,
              ${column(fields.rating)}::float8::text AS rating
         FROM data.${pg.escapeIdentifier(table.db_table_name)}`,
    );
    const first = (list: string[] | null) =>
      list === null || list.length === 0 ? null : (list[0] ?? null);
    const rowsInMemory: Row[] = stored.rows.map((row) => ({
      id: row.id,
      auto: Number(row.auto),
      status: first(row.status),
      done: row.done,
      assignee: first(row.assignee),
      rating: row.rating === null ? null : Number(row.rating),
    }));
    const statusRank = (id: string) => STATUS_ORDER.indexOf(id);
    const nameOf = (id: string | null) => (id === null ? null : (NAMES[id] ?? null));
    expected = [...rowsInMemory].sort(
      (a, b) =>
        compareNullable(a.status, b.status, (x, y) => statusRank(x) - statusRank(y)) ||
        compareNullable(
          a.done,
          b.done,
          desc((x: boolean, y: boolean) => Number(x) - Number(y)),
        ) ||
        compareNullable(nameOf(a.assignee), nameOf(b.assignee), (x, y) =>
          x < y ? -1 : x > y ? 1 : 0,
        ) ||
        compareNullable(a.rating, b.rating, desc(byNumber)) ||
        a.auto - b.auto,
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('pages through the view in exactly the in-memory order', async () => {
    const service = new RecordQueryService(db);
    const all = await service.query(scope, table.id, access, { view_id: viewId, limit: 1000 });
    expect(all.records).toHaveLength(expected.length);
    expect(all.records.map((record) => record.id)).toEqual(expected.map((row) => row.id));
    const page = await service.query(scope, table.id, access, {
      view_id: viewId,
      offset: 100,
      limit: 100,
    });
    expect(page.records.map((record) => record.id)).toEqual(
      expected.slice(100, 200).map((row) => row.id),
    );
  });

  it('group counts are the run lengths of that order', async () => {
    const service = new RecordQueryService(db);
    const counts = await service.groupCounts(scope, table.id, access, {
      view_id: viewId,
      field_key_type: 'id',
    });
    const runs: { key: string; count: number }[] = [];
    for (const row of expected) {
      const key = JSON.stringify([row.status, row.done, row.assignee]);
      const last = runs.at(-1);
      if (last?.key === key) last.count += 1;
      else runs.push({ key, count: 1 });
    }
    // Every group is one contiguous run (no group value appears twice).
    expect(new Set(runs.map((run) => run.key)).size).toBe(runs.length);
    expect(counts.truncated).toBe(false);
    expect(counts.groups.map((group) => group.count)).toEqual(runs.map((run) => run.count));
    const status = (fields.status.options as { options: { id: string; name: string }[] }).options;
    expect(
      counts.groups.map((group) => {
        const [statusName, done, assignee] = group.values as [
          string | null,
          boolean | null,
          { id: string }[] | null,
        ];
        return JSON.stringify([
          status.find((option) => option.name === statusName)?.id ?? null,
          done,
          assignee?.[0]?.id ?? null,
        ]);
      }),
    ).toEqual(runs.map((run) => run.key));
  });
});
