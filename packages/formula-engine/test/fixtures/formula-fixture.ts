import { readFileSync } from 'node:fs';

import type {
  EvaluateContext,
  FormulaDataSource,
  FormulaRecord,
  LookupAggregate,
  LookupOptions,
  LookupWhere,
  SchemaSnapshot,
  SnapshotField,
} from '../../src/index.js';

/**
 * Shared TS ≡ SQL formula fixture (SPEC §9.4, T453; replayed on
 * PostgreSQL by T454/T455). Pure data in two JSON files next to this one —
 * see README.md for the format and the semantics they pin down:
 *
 * - `formula-schema.json`: the tables (field IDs, types, options, primary
 *   field), the records of the tables formulas reach through links or
 *   `[Table]`, and the defaults (`tz`, `now`, `locale`, formula table);
 * - `formula-cases.json`: the cases — a display-form formula, the formula
 *   row (cells by field name, in the records API JSON shape), the expected
 *   JSON result and its type.
 *
 * This module only reads the JSON and builds what `evaluate` needs; a SQL
 * harness can read the JSON directly.
 */

export interface FixtureField extends SnapshotField {
  type: string;
}

export interface FixtureTable {
  id: string;
  name: string;
  /** Name of the primary field: the record title. */
  primary: string;
  fields: FixtureField[];
}

export interface FixtureRecordData {
  id: string;
  /** Cells by field name. */
  fields: Record<string, unknown>;
}

export interface FixtureSchema {
  defaults: { table: string; rowId: string; tz: string; now: string; locale: string };
  tables: FixtureTable[];
  /** Records by table name, in table order. */
  records: Record<string, FixtureRecordData[]>;
}

/**
 * A lookup field (`lookupToAst`) instead of a formula, by names: `from`
 * table, `select`/`where` fields of it, select operands as option names,
 * `{ "field_ref": name }` for a field of the formula table.
 */
export interface FixtureLookup {
  from: string;
  select: string;
  where: LookupWhere;
  aggregate?: LookupAggregate;
}

export interface FixtureCase {
  id: string;
  /** Display form (names), as typed in the editor; for a `lookup` case, a description only. */
  formula: string;
  /** Evaluate this lookup (names) instead of `formula`. */
  lookup?: FixtureLookup;
  /** Formula table name (default `defaults.table`). */
  table?: string;
  /** ID of the formula row (default `defaults.rowId`). */
  rowId?: string;
  /** Cells of the formula row by field name; missing fields are empty. */
  row?: Record<string, unknown>;
  tz?: string;
  now?: string;
  locale?: string;
  /** `evaluate` JSON result. */
  expected: unknown;
  /** `formatType` of the result type. */
  type: string;
  /** Numbers: allowed relative difference (irrational results: EXP, LN, SQRT…). */
  tolerance?: string;
  /** `same_row`: only the row's own cells (T454); `cross_table`: links or `[Table]` (T455). */
  scope: 'same_row' | 'cross_table';
}

export interface FormulaFixture {
  schema: FixtureSchema;
  cases: FixtureCase[];
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
}

export function loadFormulaFixture(): FormulaFixture {
  return {
    schema: readJson('./formula-schema.json') as FixtureSchema,
    cases: (readJson('./formula-cases.json') as { cases: FixtureCase[] }).cases,
  };
}

function tableNamed(schema: FixtureSchema, name: string): FixtureTable {
  const table = schema.tables.find((item) => item.name === name);
  if (table === undefined) throw new Error(`Unknown fixture table ${name}`);
  return table;
}

/** A record with cells keyed by field ID and the primary field as title. */
export function fixtureRecord(
  table: FixtureTable,
  id: string,
  cells: Record<string, unknown>,
): FormulaRecord {
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(cells)) {
    const field = table.fields.find((item) => item.name === name);
    if (field === undefined) throw new Error(`Unknown field ${name} in ${table.name}`);
    fields[field.id] = value;
  }
  const title = cells[table.primary];
  return { id, title: typeof title === 'string' ? title : null, fields };
}

export function fixtureSnapshot(schema: FixtureSchema, tableName: string): SchemaSnapshot {
  return { tableId: tableNamed(schema, tableName).id, tables: schema.tables };
}

export function fixtureDataSource(schema: FixtureSchema): FormulaDataSource {
  const byTable = new Map<string, FormulaRecord[]>();
  for (const table of schema.tables) {
    const records = schema.records[table.name] ?? [];
    byTable.set(
      table.id,
      records.map((record) => fixtureRecord(table, record.id, record.fields)),
    );
  }
  return {
    table: (tableId) => byTable.get(tableId) ?? [],
    record: (tableId, recordId) =>
      byTable.get(tableId)?.find((record) => record.id === recordId) ?? null,
  };
}

/** Everything `evaluate` needs for one case (without `types`). */
export function caseContext(
  schema: FixtureSchema,
  item: FixtureCase,
  resolve: FormulaDataSource = fixtureDataSource(schema),
): EvaluateContext {
  const tableName = item.table ?? schema.defaults.table;
  const table = tableNamed(schema, tableName);
  return {
    snapshot: fixtureSnapshot(schema, tableName),
    row: fixtureRecord(table, item.rowId ?? schema.defaults.rowId, item.row ?? {}),
    resolve,
    tz: item.tz ?? schema.defaults.tz,
    now: item.now ?? schema.defaults.now,
    locale: item.locale ?? schema.defaults.locale,
  };
}

/** The `LookupOptions` (IDs) of a fixture lookup (names). */
export function fixtureLookupOptions(
  schema: FixtureSchema,
  lookup: FixtureLookup,
  currentTable: string,
): LookupOptions {
  const from = tableNamed(schema, lookup.from);
  const current = tableNamed(schema, currentTable);
  const fieldOf = (table: FixtureTable, name: string): FixtureField => {
    const field = table.fields.find((item) => item.name === name);
    if (field === undefined) throw new Error(`Unknown field ${name} in ${table.name}`);
    return field;
  };
  const operand = (field: FixtureField, value: unknown): unknown => {
    if (typeof value === 'object' && value !== null && 'field_ref' in value) {
      return { field_ref: fieldOf(current, String(value.field_ref)).id };
    }
    if (field.type !== 'select' || typeof value !== 'string') return value;
    const options = (field.options?.['options'] ?? []) as { id: string; name: string }[];
    return options.find((option) => option.name === value)?.id ?? value;
  };
  const where = (node: LookupWhere): LookupWhere => {
    if ('op' in node) {
      return node.op === 'not'
        ? { op: 'not', item: where(node.item) }
        : { op: node.op, items: node.items.map(where) };
    }
    if (node.field === '__id') {
      // The source record in the current record's link (CONTRACTS §13).
      const ref = (node.value as { field_ref: string }).field_ref;
      return { ...node, value: { field_ref: fieldOf(current, ref).id } };
    }
    const field = fieldOf(from, node.field);
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
    select: fieldOf(from, lookup.select).id,
    where: where(lookup.where),
    ...(lookup.aggregate === undefined ? {} : { aggregate: lookup.aggregate }),
  };
}
