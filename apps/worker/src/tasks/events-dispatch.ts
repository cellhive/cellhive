import { idOf } from '@cellhive/contracts';
import { orgScope, type AutomationDispatcher } from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  event_id: idOf('evt'),
  organization_id: idOf('org'),
  // UTC with up to microseconds, as written by EventWriter.
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/),
});

export interface EventsDispatchDeps {
  readonly dispatcher: Pick<AutomationDispatcher, 'dispatch'>;
  readonly logger: Logger;
}

/**
 * `events.dispatch` (SPEC §11.1, BACKLOG T503): enqueued by `EventWriter`
 * in the mutation's transaction. `AutomationDispatcher` sets
 * `dispatched_at` and creates the `queued` runs of the matching
 * automations in one transaction (a redelivered job does nothing; a
 * failure rolls back and graphile-worker retries).
 *
 * Logs identifiers and outcome codes only, never the payload (`changes`
 * holds record values). A malformed payload or a missing event is logged
 * and completes the job: retrying cannot fix either.
 */
export function createEventsDispatchTask(deps: EventsDispatchDeps): Task<'events.dispatch'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'events.dispatch: malformed payload, skipped');
      return;
    }
    const { event_id: eventId, organization_id: orgId, created_at: createdAt } = parsed.data;
    const result = await deps.dispatcher.dispatch(orgScope(orgId), { id: eventId, createdAt });
    if (result.status === 'missing') {
      deps.logger.warn(
        { job_id: helpers.job.id, event_id: eventId, org_id: orgId },
        'events.dispatch: event not found, nothing to dispatch',
      );
      return;
    }
    const { event } = result;
    const automations = result.status === 'dispatched' ? result.automations : [];
    deps.logger.info(
      {
        job_id: helpers.job.id,
        event_id: event.id,
        org_id: event.organization_id,
        event_type: event.type,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        actor_type: event.actor.type,
        redelivery: result.status === 'redelivered',
        ...(automations.length === 0
          ? {}
          : {
              automations: automations.map((item) => ({
                automation_id: item.automationId,
                outcome: item.outcome,
                ...(item.runId === undefined ? {} : { run_id: item.runId }),
              })),
            }),
      },
      'event dispatched',
    );
  };
}
