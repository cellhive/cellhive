import {
  ACTIVE_NOTIFICATION_TYPES,
  DEFAULT_AUTO_FOLLOW_ASSIGNED,
  DEFAULT_AUTO_FOLLOW_CREATED,
  DEFAULT_DAILY_DIGEST_HOUR,
  DEFAULT_EMAIL_FREQUENCY,
  isMandatoryNotificationType,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_UNREAD_COUNT_CAP,
  type Id,
  type MarkNotificationsReadInput,
  type MarkNotificationsReadResult,
  type NotificationDto,
  type NotificationListDto,
  type NotificationListQuery,
  type NotificationPreferencesDto,
  type NotificationSettingsDto,
  type UpdateNotificationPreferencesInput,
  type UpdateNotificationSettingsInput,
} from '@cellhive/contracts';
import {
  AutomationRunsRepository,
  AutomationsRepository,
  batchOverflowSkipped,
  canSeeAutomation,
  decodeCursor,
  GroupMembersRepository,
  NotificationBaseMutesRepository,
  NotificationPreferencesRepository,
  NotificationSettingsRepository,
  NotificationsRepository,
  OrganizationsRepository,
  orgTelegramSettingsOf,
  readableRecordTitles,
  RecordQueryService,
  TablesRepository,
  type AppConfig,
  type Db,
  type NotificationRow,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, type BaseAccess } from '../../common/access/access.service.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';

/**
 * `/orgs/:orgId/me/notifications…` (CONTRACTS §22, BACKLOG T511): the
 * caller's own in-app notifications, preferences, email settings and base
 * mutes in one organization. Any member; a non-member gets `404`. Nothing
 * here is audited: these are personal settings and read marks.
 *
 * Titles are rendered **now** with the caller's current access: a record
 * they cannot read any more keeps its item but gets `title: null` (no
 * link); a base they cannot open is `base: null`.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RecordQueryService) private readonly records: RecordQueryService,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(AutomationsRepository) private readonly automations: AutomationsRepository,
    @Inject(AutomationRunsRepository) private readonly runs: AutomationRunsRepository,
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository,
    @Inject(NotificationPreferencesRepository)
    private readonly preferences: NotificationPreferencesRepository,
    @Inject(NotificationSettingsRepository)
    private readonly settings: NotificationSettingsRepository,
    @Inject(NotificationBaseMutesRepository)
    private readonly mutes: NotificationBaseMutesRepository,
  ) {}

  async list(
    principal: Principal,
    organizationId: Id<'org'>,
    query: NotificationListQuery,
  ): Promise<NotificationListDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const page = await this.notifications.list(
      org.scope,
      {
        userId: principal.userId,
        unreadOnly: query.unread === true,
        ...(query.base_id === undefined ? {} : { baseId: query.base_id }),
      },
      { cursor: decodeCursor(query.cursor), limit: query.limit },
    );
    return {
      items: await this.render(principal, organizationId, page.items),
      next_cursor: page.nextCursor,
    };
  }

  async unreadCount(principal: Principal, organizationId: Id<'org'>): Promise<{ count: number }> {
    const org = await this.access.requireOrg(principal, organizationId);
    return {
      count: await this.notifications.countUnread(
        org.scope,
        principal.userId,
        NOTIFICATION_UNREAD_COUNT_CAP,
      ),
    };
  }

  async markRead(
    principal: Principal,
    organizationId: Id<'org'>,
    input: MarkNotificationsReadInput,
  ): Promise<MarkNotificationsReadResult> {
    const org = await this.access.requireOrg(principal, organizationId);
    const target =
      'ids' in input
        ? { ids: [...new Set(input.ids)] }
        : { all: true as const, ...(input.base_id === undefined ? {} : { baseId: input.base_id }) };
    const updated = await this.notifications.markRead(
      org.scope,
      principal.userId,
      target,
      new Date(),
    );
    return { updated };
  }

  async getPreferences(
    principal: Principal,
    organizationId: Id<'org'>,
  ): Promise<NotificationPreferencesDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const [stored, organization] = await Promise.all([
      this.preferences.listForUsers(org.scope, [principal.userId]),
      new OrganizationsRepository(this.db).findById(organizationId),
    ]);
    const byKey = new Map(stored.map((row) => [`${row.type}|${row.channel}`, row.enabled]));
    // T550: the Telegram column only while the organization has a notification bot.
    const hasBot = orgTelegramSettingsOf(organization?.settings).secretId !== null;
    const channels = NOTIFICATION_CHANNELS.filter((channel) => channel !== 'telegram' || hasBot);
    const items: NotificationPreferencesDto['items'] = [];
    for (const type of ACTIVE_NOTIFICATION_TYPES) {
      for (const channel of channels) {
        const locked = channel === 'in_app' && isMandatoryNotificationType(type);
        items.push({
          type,
          channel,
          enabled:
            locked || (byKey.get(`${type}|${channel}`) ?? NOTIFICATION_DEFAULTS[type][channel]),
          locked,
        });
      }
    }
    return { items };
  }

  async updatePreferences(
    principal: Principal,
    organizationId: Id<'org'>,
    input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferencesDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const errors = input.items.flatMap((item, index) =>
      item.channel === 'in_app' && !item.enabled && isMandatoryNotificationType(item.type)
        ? [
            {
              path: `items.${String(index)}.enabled`,
              code: 'NOT_ALLOWED',
              message: `In-app notifications of type ${item.type} cannot be turned off`,
              params: { type: item.type, channel: item.channel },
            },
          ]
        : [],
    );
    if (errors.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Some notifications cannot be turned off.',
        errors,
      });
    }
    // The last value given for a (type, channel) wins.
    const items = new Map<string, (typeof input.items)[number]>();
    for (const item of input.items) items.set(`${item.type}|${item.channel}`, item);
    await this.preferences.upsert(org.scope, principal.userId, [...items.values()]);
    return this.getPreferences(principal, organizationId);
  }

  async getSettings(
    principal: Principal,
    organizationId: Id<'org'>,
  ): Promise<NotificationSettingsDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const [stored] = await this.settings.listForUsers(org.scope, [principal.userId]);
    const mutedBases: NotificationSettingsDto['muted_bases'] = [];
    for (const baseId of await this.mutes.listBaseIds(org.scope, principal.userId)) {
      const base = await this.findOwnBase(principal, organizationId, baseId);
      // A base the caller cannot open any more is not named (the mute stays harmless).
      if (base !== undefined) mutedBases.push({ id: base.base.id, name: base.base.name });
    }
    return {
      email_frequency: stored?.email_frequency ?? DEFAULT_EMAIL_FREQUENCY,
      daily_hour: stored?.daily_hour ?? DEFAULT_DAILY_DIGEST_HOUR,
      muted_bases: mutedBases,
      auto_follow_created: stored?.auto_follow_created ?? DEFAULT_AUTO_FOLLOW_CREATED,
      auto_follow_assigned: stored?.auto_follow_assigned ?? DEFAULT_AUTO_FOLLOW_ASSIGNED,
    };
  }

  async updateSettings(
    principal: Principal,
    organizationId: Id<'org'>,
    input: UpdateNotificationSettingsInput,
  ): Promise<NotificationSettingsDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const [stored] = await this.settings.listForUsers(org.scope, [principal.userId]);
    await this.settings.upsert(org.scope, principal.userId, {
      emailFrequency: input.email_frequency ?? stored?.email_frequency ?? DEFAULT_EMAIL_FREQUENCY,
      dailyHour: input.daily_hour ?? stored?.daily_hour ?? DEFAULT_DAILY_DIGEST_HOUR,
      autoFollowCreated:
        input.auto_follow_created ?? stored?.auto_follow_created ?? DEFAULT_AUTO_FOLLOW_CREATED,
      autoFollowAssigned:
        input.auto_follow_assigned ?? stored?.auto_follow_assigned ?? DEFAULT_AUTO_FOLLOW_ASSIGNED,
    });
    return this.getSettings(principal, organizationId);
  }

  /** Needs read access to the base (`404` otherwise, also for a base of another organization). */
  async muteBase(
    principal: Principal,
    organizationId: Id<'org'>,
    baseId: Id<'bse'>,
  ): Promise<void> {
    const org = await this.access.requireOrg(principal, organizationId);
    if ((await this.findOwnBase(principal, organizationId, baseId)) === undefined) throw notFound();
    await this.mutes.mute(org.scope, principal.userId, baseId);
  }

  /** Works without access to the base (unmuting discloses nothing). */
  async unmuteBase(
    principal: Principal,
    organizationId: Id<'org'>,
    baseId: Id<'bse'>,
  ): Promise<void> {
    const org = await this.access.requireOrg(principal, organizationId);
    await this.mutes.unmute(org.scope, principal.userId, baseId);
  }

  // -------------------------------------------------------------------------

  /** The caller's access to a base of this organization, or `undefined`. */
  private async findOwnBase(
    principal: Principal,
    organizationId: Id<'org'>,
    baseId: Id<'bse'>,
  ): Promise<BaseAccess | undefined> {
    const base = await this.access.findBase(principal, baseId);
    return base?.org.organizationId === organizationId ? base : undefined;
  }

  /**
   * DTOs of stored rows: base names and entity titles with the caller's
   * current access (records through `RecordQueryService`).
   */
  private async render(
    principal: Principal,
    organizationId: Id<'org'>,
    rows: readonly NotificationRow[],
  ): Promise<NotificationDto[]> {
    const bases = new Map<Id<'bse'>, BaseAccess | undefined>();
    for (const baseId of new Set(
      rows.flatMap((row) => (row.base_id === null ? [] : [row.base_id])),
    )) {
      bases.set(baseId, await this.findOwnBase(principal, organizationId, baseId));
    }
    const titles = new Map<string, string | null>();
    const key = (type: string, id: string) => `${type}|${id}`;

    // Records, by table: one read per table.
    const byTable = new Map<string, { base: BaseAccess; tableId: Id<'tbl'>; ids: Set<string> }>();
    for (const row of rows) {
      if (row.entity_type !== 'record' || row.base_id === null || row.table_id === null) continue;
      const base = bases.get(row.base_id);
      if (base === undefined) continue;
      const group = byTable.get(row.table_id) ?? { base, tableId: row.table_id, ids: new Set() };
      group.ids.add(row.entity_id);
      byTable.set(row.table_id, group);
    }
    for (const group of byTable.values()) {
      const context = await recordAccessContextOf(
        { groupMembers: this.groupMembers, config: this.config },
        principal.user,
        group.base,
      );
      const found = await readableRecordTitles(
        this.db,
        this.records,
        group.base.org.scope,
        context,
        group.tableId,
        [...group.ids],
      );
      for (const [id, title] of found) titles.set(key('record', id), title);
    }

    // Tables and bases: their names, when the caller sees them.
    for (const row of rows) {
      const base = row.base_id === null ? undefined : bases.get(row.base_id);
      if (base === undefined) continue;
      if (row.entity_type === 'base' && row.entity_id === base.base.id) {
        titles.set(key('base', row.entity_id), base.base.name);
      }
      if (
        row.entity_type === 'table' &&
        base.access.tables[row.entity_id as Id<'tbl'>] !== undefined &&
        !titles.has(key('table', row.entity_id))
      ) {
        const table = await this.tables.getById(base.org.scope, row.entity_id as Id<'tbl'>);
        if (table?.base_id === base.base.id) titles.set(key('table', row.entity_id), table.name);
      }
    }
    // Automations (T502): their name, when the caller can see the automation
    // (CONTRACTS §21: base admin, or reads its trigger table). Jobs: no title.
    for (const row of rows) {
      const base = row.base_id === null ? undefined : bases.get(row.base_id);
      if (row.entity_type !== 'automation' || base === undefined) continue;
      if (titles.has(key('automation', row.entity_id))) continue;
      const automation = await this.automations.get(base.org.scope, row.entity_id as Id<'aut'>);
      titles.set(
        key('automation', row.entity_id),
        automation?.base_id === base.base.id &&
          canSeeAutomation(base.access, automation.trigger_table_id)
          ? automation.name
          : null,
      );
    }
    // `automation.batch_overflow` (QA S5 L6, T542): the records left out,
    // read now from the stand-in run, only for a caller who still sees the
    // automation (its name was rendered above); never stored on the row.
    const skippedOf = new Map<Id<'ntf'>, number | null>();
    for (const row of rows) {
      if (row.type !== 'automation.batch_overflow') continue;
      const base = row.base_id === null ? undefined : bases.get(row.base_id);
      const visible = titles.get(key('automation', row.entity_id)) != null;
      skippedOf.set(
        row.id,
        base === undefined || !visible
          ? null
          : await batchOverflowSkipped(this.runs, base.org.scope, row.payload, row.entity_id),
      );
    }

    return rows.map((row) => {
      const base = row.base_id === null ? undefined : bases.get(row.base_id);
      return {
        id: row.id,
        type: row.type,
        base: base === undefined ? null : { id: base.base.id, name: base.base.name },
        table_id: row.table_id,
        entity: {
          type: row.entity_type,
          id: row.entity_id,
          title: titles.get(key(row.entity_type, row.entity_id)) ?? null,
        },
        actor:
          row.actor_type === null || row.actor_id === null
            ? null
            : { type: row.actor_type, id: row.actor_id, name: row.actor_name },
        data: {
          ...(typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
            ? row.payload
            : {}),
          ...(skippedOf.has(row.id) ? { skipped: skippedOf.get(row.id) ?? null } : {}),
        },
        read_at: row.read_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
      };
    });
  }
}
