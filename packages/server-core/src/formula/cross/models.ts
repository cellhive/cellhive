import { buildTableModel, type TableModel } from '../../records/table-model.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import { snapshotTableOf } from '../index.js';

import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { Id } from '@cellhive/contracts';
import type { SchemaSnapshot } from '@cellhive/formula-engine';

/** Models of the tables of a base outside the trash, by table id (meta only, no permissions). */
export type BaseTables = ReadonlyMap<string, TableModel>;

/**
 * Loads the models the cross-table compiler reads (`CrossTableContext.table`):
 * every table of the base outside the trash with its active fields, in two
 * queries. Tables in the trash (or purged) are absent, so links into them
 * and `[Table]` read as empty (CONTRACTS §13).
 */
export async function loadBaseTables(
  db: Db,
  scope: OrgScope,
  baseId: Id<'bse'>,
): Promise<BaseTables> {
  const tables = await new TablesRepository(db).listByBase(scope, baseId);
  const fields = await new FieldsRepository(db).listByTables(
    scope,
    tables.map((table) => table.id),
  );
  const out = new Map<string, TableModel>();
  for (const table of tables) {
    const rows = fields.filter((field) => field.table_id === table.id);
    out.set(table.id, buildTableModel(table, rows, null));
  }
  return out;
}

/** The formula-engine snapshot of a base for a formula of `tableId` (every field of every table). */
export function snapshotOfBase(tables: BaseTables, tableId: string): SchemaSnapshot {
  return { tableId, tables: [...tables.values()].map((model) => snapshotTableOf(model)) };
}
