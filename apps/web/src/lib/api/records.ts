import {
  deletedRecordsResponseSchema,
  purgedRecordsResponseSchema,
  recordHistoryResponseSchema,
  recordGroupCountsResponseSchema,
  recordListResponseSchema,
  recordSchema,
  recordsResponseSchema,
  recordSummariesResponseSchema,
  recordTrashResponseSchema,
  revertedRecordSchema,
  upsertRecordsResponseSchema,
  type CellFormat,
  type FieldKeyType,
  type RecordGroupCountsRequest,
  type RecordSummariesRequest,
  type RevertRecordRequest,
  type UpdateRecordRequest,
  type UpdateRecordsRequest,
  type recordQueryRequestSchema,
} from '@cellhive/contracts';

import { apiRequest, apiRequestOptional, UNCHECKED_SCHEMA } from './client';

import type { z } from 'zod';

/** Responses are checked in development only (FRONTEND §3.1); production builds drop the schemas (T700). */
const DEV = import.meta.env.DEV;
const id = encodeURIComponent;

/** Body of `POST …/records/query`, with the defaults (`offset`, `limit`, `include_total`) optional. */
export type RecordQueryBody = z.input<typeof recordQueryRequestSchema>;

/**
 * How cells are keyed and rendered (CONTRACTS §1.3). The web client keys
 * by field id (renaming a field never breaks a view) and reads JSON values,
 * as the grid does (FRONTEND §3.1); pass `name`/`text` only on purpose.
 */
export interface ReadOptions {
  signal?: AbortSignal | undefined;
  fieldKeyType?: FieldKeyType;
  cellFormat?: CellFormat;
}

export interface WriteOptions {
  fieldKeyType?: FieldKeyType;
  /** Accept the extra input forms of CONTRACTS §2 (paste, F§6.3). */
  typecast?: boolean;
  idempotencyKey?: string | undefined;
}

export interface CursorOptions {
  cursor?: string | null | undefined;
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
  fieldKeyType?: FieldKeyType;
}

function readParams(options: ReadOptions) {
  return {
    field_key_type: options.fieldKeyType ?? 'id',
    cell_format: options.cellFormat ?? 'json',
  };
}

function writeParams(options: WriteOptions) {
  return {
    field_key_type: options.fieldKeyType ?? 'id',
    typecast: options.typecast === true ? true : undefined,
  };
}

function cursorParams(options: CursorOptions) {
  return {
    field_key_type: options.fieldKeyType ?? 'id',
    cursor: options.cursor ?? undefined,
    limit: options.limit,
  };
}

/** New record input: `{ fields }` keyed per `field_key_type`. */
export interface NewRecord {
  fields: Readonly<Record<string, unknown>>;
}

/**
 * Records (CONTRACTS §1.3–1.4, §11). Every function maps a failure to an
 * `ApiError` (problem+json); the grid adds `version` to every update
 * (FRONTEND §4.1).
 */
export const recordsApi = {
  /** Windowed reads of the grid, realtime `ids` lookups (`POST …/records/query`). */
  query: (tableId: string, body: RecordQueryBody, options: ReadOptions = {}) =>
    apiRequest(
      `/tables/${id(tableId)}/records/query`,
      DEV ? recordListResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        query: readParams(options),
        body,
        signal: options.signal,
      },
    ),
  /**
   * Rows per group value (`POST …/records/group-counts`, CONTRACTS §1.4):
   * same WHERE as `query`; the kanban columns count their cards with it.
   */
  groupCounts: (tableId: string, body: RecordGroupCountsRequest, options: ReadOptions = {}) =>
    apiRequest(
      `/tables/${id(tableId)}/records/group-counts`,
      DEV ? recordGroupCountsResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        query: readParams(options),
        body,
        signal: options.signal,
      },
    ),
  /**
   * The summary bar (`POST …/records/summaries`, T472, CONTRACTS §1.4):
   * same WHERE as `query`, one aggregate per field and group.
   */
  summaries: (tableId: string, body: RecordSummariesRequest, options: ReadOptions = {}) =>
    apiRequest(
      `/tables/${id(tableId)}/records/summaries`,
      DEV ? recordSummariesResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        query: readParams(options),
        body,
        signal: options.signal,
      },
    ),
  get: (
    tableId: string,
    recordId: string,
    options: ReadOptions & { fields?: readonly string[] } = {},
  ) =>
    apiRequest(
      `/tables/${id(tableId)}/records/${id(recordId)}`,
      DEV ? recordSchema : UNCHECKED_SCHEMA,
      {
        query: { ...readParams(options), fields: options.fields },
        signal: options.signal,
      },
    ),
  /** Creates 1–1 000 records; the ones the caller cannot read afterwards are left out. */
  create: (tableId: string, records: readonly NewRecord[], options: WriteOptions = {}) =>
    apiRequest(`/tables/${id(tableId)}/records`, DEV ? recordsResponseSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      query: writeParams(options),
      body: { records },
      idempotencyKey: options.idempotencyKey,
    }),
  /** Bulk update: one request, one history batch (FRONTEND §4.2). */
  update: (tableId: string, records: UpdateRecordsRequest['records'], options: WriteOptions = {}) =>
    apiRequest(`/tables/${id(tableId)}/records`, DEV ? recordsResponseSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      query: writeParams(options),
      body: { records },
    }),
  upsert: (
    tableId: string,
    body: Required<Pick<UpdateRecordsRequest, 'upsert'>> & Pick<UpdateRecordsRequest, 'records'>,
    options: WriteOptions = {},
  ) =>
    apiRequest(
      `/tables/${id(tableId)}/records`,
      DEV ? upsertRecordsResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'PATCH',
        query: writeParams(options),
        body,
      },
    ),
  /** One record; `null` when the caller can no longer read it (`204`). */
  updateOne: (
    tableId: string,
    recordId: string,
    body: UpdateRecordRequest,
    options: WriteOptions = {},
  ) =>
    apiRequestOptional(
      `/tables/${id(tableId)}/records/${id(recordId)}`,
      DEV ? recordSchema : UNCHECKED_SCHEMA,
      {
        method: 'PATCH',
        query: writeParams(options),
        body,
      },
    ),
  /** Soft delete (moves to the trash); answers the ids moved. */
  remove: (tableId: string, ids: readonly string[]) =>
    apiRequest(
      `/tables/${id(tableId)}/records`,
      DEV ? deletedRecordsResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'DELETE',
        body: { ids },
      },
    ),
  restore: (tableId: string, ids: readonly string[], options: WriteOptions = {}) =>
    apiRequest(
      `/tables/${id(tableId)}/records/restore`,
      DEV ? recordsResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        body: { ids },
        idempotencyKey: options.idempotencyKey,
      },
    ),
  /**
   * Permanent delete from the trash (T408, CONTRACTS §11.3): schema right
   * only; `branch` also purges the sub-records deleted together.
   */
  purge: (tableId: string, ids: readonly string[], branch = false) =>
    apiRequest(
      `/tables/${id(tableId)}/records/trash/purge`,
      DEV ? purgedRecordsResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        body: branch ? { ids, branch: true } : { ids },
      },
    ),
  /** Trash of a table, newest deletion first (CONTRACTS §11.3), cursor pages. */
  trash: (tableId: string, options: CursorOptions = {}) =>
    apiRequest(
      `/tables/${id(tableId)}/records/trash`,
      DEV ? recordTrashResponseSchema : UNCHECKED_SCHEMA,
      {
        query: cursorParams(options),
        signal: options.signal,
      },
    ),
  /** History of a record (CONTRACTS §11.1); `field` keeps one field's changes. */
  history: (
    tableId: string,
    recordId: string,
    options: CursorOptions & { field?: string | undefined } = {},
  ) =>
    apiRequest(
      `/tables/${id(tableId)}/records/${id(recordId)}/history`,
      DEV ? recordHistoryResponseSchema : UNCHECKED_SCHEMA,
      { query: { ...cursorParams(options), field: options.field }, signal: options.signal },
    ),
  /**
   * Sets fields back to before a history entry (CONTRACTS §11.2); `null` on
   * `204`. `skipped` (T465): linked records left out because deleted since.
   */
  revert: (
    tableId: string,
    recordId: string,
    body: RevertRecordRequest,
    options: Pick<WriteOptions, 'fieldKeyType' | 'idempotencyKey'> = {},
  ) =>
    apiRequestOptional(
      `/tables/${id(tableId)}/records/${id(recordId)}/revert`,
      DEV ? revertedRecordSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        query: { field_key_type: options.fieldKeyType ?? 'id' },
        body,
        idempotencyKey: options.idempotencyKey,
      },
    ),
};
