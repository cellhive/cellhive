import type { ComputedResultTypeDto, FieldDto } from '@cellhive/contracts';
import type { FormulaType, SchemaSnapshot } from '@cellhive/formula-engine';

/**
 * What a formula of `tableId` may reference (SPEC §9.5): the tables of the
 * base the author reads and their fields the author reads (`GET
 * /tables/:id/fields` leaves `no_perm` fields out, CONTRACTS §2). The
 * editor resolves names, completes and typechecks against it; the server
 * checks again when saving.
 */
export interface FormulaSchemaField {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly isPrimary: boolean;
  /** Table a `link` (or `parent`) field points to; `null` for any other field. */
  readonly linkTableId: string | null;
  readonly resultType: ComputedResultTypeDto | null;
  readonly computeMode: 'stored' | 'virtual' | null;
}

export interface FormulaSchemaTable {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly FormulaSchemaField[];
}

export interface FormulaSchema {
  /** The formula field's table. */
  readonly tableId: string;
  readonly tables: readonly FormulaSchemaTable[];
}

function linkTableOf(field: FieldDto): string | null {
  if (field.type === 'parent') return field.table_id;
  if (field.type !== 'link') return null;
  const target = field.options['link_table'];
  return typeof target === 'string' ? target : null;
}

export function schemaFieldOf(field: FieldDto): FormulaSchemaField {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    options: field.options,
    isPrimary: field.is_primary,
    linkTableId: linkTableOf(field),
    resultType: field.result_type ?? null,
    computeMode: field.compute_mode ?? null,
  };
}

/**
 * The schema from the API lists. `exclude`: the field being edited, which
 * its own formula cannot reference (the server answers `FORMULA_CYCLE`).
 */
export function buildFormulaSchema(
  tableId: string,
  tables: readonly { id: string; name: string }[],
  fieldsOf: (tableId: string) => readonly FieldDto[] | undefined,
  exclude?: string,
): FormulaSchema {
  return {
    tableId,
    tables: tables.map((table) => ({
      id: table.id,
      name: table.name,
      fields: (fieldsOf(table.id) ?? []).filter((field) => field.id !== exclude).map(schemaFieldOf),
    })),
  };
}

export function tableOf(schema: FormulaSchema, tableId: string): FormulaSchemaTable | undefined {
  return schema.tables.find((table) => table.id === tableId);
}

/** Formula type of a computed field's `result_type` (records: their table is unknown here). */
function formulaTypeOf(result: ComputedResultTypeDto): FormulaType {
  const element: FormulaType = result.kind === 'record' ? { kind: 'any' } : { kind: result.kind };
  return result.list ? { kind: 'list', element } : element;
}

/** The engine's snapshot (T451 `SchemaSnapshot`). */
export function toSnapshot(schema: FormulaSchema): SchemaSnapshot {
  return {
    tableId: schema.tableId,
    tables: schema.tables.map((table) => ({
      id: table.id,
      name: table.name,
      primaryFieldId: table.fields.find((field) => field.isPrimary)?.id ?? null,
      fields: table.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
        options: field.options,
        linkTableId: field.linkTableId,
        resultType: field.resultType === null ? null : formulaTypeOf(field.resultType),
        computeMode: field.computeMode,
      })),
    })),
  };
}

/** `result_type` as the API shows it, from the engine's type (`null`: not a storable result). */
export function resultTypeOf(type: FormulaType | null): ComputedResultTypeDto | null {
  if (type === null) return null;
  const list = type.kind === 'list';
  const element = type.kind === 'list' ? type.element : type;
  switch (element.kind) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'user':
    case 'attachment':
    case 'null':
      return { kind: element.kind, list };
    case 'row':
      return { kind: 'record', list };
    case 'any':
      return { kind: 'text', list };
    default:
      return null;
  }
}
