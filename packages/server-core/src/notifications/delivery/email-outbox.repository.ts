import {
  NotificationOutboxRepository,
  type PendingDelivery,
} from './notification-outbox.repository.js';

import type { Db } from '../../db/create-db.js';

/** A queued email delivery with the notification it carries. */
export type PendingEmailDelivery = PendingDelivery;

/** Why a queued email of one notification was not sent (stored in `error_code`). */
export type EmailDeliverySkipCode =
  | 'smtp_not_configured'
  | 'email_off'
  | 'preference_off'
  | 'muted'
  | 'not_member'
  | 'cannot_read_base'
  | 'cannot_read_record'
  /** T542: the date field (`date.reminder`) or none of the changed fields (`record.followed_changed`). */
  | 'cannot_read_field'
  | 'unsupported_type';

/**
 * The email outbox of notifications (`meta.notification_deliveries`,
 * channel `email`; BACKLOG T512): the channel outbox of
 * {@link NotificationOutboxRepository} for `email` — `ntf_id:email` is the
 * idempotency key, every query is scoped by `organization_id`.
 */
export class NotificationEmailOutboxRepository extends NotificationOutboxRepository {
  constructor(db: Db) {
    super(db, 'email');
  }
}
