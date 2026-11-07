import {
  listAiGenerationRescueOrganizations,
  orgScope,
  type AiFieldGenerator,
  type Db,
} from '@cellhive/server-core';

import type { Id } from '@cellhive/contracts';
import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Organizations looked at per run; the rest wait for the next minute. */
export const AI_GENERATION_RESCUE_LIMIT = 200;

export interface AiGenerationRescueDeps {
  readonly db: Db;
  readonly generator: Pick<AiFieldGenerator, 'rescue'>;
  readonly logger: Logger;
  /** The zone of an organization without a valid `settings.timezone` (`DEFAULT_TIMEZONE`). */
  readonly defaultTimeZone: string;
  readonly now?: () => Date;
  readonly limit?: number;
}

/**
 * `ai.generation_rescue` (BACKLOG T910, T1003; research S8 §4.5
 * "watchdog"), cron every minute on the AI runner, no payload: for each
 * organization whose queue has work that can move now
 * (`listAiGenerationRescueOrganizations`: leases past their end; with AI
 * on, paused rows whose reason is gone and queued rows without a job), in
 * that organization's scope, `AiFieldGenerator.rescue` — expired leases
 * back to `queued`, paused rows resumed (quota reset in the organization's
 * zone, AI or record data turned back on), an `ai.generate` job for every
 * field with queued rows. Each run starts after the last organization of
 * the previous one (kept by this process; a restart starts from the first),
 * so organizations the rescue cannot fix never keep the others out. One
 * organization failing does not stop the others. Logs counts and
 * organization ids only.
 */
export function createAiGenerationRescueTask(
  deps: AiGenerationRescueDeps,
): Task<'ai.generation_rescue'> {
  const now = deps.now ?? (() => new Date());
  let after: Id<'org'> | null = null;
  return async () => {
    const organizations = await listAiGenerationRescueOrganizations(deps.db.kysely, {
      now: now(),
      limit: deps.limit ?? AI_GENERATION_RESCUE_LIMIT,
      after,
      defaultTimeZone: deps.defaultTimeZone,
    });
    after = organizations.at(-1) ?? after;
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
