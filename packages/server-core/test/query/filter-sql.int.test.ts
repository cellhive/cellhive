/**
 * Equivalence harness (SPEC §6.3, BACKLOG T105): for every field type ×
 * operator × operand of the fixture, plus random nested and/or/not trees and
 * variables in several time zones, `SELECT __id … WHERE compileToSql(…)`
 * must return exactly the records `evaluate` accepts.
 *
 * The database is migrated by the real migrator and the data table is
 * created by `SchemaService` (T102), so the columns, collations and indexes
 * are the production ones.
 */
import {
  createEvaluator,
  foldText,
  resolveVariables,
  unaccent,
  validateFilter,
  type EvaluateRecord,
  type FilterNode,
  type ResolveContext,
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
  buildCases,
  buildRecords,
  buildTrees,
  COLLATION,
  columnOf,
  FIELD_LIST,
  fields,
  RECORD_COUNT,
  tableMeta,
  TEXTS,
  usr,
  visibleFieldIds,
  type FilterCase,
} from './filter-fixture.js';

import type { FieldRow } from '../../src/db/schema.js';

const DATE_OID = 1082;

/** node-pg parsers, except `date` which stays text (the evaluator input contract). */
function typeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
  if (oid === DATE_OID) return (value) => value;
  return pg.types.getTypeParser(oid, format ?? 'text') as (value: string) => unknown;
}

const ORG = 'org_T105Harness00001';
const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

interface Context {
  readonly name: string;
  readonly resolve: ResolveContext;
}

const CONTEXTS: readonly Context[] = [
  {
    name: 'New York, DST start day, user an',
    resolve: {
      userId: usr.an,
      groupMemberUserIds: [usr.an, usr.binh, usr.chi],
      timeZone: 'America/New_York',
      now: new Date('2026-03-08T15:00:00.000Z'),
    },
  },
  {
    name: 'Ho Chi Minh, 2026-11-01 10:00, user binh',
    resolve: {
      userId: usr.binh,
      groupMemberUserIds: [usr.binh, usr.giang],
      timeZone: 'Asia/Ho_Chi_Minh',
      now: new Date('2026-11-01T03:00:00.000Z'),
    },
  },
  {
    name: 'New York, repeated hour of DST end, anonymous',
    resolve: {
      userId: null,
      groupMemberUserIds: [],
      timeZone: 'America/New_York',
      now: new Date('2026-11-01T05:45:00.000Z'),
    },
  },
];

describe('filter SQL compiler ≡ evaluator (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let appDb: Db;
  let pool: pg.Pool;
  let db: Kysely<Record<string, never>>;
  let records: { id: string; values: EvaluateRecord }[];
  /** `data.t_…` created by SchemaService. */
  let tableName: string;
  /** Fixture meta with the physical columns SchemaService chose. */
  let sqlMeta: SqlFilterTableMeta;
  let primaryColumn: string;

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
      { baseId, name: 'Harness', primaryFieldName: fields.title.name },
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
    expect(await schema.checkConsistency(scope, created.table.id)).toEqual([]);
    const physical = (id: string) => real.get(id)?.db_column_name ?? null;
    primaryColumn = physical(fields.title.id) as string;
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

    // Test data goes straight into the table (RecordMutationService is T107).
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

    // Evaluator input = what the database returns, keyed by field id.
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

  async function sqlIds(filter: ReturnType<typeof compileToSql>): Promise<string[]> {
    const result = await sql<{
      __id: string;
    }>`SELECT __id FROM ${sql.id('data', tableName)} WHERE ${filter} ORDER BY __id`.execute(db);
    return result.rows.map((row) => row.__id);
  }

  interface Outcome {
    readonly name: string;
    readonly sql: string[];
    readonly evaluated: string[];
  }

  async function runCases(cases: readonly FilterCase[], context: Context): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    for (const testCase of cases) {
      const validated = validateFilter(testCase.filter, tableMeta, visibleFieldIds);
      if (!validated.ok) {
        throw new Error(
          `Fixture case is invalid: ${testCase.name} ${JSON.stringify(validated.errors)}`,
        );
      }
      const resolved = resolveVariables(validated.ast, context.resolve);
      const matches = createEvaluator(resolved, { table: tableMeta });
      outcomes.push({
        name: testCase.name,
        sql: await sqlIds(compileToSql(resolved, sqlMeta)),
        evaluated: records.filter((record) => matches(record.values)).map((record) => record.id),
      });
    }
    return outcomes;
  }

  function expectEquivalent(outcomes: readonly Outcome[]) {
    const mismatches = outcomes
      .filter((outcome) => outcome.sql.join() !== outcome.evaluated.join())
      .map((outcome) => ({
        name: outcome.name,
        onlySql: outcome.sql.filter((id) => !outcome.evaluated.includes(id)),
        onlyEvaluate: outcome.evaluated.filter((id) => !outcome.sql.includes(id)),
      }));
    expect(mismatches.slice(0, 20)).toEqual([]);
  }

  it(`stores ${String(RECORD_COUNT)} fixture records`, () => {
    expect(records).toHaveLength(RECORD_COUNT);
  });

  const flat = buildCases();

  it('covers every field × allowed operator', () => {
    const covered = new Set(flat.map((testCase) => testCase.name.split(' ').slice(0, 2).join(' ')));
    // 19 fields; e.g. text 8 operators, number 9, datetime 8, checkbox 1, select 6.
    expect(covered.size).toBeGreaterThanOrEqual(120);
    expect(flat.length).toBeGreaterThan(1000);
  });

  describe.each(CONTEXTS)('$name', (context) => {
    it('every type × operator × operand', async () => {
      const outcomes = await runCases(flat, context);
      expectEquivalent(outcomes);
      // The fixture must discriminate: most cases match some but not all records.
      const partial = outcomes.filter(
        (outcome) => outcome.sql.length > 0 && outcome.sql.length < RECORD_COUNT,
      );
      expect(partial.length / outcomes.length).toBeGreaterThan(0.6);
    });

    it('nested and/or/not trees', async () => {
      expectEquivalent(await runCases(buildTrees(flat, 300, 7), context));
    });
  });

  it('values with quotes and LIKE metacharacters are data, not SQL', async () => {
    const hostile = [
      "'; DROP TABLE data.t_t105harness1; --",
      "') OR 1=1 --",
      '%',
      '_',
      '\\',
      '%_\\',
      '$1',
      "E'\\x27'",
    ];
    for (const value of hostile) {
      for (const operator of [
        'eq',
        'neq',
        'contains',
        'not_contains',
        'starts_with',
        'ends_with',
      ] as const) {
        const filter: FilterNode = { field: fields.title.id, operator, value };
        const validated = validateFilter(filter, tableMeta, visibleFieldIds);
        expect(validated.ok).toBe(true);
        if (!validated.ok) continue;
        const resolved = resolveVariables(validated.ast, CONTEXTS[0]?.resolve as ResolveContext);
        const compiled = compileToSql(resolved, sqlMeta).compile(db);
        // Short values ('%', '_', '\\', '$1') also occur in the constant SQL text.
        if (value.length > 3) expect(compiled.sql).not.toContain(value);
        expect(compiled.parameters).toContain(value);
        const matches = createEvaluator(resolved, { table: tableMeta });
        expect(await sqlIds(compileToSql(resolved, sqlMeta))).toEqual(
          records.filter((record) => matches(record.values)).map((record) => record.id),
        );
      }
    }
    // `contains '%'` matches only values with a literal percent sign.
    const percent = await sqlIds(
      compileToSql({ field: fields.title.id, operator: 'contains', value: '%' }, sqlMeta),
    );
    const withPercent = records.filter((record) => {
      const title = record.values[fields.title.id];
      return typeof title === 'string' && unaccent(title).includes('%');
    });
    expect(percent).toEqual(withPercent.map((record) => record.id));
    expect(percent.length).toBeGreaterThan(0);
    expect(percent.length).toBeLessThan(RECORD_COUNT);

    const table = await pool.query<{ exists: boolean; count: string }>(
      `SELECT to_regclass('data.${tableName}') IS NOT NULL AS exists, (SELECT count(*) FROM data.${quoteIdent(tableName)}) AS count`,
    );
    expect(table.rows[0]).toEqual({ exists: true, count: String(RECORD_COUNT) });
  });

  it('the planner can use the trigram index for compiled primary-field text filters', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      for (const operator of ['contains', 'starts_with', 'ends_with', 'eq'] as const) {
        const compiled = compileToSql(
          { field: fields.title.id, operator, value: 'nguyen' },
          sqlMeta,
        ).compile(db);
        const plan = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT __id FROM data.${quoteIdent(tableName)} WHERE ${compiled.sql}`,
          [...compiled.parameters],
        );
        const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
        expect(text, operator).toContain(`${tableName}_${primaryColumn}_trgm`);
      }
      // auto_number columns carry the base collation too: no COLLATE in the folded column.
      const code = compileToSql(
        { field: fields.code.id, operator: 'contains', value: 'no' },
        sqlMeta,
      ).compile(db);
      expect(code.sql).not.toMatch(/lower\("f_[0-9a-z]{12}" COLLATE/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('unaccent in TypeScript equals meta.f_unaccent for every code point up to U+1FFFF', async () => {
    const chars: string[] = [];
    for (let code = 1; code <= 0x1ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      chars.push(String.fromCodePoint(code));
    }
    const result = await pool.query<{ u: string }>(
      'SELECT meta.f_unaccent(c) AS u FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n',
      [chars],
    );
    const differences = chars.filter((char, index) => unaccent(char) !== result.rows[index]?.u);
    expect(differences.map((char) => char.codePointAt(0)?.toString(16))).toEqual([]);
  });

  it('foldText equals meta.f_unaccent(lower(x)) under the base collation', async () => {
    const samples = [
      ...TEXTS.filter((text): text is string => text !== null),
      'ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬĐÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ',
      'àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ',
      'The Quick Brown Fox ÆØÅ ÇÑ ŞĞ ŁŃŚŹŻ ĄĘ ŐŰ ÐÞ ß ẞ ǄǅǆǇǈǉ',
    ];
    // Every Latin, Greek and Cyrillic letter, one by one.
    for (let code = 0x41; code <= 0x52f; code += 1) samples.push(String.fromCodePoint(code));
    for (let code = 0x1e00; code <= 0x1fff; code += 1) samples.push(String.fromCodePoint(code));
    const result = await pool.query<{ f: string }>(
      `SELECT meta.f_unaccent(lower(c COLLATE "${COLLATION}")) AS f
       FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n`,
      [samples],
    );
    const differences = samples
      .filter((text, index) => foldText(text) !== result.rows[index]?.f)
      .map((text) => ({ text, ts: foldText(text) }));
    expect(differences).toEqual([]);
  });
});
