import { DEFAULT_DAILY_DIGEST_HOUR, DEFAULT_EMAIL_FREQUENCY, type Id } from '@cellhive/contracts';

import {
  listPendingEmailRecipients,
  type PendingEmailRecipient,
} from '../../db/cross-tenant-lookups.js';
import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { UsersRepository } from '../../db/repositories/users.repository.js';
import { orgScope } from '../../db/repository.js';
import { enqueue } from '../../jobs/enqueue.js';
import { NotificationSettingsRepository } from '../notification-preferences.repository.js';

import {
  NOTIFICATION_EMAIL_BATCH_MS,
  notificationDeliverJobKey,
  type NotificationsDeliverPayload,
} from './email-delivery.js';
import { NotificationEmailOutboxRepository } from './email-outbox.repository.js';
import { localHourOf, timeZoneOf } from './recipient.js';

import type { Db } from '../../db/create-db.js';
import type { AccessDefaults } from '../../import/member-access.js';

/** Recipients read per page of the instance-wide scan. */
export const DAILY_DIGEST_SCAN_PAGE = 500;

/**
 * A daily summary missed (worker down at that hour): sent anyway once the
 * oldest waiting email is this old.
 */
export const DAILY_DIGEST_CATCH_UP_MS = 25 * 60 * 60 * 1000;

export interface DailyDigestSweepResult {
  /** Recipients with pending emails looked at. */
  readonly recipients: number;
  /** `notifications.deliver` runs queued, by reason. */
  readonly daily: number;
  readonly immediate: number;
}

/**
 * The work of the hourly `notifications.daily_digest` cron (BACKLOG T512;
 * ADR-32 §1; "Quyết định S5 thiết kế" #7): for every recipient with
 * pending notification emails (instance-wide lookup, ids only), read their
 * settings in their organization's scope and queue `notifications.deliver`:
 *
 * - `daily` and the current hour **in the recipient's time zone** is their
 *   `daily_hour` (whole hours) — or the oldest waiting email is older than
 *   {@link DAILY_DIGEST_CATCH_UP_MS} (a missed hour) → the daily summary;
 * - `immediate` or `off` with an email waiting longer than the 5-minute
 *   batch (e.g. the frequency changed) → a run that sends or skips them.
 *
 * Nothing is queued for a recipient with nothing pending, so no empty
 * summary is ever sent. One `notifications.deliver` job per recipient
 * (job key).
 */
export async function sweepDailyDigests(
  db: Db,
  options: { readonly now: Date; readonly defaults: AccessDefaults; readonly pageSize?: number },
): Promise<DailyDigestSweepResult> {
  const pageSize = options.pageSize ?? DAILY_DIGEST_SCAN_PAGE;
  let after: PendingEmailRecipient | null = null;
  let recipients = 0;
  let daily = 0;
  let immediate = 0;
  for (;;) {
    const page = await listPendingEmailRecipients(db.kysely, { after, limit: pageSize });
    if (page.length === 0) break;
    recipients += page.length;
    const byOrg = new Map<Id<'org'>, Id<'usr'>[]>();
    for (const item of page) {
      byOrg.set(item.organizationId, [...(byOrg.get(item.organizationId) ?? []), item.userId]);
    }
    for (const [organizationId, userIds] of byOrg) {
      const queued = await planOrganization(db, organizationId, userIds, options);
      daily += queued.daily;
      immediate += queued.immediate;
    }
    after = page[page.length - 1] ?? null;
    if (page.length < pageSize) break;
  }
  return { recipients, daily, immediate };
}

async function planOrganization(
  db: Db,
  organizationId: Id<'org'>,
  userIds: readonly Id<'usr'>[],
  options: { readonly now: Date; readonly defaults: AccessDefaults },
): Promise<{ daily: number; immediate: number }> {
  const scope = orgScope(organizationId);
  const [organization, settings, oldest] = await Promise.all([
    new OrganizationsRepository(db).findById(organizationId),
    new NotificationSettingsRepository(db).listForUsers(scope, userIds),
    new NotificationEmailOutboxRepository(db).oldestPending(scope, userIds),
  ]);
  const settingOf = new Map(settings.map((row) => [row.user_id, row]));
  const users = new UsersRepository(db);
  const runs: { userId: Id<'usr'>; reason: NotificationsDeliverPayload['reason'] }[] = [];
  for (const userId of userIds) {
    const waitingSince = oldest.get(userId);
    if (waitingSince === undefined) continue;
    const waited = options.now.getTime() - waitingSince.getTime();
    const setting = settingOf.get(userId);
    const frequency = setting?.email_frequency ?? DEFAULT_EMAIL_FREQUENCY;
    if (frequency === 'daily') {
      const user = await users.findById(userId);
      if (user === undefined) continue;
      const hour = localHourOf(options.now, timeZoneOf(user, organization, options.defaults));
      const due = hour === (setting?.daily_hour ?? DEFAULT_DAILY_DIGEST_HOUR);
      if (due || waited >= DAILY_DIGEST_CATCH_UP_MS) runs.push({ userId, reason: 'daily' });
    } else if (waited >= NOTIFICATION_EMAIL_BATCH_MS) {
      runs.push({ userId, reason: 'immediate' });
    }
  }
  if (runs.length === 0) return { daily: 0, immediate: 0 };
  await db.withTx(async (tx) => {
    for (const run of runs) {
      await enqueue(
        tx,
        'notifications.deliver',
        { organization_id: organizationId, user_id: run.userId, reason: run.reason },
        {
          jobKey: notificationDeliverJobKey(organizationId, run.userId),
          // A batch already scheduled keeps its time; a summary runs now.
          ...(run.reason === 'immediate' ? { jobKeyMode: 'preserve_run_at' as const } : {}),
        },
      );
    }
  });
  return {
    daily: runs.filter((run) => run.reason === 'daily').length,
    immediate: runs.filter((run) => run.reason === 'immediate').length,
  };
}
