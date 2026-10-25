import { idOf } from '@cellhive/contracts';
import { deferrableJob, orgScope, type AutomationRunEngine } from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({ organization_id: idOf('org'), run_id: idOf('run') });

export interface AutomationRunDeps {
  readonly engine: Pick<AutomationRunEngine, 'execute'>;
  readonly logger: Logger;
}

/**
 * `automation.run` (SPEC §11.1, §11.7; BACKLOG T505): enqueued with a
 * `queued` run by `events.dispatch` (T503), again by the engine for a
 * retry, by the per-organization cap (ADR-18), or for the end of a `delay`
 * (T506, job key `automation.run:wait:<run_id>`). No `queue_name`.
 * `AutomationRunEngine` does the work; this task logs identifiers and
 * outcome codes only — never values, templates or record data.
 *
 * A malformed payload or a missing run completes the job (retrying cannot
 * fix either). An unexpected error (database down…) is rethrown: the run
 * stays `running` and graphile-worker's retry resumes it from its last
 * succeeded step.
 */
export function createAutomationRunTask(deps: AutomationRunDeps): Task<'automation.run'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'automation.run: malformed payload, skipped');
      return;
    }
    const { organization_id: orgId, run_id: runId } = parsed.data;
    const result = await deps.engine.execute(orgScope(orgId), runId, await deferrableJob(helpers));
    const fields = {
      job_id: helpers.job.id,
      org_id: orgId,
      run_id: runId,
      status: result.status,
      ...('code' in result ? { code: result.code } : {}),
      ...('step' in result ? { step: result.step } : {}),
      ...('delayMs' in result ? { retry_in_ms: result.delayMs } : {}),
      ...('until' in result ? { resume_at: result.until } : {}),
    };
    if (result.status === 'missing') deps.logger.warn(fields, 'automation.run: run not found');
    else if (result.status === 'failed') deps.logger.warn(fields, 'automation run failed');
    else deps.logger.info(fields, 'automation run');
  };
}
