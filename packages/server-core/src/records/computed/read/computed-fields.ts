import {
  isValidTimeZone,
  parseComputedStyle,
  type ComputedResultType,
  type ComputedStyle,
  type FieldType,
} from '@cellhive/field-types';
import { T, type FormulaType } from '@cellhive/formula-engine';
import { sql, type RawBuilder } from 'kysely';

import { ComputeModel, storedColumnValue } from '../../../computed/definition/compute-model.js';
import { isComputedRow, publicResultType } from '../../../computed/definition/definition.js';
import {
  formulaTypeOf,
  loadBaseSchemaRows,
  type BaseSchemaRows,
  type SchemaReadability,
} from '../../../computed/definition/schema-rows.js';
import { BasesRepository } from '../../../db/repositories/bases.repository.js';
import { OrganizationsRepository } from '../../../db/repositories/organizations.repository.js';
import { compileCrossAnalysis } from '../../../formula/cross/index.js';
import { viewerSourceScope } from '../../../formula/cross/scope.js';
import { nullOf } from '../../../formula/values.js';
import { assertDataTableName, assertFieldColumnName } from '../../../schema/names.js';
import { accessibleTable, relatedAccessContext } from '../../links/link-targets.js';
import { readable, type TableModel } from '../../table-model.js';

import {
  computedReferences,
  isComputedLocked,
  strictComputedPermissionsOf,
  type ComputedReferences,
} from './references.js';

import type { Db } from '../../../db/create-db.js';
import type { OrgScope } from '../../../db/repository.js';
import type { FieldRow } from '../../../db/schema.js';
import type { SqlFilterFieldMeta } from '../../../query/index.js';
import type { RecordAccessContext } from '../../types.js';
import type { Id } from '@cellhive/contracts';
import type { ResolveContext } from '@cellhive/filter-dsl';
import type { TableAccess } from '@cellhive/permissions';

/**
 * A formula/lookup field as a read sees it (BACKLOG T457, SPEC §5.9):
 * its value is an SQL expression over the table's row — the stored column,
 * or the formula compiled with the **reader's** read scope on every table it
 * reads (S4b open question #1b) — never selected for a reader it is locked
 * for.
 */
export interface ComputedField {
  readonly computed: true;
  readonly id: Id<'fld'>;
  readonly name: string;
  readonly type: 'formula' | 'lookup';
  readonly row: FieldRow;
  /** Result type (`meta.fields.result_type`); `null` when unknown (reads empty). */
  readonly resultType: FormulaType | null;
  /** `result_type` of the field API. */
  readonly publicType: ComputedResultType;
  /** `style` of the result, validated against it (`cell_format=text`). */
  readonly style: ComputedStyle | null;
  /** The reader's field perm is not `no_perm`: the field is read (maybe locked). */
  readonly readable: boolean;
  /** The reader lacks a source (S4b #1a): `null` + `locked`; not filterable/sortable. */
  readonly locked: boolean;
  /** The table the record ids of a record result belong to (`null`: not records). */
  readonly recordTableId: string | null;
  /**
   * The value over the row aliased `alias` (default: the data table's name,
   * i.e. an unaliased `FROM`) in the form of a stored column: scalars in
   * their PostgreSQL type, lists as arrays (`NULL` when empty), attachments
   * `jsonb`.
   */
  value(alias?: string): RawBuilder<unknown>;
  /** Filter meta of the field (`expression` = {@link value}). */
  readonly filterMeta: SqlFilterFieldMeta;
  /** Sort/group key kind (`null`: not sortable — records and attachments, like links). */
  readonly sortKind: ComputedSortKind | null;
}

/** How a computed value orders (`first`: a list orders by its first element). */
export type ComputedSortKind = 'value' | 'first' | 'user' | 'first_user';

/** The computed fields of a table for one reader. */
export interface ComputedReadPlan {
  /** Every active formula/lookup field of the table, in display order. */
  readonly fields: readonly ComputedField[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Filter meta of a result type (SPEC §6.2: operators of the result type). */
function filterResultOf(type: FormulaType | null): {
  resultType?: FieldType;
  resultOptions?: unknown;
  resultIsList?: boolean;
} {
  if (type === null) return {};
  const list = type.kind === 'list';
  const element = type.kind === 'list' ? type.element : type;
  const of = (resultType: FieldType, resultOptions?: unknown) => ({
    resultType,
    ...(resultOptions === undefined ? {} : { resultOptions }),
    resultIsList: list,
  });
  switch (element.kind) {
    case 'text':
      return of('text');
    case 'number':
      return of('number');
    case 'boolean':
      return of('checkbox');
    case 'date':
      return of('datetime', { style: { format: 'yyyy-MM-dd' } });
    case 'datetime':
      return of('datetime', { style: { format: 'yyyy-MM-dd HH:mm' } });
    case 'user':
      return of('user');
    case 'row':
      return of('link');
    case 'attachment':
      return of('attachment');
    default:
      return {};
  }
}

/**
 * Filter meta of a formula/lookup field from its `meta.fields.result_type`
 * (view configs validate saved filters with it).
 */
export function computedFilterResultOf(resultType: unknown): {
  resultType?: FieldType;
  resultOptions?: unknown;
  resultIsList?: boolean;
} {
  const type = formulaTypeOf(resultType);
  return filterResultOf(type === null || type.kind === 'any' ? null : type);
}

/** Whether records can be sorted/grouped by a formula/lookup field of this result type. */
export function isComputedSortable(resultType: unknown): boolean {
  const type = formulaTypeOf(resultType);
  if (type === null || type.kind === 'any') return true;
  return sortKindOf(publicResultType(type)) !== null;
}

function sortKindOf(type: ComputedResultType): ComputedSortKind | null {
  switch (type.kind) {
    case 'record':
    case 'attachment':
      return null;
    case 'user':
      return type.list ? 'first_user' : 'user';
    default:
      return type.list ? 'first' : 'value';
  }
}

/** What a reader may reference, from a record access context (share links: `relatedAccess`). */
export function readabilityOfAccess(access: RecordAccessContext): SchemaReadability {
  const tableAccess = (tableId: Id<'tbl'>) =>
    accessibleTable(relatedAccessContext(access, tableId), tableId);
  return {
    table: (tableId) => tableAccess(tableId) !== null,
    field: (tableId, fieldId) => readable(tableAccess(tableId), fieldId),
  };
}

export interface ComputedReadOptions {
  /** Instance default zone (an organization without `settings.timezone`). */
  readonly defaultTimeZone: string;
  /** `NOW()`/`TODAY()` of the read (the request clock). */
  readonly now: Date;
}

/**
 * Builds the {@link ComputedReadPlan} of a table for a reader (BACKLOG T457);
 * `RecordQueryService` calls it and uses the fields for `SELECT`, filters,
 * sorts and groups. Everything is decided from meta and the reader's
 * access, nothing from the request.
 */
export class ComputedReadPlanner {
  private readonly bases: BasesRepository;
  private readonly organizations: OrganizationsRepository;

  constructor(private readonly db: Db) {
    this.bases = new BasesRepository(db);
    this.organizations = new OrganizationsRepository(db);
  }

  /** `null` when the table has no active formula/lookup field (no extra query). */
  async plan(
    scope: OrgScope,
    model: TableModel,
    fieldRows: readonly FieldRow[],
    tableAccess: TableAccess,
    access: RecordAccessContext,
    context: ResolveContext,
    options: ComputedReadOptions,
  ): Promise<ComputedReadPlan | null> {
    const own = fieldRows.filter((row) => row.deleted_at === null && isComputedRow(row));
    if (own.length === 0) return null;
    const rows = await loadBaseSchemaRows(this.db, scope, model.table.base_id);
    const base = await this.bases.getById(scope, model.table.base_id);
    const strict = strictComputedPermissionsOf(base?.settings);
    const timeZone = await this.timeZoneOf(scope, options.defaultTimeZone);
    return computedReadPlan({
      model,
      own,
      rows,
      tableAccess,
      access,
      context,
      strict,
      timeZone,
      now: options.now,
    });
  }

  private async timeZoneOf(scope: OrgScope, fallback: string): Promise<string> {
    const organization = await this.organizations.findById(scope.organizationId, scope.tx);
    const zone = isRecord(organization?.settings) ? organization.settings['timezone'] : undefined;
    return typeof zone === 'string' && isValidTimeZone(zone) ? zone : fallback;
  }
}

export interface ComputedReadPlanInput {
  readonly model: TableModel;
  /** Active formula/lookup rows of the table, in display order. */
  readonly own: readonly FieldRow[];
  readonly rows: BaseSchemaRows;
  readonly tableAccess: TableAccess;
  readonly access: RecordAccessContext;
  readonly context: ResolveContext;
  /** `strict_computed_permissions` of the base. */
  readonly strict: boolean;
  /** Organization zone (ADR-21): the zone stored values are computed in. */
  readonly timeZone: string;
  readonly now: Date;
}

/** {@link ComputedReadPlanner.plan} on loaded meta. */
export function computedReadPlan(input: ComputedReadPlanInput): ComputedReadPlan {
  const { model, rows, access, context } = input;
  const base = new ComputeModel(rows, { timeZone: input.timeZone });
  const scopeOf = viewerSourceScope(access, context, (id) => base.model(id));
  const references = new Map<string, ComputedReferences>();
  const referencesOf = (field: FieldRow): ComputedReferences => {
    let found = references.get(field.id);
    if (found === undefined) {
      found = computedReferences(field, rows, (row) => base.analysis(row));
      references.set(field.id, found);
    }
    return found;
  };
  // A table the reader reads only in part: stored values (computed over every
  // record) are not theirs (S4b #1b). The alias only shapes the unused SQL.
  const scoped = new Map<string, boolean>();
  const isScoped = (tableId: string): boolean => {
    let found = scoped.get(tableId);
    if (found === undefined) {
      found = scopeOf(tableId, 'x') !== null;
      scoped.set(tableId, found);
    }
    return found;
  };
  const needsScope = (field: FieldRow) => [...referencesOf(field).tables].some(isScoped);
  const scopedModel = new ComputeModel(rows, {
    timeZone: input.timeZone,
    now: input.now,
    sourceScope: scopeOf,
    inlineStored: needsScope,
  });
  const readability = readabilityOfAccess(access);
  const tableName = assertDataTableName(model.table.db_table_name);

  const fields = input.own.map((row): ComputedField => {
    const stored = formulaTypeOf(row.result_type);
    const resultType: FormulaType | null = stored === null || stored.kind === 'any' ? null : stored;
    const type: FormulaType = resultType ?? T.text;
    const publicType: ComputedResultType =
      resultType === null ? { kind: 'null', list: false } : publicResultType(resultType);
    const options = isRecord(row.options) ? row.options : {};
    const parsedStyle = parseComputedStyle(options['style'] ?? null, publicType);
    const locked = isComputedLocked(referencesOf(row), rows, readability, input.strict);
    const element = resultType?.kind === 'list' ? resultType.element : resultType;
    const values = new Map<string, RawBuilder<unknown>>();
    const compute = (alias: string): RawBuilder<unknown> => {
      if (resultType === null || row.compute_state === 'error') return nullOf(type);
      if (row.compute_mode === 'stored' && row.db_column_name !== null && !needsScope(row)) {
        return sql.id(alias, assertFieldColumnName(row.db_column_name));
      }
      const analysis = base.analysis(row);
      if (analysis === null) return storedColumnValue(nullOf(type), type);
      try {
        const compiled = compileCrossAnalysis(
          analysis,
          { timeZone: input.timeZone, tableAlias: alias, now: input.now },
          scopedModel.cross(model.table.id),
        );
        return storedColumnValue(compiled.sql, resultType);
      } catch {
        // A definition that no longer compiles reads empty (T460 flags it).
        return storedColumnValue(nullOf(type), type);
      }
    };
    const value = (alias: string = tableName): RawBuilder<unknown> => {
      let found = values.get(alias);
      if (found === undefined) {
        found = compute(alias);
        values.set(alias, found);
      }
      return found;
    };
    return {
      computed: true,
      id: row.id,
      name: row.name,
      type: row.type as 'formula' | 'lookup',
      row,
      resultType,
      publicType,
      style: parsedStyle.ok ? parsedStyle.style : null,
      readable: readable(input.tableAccess, row.id),
      locked,
      recordTableId: element?.kind === 'row' ? element.tableId : null,
      value,
      filterMeta: {
        id: row.id,
        name: row.name,
        type: row.type as FieldType,
        options: row.options,
        dbColumnName: row.db_column_name,
        ...filterResultOf(resultType),
        expression: (alias) => value(alias),
      },
      // A field in error (T460) reads empty: saved sorts/groups skip it.
      sortKind: row.compute_state === 'error' ? null : sortKindOf(publicType),
    };
  });
  return { fields };
}
