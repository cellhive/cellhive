import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type {
  EmailFrequency,
  Id,
  NotificationChannel,
  NotificationType,
} from '@cellhive/contracts';

/** A stored preference (no row = the type default, CONTRACTS §22). */
export interface NotificationPreferenceRow {
  readonly user_id: Id<'usr'>;
  readonly type: NotificationType;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}

/** `meta.notification_preferences` (migration 0028, T511). */
export class NotificationPreferencesRepository
  extends TenantRepository<'notification_preferences'>
  implements TenantRepositoryContract<NotificationPreferencesRepository>
{
  constructor(db: Db) {
    super(db, 'notification_preferences');
  }

  /** Stored preferences of these users, optionally of one type. */
  async listForUsers(
    scope: OrgScope,
    userIds: readonly Id<'usr'>[],
    type?: NotificationType,
  ): Promise<NotificationPreferenceRow[]> {
    if (userIds.length === 0) return [];
    let query = this.executor(scope)
      .selectFrom('meta.notification_preferences')
      .select(['user_id', 'type', 'channel', 'enabled'])
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', 'in', [...userIds]);
    if (type !== undefined) query = query.where('type', '=', type);
    const rows = await query.orderBy('user_id').orderBy('type').orderBy('channel').execute();
    return rows as NotificationPreferenceRow[];
  }

  /** Stores the given preferences of one user (others unchanged). */
  async upsert(
    scope: OrgScope,
    userId: Id<'usr'>,
    items: readonly {
      readonly type: NotificationType;
      readonly channel: NotificationChannel;
      readonly enabled: boolean;
    }[],
  ): Promise<void> {
    if (items.length === 0) return;
    await this.executor(scope)
      .insertInto('meta.notification_preferences')
      .values(
        items.map((item) => ({
          organization_id: scope.organizationId,
          user_id: userId,
          type: item.type,
          channel: item.channel,
          enabled: item.enabled,
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'user_id', 'type', 'channel'])
          .doUpdateSet((eb) => ({ enabled: eb.ref('excluded.enabled') })),
      )
      .execute();
  }
}

/** Email and auto-follow settings of one user in one organization. */
export interface NotificationSettingsRow {
  readonly user_id: Id<'usr'>;
  readonly email_frequency: EmailFrequency;
  readonly daily_hour: number;
  /** Migration 0039 (T543): follow the records the user creates by hand. */
  readonly auto_follow_created: boolean;
  /** Migration 0039 (T543): follow the records the user is assigned to (T544). */
  readonly auto_follow_assigned: boolean;
}

/**
 * Values `NotificationSettingsRepository.upsert` writes; an auto-follow
 * switch left out keeps its stored value (its default on a new row).
 */
export interface NotificationSettingsValues {
  readonly emailFrequency: EmailFrequency;
  readonly dailyHour: number;
  readonly autoFollowCreated?: boolean;
  readonly autoFollowAssigned?: boolean;
}

const SETTINGS_COLUMNS = [
  'user_id',
  'email_frequency',
  'daily_hour',
  'auto_follow_created',
  'auto_follow_assigned',
] as const;

/** `meta.notification_settings` (migration 0028, T511; read by the digest of T512). */
export class NotificationSettingsRepository
  extends TenantRepository<'notification_settings'>
  implements TenantRepositoryContract<NotificationSettingsRepository>
{
  constructor(db: Db) {
    super(db, 'notification_settings');
  }

  /** Stored settings of these users (absent = defaults). */
  async listForUsers(
    scope: OrgScope,
    userIds: readonly Id<'usr'>[],
  ): Promise<NotificationSettingsRow[]> {
    if (userIds.length === 0) return [];
    const rows = await this.executor(scope)
      .selectFrom('meta.notification_settings')
      .select(SETTINGS_COLUMNS)
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', 'in', [...userIds])
      .orderBy('user_id')
      .execute();
    return rows as NotificationSettingsRow[];
  }

  /** Creates or changes the settings of one user; returns them. */
  async upsert(
    scope: OrgScope,
    userId: Id<'usr'>,
    values: NotificationSettingsValues,
  ): Promise<NotificationSettingsRow> {
    const columns = {
      email_frequency: values.emailFrequency,
      daily_hour: values.dailyHour,
      ...(values.autoFollowCreated === undefined
        ? {}
        : { auto_follow_created: values.autoFollowCreated }),
      ...(values.autoFollowAssigned === undefined
        ? {}
        : { auto_follow_assigned: values.autoFollowAssigned }),
    };
    const row = await this.executor(scope)
      .insertInto('meta.notification_settings')
      .values({ organization_id: scope.organizationId, user_id: userId, ...columns })
      .onConflict((oc) => oc.columns(['organization_id', 'user_id']).doUpdateSet(columns))
      .returning(SETTINGS_COLUMNS)
      .executeTakeFirstOrThrow();
    return row as NotificationSettingsRow;
  }
}

/** `meta.notification_base_mutes` (migration 0028, T511; ADR-32 §1). */
export class NotificationBaseMutesRepository
  extends TenantRepository<'notification_base_mutes'>
  implements TenantRepositoryContract<NotificationBaseMutesRepository>
{
  constructor(db: Db) {
    super(db, 'notification_base_mutes');
  }

  /** Mutes a base for a user (idempotent). */
  async mute(scope: OrgScope, userId: Id<'usr'>, baseId: Id<'bse'>): Promise<void> {
    await this.executor(scope)
      .insertInto('meta.notification_base_mutes')
      .values({ organization_id: scope.organizationId, user_id: userId, base_id: baseId })
      .onConflict((oc) => oc.columns(['organization_id', 'user_id', 'base_id']).doNothing())
      .execute();
  }

  /** Unmutes a base for a user; `false` when it was not muted. */
  async unmute(scope: OrgScope, userId: Id<'usr'>, baseId: Id<'bse'>): Promise<boolean> {
    const result = await this.executor(scope)
      .deleteFrom('meta.notification_base_mutes')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('base_id', '=', baseId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /** Bases a user muted, oldest mute first. */
  async listBaseIds(scope: OrgScope, userId: Id<'usr'>): Promise<Id<'bse'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.notification_base_mutes')
      .select('base_id')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .orderBy('base_id')
      .execute();
    return rows.map((row) => row.base_id);
  }

  /** Which of these users muted the base. */
  async mutedUsers(
    scope: OrgScope,
    baseId: Id<'bse'>,
    userIds: readonly Id<'usr'>[],
  ): Promise<Set<Id<'usr'>>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.executor(scope)
      .selectFrom('meta.notification_base_mutes')
      .select('user_id')
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('user_id', 'in', [...userIds])
      .execute();
    return new Set(rows.map((row) => row.user_id));
  }
}
