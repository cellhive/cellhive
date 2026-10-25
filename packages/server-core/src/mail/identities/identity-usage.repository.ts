import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** A `send_email` step naming the identity (`$id`), as sender or as Reply-To. */
const IDENTITY_STEP =
  '@.type == "send_email" && (@.config.identity_id == $id || @.config.reply_to.identity_id == $id)';

/**
 * Definitions with such a step, at the top level or in a branch of the
 * one-level `if` (SPEC §11.3). A constant SQL/JSON path; the identity id is
 * a `jsonb_path_exists` variable, never part of the path text.
 */
const IDENTITY_PATH =
  `$ ? (exists(@.actions[*] ? (${IDENTITY_STEP})) || ` +
  `exists(@.actions[*].config.then[*] ? (${IDENTITY_STEP})) || ` +
  `exists(@.actions[*].config.else[*] ? (${IDENTITY_STEP})))`;

/** Most usages listed (an organization has few automations per identity). */
export const MAX_IDENTITY_USAGES = 500;

export interface EmailIdentityUsageRow {
  readonly automationId: Id<'aut'>;
  readonly baseId: Id<'bse'>;
  readonly triggerTableId: Id<'tbl'> | null;
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * Automations (not deleted) whose `send_email` steps send as a sender
 * identity or reply to it (`meta.automations`, read only; BACKLOG T514 for
 * `GET /email-identities/:id/usages`): disabling or deleting the identity
 * makes those steps fail with `email_identity_unavailable`.
 */
export class EmailIdentityUsageRepository
  extends TenantRepository<'automations'>
  implements TenantRepositoryContract<EmailIdentityUsageRepository>
{
  constructor(db: Db) {
    super(db, 'automations');
  }

  async list(scope: OrgScope, identityId: Id<'eid'>): Promise<EmailIdentityUsageRow[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.automations')
      .select(['id', 'base_id', 'trigger_table_id', 'name', 'enabled'])
      .where('organization_id', '=', scope.organizationId)
      .where('deleted_at', 'is', null)
      .where(
        sql<boolean>`jsonb_path_exists(definition, ${IDENTITY_PATH}::jsonpath, jsonb_build_object('id', ${identityId}::text))`,
      )
      .orderBy('name')
      .orderBy('id')
      .limit(MAX_IDENTITY_USAGES)
      .execute();
    return rows.map((row) => ({
      automationId: row.id,
      baseId: row.base_id,
      triggerTableId: row.trigger_table_id,
      name: row.name,
      enabled: row.enabled,
    }));
  }
}
