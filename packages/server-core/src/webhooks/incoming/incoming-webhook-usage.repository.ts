import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** `trigger_type` of automations started by an incoming webhook (ADR-35 §2, T604). */
export const WEBHOOK_RECEIVED_TRIGGER_TYPE = 'webhook.received';

/** Most usages listed (a hook has few automations). */
export const MAX_INCOMING_WEBHOOK_USAGES = 500;

export interface IncomingWebhookUsageRow {
  readonly automationId: Id<'aut'>;
  readonly baseId: Id<'bse'>;
  readonly triggerTableId: Id<'tbl'> | null;
  readonly name: string;
}

/**
 * Automations (not deleted) triggered by a hook (`meta.automations`, read
 * only; BACKLOG T602): `trigger.type = webhook.received` with
 * `trigger.incoming_webhook_id` = the hook. Such a hook cannot be deleted
 * (`409 WEBHOOK_IN_USE`). The trigger itself is accepted from T604; until
 * then the list is empty.
 */
export class IncomingWebhookUsageRepository
  extends TenantRepository<'automations'>
  implements TenantRepositoryContract<IncomingWebhookUsageRepository>
{
  constructor(db: Db) {
    super(db, 'automations');
  }

  async list(scope: OrgScope, incomingWebhookId: Id<'hok'>): Promise<IncomingWebhookUsageRow[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.automations')
      .select(['id', 'base_id', 'trigger_table_id', 'name'])
      .where('organization_id', '=', scope.organizationId)
      .where('deleted_at', 'is', null)
      .where('trigger_type', '=', WEBHOOK_RECEIVED_TRIGGER_TYPE)
      .where(sql<string>`definition -> 'trigger' ->> 'incoming_webhook_id'`, '=', incomingWebhookId)
      .orderBy('name')
      .orderBy('id')
      .limit(MAX_INCOMING_WEBHOOK_USAGES)
      .execute();
    return rows.map((row) => ({
      automationId: row.id,
      baseId: row.base_id,
      triggerTableId: row.trigger_table_id,
      name: row.name,
    }));
  }
}
