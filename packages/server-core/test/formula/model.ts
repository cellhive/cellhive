/**
 * A table model built without a database, for the compiler unit tests:
 * field rows as meta holds them (`f_…` columns, select option ids).
 */
import { analyze, type SchemaSnapshot } from '@cellhive/formula-engine';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

import {
  compileAnalysis,
  snapshotTableOf,
  type CompiledFormula,
  FormulaSqlContext,
} from '../../src/formula/index.js';
import { buildTableModel, type TableModel } from '../../src/records/table-model.js';

import { loadFormulaFixture } from './fixture-source.js';
import { UNIT_FIELDS } from './unit-fields.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

export const kysely = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

export const TABLE_ID = 'tbl_harness000000000';
export const OTHER_TABLE_ID = 'tbl_other00000000000';

const shortId = (index: number) => `x${String(index).padStart(11, '0')}`;

function fieldRow(
  index: number,
  name: string,
  type: string,
  options: Record<string, unknown>,
): FieldRow {
  return {
    id: `fld_unit${String(index).padStart(12, '0')}`,
    organization_id: 'org_unit000000000000',
    table_id: TABLE_ID,
    name,
    type,
    options,
    is_primary: index === 0,
    db_column_name: `f_${shortId(index)}`,
    position: index,
  } as unknown as FieldRow;
}

export interface UnitTable {
  readonly model: TableModel;
  readonly snapshot: SchemaSnapshot;
}

/**
 * The unit fields, then the shared fixture's (so its cases compile), plus
 * `extra` ones, as a model, and a link
 * field `Link` to the table `Other` in the snapshot (for cross-table nodes).
 */
export function unitTable(
  extra: readonly { name: string; type: string; options?: Record<string, unknown> }[] = [],
  tableName = 'Harness',
): UnitTable {
  const shared = loadFormulaFixture().fields.filter(
    (field) => !UNIT_FIELDS.some((unit) => unit.name === field.name),
  );
  const fields = [...UNIT_FIELDS, ...shared, ...extra];
  const rows = fields.map((field, index) =>
    fieldRow(index, field.name, field.type, { ...(field.options ?? {}) }),
  );
  const table = {
    id: TABLE_ID,
    organization_id: 'org_unit000000000000',
    name: tableName,
    db_table_name: 't_unit00000000',
    collation: 'und-x-icu',
  } as unknown as TableRow;
  const model = buildTableModel(table, rows, null);
  const links = [
    { id: 'fld_link000000000000', name: 'Link', type: 'link', linkTableId: OTHER_TABLE_ID },
  ];
  const own = snapshotTableOf(model);
  return {
    model,
    snapshot: {
      tableId: TABLE_ID,
      tables: [
        { ...own, fields: [...own.fields, ...links] },
        {
          id: OTHER_TABLE_ID,
          name: 'Other',
          fields: [{ id: 'fld_otherName0000000', name: 'Other name', type: 'text' }],
        },
      ],
    },
  };
}

/** Analyses (display form) and compiles; throws on analysis errors. */
export function compileUnit(
  table: UnitTable,
  formula: string,
  ctx: Partial<Omit<FormulaSqlContext, 'types' | 'fields'>> = {},
): CompiledFormula {
  const analysis = analyze(formula, table.snapshot, { form: 'display' });
  if (analysis.errors.length > 0) {
    throw new Error(analysis.errors.map((error) => error.message).join('; '));
  }
  return compileAnalysis(analysis, {
    fields: table.model.fields,
    timeZone: 'Asia/Ho_Chi_Minh',
    ...ctx,
  });
}

/** SQL text and parameters of a compiled formula. */
export function render(compiled: CompiledFormula): { sql: string; parameters: readonly unknown[] } {
  const query = compiled.sql.compile(kysely);
  return { sql: query.sql, parameters: query.parameters };
}
