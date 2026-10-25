import { MAX_RECORDS_PER_REQUEST, type ProblemErrorItem } from '@cellhive/contracts';

import { isApiError } from '../../lib/api/client';

/** At most this many ids per `POST …/records/restore` (bulk limit of CONTRACTS §2). */
export const RESTORE_CHUNK_SIZE = MAX_RECORDS_PER_REQUEST;

/** Why one record was not restored. */
export interface RestoreFailure {
  /** The `errors[]` item naming this record (`UNIQUE_VIOLATION`, `NOT_FOUND`…), when there is one. */
  item: ProblemErrorItem | undefined;
  /** The failed request. */
  error: unknown;
}

export interface RestoreOutcome {
  restored: string[];
  failed: Map<string, RestoreFailure>;
}

const ID_PATH = /^ids\[(\d+)\]/u;

/**
 * `errors[]` items of a refused restore that name a record of `ids` by its
 * index (`ids[3]`, CONTRACTS §6). Empty when the failure is not about
 * particular records (network, rate limit, no permission on the table…).
 */
function recordIssues(error: unknown, ids: readonly string[]): Map<string, ProblemErrorItem> {
  const issues = new Map<string, ProblemErrorItem>();
  if (!isApiError(error)) return issues;
  for (const item of error.errors) {
    const match = ID_PATH.exec(item.path);
    const id = match === null ? undefined : ids[Number(match[1])];
    if (id !== undefined && !issues.has(id)) issues.set(id, item);
  }
  return issues;
}

/**
 * Restores `ids` in chunks of at most `chunkSize` (FRONTEND §10.4). A chunk
 * is atomic on the server: when it is refused because of some records
 * (`422 UNIQUE_VIOLATION`, `404` for a record no longer in the trash…),
 * those records are set aside with their error and the rest of the chunk is
 * sent again, so one bad record never blocks the others. A failure that
 * names no record fails the whole chunk.
 */
export async function restoreInChunks(
  ids: readonly string[],
  restore: (chunk: readonly string[]) => Promise<unknown>,
  chunkSize = RESTORE_CHUNK_SIZE,
): Promise<RestoreOutcome> {
  const restored: string[] = [];
  const failed = new Map<string, RestoreFailure>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += chunkSize) {
    let pending = unique.slice(start, start + chunkSize);
    while (pending.length > 0) {
      try {
        await restore(pending);
        restored.push(...pending);
        break;
      } catch (error) {
        const issues = recordIssues(error, pending);
        if (issues.size === 0) {
          for (const id of pending) failed.set(id, { item: undefined, error });
          break;
        }
        for (const [id, item] of issues) failed.set(id, { item, error });
        pending = pending.filter((id) => !issues.has(id));
      }
    }
  }
  return { restored, failed };
}

/**
 * Permanently deletes `ids` in chunks of at most `chunkSize` (T408); stops at
 * the first refused chunk (its error is thrown; earlier chunks are gone for
 * good). Answers every id deleted, sub-records of a branch included.
 */
export async function purgeInChunks(
  ids: readonly string[],
  purge: (chunk: readonly string[]) => Promise<{ ids: readonly string[] }>,
  chunkSize = RESTORE_CHUNK_SIZE,
): Promise<string[]> {
  const purged: string[] = [];
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += chunkSize) {
    const response = await purge(unique.slice(start, start + chunkSize));
    purged.push(...response.ids);
  }
  return purged;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Records and fields stay in the trash this long (ADR-23 §3, CONTRACTS §11.3). */
export const TRASH_RETENTION_DAYS = 30;

/** Whole days until a deletion at `deletedAt` is purged (0 when due). */
export function daysLeft(deletedAt: string, now: Date = new Date()): number {
  const purgeAt = new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * DAY_MS;
  return Math.max(0, Math.ceil((purgeAt - now.getTime()) / DAY_MS));
}

/** At or below this many days left, the deletion is shown as a warning. */
export const DAYS_LEFT_WARNING = 2;
