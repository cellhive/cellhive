import { sql } from 'kysely';

import { OrganizationsRepository } from '../../../db/repositories/organizations.repository.js';
import { orgScope } from '../../../db/repository.js';
import { publishChannelChanged } from '../channel-events.js';
import { UserChannelLinkTokensRepository } from '../user-channel-link-tokens.repository.js';
import { UserChannelsRepository } from '../user-channels.repository.js';

import { orgTelegramSettingsOf, withOrgTelegramSettings } from './org-telegram-settings.js';
import { TelegramWebhooksRepository } from './telegram-webhooks.repository.js';

import type { Db, Tx } from '../../../db/create-db.js';
import type { Id, TelegramBotStatus } from '@cellhive/contracts';

/**
 * The organization's notification bot changed or was removed (ADR-34 §3,
 * T549), in the caller's transaction: every Telegram channel of the
 * organization goes to `error` (`bot_changed` — chats only know the old
 * bot, members link again) and every pending link is cancelled (it names the
 * old bot). Each member whose channel changed gets `channel.changed` after
 * commit. The webhook row of the old bot is removed (T609: the caller
 * stores `telegram_delivery_mode = polling` and removes the old bot's
 * webhook at Telegram). Returns those members.
 */
export async function resetChannelsForNewBot(
  db: Db,
  tx: Tx,
  organizationId: Id<'org'>,
  now: Date,
): Promise<Id<'usr'>[]> {
  const scope = orgScope(organizationId, tx);
  const users = await new UserChannelsRepository(db).markAllError(scope, 'telegram', 'bot_changed');
  await new UserChannelLinkTokensRepository(db).cancelPending(scope, null, now);
  await new TelegramWebhooksRepository(db).delete(scope);
  for (const userId of users) {
    await publishChannelChanged(db, tx, {
      organizationId,
      userId,
      kind: 'telegram',
      status: 'error',
    });
  }
  return users;
}

/**
 * Records what the poller saw of the bot `secretId` (`ok`,
 * `webhook_conflict`, `invalid_token`) in the organization's settings, when
 * it is still the notification bot and the status differs. No audit, no
 * event: a system observation, shown to owners/admins by `GET
 * /orgs/:orgId/notification-channels`. Returns whether it changed.
 */
export async function setNotificationBotStatus(
  db: Db,
  organizationId: Id<'org'>,
  secretId: Id<'sec'>,
  status: TelegramBotStatus,
): Promise<boolean> {
  const organizations = new OrganizationsRepository(db);
  return db.withTx(async (tx) => {
    const current = await organizations.lockById(organizationId, tx);
    if (current === undefined) return false;
    const telegram = orgTelegramSettingsOf(current.settings);
    if (telegram.secretId !== secretId || telegram.status === status) return false;
    await organizations.update(
      organizationId,
      { settings: withOrgTelegramSettings(current.settings, { ...telegram, status }) },
      tx,
    );
    return true;
  });
}

/**
 * Whether the Telegram bot `botId` is already the notification bot of
 * another organization (QA S5b M3), in the caller's transaction, which is
 * about to make it the notification bot of `organizationId`. Telegram serves
 * one `getUpdates` consumer per bot: two organizations sharing a bot would
 * run two pollers that swallow each other's `/start`, so callers refuse
 * (`BOT_IN_USE`). A transaction advisory lock on the bot id first makes two
 * concurrent choices of one bot wait for each other (taken after the
 * organization's row lock, in every caller).
 */
export async function isNotificationBotOfAnotherOrganization(
  db: Db,
  tx: Tx,
  organizationId: Id<'org'>,
  botId: number,
): Promise<boolean> {
  const lockKey = `telegram-notification-bot:${String(botId)}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(tx);
  return new OrganizationsRepository(db).hasOtherWithNotificationBot(botId, organizationId, tx);
}
