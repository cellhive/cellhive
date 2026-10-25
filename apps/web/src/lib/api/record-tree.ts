import {
  deletedRecordsResponseSchema,
  recordAncestorsResponseSchema,
  recordListResponseSchema,
  recordSchema,
  recordsResponseSchema,
  recordTreeResponseSchema,
  type recordTreeRequestSchema,
  type SubrecordDeleteMode,
} from '@cellhive/contracts';

import { apiRequest, apiRequestOptional } from './client';

import type { ReadOptions } from './records';
import type { z } from 'zod';

const id = encodeURIComponent;

/** Body of `POST …/records/tree` with the defaults (`offset`, `limit`, `include_total`) optional. */
export type RecordTreeBody = z.input<typeof recordTreeRequestSchema>;

/**
 * Sub-records (SPEC §5.7, CONTRACTS §1.4, T405 → T417): one level of the
 * tree for the grid, children and ancestors for the record panel, parent
 * changes (drag, indent, outdent), delete with the children's fate and
 * restore of a whole branch. Cells are keyed by field id and read as JSON,
 * like the other record reads of the web client (FRONTEND §3.1).
 */
export const recordTreeApi = {
  /** One level: the roots (`parent_id` null) or the children of an expanded record. */
  level: (tableId: string, body: RecordTreeBody, options: ReadOptions = {}) =>
    apiRequest(`/tables/${id(tableId)}/records/tree`, recordTreeResponseSchema, {
      method: 'POST',
      query: { field_key_type: 'id', cell_format: 'json' },
      body,
      signal: options.signal,
    }),
  /** Live children the caller reads (`__auto` order): the panel's "Sub-records". */
  children: (
    tableId: string,
    recordId: string,
    options: ReadOptions & { offset?: number; limit?: number } = {},
  ) =>
    apiRequest(
      `/tables/${id(tableId)}/records/${id(recordId)}/children`,
      recordListResponseSchema,
      {
        query: {
          field_key_type: 'id',
          cell_format: 'json',
          offset: options.offset,
          limit: options.limit,
        },
        signal: options.signal,
      },
    ),
  /** Parent path, root first; ancestors the caller cannot read are `locked` placeholders. */
  ancestors: (tableId: string, recordId: string, options: ReadOptions = {}) =>
    apiRequest(
      `/tables/${id(tableId)}/records/${id(recordId)}/ancestors`,
      recordAncestorsResponseSchema,
      { signal: options.signal },
    ),
  /**
   * New parent of a record (`null`: a root). No `version`: another field
   * edited meanwhile is no conflict for a move. `null` when the record left
   * what the caller reads (`204`).
   */
  setParent: (tableId: string, recordId: string, parentId: string | null) =>
    apiRequestOptional(`/tables/${id(tableId)}/records/${id(recordId)}`, recordSchema, {
      method: 'PATCH',
      query: { field_key_type: 'id' },
      body: { fields: {}, parent_id: parentId },
    }),
  /** A new record under `parentId` (the grid's "+ Sub-record", the panel's list). */
  createChild: (
    tableId: string,
    parentId: string,
    fields: Readonly<Record<string, unknown>> = {},
  ) =>
    apiRequest(`/tables/${id(tableId)}/records`, recordsResponseSchema, {
      method: 'POST',
      query: { field_key_type: 'id' },
      body: { records: [{ fields, parent_id: parentId }] },
    }),
  /** Soft delete; `children`: `promote` (default) makes the children roots, `delete` trashes the branch. */
  remove: (tableId: string, ids: readonly string[], children: SubrecordDeleteMode) =>
    apiRequest(`/tables/${id(tableId)}/records`, deletedRecordsResponseSchema, {
      method: 'DELETE',
      body: { ids, children },
    }),
  /** Restores records with the descendants deleted together with them ("restore branch"). */
  restoreBranch: (tableId: string, ids: readonly string[]) =>
    apiRequest(`/tables/${id(tableId)}/records/restore`, recordsResponseSchema, {
      method: 'POST',
      body: { ids, branch: true },
    }),
};

export type RecordTreeLevel = z.infer<typeof recordTreeResponseSchema>;
