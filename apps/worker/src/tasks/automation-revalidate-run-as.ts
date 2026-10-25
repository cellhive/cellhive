import { idOf } from '@cellhive/contracts';
import { orgScope, type RunAsRevalidator } from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  base_id: idOf('bse').nullable(),
  after: idOf('aut').nullable().optional(),
});

export interface AutomationRevalidateRunAsDeps {
  readonly revalidator: Pick<RunAsRevalidator, 'revalidate'>;
  readonly logger: Logger;
}

/**
 * `automation.revalidate_run_as` (ADR-25 §5, BACKLOG T507): enqueued in the
 * transaction of every `permission_version` bump of a base with enabled
 * automations (job key per base or organization, debounced 2 s) and by the
 * run engine when `run_as` lost a table. `RunAsRevalidator` checks every
 * enabled automation of the base (or organization) and turns off those
 * whose `run_as` lost access (`run_as_lost_access`). Logs ids and counts
 * only. A malformed payload completes the job; an unexpected error is
 * rethrown (graphile-worker retries; automations already off are skipped).
 */
export function createAutomationRevalidateRunAsTask(
  deps: AutomationRevalidateRunAsDeps,
): Task<'automation.revalidate_run_as'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'automation.revalidate_run_as: malformed payload, skipped',
      );
      return;
    }
    const { organization_id: orgId, base_id: baseId } = parsed.data;
    const result = await deps.revalidator.revalidate(orgScope(orgId), {
      baseId,
      after: parsed.data.after ?? null,
    });
    deps.logger.info(
      {
        job_id: helpers.job.id,
        org_id: orgId,
        base_id: baseId,
        checked: result.checked,
        disabled: result.disabled.length,
        automation_ids: result.disabled,
        skipped: result.skipped,
        ...(result.continuedAfter === null ? {} : { continued_after: result.continuedAfter }),
      },
      'automation run_as check',
    );
  };
}
