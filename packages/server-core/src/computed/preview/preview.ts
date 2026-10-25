import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { compileCrossAnalysis } from '../../formula/cross/index.js';
import { assertDataTableName, DATA_SCHEMA } from '../../schema/names.js';
import { ComputeModel, type ComputeModelOptions } from '../definition/compute-model.js';

import type { Tx } from '../../db/create-db.js';
import type { TableRow } from '../../db/schema.js';
import type { BaseSchemaRows } from '../definition/schema-rows.js';
import type { Id } from '@cellhive/contracts';
import type { FormulaAnalysis, FormulaType } from '@cellhive/formula-engine';

/** One computed value of a preview (`cell_format=json`-like, CONTRACTS §13). */
export interface ComputedPreviewRow {
  readonly id: Id<'rec'>;
  readonly value: unknown;
}

export interface ComputedPreviewInput {
  readonly table: TableRow;
  readonly rows: BaseSchemaRows;
  readonly analysis: FormulaAnalysis;
  /** Alias of the table in the read (`readable` is written against it). */
  readonly alias: string;
  /** The viewer's read rule on the table (`__deleted_at IS NULL` is added). */
  readonly readable: RawBuilder<SqlBool>;
  readonly recordIds?: readonly Id<'rec'>[];
  readonly limit: number;
  readonly compute: ComputeModelOptions;
}

function jsonOf(value: unknown, type: FormulaType): unknown {
  if (value === null || value === undefined) return null;
  const element = type.kind === 'list' ? type.element : type;
  const one = (item: unknown): unknown => {
    if (item === null) return null;
    if (element.kind === 'row' && typeof item === 'string') return { id: item };
    if (element.kind === 'datetime' && typeof item === 'string') {
      const date = new Date(item);
      return Number.isNaN(date.getTime()) ? item : date.toISOString();
    }
    return item;
  };
  if (type.kind === 'list') {
    if (!Array.isArray(value) || value.length === 0) return null;
    return value.map(one);
  }
  return one(value);
}

/**
 * The values of a formula/lookup definition on the first `limit` records the
 * viewer reads (or `recordIds` among them), in record order (BACKLOG T456,
 * SPEC §9.6): the same compiled SQL as reads, with the viewer's read scope
 * on every source table (`compute.sourceScope`, BACKLOG S4b #1b).
 */
export async function runComputedPreview(
  tx: Tx,
  input: ComputedPreviewInput,
): Promise<ComputedPreviewRow[]> {
  const model = new ComputeModel(input.rows, input.compute);
  const compiled = compileCrossAnalysis(
    input.analysis,
    {
      timeZone: input.compute.timeZone,
      tableAlias: input.alias,
      ...(input.compute.now === undefined ? {} : { now: input.compute.now }),
    },
    model.cross(input.table.id),
  );
  const from = sql`${sql.id(DATA_SCHEMA, assertDataTableName(input.table.db_table_name))} AS ${sql.id(input.alias)}`;
  const conditions: RawBuilder<SqlBool>[] = [
    sql<SqlBool>`${sql.id(input.alias, '__deleted_at')} IS NULL`,
    input.readable,
  ];
  if (input.recordIds !== undefined) {
    conditions.push(
      sql<SqlBool>`${sql.id(input.alias, '__id')} = ANY(${[...input.recordIds]}::text[])`,
    );
  }
  // The expression runs on the page only (BACKLOG S4b #11: after the LIMIT).
  const { rows } = await sql<{ id: Id<'rec'>; value: unknown }>`
    SELECT ${sql.id(input.alias, '__id')} AS id, to_jsonb(${compiled.sql}) AS value
      FROM (
        SELECT ${sql.id(input.alias)}.* FROM ${from}
         WHERE ${sql.join(conditions, sql` AND `)}
         ORDER BY ${sql.id(input.alias, '__auto')}
         LIMIT ${input.limit}
      ) AS ${sql.id(input.alias)}
     ORDER BY ${sql.id(input.alias, '__auto')}
  `.execute(tx);
  return rows.map((row) => ({ id: row.id, value: jsonOf(row.value, compiled.type) }));
}
