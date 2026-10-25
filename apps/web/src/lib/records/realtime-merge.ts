import { keepKnownTitles } from '../links/values';
import { keys } from '../query/keys';

import type { RecordDto, RecordListResponse, RecordMetaDto } from '@cellhive/contracts';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Realtime `record.updated` patches on the cached copies of a record
 * (FRONTEND §5, CONTRACTS §7): the record query (`keys.record`, record
 * panel) and every grid block of the table (`keys.recordBlocks`).
 */

/** Whether the user's own write of a cell is in flight (`pending`, FRONTEND §4.1). */
export type PendingCellCheck = (recordId: string, fieldId: string) => boolean;

export interface RecordPatch {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly version: number;
  /**
   * `event_id: null`: values recomputed by the system (auto_number), which
   * keep the record's version — applied when `version` ≥ the cached one.
   */
  readonly recomputed: boolean;
  /**
   * (T816) Colors of the record under the rules of the subscribed view
   * (`meta` of `record.updated`): replaces the cached `meta` of the copies
   * read through {@link metaViewId} only — other views have other rules.
   */
  readonly meta?: RecordMetaDto | undefined;
  readonly metaViewId?: string | undefined;
}

/**
 * Merges a `record.updated` patch into a cached record, or returns `null`
 * when it does not apply: an older version (a newer write already reached
 * the cache), or a recomputation for an older version.
 *
 * Cells of the user's own writes still in flight (`pending`) keep their
 * optimistic value: the write's answer puts the server's value back. When
 * such a cell is skipped the cached `version` stays, so that the pending
 * write (sent with that version) still meets `409 VERSION_CONFLICT` if the
 * other change touched the same record.
 */
export function mergeRecordPatch(
  record: RecordDto,
  patch: RecordPatch,
  isPending: PendingCellCheck | null = null,
  withMeta = false,
): RecordDto | null {
  const fresh = patch.recomputed ? patch.version >= record.version : patch.version > record.version;
  if (!fresh) {
    // (T816) The echo of the user's own write (same version, already applied by
    // the write's answer) still brings the colors computed after it.
    if (!withMeta || patch.meta === undefined || patch.version < record.version) return null;
    return sameMeta(record.meta, patch.meta) ? null : { ...record, meta: patch.meta };
  }
  const fields: Record<string, unknown> = { ...record.fields };
  let skipped = false;
  let changed = false;
  for (const [fieldId, value] of Object.entries(patch.fields)) {
    if (isPending?.(record.id, fieldId) === true) {
      skipped = true;
      continue;
    }
    // Link cells (T413): titles withheld from this subscriber (`null`, CONTRACTS §7) keep
    // the title the cell already showed for the same record.
    fields[fieldId] = keepKnownTitles(fields[fieldId], value).value;
    changed = true;
  }
  const version = skipped ? record.version : Math.max(record.version, patch.version);
  const meta = withMeta && patch.meta !== undefined ? patch.meta : record.meta;
  const metaChanged = !sameMeta(meta, record.meta);
  if (!changed && !metaChanged && version === record.version) return null;
  const merged: RecordDto = { ...record, version, fields };
  if (meta !== undefined) merged.meta = meta;
  return merged;
}

/** Whether two record `meta` (T816 colors) say the same. */
function sameMeta(a: RecordMetaDto | undefined, b: RecordMetaDto | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const left = a.color;
  const right = b.color;
  if (left === right) return true;
  if (left === undefined || right === undefined || left.row !== right.row) return false;
  const leftCells = left.cells ?? {};
  const rightCells = right.cells ?? {};
  const keys = Object.keys(leftCells);
  if (keys.length !== Object.keys(rightCells).length) return false;
  return keys.every(
    (key) =>
      leftCells[key as keyof typeof leftCells] === rightCells[key as keyof typeof rightCells],
  );
}

// --- pending cells of every edit flow of a table ------------------------------------

const pendingChecks = new Map<string, Set<PendingCellCheck>>();

/**
 * Registers the pending cells of an edit flow (grid, record panel) of a
 * table; returns the unregistration. Realtime asks all of them.
 */
export function registerPendingCells(tableId: string, check: PendingCellCheck): () => void {
  let checks = pendingChecks.get(tableId);
  if (checks === undefined) {
    checks = new Set();
    pendingChecks.set(tableId, checks);
  }
  checks.add(check);
  return () => {
    const current = pendingChecks.get(tableId);
    current?.delete(check);
    if (current?.size === 0) pendingChecks.delete(tableId);
  };
}

/** Whether any edit flow of the table has a write of this cell in flight. */
export function isCellPending(tableId: string, recordId: string, fieldId: string): boolean {
  for (const check of pendingChecks.get(tableId) ?? []) {
    if (check(recordId, fieldId)) return true;
  }
  return false;
}

/**
 * Applies a `record.updated` patch to every cached copy of the record
 * (record query and grid blocks, all query hashes); pending cells of any
 * edit flow of the table are kept. Returns whether a copy changed.
 */
export function applyRecordPatch(
  queryClient: QueryClient,
  tableId: string,
  recordId: string,
  patch: RecordPatch,
): boolean {
  const isPending: PendingCellCheck = (record, field) => isCellPending(tableId, record, field);
  let applied = false;
  queryClient.setQueryData<RecordDto>(keys.record(tableId, recordId), (record) => {
    if (record === undefined) return record;
    const merged = mergeRecordPatch(record, patch, isPending);
    if (merged === null) return record;
    applied = true;
    return merged;
  });
  const metaView = patch.meta === undefined ? undefined : patch.metaViewId;
  const viewMarker = metaView === undefined ? null : `"view_id":"${metaView}"`;
  for (const [key, data] of queryClient.getQueriesData<RecordListResponse>({
    queryKey: keys.recordBlocks(tableId),
  })) {
    if (data === undefined) continue;
    const index = data.records.findIndex((record) => record.id === recordId);
    const current = data.records[index];
    if (current === undefined) continue;
    // Colors (T816) only on blocks read through the subscribed view (`queryHash` names it).
    const hash = key[3];
    const withMeta = viewMarker !== null && typeof hash === 'string' && hash.includes(viewMarker);
    const merged = mergeRecordPatch(current, patch, isPending, withMeta);
    if (merged === null) continue;
    applied = true;
    const records = [...data.records];
    records[index] = merged;
    queryClient.setQueryData<RecordListResponse>(key, { ...data, records });
  }
  return applied;
}

/**
 * A refetch (after `record.batch`, a reconnect or a stale block) brings the
 * server's rows; cells the user is still writing (`pending`) keep the
 * optimistic value of the cached copy, and such a record keeps its cached
 * `version` — like a skipped cell of a realtime patch, so the write in
 * flight still meets `409` if someone else changed the record. Returns
 * `records` itself when nothing is pending.
 */
export function keepPendingCells(
  queryClient: QueryClient,
  tableId: string,
  records: readonly RecordDto[],
): readonly RecordDto[] {
  if (!pendingChecks.has(tableId) || records.length === 0) return records;
  let blocks: Map<string, RecordDto> | undefined;
  const cachedCopy = (recordId: string): RecordDto | undefined => {
    const own = queryClient.getQueryData<RecordDto>(keys.record(tableId, recordId));
    if (own !== undefined) return own;
    if (blocks === undefined) {
      blocks = new Map();
      for (const [, data] of queryClient.getQueriesData<RecordListResponse>({
        queryKey: keys.recordBlocks(tableId),
      })) {
        for (const record of data?.records ?? []) blocks.set(record.id, record);
      }
    }
    return blocks.get(recordId);
  };
  const next = records.map((record) => {
    const copy = cachedCopy(record.id);
    if (copy === undefined) return record;
    const pending = new Set(
      [...Object.keys(copy.fields), ...Object.keys(record.fields)].filter((fieldId) =>
        isCellPending(tableId, record.id, fieldId),
      ),
    );
    if (pending.size === 0) return record;
    const fields: Record<string, unknown> = Object.fromEntries(
      Object.entries(record.fields).filter(([fieldId]) => !pending.has(fieldId)),
    );
    for (const fieldId of pending) {
      if (Object.hasOwn(copy.fields, fieldId)) fields[fieldId] = copy.fields[fieldId];
    }
    return { ...record, fields, version: copy.version };
  });
  return next.some((record, index) => record !== records[index]) ? next : records;
}
