import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../../db/repository.js';

import type { Db } from '../../../db/create-db.js';
import type { TelegramWebhookRow } from '../../../db/schema.js';
import type { Id, TelegramWebhookErrorCode, TelegramWebhookStatus } from '@cellhive/contracts';

/** What registering a webhook stores: hashes and sealed values only. */
export interface RegisteredTelegramWebhook {
  readonly secretId: Id<'sec'>;
  readonly pathTokenHash: string;
  readonly secretTokenEnc: string;
  /** The registered URL without its path token. */
  readonly registeredUrl: string;
  readonly checkedAt: Date;
}

/**
 * `meta.telegram_webhooks` (migration 0046, BACKLOG T609, ADR-35 §7): at most
 * one row per organization, the webhook of its notification bot. Every query
 * is scoped by `organization_id`; the public route first finds the
 * organization through the cross-tenant `findTelegramWebhookByPathHash`.
 */
export class TelegramWebhooksRepository
  extends TenantRepository<'telegram_webhooks'>
  implements TenantRepositoryContract<TelegramWebhooksRepository>
{
  constructor(db: Db) {
    super(db, 'telegram_webhooks');
  }

  async find(scope: OrgScope): Promise<TelegramWebhookRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.telegram_webhooks')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
  }

  /** Inserts or replaces the organization's webhook (status back to `ok`). */
  async upsert(scope: OrgScope, webhook: RegisteredTelegramWebhook): Promise<void> {
    await this.executor(scope)
      .insertInto('meta.telegram_webhooks')
      .values({
        organization_id: scope.organizationId,
        secret_id: webhook.secretId,
        path_token_hash: webhook.pathTokenHash,
        secret_token_enc: webhook.secretTokenEnc,
        registered_url: webhook.registeredUrl,
        status: 'ok',
        last_error_code: null,
        last_checked_at: webhook.checkedAt,
      })
      .onConflict((conflict) =>
        conflict.column('organization_id').doUpdateSet({
          secret_id: webhook.secretId,
          path_token_hash: webhook.pathTokenHash,
          secret_token_enc: webhook.secretTokenEnc,
          registered_url: webhook.registeredUrl,
          status: 'ok',
          last_error_code: null,
          last_checked_at: webhook.checkedAt,
        }),
      )
      .execute();
  }

  /** What the hourly check saw; `false` when the row is gone. */
  async setStatus(
    scope: OrgScope,
    status: TelegramWebhookStatus,
    errorCode: TelegramWebhookErrorCode | null,
    checkedAt: Date,
  ): Promise<boolean> {
    const result = await this.executor(scope)
      .updateTable('meta.telegram_webhooks')
      .set({ status, last_error_code: errorCode, last_checked_at: checkedAt })
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Removes the organization's webhook row; whether there was one. */
  async delete(scope: OrgScope): Promise<boolean> {
    const result = await this.executor(scope)
      .deleteFrom('meta.telegram_webhooks')
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
