import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { JsonValue } from '../../db/schema.js';
import type { NotificationDeliveryChannel } from '../notifications.repository.js';
import type { Id, NotificationEntityType, NotificationType } from '@cellhive/contracts';

/** A queued delivery with the notification it carries. */
export interface PendingDelivery {
  readonly notification_id: Id<'ntf'>;
  readonly attempts: number;
  /** When the delivery was queued. */
  readonly queued_at: Date;
  readonly type: NotificationType;
  readonly base_id: Id<'bse'> | null;
  readonly table_id: Id<'tbl'> | null;
  readonly entity_type: NotificationEntityType;
  readonly entity_id: string;
  readonly payload: JsonValue;
  readonly created_at: Date;
}

/**
 * The outbox of one delivery channel (`meta.notification_deliveries` rows
 * of `channel`; BACKLOG T512 for `email`, T550 for `telegram`): reads the
 * `pending` rows of one recipient and marks them `sent`, `skipped` or
 * `failed`. The (notification, channel) primary key is the idempotency key
 * `ntf_id:channel`: a row leaves `pending` once, so a notification is sent
 * at most once per channel. Every query is scoped by `organization_id` and
 * by the channel: the email and Telegram rows of one notification never
 * touch each other.
 */
export class NotificationOutboxRepository
  extends TenantRepository<'notification_deliveries'>
  implements TenantRepositoryContract<NotificationOutboxRepository>
{
  constructor(
    db: Db,
    readonly channel: NotificationDeliveryChannel,
  ) {
    super(db, 'notification_deliveries');
  }

  /**
   * Pending deliveries of `userId`, oldest first, at most `limit`, locked
   * `FOR UPDATE SKIP LOCKED` until the scope's transaction ends (a
   * concurrent delivery of the same recipient skips them).
   */
  async lockPending(scope: OrgScope, userId: Id<'usr'>, limit: number): Promise<PendingDelivery[]> {
    if (scope.tx === undefined) throw new TypeError('lockPending needs a transaction scope');
    const { rows } = await sql<PendingDelivery>`
      SELECT d.notification_id, d.attempts, d.created_at AS queued_at,
             n.type, n.base_id, n.table_id, n.entity_type, n.entity_id, n.payload, n.created_at
        FROM meta.notification_deliveries AS d
        JOIN meta.notifications AS n
          ON n.organization_id = d.organization_id AND n.id = d.notification_id
       WHERE d.organization_id = ${scope.organizationId}
         AND n.organization_id = ${scope.organizationId}
         AND n.user_id = ${userId}
         AND d.channel = ${this.channel}
         AND d.status = 'pending'
       ORDER BY n.created_at, n.id
       LIMIT ${limit}
         FOR UPDATE OF d SKIP LOCKED
    `.execute(this.executor(scope));
    return rows;
  }

  /** Oldest pending delivery per user (users without one are absent). */
  async oldestPending(
    scope: OrgScope,
    userIds: readonly Id<'usr'>[],
  ): Promise<Map<Id<'usr'>, Date>> {
    if (userIds.length === 0) return new Map();
    const { rows } = await sql<{ user_id: Id<'usr'>; oldest: Date }>`
      SELECT n.user_id, min(d.created_at) AS oldest
        FROM meta.notification_deliveries AS d
        JOIN meta.notifications AS n
          ON n.organization_id = d.organization_id AND n.id = d.notification_id
       WHERE d.organization_id = ${scope.organizationId}
         AND n.organization_id = ${scope.organizationId}
         AND n.user_id IN (${sql.join([...userIds])})
         AND d.channel = ${this.channel}
         AND d.status = 'pending'
       GROUP BY n.user_id
    `.execute(this.executor(scope));
    return new Map(rows.map((row) => [row.user_id, row.oldest]));
  }

  /** Marks pending deliveries sent; returns how many changed. */
  async markSent(scope: OrgScope, ids: readonly Id<'ntf'>[], at: Date): Promise<number> {
    return this.finish(scope, ids, { status: 'sent', error_code: null, sent_at: at }, true);
  }

  /** Marks pending deliveries skipped with the reason; returns how many changed. */
  async markSkipped(scope: OrgScope, ids: readonly Id<'ntf'>[], code: string): Promise<number> {
    return this.finish(scope, ids, { status: 'skipped', error_code: code }, false);
  }

  /** Marks pending deliveries failed with a failure code; returns how many changed. */
  async markFailed(scope: OrgScope, ids: readonly Id<'ntf'>[], code: string): Promise<number> {
    return this.finish(scope, ids, { status: 'failed', error_code: code }, true);
  }

  /**
   * Marks every pending delivery of `userId` on this channel skipped with
   * the reason (T550: Telegram refused the chat, so the rest of the queue of
   * that person is not tried); returns how many changed.
   */
  async skipAllPending(scope: OrgScope, userId: Id<'usr'>, code: string): Promise<number> {
    const { numUpdatedRows } = await this.executor(scope)
      .updateTable('meta.notification_deliveries')
      .set({ status: 'skipped', error_code: code })
      .where('organization_id', '=', scope.organizationId)
      .where('channel', '=', this.channel)
      .where('status', '=', 'pending')
      .where('notification_id', 'in', (eb) =>
        eb
          .selectFrom('meta.notifications')
          .select('id')
          .where('organization_id', '=', scope.organizationId)
          .where('user_id', '=', userId),
      )
      .executeTakeFirst();
    return Number(numUpdatedRows);
  }

  /**
   * Records a failed attempt (temporary failure) on pending deliveries;
   * returns the highest attempt count among them.
   */
  async recordAttempt(scope: OrgScope, ids: readonly Id<'ntf'>[], code: string): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.executor(scope)
      .updateTable('meta.notification_deliveries')
      .set((eb) => ({ attempts: eb('attempts', '+', 1), error_code: code }))
      .where('organization_id', '=', scope.organizationId)
      .where('channel', '=', this.channel)
      .where('status', '=', 'pending')
      .where('notification_id', 'in', [...ids])
      .returning('attempts')
      .execute();
    return rows.reduce((max, row) => Math.max(max, row.attempts), 0);
  }

  private async finish(
    scope: OrgScope,
    ids: readonly Id<'ntf'>[],
    values: {
      readonly status: 'sent' | 'skipped' | 'failed';
      readonly error_code: string | null;
      readonly sent_at?: Date;
    },
    countAttempt: boolean,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.executor(scope)
      .updateTable('meta.notification_deliveries')
      .set((eb) => ({
        ...values,
        ...(countAttempt ? { attempts: eb('attempts', '+', 1) } : {}),
      }))
      .where('organization_id', '=', scope.organizationId)
      .where('channel', '=', this.channel)
      .where('status', '=', 'pending')
      .where('notification_id', 'in', [...ids])
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
