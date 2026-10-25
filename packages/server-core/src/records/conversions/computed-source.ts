import { isId, type Id } from '@cellhive/contracts';
import {
  parseComputedStyle,
  type ComputedSource,
  type UserRef,
  LocaleContext,
} from '@cellhive/field-types';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { ComputeModel } from '../../computed/definition/compute-model.js';
import { publicResultType } from '../../computed/definition/definition.js';
import { formulaTypeOf, type BaseSchemaRows } from '../../computed/definition/schema-rows.js';
import { assertDataTableName, assertFieldColumnName, DATA_SCHEMA } from '../../schema/names.js';
import { computedCellValue, type ComputedCellField } from '../computed/read/cells.js';
import { titleOf, titleUserIds } from '../links/link-reader.js';
import { dataTableRef } from '../links/link-targets.js';
import { toFieldModel } from '../table-model.js';

import { SCAN_ALIAS, assertScanColumn } from './column-scan.js';

import type { DbExecutor } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { FieldRow, TableRow } from '../../db/schema.js';
import type { MemberDirectoryRepository } from '../member-directory.repository.js';

/**
 * Current values of a formula/lookup field for "convert to static values"
 * (CONTRACTS §4.1, BACKLOG T463): keyset batches of every row (trash
 * included) in `__auto` order, each value in its `cell_format=json` form.
 * A `stored` field that is `ready` is read from its column (the stored
 * snapshot); a `virtual` one — or a stored one still being (re)computed —
 * is computed now with its expression; a field in error reads empty. Users
 * and record titles are read for the system (every live record of the
 * linked table, whatever the caller's record rules: whoever converts reads
 * every source table). Reached through `RecordQueryService.scanComputed`
 * (previews) and the `field.convert` job (AGENTS.md rule 1).
 */

export interface ComputedScanRequest {
  readonly afterAuto: bigint;
  readonly limit: number;
  /** Also read this column raw (revert preview: the converted column). */
  readonly compareColumn?: string;
}

export interface ComputedScanRow {
  readonly id: Id<'rec'>;
  readonly auto: bigint;
  /** The computed value, `cell_format=json`. */
  readonly value: unknown;
  readonly compare: unknown;
  readonly readable: boolean;
  readonly updatedAt: Date;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The field as a conversion source: public result type and `style`. */
export function computedSourceOf(field: Pick<FieldRow, 'result_type' | 'options'>): ComputedSource {
  const type = formulaTypeOf(field.result_type);
  const result =
    type === null || type.kind === 'any'
      ? { kind: 'null' as const, list: false }
      : publicResultType(type);
  const options = isRecord(field.options) ? field.options : {};
  const style = parseComputedStyle(options['style'] ?? null, result);
  return { result, style: style.ok ? style.style : null };
}

function cellFieldOf(field: FieldRow): ComputedCellField {
  const type = formulaTypeOf(field.result_type);
  const resultType = type === null || type.kind === 'any' ? null : type;
  const element = resultType?.kind === 'list' ? resultType.element : resultType;
  return {
    locked: false,
    publicType: resultType === null ? { kind: 'null', list: false } : publicResultType(resultType),
    recordTableId: element?.kind === 'row' ? element.tableId : null,
    style: null,
  };
}

/** SQL of the field's value on the scan alias, as `jsonb`. */
function valueSql(field: FieldRow, rows: BaseSchemaRows, timeZone: string): RawBuilder<unknown> {
  if (field.compute_state === 'error') return sql`NULL::jsonb`;
  if (
    field.compute_mode === 'stored' &&
    field.compute_state === 'ready' &&
    field.db_column_name !== null
  ) {
    return sql`to_jsonb(${sql.id(SCAN_ALIAS, assertFieldColumnName(field.db_column_name))})`;
  }
  const value = new ComputeModel(rows, { timeZone }).storedValue(field, SCAN_ALIAS);
  return value === null ? sql`NULL::jsonb` : sql`to_jsonb(${value})`;
}

/** One batch of {@link ComputedScanRequest}; `readable` is the caller's read rule on the scan alias. */
export async function scanComputedBatch(
  executor: DbExecutor,
  deps: { readonly members: MemberDirectoryRepository },
  scope: OrgScope,
  input: {
    readonly table: Pick<TableRow, 'db_table_name'>;
    readonly field: FieldRow;
    readonly rows: BaseSchemaRows;
    readonly timeZone: string;
    readonly locale: LocaleContext;
  },
  request: ComputedScanRequest,
  readable: RawBuilder<SqlBool>,
): Promise<ComputedScanRow[]> {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
    throw new RangeError('scanComputedBatch: limit must be a positive integer');
  }
  const t = (column: string) => sql.id(SCAN_ALIAS, column);
  const compare =
    request.compareColumn === undefined ? sql`NULL` : t(assertScanColumn(request.compareColumn));
  const { rows } = await sql<{
    id: Id<'rec'>;
    auto: string;
    value: unknown;
    compare: unknown;
    readable: boolean | null;
    updated_at: Date;
  }>`
    SELECT ${t('__id')} AS id,
           ${t('__auto')}::text AS auto,
           ${valueSql(input.field, input.rows, input.timeZone)} AS value,
           ${compare} AS compare,
           (${readable}) AS readable,
           ${t('__updated_at')} AS updated_at
      FROM ${sql.id(DATA_SCHEMA, assertDataTableName(input.table.db_table_name))} AS ${sql.id(SCAN_ALIAS)}
     WHERE ${t('__auto')} > ${request.afterAuto.toString()}::bigint
     ORDER BY ${t('__auto')}
     LIMIT ${request.limit}
  `.execute(executor);
  const cell = cellFieldOf(input.field);
  const raws = rows.map((row) => row.value);
  const data = await cellData(executor, deps, scope, input.rows, cell, raws, input.locale);
  return rows.map((row) => ({
    id: row.id,
    auto: BigInt(row.auto),
    value: computedCellValue(cell, row.value, data, 'json', input.locale, 'member'),
    compare: request.compareColumn === undefined ? undefined : row.compare,
    readable: row.readable === true,
    updatedAt: row.updated_at,
  }));
}

function itemsOf(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? (value as unknown[]) : [value];
}

/** Members of user values and titles of record values (system access, live records). */
async function cellData(
  executor: DbExecutor,
  deps: { readonly members: MemberDirectoryRepository },
  scope: OrgScope,
  rows: BaseSchemaRows,
  cell: ComputedCellField,
  raws: readonly unknown[],
  locale: LocaleContext,
) {
  const kind = cell.publicType.kind;
  const ids = new Set<string>();
  if (kind === 'user' || kind === 'record') {
    for (const raw of raws) {
      for (const item of itemsOf(raw)) if (typeof item === 'string') ids.add(item);
    }
  }
  const users = new Map<string, UserRef>();
  const titles = new Map<string, Map<string, string | null>>();
  if (kind === 'user' && ids.size > 0) {
    for (const member of await deps.members.findMembers(scope, [...ids])) {
      users.set(member.id, member);
    }
  }
  if (kind === 'record' && cell.recordTableId !== null && ids.size > 0) {
    const recordIds = [...ids].filter((id) => isId('rec', id));
    titles.set(
      cell.recordTableId,
      await titlesOf(executor, deps, scope, rows, cell.recordTableId, recordIds, locale),
    );
  }
  return { users, titles };
}

async function titlesOf(
  executor: DbExecutor,
  deps: { readonly members: MemberDirectoryRepository },
  scope: OrgScope,
  rows: BaseSchemaRows,
  tableId: string,
  ids: readonly string[],
  locale: LocaleContext,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const table = rows.tables.find((item) => item.id === tableId);
  const primaryRow =
    table?.primary_field_id == null
      ? undefined
      : rows.fields.find((row) => row.id === table.primary_field_id);
  const primary = primaryRow === undefined ? null : toFieldModel(primaryRow);
  if (table === undefined || primary === null || ids.length === 0) return out;
  const alias = 'r';
  const { rows: found } = await sql<{ id: string; title: unknown }>`
    SELECT ${sql.id(alias, '__id')} AS id, ${sql.id(alias, primary.column)} AS title
      FROM ${dataTableRef(table)} AS ${sql.id(alias)}
     WHERE ${sql.id(alias, '__id')} = ANY(${sql.val(ids)}::text[])
       AND ${sql.id(alias, '__deleted_at')} IS NULL
  `.execute(executor);
  const users = new Map<string, UserRef>(
    (
      await deps.members.findMembers(
        scope,
        titleUserIds(
          primary,
          found.map((row) => row.title),
        ),
      )
    ).map((member) => [member.id, member]),
  );
  for (const row of found) out.set(row.id, titleOf(primary, row.title, locale, users));
  return out;
}
