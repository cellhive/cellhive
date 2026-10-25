import { idOf } from '@cellhive/contracts';
import { orgScope, type HttpDeliverer } from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({ organization_id: idOf('org'), delivery_id: idOf('hdl') });

export interface HttpDeliverDeps {
  readonly deliverer: Pick<HttpDeliverer, 'deliver'>;
  readonly logger: Logger;
}

/**
 * `http.deliver` (ADR-35 §4, BACKLOG T605): phase 2 of the outbound HTTP
 * outbox for one delivery — enqueued with the `pending` row (job key
 * `http:<delivery_id>`), again for each later attempt, for a pacer wait,
 * and as the safety net at the end of a lease. `HttpDeliverer` does the
 * work; this task logs ids, the host, codes and outcomes only — never the
 * URL, headers, bodies or tokens.
 *
 * A malformed payload completes the job (retrying cannot fix it). An
 * unexpected error (database down…) is rethrown: graphile-worker retries,
 * and an attempt left `sending` is taken again once its lease expires.
 */
export function createHttpDeliverTask(deps: HttpDeliverDeps): Task<'http.deliver'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'http.deliver: malformed payload, skipped');
      return;
    }
    const { organization_id: orgId, delivery_id: deliveryId } = parsed.data;
    const result = await deps.deliverer.deliver(orgScope(orgId), deliveryId);
    const fields = {
      job_id: helpers.job.id,
      org_id: orgId,
      delivery_id: deliveryId,
      status: result.status,
      ...('attempt' in result ? { attempt: result.attempt } : {}),
      ...('code' in result ? { code: result.code } : {}),
      ...('httpStatus' in result ? { http_status: result.httpStatus } : {}),
      ...('reason' in result ? { reason: result.reason } : {}),
      ...('at' in result ? { next_at: result.at.toISOString() } : {}),
    };
    if (result.status === 'failed') deps.logger.warn(fields, 'http delivery failed');
    else deps.logger.info(fields, 'http delivery');
  };
}
