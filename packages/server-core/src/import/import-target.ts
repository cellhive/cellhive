import {
  type Id,
  type ImportNewColumn,
  type ProblemErrorItem,
  type StartImportRequest,
} from '@cellhive/contracts';
import { fieldConfigSchema, getFieldType, isS1FieldType } from '@cellhive/field-types';

import { AppError } from '../errors/app-error.js';
import { formatIssuePath, zodIssuesToProblemErrors } from '../errors/zod-issues.js';

import type { FieldRow } from '../db/schema.js';
import type { ResolvedBaseAccess } from '@cellhive/permissions';

/** What an import writes: the new table's columns, or an existing table and its mapping. */
export type ImportSpec =
  | {
      readonly mode: 'create_table';
      readonly table: {
        readonly name: string;
        readonly columns: readonly ImportNewColumn[];
      };
    }
  | {
      readonly mode: 'append';
      readonly table_id: Id<'tbl'>;
      readonly mapping: readonly { readonly column: number; readonly field_id: Id<'fld'> }[];
    };

/** The start request without its upload id. */
export function importSpecOf(request: StartImportRequest): ImportSpec {
  return request.mode === 'create_table'
    ? { mode: 'create_table', table: request.table }
    : { mode: 'append', table_id: request.table_id, mapping: request.mapping };
}

/**
 * Field types an append import cannot fill (T411): files are uploaded, not
 * named in a sheet. Other types are refused only when not writable.
 */
const NOT_IMPORTABLE_TYPES: ReadonlySet<string> = new Set(['attachment']);
const isImportableType = (type: string): boolean => !NOT_IMPORTABLE_TYPES.has(type);

const failed = (detail: string, errors: ProblemErrorItem[]) =>
  new AppError('VALIDATION_FAILED', { detail, errors });

function checkColumns(
  columns: readonly number[],
  columnCount: number,
  path: (index: number) => string,
): ProblemErrorItem[] {
  return columns.flatMap((column, index) =>
    column < columnCount
      ? []
      : [
          {
            path: path(index),
            code: 'UNKNOWN_COLUMN',
            message: 'The file has no such column',
            params: { columns: columnCount },
          },
        ],
  );
}

/**
 * Checks a `create_table` import before it is queued and again when the job
 * starts (CONTRACTS §19): base admin (`403`), known columns used once, the
 * first column a `text` field (the primary field), names unique ignoring
 * case, valid field options, and no more columns than a table may have
 * fields (`TOO_MANY_COLUMNS`, SPEC §5.4). Table name conflicts are checked
 * by `SchemaService` (`409 NAME_CONFLICT`).
 */
export function checkCreateTableImport(
  spec: Extract<ImportSpec, { mode: 'create_table' }>,
  context: { readonly isAdmin: boolean; readonly columnCount: number; readonly maxFields: number },
): void {
  if (!context.isAdmin) {
    throw new AppError('PERMISSION_DENIED', {
      detail: 'Only base admins can create a table from an import.',
    });
  }
  const { columns } = spec.table;
  const path = (index: number, key: string) => formatIssuePath(['table', 'columns', index, key]);
  if (columns.length > context.maxFields) {
    throw failed('The file has more columns than a table can have fields.', [
      {
        path: 'table.columns',
        code: 'TOO_MANY_COLUMNS',
        message: 'Too many columns for one table',
        params: { limit: context.maxFields },
      },
    ]);
  }
  const errors = checkColumns(
    columns.map((item) => item.column),
    context.columnCount,
    (index) => path(index, 'column'),
  );
  const usedColumns = new Set<number>();
  const usedNames = new Set<string>();
  columns.forEach((item, index) => {
    if (usedColumns.has(item.column)) {
      errors.push({
        path: path(index, 'column'),
        code: 'DUPLICATE_COLUMN',
        message: 'The column is imported twice',
      });
    }
    usedColumns.add(item.column);
    const name = item.name.normalize('NFC').trim().toLowerCase();
    if (usedNames.has(name)) {
      errors.push({
        path: path(index, 'name'),
        code: 'DUPLICATE_FIELD',
        message: 'Two columns have the same name',
      });
    }
    usedNames.add(name);
    if (index === 0 && item.type !== 'text') {
      errors.push({
        path: path(index, 'type'),
        code: 'INVALID_FIELD_TYPE',
        message: 'The first column becomes the primary field and must be text',
        params: { expected: 'text', type: item.type },
      });
    }
    const config = fieldConfigSchema.safeParse({ type: item.type, options: item.options ?? {} });
    if (!config.success) {
      errors.push(
        ...zodIssuesToProblemErrors(config.error.issues).map((issue) => ({
          ...issue,
          path: `${formatIssuePath(['table', 'columns', index])}${issue.path === '' ? '' : `.${issue.path}`}`,
        })),
      );
    }
  });
  if (errors.length > 0) throw failed('The columns of the import are invalid.', errors);
}

/**
 * Checks an `append` import before it is queued and again when the job
 * starts (CONTRACTS §19), with the caller's current access: the table must
 * be visible (`404`), writable with the `add` operation (`403`); every
 * mapped field must be visible (`422 UNKNOWN_FIELD`, like a missing one),
 * mapped once (`DUPLICATE_FIELD`), of a type an import can fill
 * (`attachment` is not: `422 INVALID_FIELD_TYPE`, T411) and writable by the
 * caller on create (`403 FIELD_READ_ONLY`: field permission `read`,
 * computed and system fields); columns must exist in the file
 * (`UNKNOWN_COLUMN`). `link` and `parent` fields take titles (T411).
 */
export function checkAppendImport(
  spec: Extract<ImportSpec, { mode: 'append' }>,
  context: {
    readonly resolved: ResolvedBaseAccess;
    readonly fields: readonly FieldRow[];
    readonly columnCount: number;
  },
): void {
  const tableAccess = context.resolved.access.tables[spec.table_id];
  if (tableAccess === undefined) throw new AppError('NOT_FOUND');
  if (tableAccess.perm === 'read_only' || !tableAccess.operations.includes('add')) {
    throw new AppError('PERMISSION_DENIED', {
      detail: 'You cannot add records to this table.',
    });
  }
  const byId = new Map(context.fields.map((field) => [field.id, field]));
  const path = (index: number, key: string) => formatIssuePath(['mapping', index, key]);
  const unknown: ProblemErrorItem[] = checkColumns(
    spec.mapping.map((item) => item.column),
    context.columnCount,
    (index) => path(index, 'column'),
  );
  const readOnly: ProblemErrorItem[] = [];
  const seen = new Set<string>();
  spec.mapping.forEach((item, index) => {
    const field = byId.get(item.field_id);
    const perm = tableAccess.fields[item.field_id];
    if (field === undefined || field.table_id !== spec.table_id || perm === undefined) {
      unknown.push({
        path: path(index, 'field_id'),
        code: 'UNKNOWN_FIELD',
        // Same message for a hidden field and a missing one (CONTRACTS §6).
        message: 'Field does not exist',
      });
      return;
    }
    if (seen.has(field.id)) {
      unknown.push({
        path: path(index, 'field_id'),
        code: 'DUPLICATE_FIELD',
        message: 'The field is mapped twice',
      });
    }
    seen.add(field.id);
    if (!isImportableType(field.type)) {
      unknown.push({
        path: path(index, 'field_id'),
        code: 'INVALID_FIELD_TYPE',
        message: 'An import cannot fill fields of this type',
        params: { type: field.type },
      });
      return;
    }
    const permits = perm === 'edit' || perm === 'create';
    let writable: boolean;
    if (field.type === 'link') {
      // Values live in the junction (T401): titles are resolved by the record service.
      writable = permits && field.link_junction !== null && field.compute_mode === null;
    } else if (field.type === 'parent') {
      writable = permits;
    } else {
      const definition = isS1FieldType(field.type) ? getFieldType(field.type) : undefined;
      writable =
        permits &&
        definition !== undefined &&
        !definition.readOnly &&
        field.db_column_name !== null &&
        field.compute_mode === null;
    }
    if (!writable) {
      // Formula/lookup values are computed (T462): say so rather than "no permission".
      // Buttons hold no value (T517).
      const computed =
        field.type === 'formula' || field.type === 'lookup' || field.type === 'button';
      readOnly.push({
        path: path(index, 'field_id'),
        code: 'FIELD_READ_ONLY',
        message: computed
          ? field.type === 'button'
            ? 'Button fields hold no value and cannot be imported'
            : 'Formula and lookup fields are computed and cannot be imported'
          : 'You cannot write this field',
        ...(computed ? { params: { type: field.type } } : {}),
      });
    }
  });
  if (unknown.length > 0) throw failed('The mapping of the import is invalid.', unknown);
  if (readOnly.length > 0) {
    throw new AppError('FIELD_READ_ONLY', {
      detail: 'The mapping writes fields you can only read.',
      errors: readOnly,
    });
  }
}
