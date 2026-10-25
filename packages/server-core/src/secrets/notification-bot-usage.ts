import { OrganizationsRepository } from '../db/repositories/organizations.repository.js';
import { orgTelegramSettingsOf } from '../notifications/channels/telegram/org-telegram-settings.js';

import type { Db, Tx } from '../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/**
 * Whether `secretId` is the organization's notification bot (ADR-34 §3,
 * BACKLOG T549): such a secret is "used" (`GET /secrets/:id/usages` lists
 * `{ kind: "notification_channel" }`) and cannot be deleted
 * (`409 SECRET_IN_USE`). With `lock`, the organization row is locked
 * `FOR UPDATE` in `tx` first — the order every writer of the notification
 * bot follows (organization, then secret), so a delete and a `PATCH
 * …/notification-channels` choosing the same secret never both win.
 */
export async function isNotificationBotSecret(
  db: Db,
  organizationId: Id<'org'>,
  secretId: Id<'sec'>,
  options: { readonly tx?: Tx; readonly lock?: boolean } = {},
): Promise<boolean> {
  const organizations = new OrganizationsRepository(db);
  const organization =
    options.lock === true && options.tx !== undefined
      ? await organizations.lockById(organizationId, options.tx)
      : await organizations.findById(organizationId, options.tx);
  if (organization === undefined) return false;
  return orgTelegramSettingsOf(organization.settings).secretId === secretId;
}
