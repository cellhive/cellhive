import { keys } from '../query/keys';

import type { ChannelMessage } from './socket';
import type { QueryClient } from '@tanstack/react-query';

/**
 * T420 (S3-review §4 #8): the record count of a table (sidebar, footer of
 * a filtered grid, `tableRecordCountQuery`) follows the realtime record
 * messages of its `table:` channel. Messages only say that the count may
 * have changed; the count is asked again once per window, not per message:
 * the first message of a table starts the window, the ones that arrive in
 * it ride along, and the refetch after it sees them all (the server sends a
 * message after its transaction committed). Only an observed count is
 * fetched again (`invalidateQueries`, active queries).
 */
export const RECORD_COUNT_REFRESH_MS = 500;

const pending = new WeakMap<QueryClient, Map<string, ReturnType<typeof setTimeout>>>();

/** Whether `message` can change how many records of the table the user reads. */
export function changesRecordCount(message: ChannelMessage): boolean {
  switch (message.type) {
    case 'record.created':
    case 'record.deleted':
    case 'record.restored':
      return true;
    case 'record.batch':
      return message.ops.created + message.ops.deleted + message.ops.restored > 0;
    default:
      return false;
  }
}

/** Asks the table's record count again at the end of the current window. */
export function scheduleRecordCountRefresh(queryClient: QueryClient, tableId: string): void {
  let timers = pending.get(queryClient);
  if (timers === undefined) {
    timers = new Map();
    pending.set(queryClient, timers);
  }
  if (timers.has(tableId)) return;
  const table = timers;
  table.set(
    tableId,
    setTimeout(() => {
      table.delete(tableId);
      // A count fetch already running may predate the change: it starts over.
      void queryClient.invalidateQueries({ queryKey: keys.tableRecordCount(tableId) });
    }, RECORD_COUNT_REFRESH_MS),
  );
}
