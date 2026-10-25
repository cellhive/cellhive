import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';

/** A `send_email` step using the system sender: `identity_id` null or absent. */
const SYSTEM_SENDER_STEP =
  '@.type == "send_email" && (!(exists(@.config.identity_id)) || @.config.identity_id == null)';

/**
 * Definitions with such a step, at the top level or in a branch of the
 * one-level `if` (SPEC §11.3: branches hold no `if`). A constant SQL/JSON
 * path sent as a parameter.
 */
const SYSTEM_SENDER_PATH =
  `$ ? (exists(@.actions[*] ? (${SYSTEM_SENDER_STEP})) || ` +
  `exists(@.actions[*].config.then[*] ? (${SYSTEM_SENDER_STEP})) || ` +
  `exists(@.actions[*].config.else[*] ? (${SYSTEM_SENDER_STEP})))`;

export interface SystemSenderUsage {
  /** Automations (not deleted) with a `send_email` step sending as the system sender. */
  readonly automations: number;
  /** Of which enabled. */
  readonly enabledAutomations: number;
}

/**
 * Automations of an organization sending with the system sender
 * (`meta.automations`, read only; BACKLOG T531): shown to the organization
 * admin before disabling the system sender, since those steps then fail
 * with `email_identity_unavailable`.
 */
export class SystemSenderUsageRepository
  extends TenantRepository<'automations'>
  implements TenantRepositoryContract<SystemSenderUsageRepository>
{
  constructor(db: Db) {
    super(db, 'automations');
  }

  async count(scope: OrgScope): Promise<SystemSenderUsage> {
    const row = await this.executor(scope)
      .selectFrom('meta.automations')
      .select([
        sql<string>`count(*)`.as('automations'),
        sql<string>`count(*) FILTER (WHERE enabled)`.as('enabled_automations'),
      ])
      .where('organization_id', '=', scope.organizationId)
      .where('deleted_at', 'is', null)
      .where(sql<boolean>`definition @? ${SYSTEM_SENDER_PATH}::jsonpath`)
      .executeTakeFirstOrThrow();
    return {
      automations: Number(row.automations),
      enabledAutomations: Number(row.enabled_automations),
    };
  }
}
