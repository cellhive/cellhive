import {
  GroupMembersRepository,
  loadQueryView,
  ViewsRepository,
  type AppConfig,
} from '@cellhive/server-core';
import { isAppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, type BaseAccess } from '../../common/access/access.service.js';
import { userTimeZone } from '../../common/access/time-zone.js';
import { SchemaAccess } from '../../common/schema/schema-access.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { DashboardService } from '../dashboard/dashboard.service.js';

import type { RuleVariables, SubscriberView } from './realtime-connection.js';
import type { Principal } from '../../common/auth/principal.js';
import type { Id, RealtimeChannel, RealtimeSubscribeView } from '@cellhive/contracts';

/** A channel the caller may read, and where its messages come from. */
export interface ChannelGrant {
  /** Organizations whose bus carries the channel's messages. */
  readonly orgIds: readonly Id<'org'>[];
  readonly baseId: Id<'bse'> | null;
  readonly base: BaseAccess | null;
  /** Record-rule variables for `table:` channels (T210), else `null`. */
  readonly variables: RuleVariables | null;
  /**
   * The view asked for with a `table:` subscription (T313): `null` when none
   * was asked, `'not_found'` when the table is readable but the view is not
   * (deleted, hidden by `visible_views`, someone else's personal view).
   */
  readonly view: SubscriberView | null | 'not_found';
  /** Tables read by the widgets of a `dashboard:` channel (T807), else `null`. */
  readonly tables: ReadonlySet<Id<'tbl'>> | null;
}

/**
 * Who may subscribe to what (CONTRACTS §7, AGENTS.md rule 4): `base:` needs
 * read access to the base, `table:` a table visible in its base (not
 * `no_perm`), `user:` is the caller's own channel only, `dashboard:` a
 * dashboard the caller may read as `GET /dashboards/:id` (T807: base access,
 * `dashboards.<id>` of their role, the token's `base_ids`). Anything else —
 * missing, in the trash, another organization, no access — is `undefined`,
 * which the gateway reports as `NOT_FOUND` without telling the cases apart.
 * A view asked for with `table:` must be one the caller can query records
 * through (CONTRACTS §1.4, same check as `view_id`).
 */
@Injectable()
export class ChannelAuthorizer {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DashboardService) private readonly dashboards: DashboardService,
  ) {}

  async authorize(
    principal: Principal,
    channel: RealtimeChannel,
    view: RealtimeSubscribeView | null = null,
  ): Promise<ChannelGrant | undefined> {
    switch (channel.kind) {
      case 'base': {
        const base = await this.access.findBase(principal, channel.id);
        return base === undefined
          ? undefined
          : {
              orgIds: [base.org.organizationId],
              baseId: base.base.id,
              base,
              variables: null,
              view: null,
              tables: null,
            };
      }
      case 'table': {
        try {
          const found = await this.schemaAccess.requireTable(principal, channel.id, 'read');
          const subscriberView = await this.view(principal, found.base, channel.id, view);
          return {
            orgIds: [found.base.org.organizationId],
            baseId: found.base.base.id,
            base: found.base,
            variables: await this.variables(
              principal,
              found.base,
              channel.id,
              subscriberView === null || subscriberView === 'not_found'
                ? null
                : // Color rules (T816) are evaluated with the same variables.
                  [subscriberView.filter, subscriberView.colorRules ?? []],
            ),
            view: subscriberView,
            tables: null,
          };
        } catch (error) {
          if (isAppError(error) && error.code === 'NOT_FOUND') return undefined;
          throw error;
        }
      }
      case 'user': {
        if (channel.id !== principal.userId) return undefined;
        const memberships = await this.access.memberships(principal);
        return {
          orgIds: memberships.map((membership) => membership.organizationId),
          baseId: null,
          base: null,
          variables: null,
          view: null,
          tables: null,
        };
      }
      case 'dashboard': {
        const found = await this.dashboards.channel(principal, channel.id);
        return found === undefined
          ? undefined
          : {
              orgIds: [found.base.org.organizationId],
              baseId: found.base.base.id,
              base: found.base,
              variables: null,
              view: null,
              tables: new Set(found.tableIds),
            };
      }
    }
  }

  /** The view asked for, loaded when the caller can read records through it. */
  private async view(
    principal: Principal,
    base: BaseAccess,
    tableId: Id<'tbl'>,
    request: RealtimeSubscribeView | null,
  ): Promise<SubscriberView | null | 'not_found'> {
    if (request === null) return null;
    const tableAccess = base.access.tables[tableId];
    if (tableAccess === undefined) return 'not_found';
    try {
      const view = await loadQueryView(
        this.views,
        base.org.scope,
        tableId,
        tableAccess,
        principal.userId,
        request.id,
      );
      return {
        id: request.id,
        filterMode: request.filter_mode ?? 'and',
        filter: view.config.filter,
        colorRules: view.config.color_rules ?? [],
      };
    } catch (error) {
      if (isAppError(error) && error.code === 'NOT_FOUND') return 'not_found';
      throw error;
    }
  }

  /**
   * What the realtime gateway needs to evaluate the subscriber's read rule
   * (and view filter, T313) on the table in memory: the zone of date
   * operands and, only when one of them uses `current_user_groups`, the
   * members of the user's groups.
   */
  private async variables(
    principal: Principal,
    base: BaseAccess,
    tableId: Id<'tbl'>,
    viewFilter: unknown,
  ): Promise<RuleVariables> {
    const rule = base.resolved.internal.readFilters[tableId];
    const usesGroups =
      (rule !== undefined &&
        rule !== null &&
        JSON.stringify(rule).includes('current_user_groups')) ||
      (viewFilter !== null &&
        viewFilter !== undefined &&
        JSON.stringify(viewFilter).includes('current_user_groups'));
    return {
      timeZone: userTimeZone(principal, base, this.config.defaults.timezone),
      groupMemberUserIds: usesGroups
        ? await this.groupMembers.userIdsOfGroups(base.org.scope, base.groupIds)
        : [],
    };
  }
}
