import {
  listAiGenerationRescueOrganizations,
  orgScope,
  type AiFieldGenerator,
  type Db,
} from '@cellhive/server-core';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Organizations looked at per run; the rest wait for the next minute. */
export const AI_GENERATION_RESCUE_LIMIT = 200;

export interface AiGenerationRescueDeps {
  readonly db: Db;
  readonly generator: Pick<AiFieldGenerator, 'rescue'>;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly limit?: number;
}

/**
 * `ai.generation_rescue` (BACKLOG T910, research S8 §4.5 "watchdog"), cron
 * every minute on the AI runner, no payload: for each organization whose
 * queue needs it (`listAiGenerationRescueOrganizations`: leases past their
 * end, paused rows, queued rows without a job), in that organization's
 * scope, `AiFieldGenerator.rescue` — expired leases back to `queued`, paused
 * rows resumed once their reason is gone (quota reset in the organization's
 * zone, AI or record data turned back on), an `ai.generate` job for every
 * field with queued rows. One organization failing does not stop the
 * others. Logs counts and organization ids only.
 */
export function createAiGenerationRescueTask(
  deps: AiGenerationRescueDeps,
): Task<'ai.generation_rescue'> {
  const now = deps.now ?? (() => new Date());
  return async () => {
    const organizations = await listAiGenerationRescueOrganizations(deps.db.kysely, {
      now: now(),
      limit: deps.limit ?? AI_GENERATION_RESCUE_LIMIT,
    });
    let fields = 0;
    let failed = 0;
    for (const organizationId of organizations) {
      try {
        fields += (await deps.generator.rescue(orgScope(organizationId))).length;
      } catch (err: unknown) {
        failed += 1;
        deps.logger.warn(
          { err, organization_id: organizationId },
          'ai.generation_rescue: organization failed',
        );
      }
    }
    if (organizations.length > 0) {
      deps.logger.info(
        { organizations: organizations.length, fields, failed },
        'ai.generation_rescue',
      );
    }
  };
}
