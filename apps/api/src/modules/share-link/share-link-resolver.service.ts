import {
  publicSharingAllows,
  resolveShareLinkAccess,
  shareLinkState,
  type ResolvedBaseAccess,
} from '@cellhive/permissions';
import {
  DashboardsRepository,
  DashboardWidgetsRepository,
  findShareLinkOrganization,
  GroupMembersRepository,
  hashShareToken,
  isShareTokenFormat,
  orgScope,
  ShareLinksRepository,
  UsersRepository,
  ViewsRepository,
  type AppConfig,
  type DashboardRow,
  type DashboardWidgetRow,
  type Db,
  type OrgScope,
  type RecordAccessContext,
  type ShareLinkRow,
  type ViewRow,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, type BaseAccess } from '../../common/access/access.service.js';
import { publicSharingPolicyOf } from '../../common/access/public-sharing.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import {
  dashboardShareScopeOf,
  shareLinkScopeOf,
  storedSettingsOf,
  targetTypeOf,
} from './share-link-scope.js';

import type { ShareLinkSettings } from '@cellhive/contracts';

/** Why a known token does not work (`410 SHARE_LINK_GONE`; never sent to clients). */
export type ShareLinkGoneReason =
  | 'revoked'
  | 'disabled'
  | 'expired'
  | 'public_sharing_disabled'
  | 'target_deleted'
  | 'creator_lost_access';

/** A working link and everything the share endpoints (T305/T306) need. */
export interface ResolvedShareLink {
  readonly scope: OrgScope;
  readonly link: ShareLinkRow;
  readonly settings: ShareLinkSettings;
  /** The target view or form. */
  readonly view: ViewRow;
  /** The creator's current access to the base. */
  readonly creator: BaseAccess;
  /** Effective access of the link: creator ∩ target scope, read only (form: create only). */
  readonly access: ResolvedBaseAccess;
  /**
   * Record access context for the record services: the link's access with
   * the creator's variables (`current_user`, groups, zone) (SPEC §15A.2);
   * linked tables (titles of a view link, link questions of a form link)
   * are read with the creator's current access (`relatedAccess`, T409/T410).
   */
  readonly recordAccess: RecordAccessContext;
}

/**
 * A working dashboard link (BACKLOG T809): like {@link ResolvedShareLink}
 * with the dashboard and its widgets instead of a view. `access` is the
 * creator's current access ∩ the tables the dashboard reads, read only
 * (`resolveShareLinkAccess`, kind `dashboard`).
 */
export interface ResolvedDashboardShareLink extends Omit<ResolvedShareLink, 'view'> {
  readonly dashboard: DashboardRow;
  /** Widgets of the dashboard, the only things the link may compute. */
  readonly widgets: readonly DashboardWidgetRow[];
}

/** A working link of any target. */
export type AnyResolvedShareLink = ResolvedShareLink | ResolvedDashboardShareLink;

/** Whether a resolved link is a dashboard link. */
export function isDashboardLink(link: AnyResolvedShareLink): link is ResolvedDashboardShareLink {
  return 'dashboard' in link;
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'The link does not exist.' });
}

function gone(): AppError {
  return new AppError('SHARE_LINK_GONE', {
    detail: 'The link was revoked, has expired or no longer works.',
  });
}

/**
 * Resolves a share link token on every request (SPEC §15A.2, CONTRACTS §16;
 * used by the public endpoints of T305/T306):
 *
 * - malformed or unknown token → `404 NOT_FOUND`;
 * - revoked, turned off, expired, public while the organization policy no
 *   longer allows it, target deleted (or made personal; a dashboard in the
 *   trash), or creator without access now (left the organization,
 *   deactivated, lost the role, the right to share, the view, the
 *   dashboard or — for a form — `add`) → `410 SHARE_LINK_GONE`, one code
 *   for all (the reason is only logged by callers, never returned).
 *
 * Audience `org` (membership of the viewer) and passwords are checked by
 * the share endpoints on top.
 */
@Injectable()
export class ShareLinkResolver {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ShareLinksRepository) private readonly links: ShareLinksRepository,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(DashboardsRepository) private readonly dashboards: DashboardsRepository,
    @Inject(DashboardWidgetsRepository) private readonly widgets: DashboardWidgetsRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
  ) {}

  /**
   * The working view or form link of `token`; throws `404`/`410` as
   * described above, and `404` for a dashboard link (no view routes).
   */
  async resolve(token: string, now: Date = new Date()): Promise<ResolvedShareLink> {
    const link = await this.resolveAny(token, now);
    if (isDashboardLink(link)) throw notFound();
    return link;
  }

  /** The working link of `token`, whatever its target; throws `404`/`410`. */
  async resolveAny(token: string, now: Date = new Date()): Promise<AnyResolvedShareLink> {
    const outcome = await this.inspect(token, now);
    if (outcome === 'not_found') throw notFound();
    if ('gone' in outcome) throw gone();
    return outcome;
  }

  /**
   * Like {@link resolve}, but returns why a known link is gone (for logs,
   * metrics and tests) instead of throwing.
   */
  async inspect(
    token: string,
    now: Date = new Date(),
  ): Promise<AnyResolvedShareLink | { readonly gone: ShareLinkGoneReason } | 'not_found'> {
    if (!isShareTokenFormat(token)) return 'not_found';
    const hash = hashShareToken(token);
    const organizationId = await findShareLinkOrganization(this.db.kysely, hash);
    if (organizationId === undefined) return 'not_found';
    const scope = orgScope(organizationId);
    const link = await this.links.findByTokenHash(scope, hash);
    if (link === undefined) return 'not_found';

    const state = shareLinkState(
      { enabled: link.enabled, expiresAt: link.expires_at, revokedAt: link.revoked_at },
      now,
    );
    if (state !== 'active') return { gone: state };
    if (link.target_type === 'dashboard') return this.inspectDashboard(scope, link);

    const view = await this.views.getById(scope, link.target_id as ViewRow['id']);
    if (
      view === undefined ||
      view.is_personal ||
      view.table_id !== link.table_id ||
      targetTypeOf(view) !== link.target_type
    ) {
      return { gone: 'target_deleted' };
    }

    const creator = await this.access.findBaseForUser(
      organizationId,
      link.created_by,
      link.base_id,
    );
    if (creator === undefined) return { gone: 'creator_lost_access' };
    if (
      link.audience === 'public' &&
      !publicSharingAllows(publicSharingPolicyOf(creator.org.membership.settings), link.target_type)
    ) {
      return { gone: 'public_sharing_disabled' };
    }
    const access = resolveShareLinkAccess(creator.resolved, shareLinkScopeOf(view));
    if (access === null) return { gone: 'creator_lost_access' };

    const user = await this.users.findById(link.created_by);
    if (user === undefined) return { gone: 'creator_lost_access' };
    const linkAccess = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      user,
      creator,
      access,
    );
    // Linked tables under the creator's current access: titles of view links (T409), link
    // questions of form links — picker and written targets (T410).
    const recordAccess: RecordAccessContext = { ...linkAccess, relatedAccess: creator.resolved };
    return {
      scope,
      link,
      settings: storedSettingsOf(link.settings),
      view,
      creator,
      access,
      recordAccess,
    };
  }

  /**
   * A dashboard link that is active (T809): the dashboard must exist outside
   * the trash in the link's base, and its creator must still read it and
   * may share; the link then reads the tables of the dashboard as the
   * creator does now.
   */
  private async inspectDashboard(
    scope: OrgScope,
    link: ShareLinkRow,
  ): Promise<ResolvedDashboardShareLink | { readonly gone: ShareLinkGoneReason }> {
    const dashboard = await this.dashboards.getById(scope, link.target_id as DashboardRow['id']);
    // Outside the trash only (`getById`).
    if (dashboard === undefined || dashboard.base_id !== link.base_id) {
      return { gone: 'target_deleted' };
    }
    const creator = await this.access.findBaseForUser(
      scope.organizationId,
      link.created_by,
      link.base_id,
    );
    if (creator === undefined) return { gone: 'creator_lost_access' };
    if (
      link.audience === 'public' &&
      !publicSharingAllows(publicSharingPolicyOf(creator.org.membership.settings), link.target_type)
    ) {
      return { gone: 'public_sharing_disabled' };
    }
    const widgets = await this.widgets.listByDashboard(scope, dashboard.id);
    const access = resolveShareLinkAccess(
      creator.resolved,
      dashboardShareScopeOf(dashboard, widgets),
    );
    if (access === null) return { gone: 'creator_lost_access' };
    const user = await this.users.findById(link.created_by);
    if (user === undefined) return { gone: 'creator_lost_access' };
    const linkAccess = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      user,
      creator,
      access,
    );
    // Linked tables (titles of link dimensions) under the creator's current access, as T409.
    const recordAccess: RecordAccessContext = { ...linkAccess, relatedAccess: creator.resolved };
    return {
      scope,
      link,
      settings: storedSettingsOf(link.settings),
      dashboard,
      widgets,
      creator,
      access,
      recordAccess,
    };
  }
}
