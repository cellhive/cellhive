import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/**
 * A step naming the secret (`$id`): `send_telegram` (`config.secret_id`,
 * T516), `http_request` (`config.auth.secret_id`, `config.signing_secret_id`,
 * T606) — and any later action using these keys (`run_n8n_workflow`, T607).
 */
const SECRET_STEP =
  '@.config.secret_id == $id || @.config.auth.secret_id == $id || ' +
  '@.config.signing_secret_id == $id';

/**
 * Definitions with such a step, at the top level or in a branch of the
 * one-level `if` (SPEC §11.3). A constant SQL/JSON path; the secret id is
 * a `jsonb_path_exists` variable, never part of the path text.
 */
const SECRET_PATH =
  `$ ? (exists(@.actions[*] ? (${SECRET_STEP})) || ` +
  `exists(@.actions[*].config.then[*] ? (${SECRET_STEP})) || ` +
  `exists(@.actions[*].config.else[*] ? (${SECRET_STEP})))`;

/** Most usages listed (an organization has few automations per secret). */
export const MAX_SECRET_USAGES = 500;

export interface SecretUsageRow {
  readonly automationId: Id<'aut'>;
  readonly baseId: Id<'bse'>;
  readonly triggerTableId: Id<'tbl'> | null;
  readonly name: string;
}

/**
 * Automations (not deleted) whose steps use a secret (`meta.automations`,
 * read only; BACKLOG T516, T606): such a secret cannot be deleted
 * (`409 SECRET_IN_USE`).
 */
export class SecretUsageRepository
  extends TenantRepository<'automations'>
  implements TenantRepositoryContract<SecretUsageRepository>
{
  constructor(db: Db) {
    super(db, 'automations');
  }

  async list(scope: OrgScope, secretId: Id<'sec'>): Promise<SecretUsageRow[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.automations')
      .select(['id', 'base_id', 'trigger_table_id', 'name'])
      .where('organization_id', '=', scope.organizationId)
      .where('deleted_at', 'is', null)
      .where(
        sql<boolean>`jsonb_path_exists(definition, ${SECRET_PATH}::jsonpath, jsonb_build_object('id', ${secretId}::text))`,
      )
      .orderBy('name')
      .orderBy('id')
      .limit(MAX_SECRET_USAGES)
      .execute();
    return rows.map((row) => ({
      automationId: row.id,
      baseId: row.base_id,
      triggerTableId: row.trigger_table_id,
      name: row.name,
    }));
  }
}
