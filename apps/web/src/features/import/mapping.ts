import { getFieldType } from '@cellhive/field-types';

import { canAddRecord, canEditField, isBaseAdmin } from '../../lib/permissions/access';

import type {
  EffectiveAccess,
  FieldDto,
  ImportColumn,
  ImportFieldType,
  ImportPreview,
  StartImportRequest,
} from '@cellhive/contracts';

/**
 * The mapping step of the import wizard (T318, CONTRACTS §19), as pure
 * functions: new-table columns (name + type per file column, guesses from
 * the preview) and append mappings (file column → writable field).
 */

type Access = EffectiveAccess | null | undefined;

const fold = (name: string) => name.trim().toLocaleLowerCase();

// --- Permissions (UX only; the server checks again, CONTRACTS §19) -----------

/** Importing into a new table: base admins only. */
export function canImportNewTable(access: Access): boolean {
  return isBaseAdmin(access);
}

/**
 * Types an import cannot fill whatever the permissions (T411, CONTRACTS §19):
 * files are uploaded, not named in a sheet (the server answers
 * `INVALID_FIELD_TYPE`).
 */
const UNSUPPORTED_TYPES: ReadonlySet<string> = new Set(['attachment']);

/** Types filled by record title (T411): link fields (title lists) and the parent field. */
const TITLE_TYPES: ReadonlySet<string> = new Set(['link', 'parent']);

/** An import cannot fill fields of this type (`attachment`). */
export function isUnsupportedImportType(field: FieldDto): boolean {
  return UNSUPPORTED_TYPES.has(field.type);
}

/** Formula and lookup fields: their values are computed, an import never fills them (T462). */
export function isComputedField(field: FieldDto): boolean {
  return field.type === 'formula' || field.type === 'lookup';
}

/** Whether a field takes values from an import: a writable type the caller may set on create. */
export function isImportTarget(access: Access, tableId: string, field: FieldDto): boolean {
  if (isUnsupportedImportType(field)) return false;
  if (!TITLE_TYPES.has(field.type)) {
    const definition = getFieldType(field.type);
    if (definition === undefined || definition.readOnly) return false;
  }
  return canEditField(access, tableId, field.id, 'create');
}

/** Fields of `fields` an append import may write, in their order. */
export function importTargets(
  access: Access,
  tableId: string,
  fields: readonly FieldDto[],
): FieldDto[] {
  return fields.filter((field) => isImportTarget(access, tableId, field));
}

/** Appending to a table: `edit` + `add` (or base admin) and at least one writable field. */
export function canAppendTo(access: Access, tableId: string, fields: readonly FieldDto[]): boolean {
  const mayAdd = isBaseAdmin(access) || canAddRecord(access, tableId);
  return mayAdd && importTargets(access, tableId, fields).length > 0;
}

// --- New table ---------------------------------------------------------------

export interface NewColumnDraft {
  readonly column: number;
  readonly include: boolean;
  readonly name: string;
  readonly type: ImportFieldType;
}

/** Every column of the preview, named and typed as guessed. */
export function initialNewColumns(preview: ImportPreview): NewColumnDraft[] {
  return preview.columns.map((column) => ({
    column: column.index,
    include: true,
    name: column.name,
    type: column.type,
  }));
}

/** The first imported column becomes the primary field, which must be text (CONTRACTS §19). */
export function primaryColumn(drafts: readonly NewColumnDraft[]): number | undefined {
  return drafts.find((draft) => draft.include)?.column;
}

/** Type sent for `draft`: the primary field is always `text`. */
export function effectiveType(draft: NewColumnDraft, primary: number | undefined): ImportFieldType {
  return draft.column === primary ? 'text' : draft.type;
}

export type TableNameIssue = 'required' | 'taken';
export type ColumnIssue = 'nameRequired' | 'nameDuplicate';

export interface CreateIssues {
  readonly tableName: TableNameIssue | undefined;
  /** By column index. */
  readonly columns: ReadonlyMap<number, ColumnIssue>;
  /** No column is imported. */
  readonly noColumns: boolean;
}

export function validateNewTable(
  tableName: string,
  drafts: readonly NewColumnDraft[],
  existingTables: readonly string[],
): CreateIssues {
  const name = fold(tableName);
  const tableIssue: TableNameIssue | undefined =
    name === ''
      ? 'required'
      : existingTables.some((table) => fold(table) === name)
        ? 'taken'
        : undefined;
  const columns = new Map<number, ColumnIssue>();
  const seen = new Map<string, number>();
  for (const draft of drafts) {
    if (!draft.include) continue;
    const key = fold(draft.name);
    if (key === '') {
      columns.set(draft.column, 'nameRequired');
      continue;
    }
    if (seen.has(key)) columns.set(draft.column, 'nameDuplicate');
    else seen.set(key, draft.column);
  }
  return {
    tableName: tableIssue,
    columns,
    noColumns: !drafts.some((draft) => draft.include),
  };
}

export function hasCreateIssues(issues: CreateIssues): boolean {
  return issues.tableName !== undefined || issues.columns.size > 0 || issues.noColumns;
}

/**
 * `StartImportRequest` of a new table. A column keeps the options guessed
 * for its type (select options, date format) only when its type is still the
 * guessed one.
 */
export function newTableRequest(
  uploadId: string,
  tableName: string,
  drafts: readonly NewColumnDraft[],
  columns: readonly ImportColumn[],
): StartImportRequest {
  const primary = primaryColumn(drafts);
  const guessed = new Map(columns.map((column) => [column.index, column]));
  return {
    upload_id: uploadId as StartImportRequest['upload_id'],
    mode: 'create_table',
    table: {
      name: tableName.trim(),
      columns: drafts
        .filter((draft) => draft.include)
        .map((draft) => {
          const type = effectiveType(draft, primary);
          const guess = guessed.get(draft.column);
          const options =
            guess !== undefined && guess.type === type && Object.keys(guess.options).length > 0
              ? { options: guess.options }
              : {};
          return { column: draft.column, name: draft.name.trim(), type, ...options };
        }),
    },
  };
}

// --- Append ------------------------------------------------------------------

/** Column index → field id (`null`: not imported). */
export type AppendMapping = ReadonlyMap<number, string | null>;

/** Maps each column to the writable field of the same name (ignoring case), each field once. */
export function autoMapping(
  columns: readonly ImportColumn[],
  targets: readonly FieldDto[],
): AppendMapping {
  const byName = new Map<string, FieldDto>();
  for (const field of targets)
    if (!byName.has(fold(field.name))) byName.set(fold(field.name), field);
  const used = new Set<string>();
  const mapping = new Map<number, string | null>();
  for (const column of columns) {
    const field = byName.get(fold(column.name));
    if (field !== undefined && !used.has(field.id)) {
      used.add(field.id);
      mapping.set(column.index, field.id);
    } else {
      mapping.set(column.index, null);
    }
  }
  return mapping;
}

/** Why a column is not imported. */
export type ColumnStatus =
  | { readonly kind: 'mapped'; readonly fieldId: string }
  /** The user chose not to import it although a writable field fits. */
  | { readonly kind: 'skipped' }
  /** Its name matches a field the user may not write (read-only, system). */
  | { readonly kind: 'readOnly'; readonly fieldName: string }
  /** Its name matches a formula/lookup field: computed, never imported (T462). */
  | { readonly kind: 'computed'; readonly fieldName: string }
  /** Its name matches a field of a type an import cannot fill (attachment, T411). */
  | { readonly kind: 'unsupported'; readonly fieldName: string }
  /** No field of that name. */
  | { readonly kind: 'noMatch' };

export interface AppendAnalysis {
  readonly statuses: ReadonlyMap<number, ColumnStatus>;
  /** Fields chosen for more than one column. */
  readonly duplicates: ReadonlySet<string>;
  /** Required fields without a default that no column fills: every row would be skipped. */
  readonly missingRequired: readonly FieldDto[];
  readonly mappedCount: number;
}

function hasDefault(field: FieldDto): boolean {
  const value = (field.options as { default_value?: unknown }).default_value;
  return value !== undefined && value !== null && value !== '';
}

/**
 * The state of an append mapping: what each column does, and what blocks
 * the import (a field used twice, a required field left empty, nothing mapped).
 */
export function analyzeAppend(
  columns: readonly ImportColumn[],
  mapping: AppendMapping,
  targets: readonly FieldDto[],
  visibleFields: readonly FieldDto[],
): AppendAnalysis {
  const targetIds = new Set<string>(targets.map((field) => field.id));
  const targetNames = new Set(targets.map((field) => fold(field.name)));
  const readOnlyByName = new Map(
    visibleFields
      .filter((field) => !targetIds.has(field.id))
      .map((field) => [fold(field.name), field] as const),
  );
  const statuses = new Map<number, ColumnStatus>();
  const counts = new Map<string, number>();
  for (const column of columns) {
    const fieldId = mapping.get(column.index) ?? null;
    if (fieldId !== null && targetIds.has(fieldId)) {
      statuses.set(column.index, { kind: 'mapped', fieldId });
      counts.set(fieldId, (counts.get(fieldId) ?? 0) + 1);
      continue;
    }
    const readOnly = readOnlyByName.get(fold(column.name));
    if (targetNames.has(fold(column.name))) statuses.set(column.index, { kind: 'skipped' });
    else if (readOnly !== undefined)
      statuses.set(column.index, {
        kind: isUnsupportedImportType(readOnly)
          ? 'unsupported'
          : isComputedField(readOnly)
            ? 'computed'
            : 'readOnly',
        fieldName: readOnly.name,
      });
    else statuses.set(column.index, { kind: 'noMatch' });
  }
  const duplicates = new Set(
    [...counts].filter(([, count]) => count > 1).map(([fieldId]) => fieldId),
  );
  const mapped = new Set(counts.keys());
  const missingRequired = visibleFields.filter(
    (field) => field.required && !mapped.has(field.id) && !hasDefault(field),
  );
  return { statuses, duplicates, missingRequired, mappedCount: counts.size };
}

export function canStartAppend(analysis: AppendAnalysis): boolean {
  return (
    analysis.mappedCount > 0 &&
    analysis.duplicates.size === 0 &&
    analysis.missingRequired.length === 0
  );
}

// --- Links, parents and files (T411, T419) ------------------------------------

/** A column filled by record titles: a link or parent field (CONTRACTS §19). */
export interface TitleColumn {
  readonly column: ImportColumn;
  readonly field: FieldDto;
  /** Table whose records the titles name (the table itself for `parent`); `null` unknown. */
  readonly tableId: string | null;
}

/** The mapped columns that fill link or parent fields, in file order. */
export function titleColumns(
  columns: readonly ImportColumn[],
  mapping: AppendMapping,
  fields: ReadonlyMap<string, FieldDto>,
  tableId: string,
): TitleColumn[] {
  return columns.flatMap((column) => {
    const fieldId = mapping.get(column.index) ?? null;
    const field = fieldId === null ? undefined : fields.get(fieldId);
    if (field === undefined || !TITLE_TYPES.has(field.type)) return [];
    const linked = (field.options as { link_table?: unknown }).link_table;
    return [
      {
        column,
        field,
        tableId: field.type === 'parent' ? tableId : typeof linked === 'string' ? linked : null,
      },
    ];
  });
}

/**
 * Fields the user sees that an import can never fill whatever the
 * permissions (attachments, T411): listed disabled with their reason in the
 * field choice of every column, so nobody looks for them in vain.
 */
export function unsupportedFields(visibleFields: readonly FieldDto[]): FieldDto[] {
  return visibleFields.filter(isUnsupportedImportType);
}

/** Row error codes of link and parent cells (CONTRACTS §19, T411). */
export const LINK_ROW_CODES = ['LINK_TARGET_NOT_FOUND', 'LINK_TARGET_AMBIGUOUS'] as const;
export type LinkRowCode = (typeof LINK_ROW_CODES)[number];

export function isLinkRowCode(code: string): code is LinkRowCode {
  return (LINK_ROW_CODES as readonly string[]).includes(code);
}

/** How many of the listed row errors are titles not found / matching several records. */
export function linkErrorCounts(errors: readonly { readonly code: string }[]): {
  readonly notFound: number;
  readonly ambiguous: number;
} {
  let notFound = 0;
  let ambiguous = 0;
  for (const error of errors) {
    if (error.code === 'LINK_TARGET_NOT_FOUND') notFound += 1;
    else if (error.code === 'LINK_TARGET_AMBIGUOUS') ambiguous += 1;
  }
  return { notFound, ambiguous };
}

export function appendRequest(
  uploadId: string,
  tableId: string,
  mapping: AppendMapping,
): StartImportRequest {
  return {
    upload_id: uploadId as StartImportRequest['upload_id'],
    mode: 'append',
    table_id: tableId as Extract<StartImportRequest, { mode: 'append' }>['table_id'],
    mapping: [...mapping]
      .filter((entry): entry is [number, string] => entry[1] !== null)
      .sort(([a], [b]) => a - b)
      .map(([column, fieldId]) => ({
        column,
        field_id: fieldId as Extract<
          StartImportRequest,
          { mode: 'append' }
        >['mapping'][number]['field_id'],
      })),
  };
}
