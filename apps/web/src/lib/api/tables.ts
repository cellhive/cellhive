import {
  fieldListSchema,
  fieldSchema,
  updateFieldResponseSchema,
  MAX_LIST_LIMIT,
  tableListSchema,
  tableSchema,
  computedPreviewResponseSchema,
  convertFieldPreviewSchema,
  convertFieldResponseSchema,
  deletePreviewSchema,
  purgedTableResponseSchema,
  trashedTableListSchema,
  type ComputedPreviewRequest,
  type PurgeTableRequest,
  revertConversionPreviewSchema,
  type ConvertFieldPreviewRequest,
  type ConvertFieldRequest,
  type RevertConversionRequest,
  type CreateFieldRequest,
  type CreateTableRequest,
  type UpdateFieldRequest,
  type UpdateTableRequest,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid, UNCHECKED_SCHEMA } from './client';

/** Responses are checked in development only (FRONTEND §3.1); production builds drop the schemas (T700). */
const DEV = import.meta.env.DEV;
const id = encodeURIComponent;

/**
 * A base has few tables and a table at most `MAX_FIELDS_PER_TABLE` (500)
 * fields (SPEC §5.4): one page of the maximum size holds all of them.
 */
const ALL = { offset: 0, limit: MAX_LIST_LIMIT } as const;

/** Tables (CONTRACTS §13). Tables the caller cannot see are absent. */
export const tablesApi = {
  list: (baseId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/tables`, DEV ? tableListSchema : UNCHECKED_SCHEMA, {
      query: ALL,
      signal,
    }),
  get: (tableId: string, signal?: AbortSignal) =>
    apiRequest(`/tables/${id(tableId)}`, DEV ? tableSchema : UNCHECKED_SCHEMA, { signal }),
  create: (baseId: string, body: CreateTableRequest) =>
    apiRequest(`/bases/${id(baseId)}/tables`, DEV ? tableSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
    }),
  update: (tableId: string, body: UpdateTableRequest) =>
    apiRequest(`/tables/${id(tableId)}`, DEV ? tableSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body,
    }),
  remove: (tableId: string) => apiRequestVoid(`/tables/${id(tableId)}`, { method: 'DELETE' }),
  /**
   * `POST /tables/:id/restore`; (T469) with an `Idempotency-Key`, so that a
   * `429` of a busy base is sent again after `Retry-After` (FRONTEND §3.1).
   */
  restore: (tableId: string) =>
    apiRequest(`/tables/${id(tableId)}/restore`, DEV ? tableSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
  /**
   * (T469) Formula/lookup fields of other tables that deleting the table
   * would put in `REF` (base admins; CONTRACTS §13).
   */
  deletePreview: (tableId: string, signal?: AbortSignal) =>
    apiRequest(
      `/tables/${id(tableId)}/delete-preview`,
      DEV ? deletePreviewSchema : UNCHECKED_SCHEMA,
      { signal },
    ),
  /** (T469) Tables of the base in the trash (base admins; CONTRACTS §13). */
  trash: (baseId: string, signal?: AbortSignal) =>
    apiRequest(
      `/bases/${id(baseId)}/tables/trash`,
      DEV ? trashedTableListSchema : UNCHECKED_SCHEMA,
      { signal },
    ),
  /** (T461, T469) Deletes a table of the trash for good, confirmed by its name. */
  purge: (tableId: string, body: PurgeTableRequest) =>
    apiRequest(`/tables/${id(tableId)}/purge`, DEV ? purgedTableResponseSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
};

/** Fields (CONTRACTS §13). `no_perm` fields are absent (CONTRACTS §2). */
export const fieldsApi = {
  list: (tableId: string, signal?: AbortSignal) =>
    apiRequest(`/tables/${id(tableId)}/fields`, DEV ? fieldListSchema : UNCHECKED_SCHEMA, {
      query: ALL,
      signal,
    }),
  /**
   * Live fields followed by the deleted ones that can still be restored,
   * each with `deleted_at` (`include_deleted=true`, schema managers only).
   */
  listWithTrash: (tableId: string, signal?: AbortSignal) =>
    apiRequest(`/tables/${id(tableId)}/fields`, DEV ? fieldListSchema : UNCHECKED_SCHEMA, {
      query: { ...ALL, include_deleted: true },
      signal,
    }),
  get: (fieldId: string, signal?: AbortSignal) =>
    apiRequest(`/fields/${id(fieldId)}`, DEV ? fieldSchema : UNCHECKED_SCHEMA, { signal }),
  create: (tableId: string, body: CreateFieldRequest) =>
    apiRequest(`/tables/${id(tableId)}/fields`, DEV ? fieldSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
    }),
  update: (fieldId: string, body: UpdateFieldRequest) =>
    apiRequest(`/fields/${id(fieldId)}`, DEV ? updateFieldResponseSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body,
    }),
  /** Type conversion (CONTRACTS §4.4): `202 { job_id, field }`. */
  convert: (fieldId: string, body: ConvertFieldRequest) =>
    apiRequest(`/fields/${id(fieldId)}`, DEV ? convertFieldResponseSchema : UNCHECKED_SCHEMA, {
      method: 'PUT',
      body,
    }),
  /** What a conversion would do (CONTRACTS §4.4), before `convert`. */
  convertPreview: (fieldId: string, body: ConvertFieldPreviewRequest, signal?: AbortSignal) =>
    apiRequest(
      `/fields/${id(fieldId)}/convert-preview`,
      DEV ? convertFieldPreviewSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        body,
        signal,
      },
    ),
  /** What undoing the last conversion would do (7 days, CONTRACTS §4.4). */
  revertPreview: (fieldId: string, signal?: AbortSignal) =>
    apiRequest(
      `/fields/${id(fieldId)}/revert-conversion/preview`,
      DEV ? revertConversionPreviewSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        signal,
      },
    ),
  /** Undoes the last conversion: the field reverted, or the new field (`new_field`). */
  revert: (fieldId: string, body: RevertConversionRequest) =>
    apiRequest(`/fields/${id(fieldId)}/revert-conversion`, DEV ? fieldSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
    }),
  /**
   * (T466, T467) Values a formula or lookup definition would give on the
   * first 5 records the caller reads (CONTRACTS §13, `POST
   * /tables/:id/computed-preview`); `422 FORMULA_*` with positions.
   */
  computedPreview: (tableId: string, body: ComputedPreviewRequest, signal?: AbortSignal) =>
    apiRequest(
      `/tables/${id(tableId)}/computed-preview`,
      DEV ? computedPreviewResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        body,
        signal,
      },
    ),
  remove: (fieldId: string) => apiRequestVoid(`/fields/${id(fieldId)}`, { method: 'DELETE' }),
  /**
   * (T469) What deleting the field would stop: views, roles and the
   * formula/lookup fields that would be `REF` (CONTRACTS §13).
   */
  deletePreview: (fieldId: string, signal?: AbortSignal) =>
    apiRequest(
      `/fields/${id(fieldId)}/delete-preview`,
      DEV ? deletePreviewSchema : UNCHECKED_SCHEMA,
      { signal },
    ),
  restore: (fieldId: string) =>
    apiRequest(`/fields/${id(fieldId)}/restore`, DEV ? fieldSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
    }),
};
