import { Buffer } from 'node:buffer';

import { DEFAULT_EMAIL_FREQUENCY, type Id } from '@cellhive/contracts';

import { OrgMembersRepository } from '../../db/repositories/org-members.repository.js';
import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { UsersRepository } from '../../db/repositories/users.repository.js';
import { orgScope, type OrgScope } from '../../db/repository.js';
import { enqueue } from '../../jobs/enqueue.js';
import { deterministicMessageId } from '../../mail/headers.js';
import { EMAIL_QUOTA_MAX_WAIT_MS } from '../../mail/limits.js';
import { isEmailSendError } from '../../mail/smtp-errors.js';
import {
  renderNotificationEmail,
  type RenderedNotificationEmail,
} from '../../mail/templates/notification-email.js';
import { NotificationSettingsRepository } from '../notification-preferences.repository.js';

import { NotificationDeliveryChecker, type CheckedDelivery } from './delivery-check.js';
import {
  NotificationEmailOutboxRepository,
  type EmailDeliverySkipCode,
  type PendingEmailDelivery,
} from './email-outbox.repository.js';
import { timeZoneOf, localeOf } from './recipient.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { Organization, User } from '../../db/schema.js';
import type { AccessDefaults } from '../../import/member-access.js';
import type { Mailer } from '../../mail/mailer.js';
import type { EmailSendError } from '../../mail/smtp-errors.js';
import type { RecordQueryService } from '../../records/record-query.service.js';

/** Notifications of one recipient gathered into one "immediate" email (ADR-29 §1). */
export const NOTIFICATION_EMAIL_BATCH_MS = 5 * 60 * 1000;
/** Pending deliveries read (and checked) per run; more → another run right after. */
export const NOTIFICATION_EMAIL_MAX_PENDING = 200;
/** Notifications shown in full in one email; the others are counted ("and N more"). */
export const NOTIFICATION_EMAIL_MAX_ITEMS = 50;
/** Attempts of a delivery that keeps failing temporarily before it is `failed`. */
export const NOTIFICATION_EMAIL_MAX_ATTEMPTS = 5;

/**
 * Payload of `notifications.deliver` (T512, T550): one recipient of one
 * organization on one channel. `channel` absent or `email`: `immediate` =
 * the 5-minute batch (queued when an email is queued), `daily` = the daily
 * summary is due (queued by `notifications.daily_digest`). `channel =
 * telegram` (T550): always `immediate`, 5 seconds after the first queued
 * Telegram delivery (`notificationTelegramDeliverJobKey`).
 */
export interface NotificationsDeliverPayload {
  readonly organization_id: Id<'org'>;
  readonly user_id: Id<'usr'>;
  readonly reason: 'immediate' | 'daily';
  readonly channel?: 'email' | 'telegram';
}

/** One graphile-worker job per recipient and organization (deduplicated). */
export function notificationDeliverJobKey(organizationId: Id<'org'>, userId: Id<'usr'>): string {
  return `notifications.deliver:${organizationId}:${userId}`;
}

/**
 * Schedules the "immediate" email of `userId` (ADR-29 §1: grouped per
 * recipient every 5 minutes) in the caller's transaction: the first queued
 * notification sets the time, later ones within the window join the same
 * job (`preserve_run_at`).
 */
export async function scheduleImmediateEmail(
  tx: Tx,
  input: {
    readonly organizationId: Id<'org'>;
    readonly userId: Id<'usr'>;
    readonly runAt: Date;
  },
): Promise<void> {
  await enqueue(
    tx,
    'notifications.deliver',
    { organization_id: input.organizationId, user_id: input.userId, reason: 'immediate' },
    {
      runAt: input.runAt,
      jobKey: notificationDeliverJobKey(input.organizationId, input.userId),
      jobKeyMode: 'preserve_run_at',
    },
  );
}

export interface NotificationEmailDeliveryOptions {
  /** `PUBLIC_URL`: links of the email. */
  readonly publicUrl: string;
  /** Domain of `SMTP_FROM` for the deterministic `Message-ID`; `null` without SMTP. */
  readonly messageIdDomain: string | null;
  /** `EMAIL_MAX_HTML_BYTES`. */
  readonly maxHtmlBytes: number;
  readonly defaults: AccessDefaults;
  readonly now?: () => Date;
}

/** What one run did (ids and counts only: logged by the job). */
export type NotificationEmailOutcome =
  | { readonly status: 'nothing' }
  /** `immediate` run of a recipient now on `daily`: left for the summary. */
  | { readonly status: 'waiting_for_digest'; readonly pending: number }
  | {
      readonly status: 'sent';
      readonly sent: number;
      readonly skipped: Readonly<Partial<Record<EmailDeliverySkipCode, number>>>;
      readonly more: boolean;
    }
  | {
      readonly status: 'skipped';
      readonly skipped: Readonly<Partial<Record<EmailDeliverySkipCode, number>>>;
      readonly more: boolean;
    }
  | { readonly status: 'failed'; readonly failed: number; readonly error: EmailSendError }
  /** Hourly quota reached: a run is scheduled at `retryAt`. */
  | { readonly status: 'deferred'; readonly pending: number; readonly retryAt: Date }
  /** Temporary SMTP failure: the job must throw so it is retried. */
  | { readonly status: 'retry'; readonly attempts: number; readonly error: EmailSendError };

/**
 * Sends the notification emails of one recipient (BACKLOG T512; ADR-29 §1,
 * ADR-32 §1, §3) — the work of `notifications.deliver`:
 *
 * 1. locks the recipient's `pending` deliveries (one run per recipient at a
 *    time; a delivery leaves `pending` once: idempotency `ntf_id:email`);
 * 2. applies the recipient's choices **now**: email frequency (`off` →
 *    skipped; `daily` waits for the summary), email preference, base mute
 *    (never for a mandatory type);
 * 3. checks the recipient's access **now** (ADR-29 §1): active member,
 *    reads the base, reads the record (primary field shown only when
 *    readable) — anything else is left out without a trace in the email;
 * 4. renders one fixed-template email in the recipient's language and time
 *    zone, sends it from the system sender (`SMTP_FROM`) as a
 *    `notification` (mandatory headers, organization hourly quota,
 *    deterministic `Message-ID`), and marks the deliveries.
 *
 * No SMTP → every pending delivery is skipped silently (in-app is not
 * affected). Temporary SMTP failures are counted per delivery and retried
 * up to {@link NOTIFICATION_EMAIL_MAX_ATTEMPTS}; rejections fail at once;
 * a reached hourly quota defers the run to the next hour (up to 24 hours).
 */
export class NotificationEmailDelivery {
  readonly #outbox: NotificationEmailOutboxRepository;
  readonly #checker: NotificationDeliveryChecker;
  readonly #now: () => Date;

  constructor(
    private readonly db: Db,
    query: RecordQueryService,
    private readonly mailer: Mailer | null,
    private readonly options: NotificationEmailDeliveryOptions,
  ) {
    this.#outbox = new NotificationEmailOutboxRepository(db);
    this.#now = options.now ?? (() => new Date());
    this.#checker = new NotificationDeliveryChecker(db, query, {
      publicUrl: options.publicUrl,
      defaults: options.defaults,
      now: this.#now,
    });
  }

  deliver(payload: NotificationsDeliverPayload): Promise<NotificationEmailOutcome> {
    return this.db.withTx((tx) => this.deliverIn(tx, payload));
  }

  private async deliverIn(
    tx: Tx,
    payload: NotificationsDeliverPayload,
  ): Promise<NotificationEmailOutcome> {
    const organizationId = payload.organization_id;
    const userId = payload.user_id;
    const scope = orgScope(organizationId, tx);
    const [settings] = await new NotificationSettingsRepository(this.db).listForUsers(scope, [
      userId,
    ]);
    const frequency = settings?.email_frequency ?? DEFAULT_EMAIL_FREQUENCY;

    const rows = await this.#outbox.lockPending(scope, userId, NOTIFICATION_EMAIL_MAX_PENDING + 1);
    if (rows.length === 0) return { status: 'nothing' };
    const more = rows.length > NOTIFICATION_EMAIL_MAX_PENDING;
    const batch = rows.slice(0, NOTIFICATION_EMAIL_MAX_PENDING);
    if (payload.reason === 'immediate' && frequency === 'daily') {
      return { status: 'waiting_for_digest', pending: batch.length };
    }

    const skipped: Partial<Record<EmailDeliverySkipCode, number>> = {};
    const skip = async (items: readonly PendingEmailDelivery[], code: EmailDeliverySkipCode) => {
      if (items.length === 0) return;
      const count = await this.#outbox.markSkipped(
        scope,
        items.map((row) => row.notification_id),
        code,
      );
      skipped[code] = (skipped[code] ?? 0) + count;
    };
    const finishSkipped = async (): Promise<NotificationEmailOutcome> => {
      if (more) await this.scheduleNext(tx, payload);
      return { status: 'skipped', skipped, more };
    };

    if (this.mailer?.instanceConfigured !== true || this.options.messageIdDomain === null) {
      await skip(batch, 'smtp_not_configured');
      return finishSkipped();
    }
    if (frequency === 'off') {
      await skip(batch, 'email_off');
      return finishSkipped();
    }
    const [user, member, organization] = await Promise.all([
      new UsersRepository(this.db).findById(userId),
      new OrgMembersRepository(this.db).get(scope, userId),
      new OrganizationsRepository(this.db).findById(organizationId),
    ]);
    if (user?.status !== 'active' || member === undefined || organization === undefined) {
      await skip(batch, 'not_member');
      return finishSkipped();
    }

    const { kept, dropped } = await this.#checker.check(scope, user, batch, 'email');
    for (const [code, items] of dropped) await skip(items, code);
    if (kept.length === 0) return finishSkipped();

    const email = this.render(organization, user, payload.reason, kept);
    const ids = kept.map((entry) => entry.row.notification_id);
    try {
      await this.mailer.send({
        to: user.email,
        subject: email.subject,
        text: email.text,
        html: email.html,
        origin: { kind: 'notification', organizationId },
        messageId: deterministicMessageId(
          [...ids]
            .sort()
            .map((id) => `${id}:email`)
            .join(','),
          this.options.messageIdDomain,
        ),
      });
    } catch (error) {
      if (!isEmailSendError(error)) throw error;
      return this.onSendError(tx, scope, payload, kept, error);
    }
    const sent = await this.#outbox.markSent(scope, ids, this.#now());
    if (more) await this.scheduleNext(tx, payload);
    return { status: 'sent', sent, skipped, more };
  }

  /**
   * The email: the first items in full while the HTML fits
   * `EMAIL_MAX_HTML_BYTES` (at most {@link NOTIFICATION_EMAIL_MAX_ITEMS}),
   * the rest counted.
   */
  private render(
    organization: Organization,
    user: User,
    reason: 'immediate' | 'daily',
    kept: readonly CheckedDelivery[],
  ): RenderedNotificationEmail {
    const root = this.options.publicUrl.replace(/\/+$/, '');
    const timeZone = timeZoneOf(user, organization, this.options.defaults);
    const locale = localeOf(user, organization, this.options.defaults);
    let shown = Math.min(kept.length, NOTIFICATION_EMAIL_MAX_ITEMS);
    for (;;) {
      const email = renderNotificationEmail({
        locale,
        timeZone,
        mode: reason,
        organizationName: organization.name,
        recipientName: user.display_name,
        items: kept.slice(0, shown).map((entry) => entry.item),
        moreCount: kept.length - shown,
        moreUrl: `${root}/o/${encodeURIComponent(organization.slug)}`,
        manageUrl: `${root}/o/${encodeURIComponent(organization.slug)}/settings/notifications`,
        now: this.#now(),
      });
      if (Buffer.byteLength(email.html, 'utf8') <= this.options.maxHtmlBytes || shown <= 1) {
        return email;
      }
      shown = Math.max(1, Math.floor(shown / 2));
    }
  }

  private async onSendError(
    tx: Tx,
    scope: OrgScope,
    payload: NotificationsDeliverPayload,
    kept: readonly CheckedDelivery[],
    error: EmailSendError,
  ): Promise<NotificationEmailOutcome> {
    const ids = kept.map((entry) => entry.row.notification_id);
    if (error.code === 'smtp_not_configured') {
      await this.#outbox.markSkipped(scope, ids, 'smtp_not_configured');
      return { status: 'skipped', skipped: { smtp_not_configured: ids.length }, more: false };
    }
    if (error.code === 'email_quota_exceeded' && error.retryAt !== null) {
      const oldest = Math.min(...kept.map((entry) => entry.row.queued_at.getTime()));
      if (error.retryAt.getTime() - oldest <= EMAIL_QUOTA_MAX_WAIT_MS) {
        await enqueue(tx, 'notifications.deliver', payload, {
          runAt: error.retryAt,
          jobKey: notificationDeliverJobKey(payload.organization_id, payload.user_id),
        });
        return { status: 'deferred', pending: ids.length, retryAt: error.retryAt };
      }
      const failed = await this.#outbox.markFailed(scope, ids, error.code);
      return { status: 'failed', failed, error };
    }
    if (error.retryable) {
      const attempts = await this.#outbox.recordAttempt(scope, ids, error.code);
      if (attempts < NOTIFICATION_EMAIL_MAX_ATTEMPTS) return { status: 'retry', attempts, error };
      const failed = await this.#outbox.markFailed(scope, ids, error.code);
      return { status: 'failed', failed, error };
    }
    const failed = await this.#outbox.markFailed(scope, ids, error.code);
    return { status: 'failed', failed, error };
  }

  /** More pending deliveries than one run reads: another run right away. */
  private async scheduleNext(tx: Tx, payload: NotificationsDeliverPayload): Promise<void> {
    await enqueue(tx, 'notifications.deliver', payload, {
      jobKey: notificationDeliverJobKey(payload.organization_id, payload.user_id),
    });
  }
}
