/**
 * Support of the formula SQL harness (BACKLOG T454): a real data table
 * created by `SchemaService` from the fixture's fields, one row per case,
 * and value comparison (numbers as decimals, dates as ISO text).
 */
import { compareDecimal, parseDecimal } from '@cellhive/filter-dsl';
import { analyze, type FormulaType, type SchemaSnapshot } from '@cellhive/formula-engine';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { compileAnalysis, snapshotTableOf, type CompiledFormula } from '../../src/formula/index.js';
import { buildTableModel, type TableModel } from '../../src/records/table-model.js';
import { SchemaService } from '../../src/schema/index.js';
import { createTestDb, migrateAll, type TestDatabase } from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import type { FormulaFixture, FormulaFixtureCase } from './fixture-types.js';
import type { FieldRow } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

const TEXT_ARRAY_OID = 1009;
/** `date`, `date[]` and `numeric[]` stay text (no JS Date/float rounding). */
const TEXT_TYPES = new Map<number, number | null>([
  [1082, null],
  [1182, TEXT_ARRAY_OID],
  [1231, TEXT_ARRAY_OID],
]);

function typeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
  if (TEXT_TYPES.has(oid)) {
    const as = TEXT_TYPES.get(oid) ?? null;
    return as === null
      ? (value) => value
      : (pg.types.getTypeParser(as, 'text') as (v: string) => unknown);
  }
  return pg.types.getTypeParser(oid, format ?? 'text') as (value: string) => unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- data tables have no static schema
export type AnyKysely = Kysely<any>;

/** A single-connection Kysely (session settings stick) with text dates and decimals. */
export function harnessKysely(url: string): { db: AnyKysely; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    types: { getTypeParser: typeParser as typeof pg.types.getTypeParser },
  });
  return { db: new Kysely({ dialect: new PostgresDialect({ pool }) }), pool };
}

export interface HarnessTable {
  readonly model: TableModel;
  readonly snapshot: SchemaSnapshot;
  /** `data.t_…` of the table. */
  readonly tableName: string;
  readonly schema: SchemaService;
  readonly tableId: Id<'tbl'>;
}

/** Creates the fixture's table through `SchemaService` (real columns, collations, options). */
export async function createHarnessTable(
  appDb: Db,
  database: TestDatabase,
  orgId: Id<'org'>,
  fixture: FormulaFixture,
  tableName = 'Formula harness',
): Promise<HarnessTable> {
  await migrateAll(database.url, appDb);
  const { baseId } = await seedTenant(appDb, orgId);
  const schema = new SchemaService(appDb, { maxFieldsPerTable: 500 });
  const scope = orgScope(orgId);
  const context = systemAuditContext();
  const [primary, ...rest] = fixture.fields;
  if (primary === undefined) throw new Error('The fixture has no field');
  const created = await schema.createTable(
    scope,
    { baseId, name: tableName, primaryFieldName: primary.name },
    context,
  );
  const rows: FieldRow[] = [created.primaryField];
  for (const field of rest) {
    rows.push(
      await schema.addField(
        scope,
        created.table.id,
        { name: field.name, type: field.type, options: field.options ?? {} },
        context,
      ),
    );
  }
  const model = buildTableModel(created.table, rows, null);
  return {
    model,
    snapshot: { tableId: created.table.id, tables: [snapshotTableOf(model)] },
    tableName: created.table.db_table_name,
    schema,
    tableId: created.table.id,
  };
}

/** Column value of a fixture row value (select names → option ids, attachments → JSON). */
function storageValue(table: HarnessTable, name: string, value: unknown): unknown {
  const field = table.model.fields.find((item) => item.name === name);
  if (field === undefined) throw new Error(`Unknown fixture field ${name}`);
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'select': {
      const options = (field.options as { options: { id: string; name: string }[] }).options;
      const names = Array.isArray(value) ? (value as string[]) : [value as string];
      return names.map((item) => {
        const option = options.find((candidate) => candidate.name === item);
        if (option === undefined) throw new Error(`Unknown option ${item} of ${name}`);
        return option.id;
      });
    }
    case 'attachment':
      return JSON.stringify(value);
    case 'number':
      return typeof value === 'number' ? String(value) : value;
    default:
      return value;
  }
}

export const recordId = (index: number): string => `rec_${String(index).padStart(16, '0')}`;

/** Inserts one row per case (the case's `rowId`, else `rec_…` ids in case order). */
export async function insertCaseRows(
  db: AnyKysely,
  table: HarnessTable,
  cases: readonly FormulaFixtureCase[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const [index, item] of cases.entries()) {
    const id = item.rowId ?? recordId(index);
    ids.set(item.name, id);
    const entries = Object.entries(item.row ?? {});
    const columns = [
      sql.id('__id'),
      ...entries.map(([name]) => {
        const field = table.model.fields.find((candidate) => candidate.name === name);
        return sql.id(field?.column ?? name);
      }),
    ];
    const values = [
      sql.val(id),
      ...entries.map(([name, value]) => sql.val(storageValue(table, name, value))),
    ];
    await sql`INSERT INTO ${sql.id('data', table.tableName)} (${sql.join(columns)}) VALUES (${sql.join(values)})`.execute(
      db,
    );
  }
  return ids;
}

/** Analyses (display form) and compiles one case; throws on analysis errors. */
export function compileCase(table: HarnessTable, item: FormulaFixtureCase): CompiledFormula {
  const analysis = analyze(item.formula, table.snapshot, { form: 'display' });
  if (analysis.errors.length > 0) {
    throw new Error(
      `${item.name}: ${analysis.errors.map((error) => `${error.code} ${error.message}`).join('; ')}`,
    );
  }
  return compileAnalysis(analysis, {
    fields: table.model.fields,
    timeZone: item.tz,
    now: new Date(item.now),
  });
}

const isCalendar = (type: FormulaType): boolean => {
  const kind = type.kind === 'list' ? type.element.kind : type.kind;
  return kind === 'date' || kind === 'datetime';
};

/**
 * The compiled value of a row. Dates and datetimes go through `to_json`
 * (ISO 8601 whatever `DateStyle`), so the wire format of the session does
 * not change what the harness compares.
 */
export async function selectValue(
  db: AnyKysely,
  table: HarnessTable,
  compiled: CompiledFormula,
  id: string,
): Promise<unknown> {
  const value = isCalendar(compiled.type) ? sql`to_json(${compiled.sql})::text` : compiled.sql;
  const { rows } = await sql<{
    v: unknown;
  }>`SELECT ${value} AS v FROM ${sql.id('data', table.tableName)} WHERE __id = ${id}`.execute(db);
  const out = rows[0]?.v;
  return isCalendar(compiled.type) && typeof out === 'string' ? (JSON.parse(out) as unknown) : out;
}

// ---------------------------------------------------------------------------
// Comparison

function sameNumber(actual: unknown, expected: unknown): boolean {
  const a = parseDecimal(actual);
  const b = parseDecimal(expected);
  if (a === null || b === null) return false;
  if (compareDecimal(a, b) === 0) return true;
  // Irrational results (SQRT, EXP, LN, 1/3…) differ past the 15th digit
  // between numeric and double: compare 12 significant digits.
  const digits = (value: typeof a) => (value.kind === 'finite' ? value.digits.length : 0);
  if (Math.max(digits(a), digits(b)) <= 15) return false;
  const round = (value: unknown) => Number(value).toPrecision(12);
  return round(actual) === round(expected);
}

function sameScalar(kind: string, actual: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  switch (kind) {
    case 'number':
      return sameNumber(actual, expected);
    case 'datetime':
      return (
        typeof actual === 'string' &&
        new Date(actual).toISOString() === new Date(expected as string).toISOString()
      );
    case 'attachment':
      return JSON.stringify(actual) === JSON.stringify(expected);
    default:
      return actual === expected;
  }
}

/** SQL result ≡ expected value for the formula's result type (an empty list ≡ NULL). */
export function sameValue(type: FormulaType, actual: unknown, expected: unknown): boolean {
  if (type.kind === 'list') {
    const a = (actual ?? []) as unknown[];
    const b = (expected ?? []) as unknown[];
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameScalar(type.element.kind, item, b[index]));
  }
  return sameScalar(type.kind, actual, expected);
}

/** Printable form of a SQL result (datetimes as UTC ISO instants). */
export function show(type: FormulaType, value: unknown): string {
  const kind = type.kind === 'list' ? type.element.kind : type.kind;
  const iso = (item: unknown) =>
    kind === 'datetime' && typeof item === 'string' ? new Date(item).toISOString() : item;
  return JSON.stringify(Array.isArray(value) ? value.map(iso) : iso(value));
}

export { createTestDb };
