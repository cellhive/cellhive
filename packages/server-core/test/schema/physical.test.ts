import { getFieldType, type S1FieldType } from '@cellhive/field-types';
import {
  Kysely,
  PostgresAdapter,
  DummyDriver,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  autoNumberCells,
  expectedColumnOf,
  planColumn,
  type PhysicalField,
} from '../../src/schema/index.js';
import {
  addColumnSql,
  createIndexSql,
  createTableSql,
  singleValueCheckSql,
} from '../../src/schema/physical.js';

const kysely = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const TABLE = 't_aaaaaaaaaaaa';
const COLUMN = 'f_bbbbbbbbbbbb';

function field(type: S1FieldType, options: unknown = {}, extra: Partial<PhysicalField> = {}) {
  const definition = getFieldType(type);
  if (definition === undefined) throw new Error(type);
  return {
    type,
    options: definition.optionsSchema.parse(options),
    column: COLUMN,
    isPrimary: false,
    uniqueValues: false,
    ...extra,
  } satisfies PhysicalField;
}

describe('planColumn', () => {
  it.each([
    { type: 'text', options: {}, pgType: 'text COLLATE "vi-VN-x-icu"', indexes: [] },
    { type: 'auto_number', options: {}, pgType: 'text COLLATE "vi-VN-x-icu"', indexes: [] },
    { type: 'number', options: {}, pgType: 'numeric', indexes: [] },
    {
      type: 'datetime',
      options: { style: { format: 'dd/MM/yyyy' } },
      pgType: 'date',
      indexes: [],
    },
    {
      type: 'datetime',
      options: { style: { format: 'dd/MM/yyyy HH:mm' } },
      pgType: 'timestamptz',
      indexes: [],
    },
    { type: 'checkbox', options: {}, pgType: 'boolean NOT NULL DEFAULT false', indexes: [] },
    { type: 'select', options: {}, pgType: 'text[]', indexes: ['gin'] },
    { type: 'user', options: {}, pgType: 'text[]', indexes: ['gin'] },
  ] as const)('$type $options → $pgType', ({ type, options, pgType, indexes }) => {
    const plan = planColumn(field(type, options), TABLE, 'vi-VN-x-icu');
    expect(plan?.pgType).toBe(pgType);
    expect(plan?.indexes.map((index) => index.kind)).toEqual(indexes);
  });

  it('has no column for system types', () => {
    for (const type of ['created_at', 'updated_at', 'created_by', 'updated_by'] as const) {
      expect(planColumn(field(type), TABLE, 'und-x-icu')).toBeNull();
    }
  });

  it('adds a single-value CHECK only for select/user with multiple = false', () => {
    expect(planColumn(field('select'), TABLE, 'und-x-icu')?.singleValue).toBe(true);
    expect(planColumn(field('select', { multiple: true }), TABLE, 'und-x-icu')?.singleValue).toBe(
      false,
    );
    expect(planColumn(field('user'), TABLE, 'und-x-icu')?.singleValue).toBe(false);
    expect(planColumn(field('user', { multiple: false }), TABLE, 'und-x-icu')?.singleValue).toBe(
      true,
    );
  });

  it('indexes the primary text field with trigrams and unique fields with a partial index', () => {
    const primary = planColumn(
      field('text', {}, { isPrimary: true, uniqueValues: true }),
      TABLE,
      'und-x-icu',
    );
    expect(primary?.indexes).toEqual([
      { name: `${TABLE}_${COLUMN}_trgm`, kind: 'trgm' },
      { name: `${TABLE}_${COLUMN}_uniq`, kind: 'uniq' },
    ]);
    expect(() =>
      planColumn(field('checkbox', {}, { uniqueValues: true }), TABLE, 'und-x-icu'),
    ).toThrow(TypeError);
  });

  it('refuses collations that could escape the quoted identifier', () => {
    expect(() => planColumn(field('text'), TABLE, 'x" ; DROP TABLE t; --')).toThrow(TypeError);
  });

  it('maps column types to what information_schema reports', () => {
    expect(expectedColumnOf('text COLLATE "und-x-icu"')).toEqual({
      dataType: 'text',
      udtName: 'text',
      collation: 'und-x-icu',
      notNull: false,
    });
    expect(expectedColumnOf('text[]').udtName).toBe('_text');
    expect(expectedColumnOf('boolean NOT NULL DEFAULT false').notNull).toBe(true);
    expect(() => expectedColumnOf('text; DROP TABLE x')).toThrow(TypeError);
  });
});

describe('DDL text', () => {
  const compile = (builder: { compile(db: Kysely<Record<string, never>>): { sql: string } }) =>
    builder.compile(kysely).sql;

  it('quotes every identifier and uses the trigram expression of the filter compiler', () => {
    const plan = planColumn(field('text', {}, { isPrimary: true }), TABLE, 'und-x-icu');
    if (plan === null) throw new Error('plan');
    expect(compile(createTableSql(TABLE))).toContain(`CREATE TABLE "data"."${TABLE}"`);
    expect(compile(addColumnSql(TABLE, plan))).toBe(
      `ALTER TABLE "data"."${TABLE}" ADD COLUMN "${COLUMN}" text COLLATE "und-x-icu"`,
    );
    expect(
      compile(createIndexSql(TABLE, COLUMN, plan.indexes[0] ?? { name: '', kind: 'gin' })),
    ).toBe(
      `CREATE INDEX "${TABLE}_${COLUMN}_trgm" ON "data"."${TABLE}" USING gin (meta.f_unaccent(lower("${COLUMN}")) public.gin_trgm_ops)`,
    );
    expect(compile(singleValueCheckSql(TABLE, COLUMN))).toBe(
      `ALTER TABLE "data"."${TABLE}" ADD CONSTRAINT "${COLUMN}_single" CHECK (cardinality("${COLUMN}") <= 1)`,
    );
  });

  it('refuses identifiers that are not meta short-id names', () => {
    expect(() => createTableSql('t_x"; DROP')).toThrow(TypeError);
    expect(() => singleValueCheckSql(TABLE, 'f_"x"')).toThrow(TypeError);
  });
});

describe('autoNumberCells', () => {
  it('formats every active auto_number column and ignores the rest', () => {
    const cells = autoNumberCells(
      [
        {
          type: 'auto_number',
          options: {
            style: {
              rules: [
                { type: 'text', text: 'TK-' },
                { type: 'created_time', date_format: 'yyyyMMdd' },
                { type: 'text', text: '-' },
                { type: 'incremental_number', length: 4 },
              ],
            },
          },
          db_column_name: 'f_aaaaaaaaaaaa',
          deleted_at: null,
        },
        { type: 'auto_number', options: {}, db_column_name: 'f_bbbbbbbbbbbb', deleted_at: null },
        {
          type: 'auto_number',
          options: {},
          db_column_name: 'f_cccccccccccc',
          deleted_at: new Date(),
        },
        { type: 'text', options: {}, db_column_name: 'f_dddddddddddd', deleted_at: null },
      ],
      { autoValue: 42n, createdAt: new Date('2026-09-20T18:00:00Z'), timeZone: 'Asia/Ho_Chi_Minh' },
    );
    expect(cells).toEqual({ f_aaaaaaaaaaaa: 'TK-20260921-0042', f_bbbbbbbbbbbb: 'NO.042' });
  });
});
