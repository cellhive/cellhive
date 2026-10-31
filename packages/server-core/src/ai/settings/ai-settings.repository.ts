import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { AiSettingsRow, AiSettingsTable } from '../../db/schema.js';
import type { AiOutputRung, Id } from '@cellhive/contracts';
import type { Updateable } from 'kysely';

/** Every settable column (the row is created on first save). */
export type AiSettingsValues = Omit<
  Updateable<AiSettingsTable>,
  'organization_id' | 'created_at' | 'updated_at'
>;

/**
 * `meta.ai_settings` (BACKLOG T906, CONTRACTS §29.1): at most one row per
 * organization, scoped by `organization_id` — the settings of another
 * organization behave exactly like none.
 */
export class AiSettingsRepository
  extends TenantRepository<'ai_settings'>
  implements TenantRepositoryContract<AiSettingsRepository>
{
  constructor(db: Db) {
    super(db, 'ai_settings');
  }

  /** The row, `undefined` until first saved; `forUpdate` serialises saves. */
  async find(
    scope: OrgScope,
    options: { forUpdate?: boolean } = {},
  ): Promise<AiSettingsRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.ai_settings')
      .selectAll()
      .where('organization_id', '=', scope.organizationId);
    if (options.forUpdate === true) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** Creates the row or changes it. */
  async save(scope: OrgScope, values: AiSettingsValues): Promise<AiSettingsRow> {
    return this.executor(scope)
      .insertInto('meta.ai_settings')
      .values({ ...values, organization_id: scope.organizationId })
      .onConflict((oc) => oc.column('organization_id').doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Stores the rung "Test connection" found for `structured_output = auto`,
   * unless the provider changed meanwhile (`baseUrl`/`model` are those that
   * were tested).
   */
  async saveDetectedOutput(
    scope: OrgScope,
    tested: { readonly baseUrl: string; readonly model: string },
    rung: AiOutputRung,
  ): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.ai_settings')
      .set({ detected_output: rung })
      .where('organization_id', '=', scope.organizationId)
      .where('provider_base_url', '=', tested.baseUrl)
      .where('model', '=', tested.model)
      .where('structured_output', '=', 'auto')
      .where('detected_output', 'is distinct from', rung)
      .execute();
  }

  /** Whether the settings use `secretId` as their key (`409 SECRET_IN_USE`). */
  async usesKey(scope: OrgScope, secretId: Id<'sec'>): Promise<boolean> {
    const row = await this.executor(scope)
      .selectFrom('meta.ai_settings')
      .select('organization_id')
      .where('organization_id', '=', scope.organizationId)
      .where('api_key_secret_id', '=', secretId)
      .executeTakeFirst();
    return row !== undefined;
  }
}
