import { idOf } from '@cellhive/contracts';
import {
  enqueueAiGeneration,
  orgScope,
  recomputeJobBatchId,
  type AiBatchOutcome,
  type AiFieldGenerator,
  type Db,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({ organization_id: idOf('org'), field_id: idOf('fld') });

/** Batches one job runs before it hands over (other fields get the AI slots too). */
export const AI_GENERATE_JOB_BUDGET_MS = 60_000;

export interface AiGenerateDeps {
  readonly db: Db;
  readonly generator: Pick<AiFieldGenerator, 'runBatch'>;
  readonly logger: Logger;
  /** Time of batches per job; default {@link AI_GENERATE_JOB_BUDGET_MS}. */
  readonly budgetMs?: number;
}

/**
 * `ai.generate` (BACKLOG T910, ADR-39 §7), job key `ai.generate:<field_id>`,
 * on the AI runner only (`AI_CONCURRENCY`): batches of ≤ 20 queued rows of
 * one AI field (`AiFieldGenerator.runBatch`) for up to a minute, then the
 * job schedules itself again when rows are left — now, or when the next
 * retry is due. Every batch of a run shares `batch_id = job_…` (its audit
 * entries). Logs counts and token totals only, never a prompt or a value.
 */
export function createAiGenerateTask(deps: AiGenerateDeps): Task<'ai.generate'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'ai.generate: malformed payload, skipped');
      return;
    }
    const { organization_id: organizationId, field_id: fieldId } = parsed.data;
    const scope = orgScope(organizationId);
    const batchId = recomputeJobBatchId(helpers.job.id);
    const started = Date.now();
    let outcome: AiBatchOutcome;
    do {
      outcome = await deps.generator.runBatch(scope, fieldId, batchId);
      if (outcome.rows > 0 || outcome.status === 'paused') {
        deps.logger.info(
          {
            organization_id: organizationId,
            field_id: fieldId,
            status: outcome.status,
            rows: outcome.rows,
            written: outcome.written,
            failed: outcome.failed,
            calls: outcome.calls,
            prompt_tokens: outcome.usage.promptTokens,
            completion_tokens: outcome.usage.completionTokens,
            ...(outcome.pausedReason === undefined ? {} : { paused_reason: outcome.pausedReason }),
          },
          'ai.generate batch',
        );
      }
    } while (
      outcome.status === 'more' &&
      Date.now() - started < (deps.budgetMs ?? AI_GENERATE_JOB_BUDGET_MS)
    );
    const next = outcome.status === 'more' ? new Date() : outcome.nextRunAt;
    if (next !== null) {
      await deps.db.withTx((tx) => enqueueAiGeneration(tx, organizationId, fieldId, next));
    }
  };
}
