import {
  TABLE_TRASH_RETENTION_DAYS,
  type TrashedTableDto,
  type TrashedTableList,
} from '@cellhive/contracts';
import {
  fieldErrorOf,
  isComputedRow,
  loadBaseSchemaRows,
  type AuditLogsRepository,
  type Db,
  type FieldRow,
  type FieldsRepository,
  type TableRow,
  type TablesRepository,
} from '@cellhive/server-core';

import { tableDtoOf } from '../../common/schema/schema-dto.js';
import { readabilityOf } from '../field/computed-fields.js';

import type { BaseAccess } from '../../common/access/access.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TableTrashDeps {
  readonly db: Db;
  readonly tables: TablesRepository;
  readonly fields: FieldsRepository;
  readonly auditLogs: AuditLogsRepository;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Who deleted the table: the actor of its latest `table.deleted` audit entry. */
async function deletedByOf(
  deps: TableTrashDeps,
  base: BaseAccess,
  table: TableRow,
): Promise<TrashedTableDto['deleted_by']> {
  const { items } = await deps.auditLogs.list(
    base.org.scope,
    { entityType: 'table', entityId: table.id, actions: ['table.deleted'] },
    { cursor: null, limit: 1 },
  );
  const entry = items[0];
  if (entry === undefined || entry.actor_type !== 'user' || entry.actor_id === null) return null;
  return { id: entry.actor_id, name: entry.actor_name };
}

/**
 * Formula/lookup fields of active tables in `REF` because of `table`: their
 * error names the table, one of its fields, one of its partner link fields,
 * or (transitively) another field of this list.
 */
function computedFieldsOf(
  active: readonly FieldRow[],
  table: TableRow,
  causes: ReadonlySet<string>,
): FieldRow[] {
  const found = new Map<string, FieldRow>();
  let grown = true;
  while (grown) {
    grown = false;
    for (const field of active) {
      if (!isComputedRow(field) || found.has(field.id)) continue;
      const error = fieldErrorOf(field.compute_error);
      if (error?.code !== 'REF') continue;
      const hit = error.refs.some((ref) =>
        ref.kind === 'table' ? ref.id === table.id : causes.has(ref.id) || found.has(ref.id),
      );
      if (hit) {
        found.set(field.id, field);
        grown = true;
      }
    }
  }
  return [...found.values()];
}

/**
 * `GET /bases/:baseId/tables/trash` (T469, CONTRACTS §13) for a base admin
 * (the caller checks): the tables of the base in the trash, latest first,
 * with what a permanent delete (T461) takes with it.
 */
export async function listTableTrash(
  deps: TableTrashDeps,
  base: BaseAccess,
): Promise<TrashedTableList> {
  const scope = base.org.scope;
  const trashed = await deps.tables.listTrashByBase(scope, base.base.id);
  if (trashed.length === 0) return { items: [] };
  const rows = await loadBaseSchemaRows(deps.db, scope, base.base.id);
  const activeTables = new Set<string>(rows.tables.map((table) => table.id));
  const readable = readabilityOf(base.access);
  const items: TrashedTableDto[] = [];
  for (const table of trashed) {
    const ownFields = await deps.fields.listByTable(scope, table.id);
    const partners = (await deps.fields.listLinksTouching(scope, table.id)).filter(
      (field) =>
        field.table_id !== table.id && field.purged_at === null && activeTables.has(field.table_id),
    );
    const causes = new Set<string>([
      ...ownFields.map((field) => field.id),
      ...partners.map((field) => field.id),
    ]);
    const deletedAt = table.deleted_at ?? new Date();
    items.push({
      ...tableDtoOf(table),
      deleted_at: deletedAt.toISOString(),
      purge_after: new Date(
        deletedAt.getTime() + TABLE_TRASH_RETENTION_DAYS * DAY_MS,
      ).toISOString(),
      deleted_by: await deletedByOf(deps, base, table),
      field_count: ownFields.length,
      partner_fields: partners.map((field) => ({
        id: field.id,
        table_id: field.table_id,
        name: field.name,
        kind:
          isRecord(field.options) && field.options['bidirectional'] === true
            ? 'two_way'
            : 'one_way',
        in_trash: field.deleted_at !== null,
      })),
      computed_fields: computedFieldsOf(rows.fields, table, causes)
        .filter((field) => readable.field(field.table_id, field.id))
        .map((field) => ({
          id: field.id,
          table_id: field.table_id,
          name: field.name,
          type: field.type === 'lookup' ? 'lookup' : 'formula',
        })),
    });
  }
  return { items };
}
