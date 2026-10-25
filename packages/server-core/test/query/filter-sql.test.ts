import {
  resolveVariables,
  validateFilter,
  type DslOperator,
  type ResolvedFilterNode,
  type ResolvedValue,
} from '@cellhive/filter-dsl';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RawBuilder,
  type SqlBool,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  compileToSql,
  FilterCompileError,
  type SqlFilterTableMeta,
} from '../../src/query/index.js';

import {
  buildCases,
  buildTrees,
  fields,
  fixedId,
  opt,
  tableMeta,
  usr,
  visibleFieldIds,
} from './filter-fixture.js';

/** Compiles without a database. */
const db = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const compile = (expression: RawBuilder<SqlBool>) => expression.compile(db);

const cond = (field: string, operator: DslOperator, value?: ResolvedValue): ResolvedFilterNode =>
  (value === undefined ? { field, operator } : { field, operator, value }) as ResolvedFilterNode;

const SEP23 = {
  $range: {
    start: '2026-09-22T17:00:00.000Z',
    end: '2026-09-23T17:00:00.000Z',
    start_date: '2026-09-23',
    end_date: '2026-09-24',
  },
};

describe('compileToSql: SQL shape', () => {
  it.each([
    {
      name: 'text contains: folded column LIKE escaped folded parameter',
      node: cond(fields.title.id, 'contains', 'Đào'),
      sql: `("f_title0000000" IS NOT NULL AND meta.f_unaccent(lower("f_title0000000")) LIKE '%' || replace(replace(replace(meta.f_unaccent(lower($1::text COLLATE "vi-VN-x-icu")), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\')`,
      parameters: ['Đào'],
    },
    {
      name: 'text neq: complement of eq',
      node: cond(fields.title.id, 'neq', 'x'),
      sql: `(NOT ("f_title0000000" IS NOT NULL AND meta.f_unaccent(lower("f_title0000000")) = meta.f_unaccent(lower($1::text COLLATE "vi-VN-x-icu"))))`,
      parameters: ['x'],
    },
    {
      name: 'auto_number folds its column like text (the column carries the base collation)',
      node: cond(fields.code.id, 'starts_with', 'no.'),
      sql: `("f_code00000000" IS NOT NULL AND meta.f_unaccent(lower("f_code00000000")) LIKE replace(replace(replace(meta.f_unaccent(lower($1::text COLLATE "vi-VN-x-icu")), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\')`,
      parameters: ['no.'],
    },
    {
      name: 'text is_not_empty',
      node: cond(fields.title.id, 'is_not_empty'),
      sql: `(NOT ("f_title0000000" IS NULL OR "f_title0000000" = ''))`,
      parameters: [],
    },
    {
      name: 'number between: numeric parameters',
      node: cond(fields.amount.id, 'between', [0.1, 1e21]),
      sql: `("f_amount000000" IS NOT NULL AND "f_amount000000" >= $1::numeric AND "f_amount000000" <= $2::numeric)`,
      parameters: ['0.1', '1e+21'],
    },
    {
      name: 'number gt',
      node: cond(fields.amount.id, 'gt', -0),
      sql: `("f_amount000000" IS NOT NULL AND "f_amount000000" > $1::numeric)`,
      parameters: ['0'],
    },
    {
      name: 'date-only datetime uses start_date/end_date',
      node: cond(fields.due.id, 'is', SEP23),
      sql: `("f_due000000000" IS NOT NULL AND "f_due000000000" >= $1::date AND "f_due000000000" < $2::date)`,
      parameters: ['2026-09-23', '2026-09-24'],
    },
    {
      name: 'timestamp datetime uses start/end',
      node: cond(fields.dueNy.id, 'on_or_after', SEP23),
      sql: `("f_dueny0000000" IS NOT NULL AND "f_dueny0000000" >= $1::timestamptz)`,
      parameters: ['2026-09-22T17:00:00.000Z'],
    },
    {
      name: 'created_at reads __created_at',
      node: cond(fields.created.id, 'between', [SEP23, SEP23]),
      sql: `("__created_at" IS NOT NULL AND "__created_at" >= $1::timestamptz AND "__created_at" < $2::timestamptz)`,
      parameters: ['2026-09-22T17:00:00.000Z', '2026-09-23T17:00:00.000Z'],
    },
    {
      name: 'checkbox is true: no parameter at all',
      node: cond(fields.done.id, 'is', true),
      sql: `("f_done00000000" IS TRUE)`,
      parameters: [],
    },
    {
      name: 'checkbox is false',
      node: cond(fields.done.id, 'is', false),
      sql: `("f_done00000000" IS NOT TRUE)`,
      parameters: [],
    },
    {
      name: 'single select is',
      node: cond(fields.status.id, 'is', opt.done),
      sql: `("f_status000000" IS NOT NULL AND "f_status000000" @> $1::text[])`,
      parameters: [[opt.done]],
    },
    {
      name: 'single select is_none_of',
      node: cond(fields.status.id, 'is_none_of', [opt.new, opt.done]),
      sql: `(NOT ("f_status000000" IS NOT NULL AND "f_status000000" && $1::text[]))`,
      parameters: [[opt.new, opt.done]],
    },
    {
      name: 'multi select is_exactly',
      node: cond(fields.tags.id, 'is_exactly', [opt.a, opt.b, opt.a]),
      sql: `("f_tags00000000" IS NOT NULL AND "f_tags00000000" @> $1::text[] AND "f_tags00000000" <@ $2::text[])`,
      parameters: [
        [opt.a, opt.b],
        [opt.a, opt.b],
      ],
    },
    {
      name: 'multi is_empty covers NULL and {}',
      node: cond(fields.tags.id, 'is_empty'),
      sql: `("f_tags00000000" IS NULL OR cardinality("f_tags00000000") = 0)`,
      parameters: [],
    },
    {
      name: 'user has_all_of',
      node: cond(fields.owners.id, 'has_all_of', [usr.an]),
      sql: `("f_owners000000" IS NOT NULL AND "f_owners000000" @> $1::text[])`,
      parameters: [[usr.an]],
    },
    {
      name: 'has_any_of [] (no current user) matches nothing',
      node: cond(fields.owners.id, 'has_any_of', []),
      sql: 'false',
      parameters: [],
    },
    {
      name: 'has_none_of [] matches everything',
      node: cond(fields.owners.id, 'has_none_of', []),
      sql: '(NOT false)',
      parameters: [],
    },
    {
      name: 'created_by (scalar text) has_any_of',
      node: cond(fields.creator.id, 'has_any_of', [usr.an, usr.binh]),
      sql: `("__created_by" IS NOT NULL AND "__created_by" = ANY($1::text[]))`,
      parameters: [[usr.an, usr.binh]],
    },
    {
      name: 'updated_by (scalar text) is_exactly',
      node: cond(fields.updater.id, 'is_exactly', [usr.an]),
      sql: `("__updated_by" IS NOT NULL AND "__updated_by" = ALL($1::text[]))`,
      parameters: [[usr.an]],
    },
    {
      name: 'created_by is_empty',
      node: cond(fields.creator.id, 'is_empty'),
      sql: `("__created_by" IS NULL OR "__created_by" = '')`,
      parameters: [],
    },
    {
      name: 'groups',
      node: {
        op: 'or',
        items: [
          { op: 'not', item: cond(fields.done.id, 'is', true) },
          { op: 'and', items: [] },
          { op: 'or', items: [] },
        ],
      } as ResolvedFilterNode,
      sql: `((NOT ("f_done00000000" IS TRUE)) OR true OR false)`,
      parameters: [],
    },
  ])('$name', ({ node, sql, parameters }) => {
    const compiled = compile(compileToSql(node, tableMeta));
    expect(compiled.sql).toBe(sql);
    expect(compiled.parameters).toEqual(parameters);
  });

  it('works without a base collation (database default)', () => {
    const compiled = compile(
      compileToSql(cond(fields.title.id, 'eq', 'x'), { fields: tableMeta.fields }),
    );
    expect(compiled.sql).toBe(
      `("f_title0000000" IS NOT NULL AND meta.f_unaccent(lower("f_title0000000")) = meta.f_unaccent(lower($1::text)))`,
    );
  });

  it('qualifies columns with a table alias', () => {
    const compiled = compile(
      compileToSql(cond(fields.amount.id, 'is_empty'), tableMeta, { tableAlias: 't' }),
    );
    expect(compiled.sql).toBe(`("t"."f_amount000000" IS NULL)`);
  });
});

describe('compileToSql: identifiers come from meta, values are parameters', () => {
  it('quotes a hostile db_column_name, collation and alias as identifiers', () => {
    const hostile: SqlFilterTableMeta = {
      collation: 'x" ) OR 1=1 --',
      fields: [{ ...fields.title, dbColumnName: 'f_x"; DROP TABLE data.t_abc; --' }],
    };
    const compiled = compile(
      compileToSql(cond(fields.title.id, 'eq', 'v'), hostile, { tableAlias: 'a"b' }),
    );
    expect(compiled.sql).toContain('"a""b"."f_x""; DROP TABLE data.t_abc; --"');
    expect(compiled.sql).toContain('COLLATE "x"" ) OR 1=1 --"');
    expect(compiled.parameters).toEqual(['v']);
  });

  it('never puts an operand into the SQL text (every fixture case and tree)', () => {
    const flat = buildCases();
    const cases = [...flat, ...buildTrees(flat, 200, 11)];
    let checked = 0;
    for (const testCase of cases) {
      const validated = validateFilter(testCase.filter, tableMeta, visibleFieldIds);
      expect(validated.ok).toBe(true);
      if (!validated.ok) continue;
      const resolved = resolveVariables(validated.ast, {
        userId: usr.an,
        groupMemberUserIds: [usr.an, usr.binh],
        timeZone: 'Asia/Ho_Chi_Minh',
        now: new Date('2026-09-23T03:00:00Z'),
      });
      const compiled = compile(compileToSql(resolved, tableMeta));
      const strings = compiled.parameters
        .flatMap((parameter) => (Array.isArray(parameter) ? (parameter as unknown[]) : [parameter]))
        .filter((parameter): parameter is string => typeof parameter === 'string');
      // Short operands ('%', '_', '\\', 'x'…) also occur in the constant SQL text.
      for (const value of strings.filter((text) => text.length >= 4)) {
        expect(compiled.sql).not.toContain(value);
      }
      // Only $n placeholders and constant literals reach the SQL.
      const literals = compiled.sql.match(/'(?:[^']|'')*'/g) ?? [];
      expect(new Set(literals)).toSatisfy((set: Set<string>) =>
        [...set].every((literal) =>
          ["'%'", "''", "'\\'", "'\\\\'", "'\\%'", "'_'", "'\\_'"].includes(literal),
        ),
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2000);
  });
});

describe('compileToSql: rejects what it must never receive', () => {
  const linkTable: SqlFilterTableMeta = {
    fields: [
      { id: fixedId('fld', 'link'), name: 'link', type: 'link', dbColumnName: 'f_link00000000' },
      {
        id: fixedId('fld', 'formula'),
        name: 'formula',
        type: 'formula',
        dbColumnName: 'f_formula00000',
      },
      {
        id: fixedId('fld', 'stored'),
        name: 'stored',
        type: 'formula',
        resultType: 'number',
        dbColumnName: 'f_stored000000',
      },
      { id: fixedId('fld', 'nocol'), name: 'nocol', type: 'text' },
    ],
  };

  it.each([
    { name: 'changed (automation only)', node: cond(fields.title.id, 'changed') },
    { name: 'changed_to (automation only)', node: cond(fields.status.id, 'changed_to', opt.done) },
    {
      name: 'changed_from (automation only)',
      node: cond(fields.status.id, 'changed_from', opt.done),
    },
    { name: 'intersects (lookup, S4b)', node: cond(fields.tags.id, 'intersects', [opt.a]) },
    { name: 'disjoint (lookup, S4b)', node: cond(fields.tags.id, 'disjoint', [opt.a]) },
    {
      name: 'field_ref (lookup, S4b)',
      node: cond(fields.title.id, 'eq', { field_ref: fields.phone.id }),
    },
    { name: 'unknown field', node: cond(fixedId('fld', 'nope'), 'eq', 'x') },
    { name: 'operator not allowed for the type', node: cond(fields.title.id, 'gt', 'x') },
    { name: 'unresolved date operand', node: cond(fields.due.id, 'is', '2026-09-23') },
    { name: 'date between with one operand', node: cond(fields.due.id, 'between', [SEP23]) },
    { name: 'number as a string', node: cond(fields.amount.id, 'eq', '1') },
    { name: 'non-finite number', node: cond(fields.amount.id, 'eq', Number.POSITIVE_INFINITY) },
    { name: 'text without a string', node: cond(fields.title.id, 'contains', 1) },
    { name: 'checkbox without a boolean', node: cond(fields.done.id, 'is', 'true') },
    { name: 'list with a non-id', node: cond(fields.tags.id, 'has_any_of', [1]) },
  ])('$name', ({ node }) => {
    expect(() => compileToSql(node, tableMeta)).toThrow(FilterCompileError);
  });

  it.each([
    { name: 'link field (S4)', field: fixedId('fld', 'link'), operator: 'is_empty' as const },
    {
      name: 'formula field without a result type',
      field: fixedId('fld', 'formula'),
      operator: 'is_empty' as const,
    },
    {
      name: 'field without db_column_name',
      field: fixedId('fld', 'nocol'),
      operator: 'is_empty' as const,
    },
  ])('$name', ({ field, operator }) => {
    expect(() => compileToSql(cond(field, operator), linkTable)).toThrow(FilterCompileError);
  });

  it('a formula with a result type filters its column like its result (T457)', () => {
    const compiled = compile(
      compileToSql(cond(fixedId('fld', 'stored'), 'gt', 5), linkTable, { tableAlias: 't' }),
    );
    expect(compiled.sql).toContain('"t"."f_stored000000" >');
    expect(compiled.parameters).toEqual(['5']);
  });
});
