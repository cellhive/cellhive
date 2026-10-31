import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { AiUsage } from '../client.js';
import type { AiFeature } from '@cellhive/contracts';

/** One row of the ledger: a day of the organization and a feature. */
export interface AiUsageDay {
  readonly day: string;
  readonly feature: AiFeature;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly estimatedRequests: number;
}

/**
 * `meta.ai_usage_daily` (BACKLOG T906, ADR-39 §6): tokens per organization,
 * day (organization time zone) and feature. Every call adds its usage —
 * failed calls that reported usage too; the quota reads the day's sum.
 */
export class AiUsageRepository
  extends TenantRepository<'ai_usage_daily'>
  implements TenantRepositoryContract<AiUsageRepository>
{
  constructor(db: Db) {
    super(db, 'ai_usage_daily');
  }

  /** Adds one call (`INSERT … ON CONFLICT DO UPDATE`: concurrent calls never lose a count). */
  async add(scope: OrgScope, day: string, feature: AiFeature, usage: AiUsage): Promise<void> {
    const estimated = usage.estimated ? 1 : 0;
    await this.executor(scope)
      .insertInto('meta.ai_usage_daily')
      .values({
        organization_id: scope.organizationId,
        day,
        feature,
        requests: 1,
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        estimated_requests: estimated,
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'day', 'feature']).doUpdateSet({
          requests: sql`meta.ai_usage_daily.requests + 1`,
          prompt_tokens: sql`meta.ai_usage_daily.prompt_tokens + ${usage.promptTokens}`,
          completion_tokens: sql`meta.ai_usage_daily.completion_tokens + ${usage.completionTokens}`,
          estimated_requests: sql`meta.ai_usage_daily.estimated_requests + ${estimated}`,
        }),
      )
      .execute();
  }

  /** Prompt + completion tokens of `day`, every feature. */
  async tokensOn(scope: OrgScope, day: string): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.ai_usage_daily')
      .select(sql<string>`coalesce(sum(prompt_tokens + completion_tokens), 0)`.as('tokens'))
      .where('organization_id', '=', scope.organizationId)
      .where('day', '=', day)
      .executeTakeFirstOrThrow();
    return Number(row.tokens);
  }

  /** Rows of `from`…`to` (both included), newest day first, then by feature. */
  async list(scope: OrgScope, from: string, to: string): Promise<AiUsageDay[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.ai_usage_daily')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('day', '>=', from)
      .where('day', '<=', to)
      .orderBy('day', 'desc')
      .orderBy('feature')
      .execute();
    return rows.map((row) => ({
      day: row.day,
      feature: row.feature,
      requests: row.requests,
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      estimatedRequests: row.estimated_requests,
    }));
  }
}
