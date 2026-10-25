import { recordFollowSchema, type RecordFollowDto } from '@cellhive/contracts';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { apiRequest, apiRequestVoid, isApiError } from '../api/client';
import { keys } from '../query/keys';
import { showErrorToast } from '../toast/toast';

/**
 * Following a record (T553, CONTRACTS §22.5): the follow button of the
 * record panel (`features/record/follow`) and the "Follow" / "Unfollow"
 * item of the grid and kanban menus share this state, so a toggle in one
 * place shows everywhere. Only for the caller, on records they can read;
 * never on share links (no route there). Not realtime (a personal
 * setting): the panel asks again when the record changes, since being
 * assigned to it may have started a follow (T544).
 */

const id = encodeURIComponent;
const followPath = (tableId: string, recordId: string) =>
  `/tables/${id(tableId)}/records/${id(recordId)}/follow`;

/** `GET|PUT|DELETE /tables/:tableId/records/:recordId/follow`. */
export const recordFollowApi = {
  get: (tableId: string, recordId: string, signal?: AbortSignal) =>
    apiRequest(followPath(tableId, recordId), recordFollowSchema, { signal }),
  /** `204`; idempotent: a follow already there keeps its source. */
  follow: (tableId: string, recordId: string) =>
    apiRequestVoid(followPath(tableId, recordId), { method: 'PUT' }),
  /** `204`; idempotent. Unfollowing by hand wins over every automatic follow of the record. */
  unfollow: (tableId: string, recordId: string) =>
    apiRequestVoid(followPath(tableId, recordId), { method: 'DELETE' }),
};

export const recordFollowQuery = (tableId: string, recordId: string) =>
  queryOptions({
    queryKey: keys.recordFollow(tableId, recordId),
    queryFn: ({ signal }) => recordFollowApi.get(tableId, recordId, signal),
  });

/**
 * What the button shows right after a toggle, before the server answers:
 * a new follow is `manual` (what `PUT` records when there was none), a
 * follow already there keeps its source.
 */
export function optimisticFollow(
  previous: RecordFollowDto | undefined,
  following: boolean,
): RecordFollowDto {
  if (!following) return { following: false, source: null };
  return previous?.following === true ? previous : { following: true, source: 'manual' };
}

/**
 * `done`: saved; `gone`: the record was deleted or is out of reach (`404`,
 * the caller says so); `failed`: refused or not sent (an error toast was
 * shown — `TOO_MANY_FOLLOWS` is translated by its code — and the state
 * went back to what the server holds).
 */
export type FollowOutcome = 'done' | 'gone' | 'failed';

/** Requests of one record run one after the other, in the order of the clicks. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Follows or unfollows a record, optimistically: the cached state changes
 * at once, the request follows the earlier ones of the same record, and a
 * failure puts the state back (when no later toggle is on its way, which
 * then decides) and asks the server again.
 */
export async function setRecordFollow(
  client: QueryClient,
  tableId: string,
  recordId: string,
  following: boolean,
): Promise<FollowOutcome> {
  const key = keys.recordFollow(tableId, recordId);
  // A read on its way would overwrite the optimistic state with an older one.
  await client.cancelQueries({ queryKey: key, exact: true });
  const previous = client.getQueryData<RecordFollowDto>(key);
  client.setQueryData<RecordFollowDto>(key, optimisticFollow(previous, following));

  const queueKey = `${tableId}/${recordId}`;
  const before = queues.get(queueKey) ?? Promise.resolve();
  const request = before
    .catch(() => undefined)
    .then(() =>
      following
        ? recordFollowApi.follow(tableId, recordId)
        : recordFollowApi.unfollow(tableId, recordId),
    );
  queues.set(queueKey, request);
  try {
    await request;
    return 'done';
  } catch (error) {
    const latest = queues.get(queueKey) === request;
    if (isApiError(error) && error.status === 404) {
      client.setQueryData<RecordFollowDto>(key, { following: false, source: null });
      return 'gone';
    }
    if (latest) {
      client.setQueryData<RecordFollowDto>(
        key,
        previous ?? optimisticFollow(undefined, !following),
      );
    }
    void client.invalidateQueries({ queryKey: key, exact: true });
    showErrorToast(error);
    return 'failed';
  } finally {
    if (queues.get(queueKey) === request) queues.delete(queueKey);
  }
}

export interface RecordFollow {
  /** `undefined` while it loads, or when it could not be read. */
  readonly state: RecordFollowDto | undefined;
  /** The first read is on its way. */
  readonly loading: boolean;
  /** The record is out of reach (`GET` answered `404`). */
  readonly gone: boolean;
  /** Follows (`true`) or unfollows (`false`), see {@link setRecordFollow}. */
  readonly set: (following: boolean) => Promise<FollowOutcome>;
}

/** Whether the caller follows a record, and the toggle. */
export function useRecordFollow(tableId: string, recordId: string, enabled = true): RecordFollow {
  const client = useQueryClient();
  const query = useQuery({ ...recordFollowQuery(tableId, recordId), enabled });
  const set = useCallback(
    (following: boolean) => setRecordFollow(client, tableId, recordId, following),
    [client, tableId, recordId],
  );
  return {
    state: query.data,
    loading: enabled && query.isPending && query.fetchStatus !== 'idle',
    gone: isApiError(query.error) && query.error.status === 404,
    set,
  };
}
