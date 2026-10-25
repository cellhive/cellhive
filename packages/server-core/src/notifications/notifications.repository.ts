import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { afterCursor, cursorTimestamp, pageWithCursor, type KeysetCursor } from '../db/cursor.js';
import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { ActorType, JsonObject, JsonValue } from '../db/schema.js';
import type { Id, NotificationEntityType, NotificationType } from '@cellhive/contracts';

/** A row to insert into `meta.notifications` (one recipient). */
export interface NewNotification {
  readonly id: Id<'ntf'>;
  readonly userId: Id<'usr'>;
  readonly type: NotificationType;
  readonly baseId: Id<'bse'> | null;
  readonly tableId: Id<'tbl'> | null;
  readonly entityType: NotificationEntityType;
  readonly entityId: string;
  readonly actor: { readonly type: ActorType; readonly id: string } | null;
  readonly groupKey: string | null;
  readonly payload: JsonObject;
  /** `false`: kept only for another channel (the user turned in-app off). */
  readonly inApp: boolean;
}

/** A stored notification, as the list returns it. */
export interface NotificationRow {
  readonly id: Id<'ntf'>;
  readonly user_id: Id<'usr'>;
  readonly type: NotificationType;
  readonly base_id: Id<'bse'> | null;
  readonly table_id: Id<'tbl'> | null;
  readonly entity_type: NotificationEntityType;
  readonly entity_id: string;
  readonly actor_type: ActorType | null;
  readonly actor_id: string | null;
  /** Display name of a user actor still in the organization. */
  readonly actor_name: string | null;
  readonly group_key: string | null;
  readonly payload: JsonValue;
  readonly read_at: Date | null;
  readonly created_at: Date;
  /** `created_at` with microseconds, for the keyset cursor. */
  readonly cursor_at: string;
}

export interface NotificationListFilter {
  readonly userId: Id<'usr'>;
  readonly unreadOnly?: boolean;
  readonly baseId?: Id<'bse'>;
}

export interface NotificationPage {
  readonly items: NotificationRow[];
  readonly nextCursor: string | null;
}

/** Which notifications `markRead` touches. */
export type NotificationReadTarget =
  { readonly ids: readonly Id<'ntf'>[] } | { readonly all: true; readonly baseId?: Id<'bse'> };

/**
 * `meta.notifications` (migration 0028, BACKLOG T511). Every query is scoped
 * by `organization_id` and, for a person's list, by `user_id`; who may read
 * what is decided by the callers (the recipient check of the fan-out, the
 * `/me` routes of the api).
 */
export class NotificationsRepository
  extends TenantRepository<'notifications'>
  implements TenantRepositoryContract<NotificationsRepository>
{
  constructor(db: Db) {
    super(db, 'notifications');
  }

  /**
   * Inserts the rows; a row whose (user, type, `group_key`) already exists
   * is skipped (producers' idempotency). Returns the rows inserted.
   */
  async insertMany(
    scope: OrgScope,
    rows: readonly NewNotification[],
  ): Promise<{ id: Id<'ntf'>; user_id: Id<'usr'> }[]> {
    if (rows.length === 0) return [];
    return this.executor(scope)
      .insertInto('meta.notifications')
      .values(
        rows.map((row) => ({
          id: row.id,
          organization_id: scope.organizationId,
          user_id: row.userId,
          type: row.type,
          base_id: row.baseId,
          table_id: row.tableId,
          entity_type: row.entityType,
          entity_id: row.entityId,
          actor_type: row.actor?.type ?? null,
          actor_id: row.actor?.id ?? null,
          group_key: row.groupKey,
          payload: row.payload,
          in_app: row.inApp,
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'user_id', 'type', 'group_key'])
          .where('group_key', 'is not', null)
          .doNothing(),
      )
      .returning(['id', 'user_id'])
      .execute();
  }

  /** In-app notifications of a user, newest first, cursor-paginated. */
  async list(
    scope: OrgScope,
    filter: NotificationListFilter,
    page: { readonly cursor: KeysetCursor | null; readonly limit: number },
  ): Promise<NotificationPage> {
    const conditions: RawBuilder<SqlBool>[] = [];
    if (filter.unreadOnly === true) conditions.push(sql<SqlBool>`n.read_at IS NULL`);
    if (filter.baseId !== undefined) conditions.push(sql<SqlBool>`n.base_id = ${filter.baseId}`);
    if (page.cursor !== null) {
      conditions.push(afterCursor(sql`n.created_at`, sql`n.id`, page.cursor));
    }
    const extra = conditions.length === 0 ? sql`` : sql` AND ${sql.join(conditions, sql` AND `)}`;
    const { rows } = await sql<NotificationRow>`
      SELECT n.id, n.user_id, n.type, n.base_id, n.table_id, n.entity_type, n.entity_id,
             n.actor_type, n.actor_id,
             CASE WHEN n.actor_type = 'user' AND m.user_id IS NOT NULL AND u.status <> 'deleted'
                  THEN u.display_name END AS actor_name,
             n.group_key, n.payload, n.read_at, n.created_at,
             ${cursorTimestamp(sql`n.created_at`)} AS cursor_at
        FROM meta.notifications AS n
        LEFT JOIN meta.org_members AS m
               ON n.actor_type = 'user' AND m.organization_id = n.organization_id
              AND m.user_id = n.actor_id
        LEFT JOIN meta.users AS u ON u.id = m.user_id
       WHERE n.organization_id = ${scope.organizationId}
         AND n.user_id = ${filter.userId}
         AND n.in_app${extra}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ${page.limit + 1}
    `.execute(this.executor(scope));
    return pageWithCursor(rows, page.limit, (row) => ({ at: row.cursor_at, id: row.id }));
  }

  /** Unread in-app notifications of a user, counted up to `cap`. */
  async countUnread(scope: OrgScope, userId: Id<'usr'>, cap: number): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM meta.notifications
         WHERE organization_id = ${scope.organizationId}
           AND user_id = ${userId}
           AND in_app
           AND read_at IS NULL
         LIMIT ${cap}
      ) AS unread
    `.execute(this.executor(scope));
    return rows[0]?.n ?? 0;
  }

  /** Marks unread in-app notifications of `userId` read; returns how many changed. */
  async markRead(
    scope: OrgScope,
    userId: Id<'usr'>,
    target: NotificationReadTarget,
    at: Date,
  ): Promise<number> {
    let query = this.executor(scope)
      .updateTable('meta.notifications')
      .set({ read_at: at })
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('in_app', '=', true)
      .where('read_at', 'is', null);
    if ('ids' in target) {
      if (target.ids.length === 0) return 0;
      query = query.where('id', 'in', [...target.ids]);
    } else if (target.baseId !== undefined) {
      query = query.where('base_id', '=', target.baseId);
    }
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * Deletes the notifications about these entities (e.g. the content of
   * `automation.message` when its record is purged, ADR-32 §1).
   */
  async deleteByEntity(
    scope: OrgScope,
    entityType: NotificationEntityType,
    entityIds: readonly string[],
  ): Promise<number> {
    if (entityIds.length === 0) return 0;
    const result = await this.executor(scope)
      .deleteFrom('meta.notifications')
      .where('organization_id', '=', scope.organizationId)
      .where('entity_type', '=', entityType)
      .where('entity_id', 'in', [...entityIds])
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Deletes the notifications about records of a table (its records are
   * purged with it — T515, ADR-32 §1).
   */
  async deleteRecordsOfTable(scope: OrgScope, tableId: Id<'tbl'>): Promise<number> {
    const result = await this.executor(scope)
      .deleteFrom('meta.notifications')
      .where('organization_id', '=', scope.organizationId)
      .where('entity_type', '=', 'record')
      .where('table_id', '=', tableId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

/** A queued delivery of a notification on a channel other than in-app. */
export interface NotificationDeliveryRow {
  readonly notification_id: Id<'ntf'>;
  readonly channel: NotificationDeliveryChannel;
  readonly status: 'pending' | 'sent' | 'skipped' | 'failed';
  readonly created_at: Date;
}

/** Channels with an outbox row (in-app is the notification row itself). */
export type NotificationDeliveryChannel = 'email' | 'telegram';

/**
 * `meta.notification_deliveries` (migration 0028; `telegram` from 0040): the
 * outbox of the email and Telegram channels. T511 queues (`pending`); T512
 * (email) and T550 (Telegram) send, group and mark.
 */
export class NotificationDeliveriesRepository
  extends TenantRepository<'notification_deliveries'>
  implements TenantRepositoryContract<NotificationDeliveriesRepository>
{
  constructor(db: Db) {
    super(db, 'notification_deliveries');
  }

  /** Queues one `pending` delivery per notification (existing ones are kept). */
  async queue(
    scope: OrgScope,
    channel: NotificationDeliveryChannel,
    notificationIds: readonly Id<'ntf'>[],
  ): Promise<number> {
    if (notificationIds.length === 0) return 0;
    const rows = await this.executor(scope)
      .insertInto('meta.notification_deliveries')
      .values(
        notificationIds.map((id) => ({
          organization_id: scope.organizationId,
          notification_id: id,
          channel,
        })),
      )
      .onConflict((oc) => oc.columns(['notification_id', 'channel']).doNothing())
      .returning('notification_id')
      .execute();
    return rows.length;
  }

  /** Deliveries of these notifications. */
  async listByNotifications(
    scope: OrgScope,
    notificationIds: readonly Id<'ntf'>[],
  ): Promise<NotificationDeliveryRow[]> {
    if (notificationIds.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.notification_deliveries')
      .select(['notification_id', 'channel', 'status', 'created_at'])
      .where('organization_id', '=', scope.organizationId)
      .where('notification_id', 'in', [...notificationIds])
      .orderBy('notification_id')
      .execute();
  }
}
