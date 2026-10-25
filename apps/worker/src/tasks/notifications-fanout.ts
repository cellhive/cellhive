import {
  ACTOR_TYPES,
  idOf,
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_TYPES,
} from '@cellhive/contracts';
import { MAX_NOTIFICATION_RECIPIENTS, type NotificationFanout } from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  type: z.enum(NOTIFICATION_TYPES),
  base_id: idOf('bse').nullable(),
  table_id: idOf('tbl').nullable(),
  entity_type: z.enum(NOTIFICATION_ENTITY_TYPES),
  entity_id: z.string().min(1).max(64),
  actor: z.object({ type: z.enum(ACTOR_TYPES), id: z.string().min(1).max(64) }).nullable(),
  group_key: z.string().min(1).max(200).nullable(),
  recipients: z.object({
    user_ids: z.array(idOf('usr')).max(MAX_NOTIFICATION_RECIPIENTS),
    base_admins: z.boolean(),
  }),
  requires: z.object({
    record_id: idOf('rec').nullable(),
    field_ids: z.array(idOf('fld')).max(500),
    // T542: optional, so jobs queued before it still parse.
    any_field_ids: z.array(idOf('fld')).max(500).optional(),
  }),
  skip_actor: z.boolean(),
  data: z.record(z.string(), z.json()),
});

export interface NotificationsFanoutDeps {
  readonly fanout: NotificationFanout;
  readonly logger: Logger;
}

/**
 * `notifications.fanout` (ADR-29 §1, BACKLOG T511): enqueued in the
 * producer's transaction. Expands and checks recipients **now** (current
 * access), records the notifications, queues emails and announces them on
 * `user:<id>` after commit. A failure rolls back and graphile-worker
 * retries; a retry cannot duplicate rows of a producer that set
 * `group_key`.
 *
 * Logs ids and counts only, never `data` (it may hold rendered content).
 */
export function createNotificationsFanoutTask(
  deps: NotificationsFanoutDeps,
): Task<'notifications.fanout'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'notifications.fanout: malformed payload, skipped',
      );
      return;
    }
    const input = parsed.data;
    const started = Date.now();
    const result = await deps.fanout.run(input);
    const skipped: Record<string, number> = {};
    for (const item of result.skipped) skipped[item.reason] = (skipped[item.reason] ?? 0) + 1;
    deps.logger.info(
      {
        job_id: helpers.job.id,
        org_id: input.organization_id,
        notification_type: input.type,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        recorded: result.written.filter((item) => item.id !== null).length,
        in_app: result.written.filter((item) => item.inApp).length,
        email_queued: result.written.filter((item) => item.emailQueued).length,
        telegram_queued: result.written.filter((item) => item.telegramQueued).length,
        skipped,
        duration_ms: Date.now() - started,
      },
      'notifications fanned out',
    );
  };
}
