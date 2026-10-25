/**
 * TS ≡ SQL for the `cross_table` cases of the shared fixture (SPEC §9.4,
 * BACKLOG T453/T455): the fixture's tables are created by `SchemaService`
 * (real columns and junctions), its records and each case's formula row
 * inserted, every case compiled by the cross-table compiler and `SELECT`ed
 * on its row, and the result compared with the value the TS evaluator gives
 * (`expected`; records `{ id, title }` compare by id). A case with a
 * `lookup` (names) goes through `lookupToAst` instead of its formula.
 */
import { readFileSync } from 'node:fs';

import {
  analyze,
  analyzeAst,
  lookupToAst,
  type FormulaType,
  type LookupOptions,
  type LookupWhere,
} from '@cellhive/formula-engine';
import { sql, type RawBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../../src/audit/index.js';
import { orgScope, type Db } from '../../../src/db/index.js';
import {
  compileCrossAnalysis,
  loadBaseTables,
  snapshotOfBase,
  type BaseTables,
} from '../../../src/formula/cross/index.js';
import { SchemaService } from '../../../src/schema/index.js';
import { createTestDatabase, migrateAll, type TestDatabase } from '../../support/postgres.js';
import { seedTenant } from '../../support/tenant.js';
import { createTestDb, harnessKysely, sameValue, show, type AnyKysely } from '../harness.js';

import type { FieldRow, TableRow } from '../../../src/db/schema.js';

interface SharedField {
  id: string;
  name: string;
  type: string;
  options?: Record<string, unknown>;
  linkTableId?: string;
}
interface SharedTable {
  id: string;
  name: string;
  primary: string;
  fields: SharedField[];
}
interface SharedSchema {
  defaults: { table: string; rowId: string; tz: string; now: string };
  tables: SharedTable[];
  records: Record<string, { id: string; fields: Record<string, unknown> }[]>;
}
interface SharedLookup {
  from: string;
  select: string;
  where: LookupWhere;
  aggregate?: LookupOptions['aggregate'];
}
interface SharedCase {
  id: string;
  formula: string;
  lookup?: SharedLookup;
  table?: string;
  rowId?: string;
  row?: Record<string, unknown> | null;
  tz?: string;
  now?: string;
  expected: unknown;
  scope: 'same_row' | 'cross_table';
}

const FIXTURES = new URL('../../../../formula-engine/test/fixtures/', import.meta.url);
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const schemaJson = read('formula-schema.json') as SharedSchema;
const CASES = (read('formula-cases.json') as { cases: SharedCase[] }).cases.filter(
  (item) => item.scope === 'cross_table',
);
const ORG = 'org_T455SharedFixtur';

/** Records `{ id, title }` of the evaluator compare with the SQL ids. */
function expectedIds(type: FormulaType, value: unknown): unknown {
  const id = (item: unknown) =>
    typeof item === 'object' && item !== null && 'id' in item ? (item as { id: string }).id : item;
  if (type.kind === 'row') return id(value);
  if (type.kind === 'list' && type.element.kind === 'row' && Array.isArray(value)) {
    return value.map(id);
  }
  return value;
}

describe('cross-table SQL ≡ shared fixture (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let appDb: Db;
  let db: AnyKysely;
  let models: BaseTables;
  const tables = new Map<string, TableRow>();
  const fields = new Map<string, FieldRow[]>();
  const rowIds = new Map<string, { table: string; id: string }>();

  function column(table: string, name: string): FieldRow {
    const field = fields.get(table)?.find((item) => item.name === name);
    if (field === undefined) throw new Error(`Unknown field ${table}.${name}`);
    return field;
  }

  /** A fixture lookup (table, field and select option names) → `LookupOptions` of the created tables. */
  function lookupOptions(lookup: SharedLookup, currentTable: string): LookupOptions {
    const from = tables.get(lookup.from) as TableRow;
    const operand = (field: FieldRow, value: unknown): unknown => {
      if (typeof value === 'object' && value !== null && 'field_ref' in value) {
        return { field_ref: column(currentTable, String(value.field_ref)).id };
      }
      if (field.type !== 'select' || typeof value !== 'string') return value;
      const options = (field.options as { options: { id: string; name: string }[] }).options;
      return options.find((option) => option.name === value)?.id ?? value;
    };
    const where = (node: LookupWhere): LookupWhere => {
      if ('op' in node) {
        return node.op === 'not'
          ? { op: 'not', item: where(node.item) }
          : { op: node.op, items: node.items.map(where) };
      }
      if (node.field === '__id') {
        const ref = (node.value as { field_ref: string }).field_ref;
        return { ...node, value: { field_ref: column(currentTable, ref).id } };
      }
      const field = column(lookup.from, node.field);
      const value =
        node.value === undefined
          ? undefined
          : Array.isArray(node.value)
            ? node.value.map((item) => operand(field, item))
            : operand(field, node.value);
      return { ...node, field: field.id, value } as LookupWhere;
    };
    return {
      from: from.id,
      select: column(lookup.from, lookup.select).id,
      where: where(lookup.where),
      ...(lookup.aggregate === undefined ? {} : { aggregate: lookup.aggregate }),
    };
  }

  /** A cell (records API JSON, select = fixture option id) as its column value. */
  function storage(table: string, shared: SharedField, value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (shared.type === 'select') {
      const sharedOptions = (shared.options?.['options'] ?? []) as { id: string; name: string }[];
      const created = (
        column(table, shared.name).options as { options: { id: string; name: string }[] }
      ).options;
      const map = (id: unknown) => {
        const name = sharedOptions.find((option) => option.id === id)?.name;
        return created.find((option) => option.name === name)?.id ?? id;
      };
      return Array.isArray(value) ? value.map(map) : [map(value)];
    }
    if (shared.type === 'attachment') return JSON.stringify(value);
    if (shared.type === 'number' && typeof value === 'number') return String(value);
    return value;
  }

  async function insert(tableName: string, id: string, cells: Record<string, unknown>) {
    const table = schemaJson.tables.find((item) => item.name === tableName) as SharedTable;
    const row = tables.get(tableName) as TableRow;
    const columns: RawBuilder<unknown>[] = [sql.id('__id')];
    const values: RawBuilder<unknown>[] = [sql.val(id)];
    const links: [FieldRow, string[]][] = [];
    for (const [name, value] of Object.entries(cells)) {
      const shared = table.fields.find((item) => item.name === name);
      if (shared === undefined) throw new Error(`Unknown fixture field ${name}`);
      if (shared.type === 'link') {
        links.push([column(tableName, name), (value ?? []) as string[]]);
        continue;
      }
      columns.push(sql.id(column(tableName, name).db_column_name as string));
      values.push(sql.val(storage(tableName, shared, value)));
    }
    await sql`INSERT INTO ${sql.id('data', row.db_table_name)} (${sql.join(columns)}) VALUES (${sql.join(values)})`.execute(
      db,
    );
    for (const [field, targets] of links) {
      for (const [position, target] of targets.entries()) {
        await sql`INSERT INTO ${sql.id('data', field.link_junction as string)} (a_id, b_id, position) VALUES (${id}, ${target}, ${position})`.execute(
          db,
        );
      }
    }
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    appDb = createTestDb(database.url);
    await migrateAll(database.url, appDb);
    ({ db } = harnessKysely(database.url));
    const { baseId } = await seedTenant(appDb, ORG);
    const schema = new SchemaService(appDb, { maxFieldsPerTable: 500 });
    const scope = orgScope(ORG);
    const context = systemAuditContext();
    const tableIds = new Map<string, string>();
    for (const table of schemaJson.tables) {
      const created = await schema.createTable(
        scope,
        { baseId, name: table.name, primaryFieldName: table.primary },
        context,
      );
      tables.set(table.name, created.table);
      tableIds.set(table.id, created.table.id);
      const rows: FieldRow[] = [created.primaryField];
      for (const field of table.fields) {
        if (field.name === table.primary || field.type === 'link') continue;
        rows.push(
          await schema.addField(
            scope,
            created.table.id,
            { name: field.name, type: field.type, options: field.options ?? {} },
            context,
          ),
        );
      }
      fields.set(table.name, rows);
    }
    for (const table of schemaJson.tables) {
      for (const field of table.fields) {
        if (field.type !== 'link') continue;
        (fields.get(table.name) as FieldRow[]).push(
          await schema.addField(
            scope,
            (tables.get(table.name) as TableRow).id,
            {
              name: field.name,
              type: 'link',
              options: { link_table: tableIds.get(field.linkTableId as string) },
            },
            context,
          ),
        );
      }
    }
    for (const [tableName, records] of Object.entries(schemaJson.records)) {
      for (const record of records) await insert(tableName, record.id, record.fields);
    }
    for (const [index, item] of CASES.entries()) {
      const table = item.table ?? schemaJson.defaults.table;
      if (item.rowId !== undefined && table !== schemaJson.defaults.table) {
        rowIds.set(item.id, { table, id: item.rowId });
        continue;
      }
      const id = `rec_xcase${String(index).padStart(11, '0')}`;
      await insert(table, id, item.row ?? {});
      rowIds.set(item.id, { table, id });
    }
    models = await loadBaseTables(appDb, scope, baseId);
  }, 300_000);

  afterAll(async () => {
    await db.destroy();
    await appDb.destroy();
    await database.drop();
  });

  it('has the cross_table cases of the shared fixture', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
  });

  it('gives the TS evaluator value for every cross_table case', async () => {
    const failures: string[] = [];
    for (const item of CASES) {
      try {
        const { table, id } = rowIds.get(item.id) as { table: string; id: string };
        const tableRow = tables.get(table) as TableRow;
        const self = models.get(tableRow.id);
        if (self === undefined) throw new Error(`No model for ${table}`);
        const snapshot = snapshotOfBase(models, tableRow.id);
        const analysis =
          item.lookup === undefined
            ? analyze(item.formula, snapshot, { form: 'display' })
            : analyzeAst(lookupToAst(lookupOptions(item.lookup, table), snapshot), snapshot);
        if (analysis.errors.length > 0) {
          throw new Error(analysis.errors.map((error) => error.message).join('; '));
        }
        const compiled = compileCrossAnalysis(
          analysis,
          {
            timeZone: item.tz ?? schemaJson.defaults.tz,
            now: new Date(item.now ?? schemaJson.defaults.now),
            tableAlias: 'r',
          },
          { self, table: (tableId) => models.get(tableId) ?? null },
        );
        const element = compiled.type.kind === 'list' ? compiled.type.element : compiled.type;
        const calendar = element.kind === 'date' || element.kind === 'datetime';
        const select = calendar ? sql`to_json(${compiled.sql})::text` : compiled.sql;
        const { rows } = await sql<{ v: unknown }>`
          SELECT ${select} AS v FROM ${sql.id('data', tableRow.db_table_name)} AS r WHERE r.__id = ${id}
        `.execute(db);
        const raw = rows[0]?.v;
        const actual = calendar && typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
        const expected = expectedIds(compiled.type, item.expected);
        if (!sameValue(compiled.type, actual, expected)) {
          failures.push(
            `${item.id}: expected ${JSON.stringify(expected)}, got ${show(compiled.type, actual)}`,
          );
        }
      } catch (error) {
        failures.push(`${item.id}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
