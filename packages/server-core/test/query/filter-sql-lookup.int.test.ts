/**
 * Lookup conditions (SPEC §5.8, BACKLOG T455): `intersects`/`disjoint` and
 * `{ field_ref }` operands compiled by `compileToSql` in lookup mode return
 * exactly the records `evaluate` accepts with the same current record
 * (`refRecord`), on the T105 fixture table: every field × lookup operator ×
 * constant list, and every field × operator × compatible referenced field ×
 * a few current records, in two zones.
 */
import {
  allowedOperators,
  createEvaluator,
  fieldProfile,
  resolveVariables,
  validateFilter,
  type EvaluateRecord,
  type FilterNode,
  type FilterValue,
} from '@cellhive/filter-dsl';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { compileToSql, type SqlFilterTableMeta } from '../../src/query/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import {
  buildRecords,
  COLLATION,
  columnOf,
  DATE_OPERANDS,
  FIELD_LIST,
  fields,
  NUMBER_OPERANDS,
  opt,
  tableMeta,
  TEXT_NEEDLES,
  usr,
  visibleFieldIds,
} from './filter-fixture.js';

import type { FieldRow } from '../../src/db/schema.js';

const DATE_OID = 1082;
function typeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
  if (oid === DATE_OID) return (value) => value;
  return pg.types.getTypeParser(oid, format ?? 'text') as (value: string) => unknown;
}

const ORG = 'org_T455LookupFiltr1';
const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
const ZONES = ['Asia/Ho_Chi_Minh', 'America/New_York'] as const;
const NOW = new Date('2026-03-08T15:00:00.000Z');

type RefKind = 'text' | 'numeric' | 'date' | 'timestamptz' | 'ids' | 'scalar';

/** Referenced fields by the kind of value they give (`__id` is `scalar`). */
const REFS: Record<RefKind, readonly string[]> = {
  text: [fields.title.id, fields.code.id],
  numeric: [fields.amount.id, fields.rating.id],
  date: [fields.due.id],
  timestamptz: [fields.dueNy.id, fields.created.id],
  ids: [fields.status.id, fields.tags.id, fields.owners.id],
  scalar: [fields.creator.id, '__id'],
};

/** Kinds a condition field compiles a `field_ref` from (filter-sql `fieldRefCondition`). */
function refKinds(group: string): RefKind[] {
  switch (group) {
    case 'text':
      return ['text', 'numeric', 'date', 'ids', 'scalar'];
    case 'number':
      return ['numeric'];
    case 'datetime':
      return ['date', 'timestamptz'];
    case 'single_select':
    case 'multi':
      return ['text', 'ids', 'scalar'];
    default:
      return [];
  }
}

const lists = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
};

function constantOperands(group: string, element: string): FilterValue[] {
  switch (group) {
    case 'text':
      return lists(TEXT_NEEDLES, 3);
    case 'number':
      return lists(NUMBER_OPERANDS, 3);
    case 'datetime':
      return lists(DATE_OPERANDS, 4);
    case 'single_select':
      return [[opt.new], [opt.done, opt.hold]];
    default:
      return element === 'option'
        ? [[opt.a], [opt.b, opt.c], [opt.a, opt.b, opt.c, opt.d, opt.e]]
        : [[usr.an], [usr.binh, usr.ghost], [{ $var: 'current_user' }]];
  }
}

describe('lookup filter conditions: SQL ≡ evaluator (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let appDb: Db;
  let pool: pg.Pool;
  let db: Kysely<Record<string, never>>;
  let records: { id: string; values: EvaluateRecord }[];
  let tableName: string;
  let sqlMeta: SqlFilterTableMeta;

  beforeAll(async () => {
    database = await createTestDatabase();
    appDb = createTestDb(database.url);
    await migrateAll(database.url, appDb);
    const { baseId } = await seedTenant(appDb, ORG, { collation: COLLATION });
    const schema = new SchemaService(appDb, { maxFieldsPerTable: 500 });
    const scope = orgScope(ORG);
    const context = systemAuditContext();
    const created = await schema.createTable(
      scope,
      { baseId, name: 'Lookup harness', primaryFieldName: fields.title.name },
      context,
    );
    tableName = created.table.db_table_name;
    const real = new Map<string, FieldRow>([[fields.title.id, created.primaryField]]);
    for (const item of FIELD_LIST) {
      if (item.id === fields.title.id) continue;
      real.set(
        item.id,
        await schema.addField(
          scope,
          created.table.id,
          { name: item.name, type: item.type, options: item.options },
          context,
        ),
      );
    }
    const physical = (id: string) => real.get(id)?.db_column_name ?? null;
    sqlMeta = {
      collation: created.table.collation,
      fields: FIELD_LIST.map((item) => ({ ...item, dbColumnName: physical(item.id) })),
    };
    const renamed = new Map(
      FIELD_LIST.filter((item) => physical(item.id) !== null).map((item) => [
        columnOf(item),
        physical(item.id) as string,
      ]),
    );
    pool = new pg.Pool({
      connectionString: database.url,
      max: 4,
      types: { getTypeParser: typeParser as typeof pg.types.getTypeParser },
    });
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const rows = buildRecords();
    const columns = Object.keys(rows[0] ?? {});
    const target = columns.map((column) => renamed.get(column) ?? column);
    const insert = `INSERT INTO data.${quoteIdent(tableName)} (${target.map(quoteIdent).join(', ')})
      VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`;
    for (const row of rows)
      await pool.query(
        insert,
        columns.map((column) => row[column]),
      );
    const stored = await pool.query<Record<string, unknown>>(
      `SELECT * FROM data.${quoteIdent(tableName)} ORDER BY __id`,
    );
    records = stored.rows.map((row) => ({
      id: row['__id'] as string,
      values: Object.fromEntries(
        FIELD_LIST.map((item) => [item.id, row[renamed.get(columnOf(item)) ?? columnOf(item)]]),
      ),
    }));
  });

  afterAll(async () => {
    await db.destroy();
    await appDb.destroy();
    await database.drop();
  });

  interface Case {
    readonly name: string;
    readonly filter: FilterNode;
    readonly ref: number;
  }

  /** Current records: the first ones hold the awkward values of each pool. */
  const REF_RECORDS = [0, 3, 11, 40];

  function cases(): Case[] {
    const out: Case[] = [];
    for (const item of FIELD_LIST) {
      const profile = fieldProfile(item);
      const operators = [...allowedOperators(profile, 'lookup')];
      if (operators.includes('intersects')) {
        for (const operator of ['intersects', 'disjoint'] as const) {
          for (const value of constantOperands(profile.group, profile.element)) {
            out.push({
              name: `${item.name} ${operator} ${JSON.stringify(value)}`,
              filter: { field: item.id, operator, value },
              ref: 0,
            });
          }
        }
      }
      for (const kind of refKinds(profile.group)) {
        for (const ref of REFS[kind]) {
          for (const operator of operators) {
            if (['is_empty', 'is_not_empty', 'between'].includes(operator)) continue;
            // ids ← option ids / user ids only; the text ref (title) never is one.
            if (kind === 'text' && profile.group !== 'text' && ref !== fields.code.id) continue;
            for (const index of REF_RECORDS) {
              out.push({
                name: `${item.name} ${operator} field_ref ${ref} @${String(index)}`,
                filter: {
                  field: item.id,
                  operator: operator,
                  value: { field_ref: ref },
                } as FilterNode,
                ref: index,
              });
            }
          }
        }
      }
    }
    return out;
  }

  it.each(ZONES)('every lookup condition matches the evaluator (%s)', async (timeZone) => {
    const all = cases();
    expect(all.length).toBeGreaterThan(1000);
    const mismatches: string[] = [];
    let partial = 0;
    for (const item of all) {
      const validated = validateFilter(item.filter, tableMeta, visibleFieldIds, {
        mode: 'lookup',
        refFieldIds: visibleFieldIds,
      });
      if (!validated.ok) throw new Error(`${item.name}: ${JSON.stringify(validated.errors)}`);
      const resolved = resolveVariables(validated.ast, {
        userId: usr.an,
        groupMemberUserIds: [usr.an, usr.binh],
        timeZone,
        now: NOW,
      });
      const refRecord = records[item.ref] as { id: string; values: EvaluateRecord };
      const matches = createEvaluator(resolved, {
        table: tableMeta,
        refRecord: { ...refRecord.values, __id: refRecord.id },
        timeZone,
      });
      const expected = records
        .filter((record) => matches(record.values))
        .map((record) => record.id);
      const condition = compileToSql(resolved, sqlMeta, {
        tableAlias: 's',
        lookup: { refTable: sqlMeta, refAlias: 'ref', timeZone },
      });
      const table = sql.id('data', tableName);
      const { rows } = await sql<{ id: string }>`
        SELECT s.__id AS id FROM ${table} AS s, ${table} AS ref
         WHERE ref.__id = ${refRecord.id} AND ${condition}
         ORDER BY s.__id
      `.execute(db);
      const actual = rows.map((row) => row.id);
      if (actual.join() !== expected.join()) {
        mismatches.push(
          `${item.name}: sql ${String(actual.length)} vs evaluate ${String(expected.length)} (only sql ${actual
            .filter((id) => !expected.includes(id))
            .slice(0, 3)
            .join(',')}; only evaluate ${expected
            .filter((id) => !actual.includes(id))
            .slice(0, 3)
            .join(',')})`,
        );
      }
      if (expected.length > 0 && expected.length < records.length) partial += 1;
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(partial / all.length).toBeGreaterThan(0.4);
  });
});
