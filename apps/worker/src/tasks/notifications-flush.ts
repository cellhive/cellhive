import { idOf, NOTIFICATION_BUFFER_KINDS } from '@cellhive/contracts';
import { NOTIFICATION_BUFFER_GROUP_KEY_MAX, type NotificationFlusher } from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  kind: z.enum(NOTIFICATION_BUFFER_KINDS),
  group_key: z.string().min(1).max(NOTIFICATION_BUFFER_GROUP_KEY_MAX),
});

export interface NotificationsFlushDeps {
  readonly flusher: NotificationFlusher;
  readonly logger: Logger;
}

/**
 * `notifications.flush` (BACKLOG T542, ADR-34 §2): enqueued by
 * `NotificationBuffer.append` in the producer's transaction (job key
 * `<kind>:<group_key>`, debounced). Gathers the buffered rows of one group
 * into one notification per recipient, checked now, in one transaction
 * with the deletion of the rows: a failure rolls back and graphile-worker
 * retries; a re-run writes nothing twice (`group_key`).
 *
 * Logs ids and counts only (no record value, no `data`).
 */
export function createNotificationsFlushTask(
  deps: NotificationsFlushDeps,
): Task<'notifications.flush'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'notifications.flush: malformed payload, skipped',
      );
      return;
    }
    const input = parsed.data;
    const started = Date.now();
    const outcome = await deps.flusher.flush(input, { jobId: helpers.job.id });
    const log = {
      job_id: helpers.job.id,
      org_id: input.organization_id,
      kind: input.kind,
      ...outcome,
      duration_ms: Date.now() - started,
    };
    if (outcome.status === 'no_grouper') {
      deps.logger.error(log, 'notifications.flush: no grouper for this kind, rows kept');
      return;
    }
    deps.logger.info(log, 'notification buffer flushed');
  };
}
