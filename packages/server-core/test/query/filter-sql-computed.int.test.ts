/**
 * Filters on formula/lookup fields (BACKLOG T457, SPEC §6.2: operators of
 * the result type): `compileToSql` on a computed value — its stored column
 * or an expression (`SqlFilterFieldMeta.expression`, what virtual fields
 * and reader-scoped values use) — returns exactly the records `evaluate`
 * accepts on the same values in storage form, for every result kind and
 * every allowed operator.
 */
import {
  allowedOperators,
  createEvaluator,
  fieldProfile,
  resolveVariables,
  validateFilter,
  type EvaluateRecord,
  type FieldProfile,
  type FilterNode,
  type FilterValue,
} from '@cellhive/filter-dsl';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compileToSql, type SqlFilterFieldMeta } from '../../src/query/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import type { FieldType } from '@cellhive/field-types';

const DATE_OID = 1082;
function typeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
  if (oid === DATE_OID) return (value) => value;
  return pg.types.getTypeParser(oid, format ?? 'text') as (value: string) => unknown;
}

const ZONE = 'Asia/Ho_Chi_Minh';
const NOW = new Date('2026-03-08T15:00:00.000Z');
const [U1, U2, U3] = ['usr_an00000000000000', 'usr_binh000000000000', 'usr_chi0000000000000'];
const [R1, R2, R3] = ['rec_a000000000000000', 'rec_b000000000000000', 'rec_c000000000000000'];
const USERS = [U1, U2, U3];
const RECS = [R1, R2, R3];

interface Column {
  readonly name: string;
  readonly pgType: string;
  readonly resultType: FieldType;
  readonly list: boolean;
  readonly resultOptions?: unknown;
  readonly values: readonly unknown[];
}

const ROWS = 12;
const pick = <T>(items: readonly T[], index: number): T => items[index % items.length] as T;

/** One column per result kind × list, with empty values, NULL and edge values. */
const COLUMNS: readonly Column[] = [
  {
    name: 'text',
    pgType: 'text',
    resultType: 'text',
    list: false,
    values: Array.from({ length: ROWS }, (_, i) =>
      pick([null, '', 'An Phát', 'an phat', 'Đồng 100%', 'x_y', 'Bình'], i),
    ),
  },
  {
    name: 'num',
    pgType: 'numeric',
    resultType: 'number',
    list: false,
    values: Array.from({ length: ROWS }, (_, i) =>
      pick([null, '0', '1.5', '-2', '1000000', '0.1'], i),
    ),
  },
  {
    name: 'bool',
    pgType: 'boolean',
    resultType: 'checkbox',
    list: false,
    values: Array.from({ length: ROWS }, (_, i) => pick([null, true, false], i)),
  },
  {
    name: 'day',
    pgType: 'date',
    resultType: 'datetime',
    resultOptions: { style: { format: 'yyyy-MM-dd' } },
    list: false,
    values: Array.from({ length: ROWS }, (_, i) =>
      pick([null, '2026-03-08', '2026-03-09', '2025-12-31'], i),
    ),
  },
  {
    name: 'at',
    pgType: 'timestamptz',
    resultType: 'datetime',
    resultOptions: { style: { format: 'yyyy-MM-dd HH:mm' } },
    list: false,
    values: Array.from({ length: ROWS }, (_, i) =>
      pick([null, '2026-03-08T16:59:59.999Z', '2026-03-08T17:00:00Z', '2026-03-07T03:00:00Z'], i),
    ),
  },
  {
    name: 'user1',
    pgType: 'text',
    resultType: 'user',
    list: false,
    values: Array.from({ length: ROWS }, (_, i) => pick([null, ...USERS], i)),
  },
  {
    name: 'rec1',
    pgType: 'text',
    resultType: 'link',
    list: false,
    values: Array.from({ length: ROWS }, (_, i) => pick([null, ...RECS], i)),
  },
  {
    name: 'texts',
    pgType: 'text[]',
    resultType: 'text',
    list: true,
    values: Array.from({ length: ROWS }, (_, i) =>
      pick([null, ['a'], ['a', 'B'], ['An Phát'], ['b', 'c']], i),
    ),
  },
  {
    name: 'users',
    pgType: 'text[]',
    resultType: 'user',
    list: true,
    values: Array.from({ length: ROWS }, (_, i) =>
      pick([null, [USERS[0]], [USERS[0], USERS[1]], [USERS[2]]], i),
    ),
  },
  {
    name: 'recs',
    pgType: 'text[]',
    resultType: 'link',
    list: true,
    values: Array.from({ length: ROWS }, (_, i) =>
      pick([null, [RECS[0]], [RECS[1], RECS[2]], [RECS[0], RECS[2]]], i),
    ),
  },
  {
    name: 'nums',
    pgType: 'numeric[]',
    resultType: 'number',
    list: true,
    values: Array.from({ length: ROWS }, (_, i) => pick([null, ['1'], ['2', '3']], i)),
  },
  {
    name: 'files',
    pgType: 'jsonb',
    resultType: 'attachment',
    list: true,
    values: Array.from({ length: ROWS }, (_, i) =>
      pick(
        [
          null,
          JSON.stringify([{ id: 'att_a000000000000000', name: 'a.pdf', size: 1, mime: 'a/b' }]),
        ],
        i,
      ),
    ),
  },
];

const fieldId = (column: Column) => `fld_${column.name.padEnd(16, '0').slice(0, 16)}`;

/** Operands per filter profile (values of the pools above plus misses). */
function operands(profile: FieldProfile, operator: string): FilterValue[] {
  if (['is_empty', 'is_not_empty'].includes(operator)) return [null];
  switch (profile.group) {
    case 'text':
      return ['an phat', 'Đồng', '%', 'x_', 'nope'];
    case 'number':
      return operator === 'between'
        ? [
            [0, 1.5],
            [-5, 0],
          ]
        : [0, 1.5, -2, 1000000, 7];
    case 'datetime': {
      const days = [{ $date: { exact: '2026-03-08' } }, { $date: { exact: '2026-03-09' } }];
      return operator === 'between' ? [days] : [...days, { $var: 'today' }];
    }
    case 'checkbox':
      return [true, false];
    default:
      switch (profile.element) {
        case 'user':
          return [[U1], [U1, U2], [{ $var: 'current_user' }]];
        case 'record':
          return [[R1], [R2, R3]];
        default:
          return [['a'], ['a', 'B'], ['An Phát', 'zz']];
      }
  }
}

describe('computed field filters: SQL ≡ evaluator (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let pool: pg.Pool;
  let db: Kysely<Record<string, never>>;
  let records: { id: string; values: EvaluateRecord }[];

  const metaOf = (column: Column, mode: 'stored' | 'virtual'): SqlFilterFieldMeta => ({
    id: fieldId(column),
    name: column.name,
    type: mode === 'stored' ? 'formula' : 'lookup',
    options: {},
    resultType: column.resultType,
    resultIsList: column.list,
    ...(column.resultOptions === undefined ? {} : { resultOptions: column.resultOptions }),
    dbColumnName: column.name,
    ...(mode === 'virtual'
      ? {
          // A computed expression over the row, not the bare column.
          expression: (alias: string | undefined) =>
            sql`(SELECT v FROM (SELECT ${sql.id(alias ?? 'c', column.name)} AS v) AS e)`,
        }
      : {}),
  });

  beforeAll(async () => {
    database = await createTestDatabase();
    // `meta.f_unaccent` of the text operators.
    const appDb = createTestDb(database.url);
    await migrateAll(database.url, appDb);
    await appDb.destroy();
    pool = new pg.Pool({
      connectionString: database.url,
      max: 2,
      types: { getTypeParser: typeParser as typeof pg.types.getTypeParser },
    });
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    await pool.query(
      `CREATE TABLE c (id int PRIMARY KEY, ${COLUMNS.map((column) => `"${column.name}" ${column.pgType}`).join(', ')})`,
    );
    for (let row = 0; row < ROWS; row += 1) {
      await pool.query(
        `INSERT INTO c VALUES ($1, ${COLUMNS.map((_, index) => `$${String(index + 2)}`).join(', ')})`,
        [row, ...COLUMNS.map((column) => column.values[row])],
      );
    }
    const stored = await pool.query<Record<string, unknown>>('SELECT * FROM c ORDER BY id');
    records = stored.rows.map((row) => ({
      id: String(row['id']),
      values: Object.fromEntries(COLUMNS.map((column) => [fieldId(column), row[column.name]])),
    }));
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it.each(['stored', 'virtual'] as const)(
    'every result kind × operator matches the evaluator (%s)',
    async (mode) => {
      const table = { fields: COLUMNS.map((column) => metaOf(column, mode)) };
      const ids = table.fields.map((field) => field.id);
      let count = 0;
      const mismatches: string[] = [];
      for (const field of table.fields) {
        const profile = fieldProfile(field);
        for (const operator of allowedOperators(profile, 'standard')) {
          for (const value of operands(profile, operator)) {
            const filter = {
              field: field.id,
              operator,
              ...(value === null ? {} : { value }),
            } as FilterNode;
            const validated = validateFilter(filter, table, ids);
            if (!validated.ok) {
              throw new Error(`${field.name} ${operator}: ${JSON.stringify(validated.errors)}`);
            }
            const resolved = resolveVariables(validated.ast, {
              userId: U1,
              groupMemberUserIds: [],
              timeZone: ZONE,
              now: NOW,
            });
            const evaluate = createEvaluator(resolved, { table });
            const expected = records
              .filter((record) => evaluate(record.values))
              .map((record) => record.id);
            const where = compileToSql(resolved, table, { tableAlias: 'c' });
            const { rows } = await sql<{ id: number }>`
              SELECT id FROM c AS c WHERE ${where} ORDER BY id
            `.execute(db);
            const actual = rows.map((row) => String(row.id));
            count += 1;
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              mismatches.push(
                `${field.name} ${operator} ${JSON.stringify(value)}: sql ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`,
              );
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
      expect(count).toBeGreaterThan(150);
    },
  );

  it('lists of numbers only filter on emptiness; attachments too', () => {
    const nums = COLUMNS.find((column) => column.name === 'nums') as Column;
    const files = COLUMNS.find((column) => column.name === 'files') as Column;
    expect([...allowedOperators(fieldProfile(metaOf(nums, 'stored')), 'standard')].sort()).toEqual([
      'is_empty',
      'is_not_empty',
    ]);
    expect([...allowedOperators(fieldProfile(metaOf(files, 'stored')), 'standard')].sort()).toEqual(
      ['is_empty', 'is_not_empty'],
    );
  });
});
