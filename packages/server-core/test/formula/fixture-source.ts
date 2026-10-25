/**
 * The fixture the TS ≡ SQL harness replays (SPEC §9.4, BACKLOG T453/T454):
 * the shared data fixture of `@cellhive/formula-engine`
 * (`packages/formula-engine/test/fixtures/formula-{schema,cases}.json`,
 * format in the README there), adapted to `FormulaFixture`:
 *
 * - fields: the formula table's fields (`Dữ liệu`, primary field first),
 *   without link fields (cross-table cases are T455's);
 * - cases: row cells by field name with select option **names** (the shared
 *   fixture stores option ids), `tz`/`now` defaults filled in, `crossTable`
 *   from `scope`.
 *
 * The TS evaluator replays the same JSON in
 * `packages/formula-engine/test/evaluate-fixture.test.ts`.
 */
import { readFileSync } from 'node:fs';

import type { FormulaFixture, FormulaFixtureCase, FormulaFixtureField } from './fixture-types.js';

interface SharedField {
  id: string;
  name: string;
  type: string;
  options?: Record<string, unknown>;
  linkTableId?: string;
}

interface SharedSchema {
  defaults: { table: string; rowId: string; tz: string; now: string };
  tables: { id: string; name: string; primary: string; fields: SharedField[] }[];
}

interface SharedCase {
  id: string;
  formula: string;
  table?: string;
  rowId?: string;
  row?: Record<string, unknown>;
  tz?: string;
  now?: string;
  expected: unknown;
  scope: 'same_row' | 'cross_table';
}

const FIXTURES = new URL('../../../formula-engine/test/fixtures/', import.meta.url);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

/** Select option ids of a cell → option names (the harness stores names back as ids). */
function cellOf(field: SharedField | undefined, value: unknown): unknown {
  if (field?.type !== 'select' || value === null || value === undefined) return value;
  const options = (field.options?.['options'] ?? []) as { id: string; name: string }[];
  const name = (id: unknown) => options.find((option) => option.id === id)?.name ?? id;
  return Array.isArray(value) ? value.map(name) : name(value);
}

export function loadFormulaFixture(): FormulaFixture {
  const schema = readJson('formula-schema.json') as SharedSchema;
  const { cases } = readJson('formula-cases.json') as { cases: SharedCase[] };
  const table = schema.tables.find((item) => item.name === schema.defaults.table);
  if (table === undefined) throw new Error('The shared fixture has no formula table');
  const own = table.fields.filter((field) => field.type !== 'link');
  const primary = own.find((field) => field.name === table.primary);
  const ordered = [
    ...(primary === undefined ? [] : [primary]),
    ...own.filter((field) => field !== primary),
  ];
  const fields: FormulaFixtureField[] = ordered.map((field) =>
    field.options === undefined
      ? { name: field.name, type: field.type }
      : { name: field.name, type: field.type, options: field.options },
  );
  const byName = new Map(table.fields.map((field) => [field.name, field]));
  return {
    fields,
    cases: cases.map((item): FormulaFixtureCase => {
      const row = Object.fromEntries(
        Object.entries(item.row ?? {}).map(([name, value]) => [
          name,
          cellOf(byName.get(name), value),
        ]),
      );
      const crossTable =
        item.scope === 'cross_table' ||
        (item.table !== undefined && item.table !== schema.defaults.table);
      return {
        name: item.id,
        formula: item.formula,
        row,
        ...(item.rowId === undefined ? {} : { rowId: item.rowId }),
        tz: item.tz ?? schema.defaults.tz,
        now: item.now ?? schema.defaults.now,
        expected: item.expected,
        ...(crossTable ? { crossTable: true } : {}),
      };
    }),
  };
}

/** Cases of the same-row compiler (T454); cross-table ones are T455's. */
export function sameRowCases(fixture: FormulaFixture): FormulaFixtureCase[] {
  return fixture.cases.filter((item) => item.crossTable !== true);
}
