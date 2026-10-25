import {
  EMBED_NOT_SUPPORTED,
  embedOriginOf,
  INVALID_ORIGIN,
  newId,
  PERSONAL_VIEW,
  type CreatedShareLinkDto,
  type CreateShareLinkRequest,
  type Id,
  type OrgShareLinkListQuery,
  type RevokeShareLinksRequest,
  type RevokeShareLinksResponse,
  type ShareLinkDto,
  type ShareLinkList,
  type ShareLinkListQuery,
  type ShareLinkPreview,
  type ShareLinkSettings,
  type ShareLinkSettingsInput,
  type ShareLinkStatus,
  type UpdateShareLinkRequest,
} from '@cellhive/contracts';
import {
  canReadDashboard,
  canShareLinks,
  isViewVisible,
  publicSharingAllows,
  resolveShareLinkAccess,
  shareLinkState,
  type ResolvedBaseAccess,
  type TableAccess,
} from '@cellhive/permissions';
import {
  DashboardsRepository,
  DashboardWidgetsRepository,
  FieldsRepository,
  generateShareToken,
  GroupMembersRepository,
  orgScope,
  RecordQueryService,
  ShareLinksRepository,
  TablesRepository,
  ViewsRepository,
  withTxScope,
  type AppConfig,
  type AuditContext,
  type DashboardRow,
  type Db,
  type JsonObject,
  type OrgScope,
  type ShareLinkListRow,
  type ShareLinkRow,
  type Tx,
  type ViewRow,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type BaseAccess,
  type OrgAccess,
} from '../../common/access/access.service.js';
import { mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { publicSharingPolicyOf } from '../../common/access/public-sharing.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { PasswordHasher } from '../../common/auth/password/password-hasher.js';
import { iso, isoOrNull, validationFailed } from '../../common/dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import {
  dashboardShareScopeOf,
  shareLinkScopeOf,
  storedSettingsOf,
  targetTypeOf,
} from './share-link-scope.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

/** A shared view the caller can see, with the access that makes it visible. */
interface LocatedView {
  readonly base: BaseAccess;
  readonly tableAccess: TableAccess;
  readonly view: ViewRow;
}

/** A dashboard the caller reads, with their access to its base (T809). */
interface LocatedDashboard {
  readonly base: BaseAccess;
  readonly dashboard: DashboardRow;
}

/**
 * A link the caller may manage. `view` (view and form links) or
 * `dashboard` (dashboard links) is missing when the target was deleted.
 */
interface LocatedLink {
  readonly base: BaseAccess;
  readonly link: ShareLinkListRow;
  readonly view: ViewRow | undefined;
  readonly dashboard: DashboardRow | undefined;
}

type RevokeReason = 'revoked' | 'regenerated' | 'replaced' | 'bulk';

function publicSharingDisabled(): AppError {
  return new AppError('PUBLIC_SHARING_DISABLED', {
    detail: 'The organization does not allow public links for this target.',
  });
}

function cannotShare(): AppError {
  return permissionDenied(
    'Share links need the base owner, the admin role or a role with base_rule.share_link.',
  );
}

/** Audit/event snapshot of a link: never the token, its hash, its prefix or the password hash. */
function snapshotOf(link: ShareLinkRow): JsonObject {
  return {
    id: link.id,
    base_id: link.base_id,
    table_id: link.table_id,
    target_type: link.target_type,
    target_id: link.target_id,
    audience: link.audience,
    has_password: link.password_hash !== null,
    expires_at: isoOrNull(link.expires_at),
    enabled: link.enabled,
    settings: link.settings,
    created_by: link.created_by,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Settings after applying a request (present keys replace; `embed`/`dashboard` merge). */
function mergeSettings(stored: ShareLinkSettings, input: ShareLinkSettingsInput | undefined) {
  if (input === undefined) return stored;
  const defined = <T extends object>(value: T) =>
    Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    ) as Partial<T>;
  const { embed, dashboard, ...flat } = input;
  return {
    ...stored,
    ...defined(flat),
    embed: { ...stored.embed, ...(embed === undefined ? {} : defined(embed)) },
    dashboard: { ...stored.dashboard, ...(dashboard === undefined ? {} : defined(dashboard)) },
  } as ShareLinkSettings;
}

/**
 * `allow_download` is accepted from S4: attachments only (open question S4
 * #3, T409). `allow_export` (S7 decision 17, T810): view links (the view)
 * and dashboard links (widget CSV, T809) — a form has nothing to export.
 */
function assertAvailable(
  settings: ShareLinkSettings,
  targetType: ShareLinkRow['target_type'],
): void {
  if (settings.allow_export && targetType === 'form') {
    throw validationFailed('A form link cannot export records.', {
      path: 'settings.allow_export',
      code: 'NOT_ALLOWED',
    });
  }
}

/**
 * Embedding (BACKLOG T809, S7 decisions 14–16): the allowed origins as
 * `https://host[:port]` (`http://localhost` in development), normalized and
 * without duplicates (`422 INVALID_ORIGIN` for anything else); embedding on
 * needs at least one origin and a `public` link without password — the
 * unlock cookie (`SameSite=Strict`) and the session cookie never reach a
 * third-party frame (`422 EMBED_NOT_SUPPORTED`).
 */
function checkedEmbed(
  settings: ShareLinkSettings,
  link: { readonly audience: ShareLinkRow['audience']; readonly hasPassword: boolean },
  allowLocalHttp: boolean,
): ShareLinkSettings {
  const origins: string[] = [];
  for (const [index, value] of settings.embed.allowed_origins.entries()) {
    const origin = embedOriginOf(value, { allowLocalHttp });
    if (origin === null) {
      throw validationFailed('Embedding origins are https://host[:port], without path.', {
        path: `settings.embed.allowed_origins[${String(index)}]`,
        code: INVALID_ORIGIN,
      });
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (settings.embed.enabled) {
    if (link.audience !== 'public' || link.hasPassword) {
      throw validationFailed('Only a public link without password can be embedded.', {
        path: 'settings.embed.enabled',
        code: EMBED_NOT_SUPPORTED,
      });
    }
    if (origins.length === 0) {
      throw validationFailed('Embedding needs at least one allowed origin.', {
        path: 'settings.embed.allowed_origins',
        code: INVALID_ORIGIN,
      });
    }
  }
  return { ...settings, embed: { ...settings.embed, allowed_origins: origins } };
}

function assertFuture(expiresAt: string | null | undefined, now: Date): void {
  if (expiresAt != null && new Date(expiresAt).getTime() <= now.getTime()) {
    throw validationFailed('The expiry must be in the future.', {
      path: 'expires_at',
      code: 'OUT_OF_RANGE',
    });
  }
}

/**
 * Share link management (SPEC §15A, CONTRACTS §16; BACKLOG T304).
 *
 * - Managing the links of a view (create, read, change, regenerate,
 *   revoke) needs to see the view — else `404` — and the right to share
 *   (base owner, role `admin` or `base_rule.share_link`) — else `403`. Base
 *   admins may also read and revoke links whose target was deleted.
 * - A target has at most one link that is not revoked: creating a link
 *   revokes the previous one, regenerating replaces the token by revoking
 *   the link and creating a copy (the old token then answers `410`).
 * - The token is returned once (create, regenerate), never stored, logged
 *   or audited: only its SHA-256 and first six characters are kept.
 * - Public links follow `organizations.settings.public_sharing`
 *   (`403 PUBLIC_SHARING_DISABLED`).
 * - Every change writes `share_link.*` + audit in its transaction.
 */
@Injectable()
export class ShareLinkService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ShareLinksRepository) private readonly links: ShareLinksRepository,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(DashboardsRepository) private readonly dashboards: DashboardsRepository,
    @Inject(DashboardWidgetsRepository) private readonly widgets: DashboardWidgetsRepository,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(RecordQueryService) private readonly records: RecordQueryService,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
  ) {}

  // --- Links of a view ------------------------------------------------------------

  async listForView(principal: Principal, viewId: Id<'viw'>): Promise<ShareLinkList> {
    const { base, view } = await this.locateShareableView(principal, viewId);
    const rows = await this.links.listLiveForTarget(base.org.scope, targetTypeOf(view), view.id);
    return {
      items: rows.map((row) => this.dtoOf(base.org, row)),
      total: rows.length,
      offset: 0,
      limit: Math.max(rows.length, 1),
    };
  }

  async preview(principal: Principal, viewId: Id<'viw'>): Promise<ShareLinkPreview> {
    const { base, view } = await this.locateShareableView(principal, viewId);
    const linkAccess = this.linkAccessOrDeny(base.resolved, view);
    const tableAccess = linkAccess.access.tables[view.table_id];
    const fields = (await this.fields.listByTable(base.org.scope, view.table_id)).flatMap(
      (field) => {
        const perm = tableAccess?.fields[field.id];
        return perm === 'read' || perm === 'create'
          ? [{ id: field.id, name: field.name, type: field.type, access: perm }]
          : [];
      },
    );
    const targetType = targetTypeOf(view);
    if (targetType === 'form') {
      return { target_type: targetType, record_count: null, record_count_estimated: false, fields };
    }
    const context = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
      linkAccess,
    );
    const page = await this.records.query(base.org.scope, view.table_id, context, {
      field_key_type: 'id',
      fields: [],
      limit: 1,
    });
    const estimated = 'total_estimate' in page;
    return {
      target_type: targetType,
      record_count: 'total' in page ? page.total : estimated ? page.total_estimate : 0,
      record_count_estimated: estimated,
      fields,
    };
  }

  async create(
    principal: Principal,
    viewId: Id<'viw'>,
    input: CreateShareLinkRequest,
    meta: RequestMeta,
  ): Promise<CreatedShareLinkDto> {
    const { base, view } = await this.locateShareableView(principal, viewId);
    this.linkAccessOrDeny(base.resolved, view);
    const targetType = targetTypeOf(view);
    if (input.audience === 'public' && input.enabled && !this.publicAllowed(base.org, targetType)) {
      throw publicSharingDisabled();
    }
    return this.createLink(principal, base, input, meta, {
      targetType,
      targetId: view.id,
      tableId: view.table_id,
    });
  }

  // --- Links of a dashboard (T809) ------------------------------------------------------

  async listForDashboard(principal: Principal, dashboardId: Id<'dsh'>): Promise<ShareLinkList> {
    const { base, dashboard } = await this.locateShareableDashboard(principal, dashboardId);
    const rows = await this.links.listLiveForTarget(base.org.scope, 'dashboard', dashboard.id);
    return {
      items: rows.map((row) => this.dtoOf(base.org, row)),
      total: rows.length,
      offset: 0,
      limit: Math.max(rows.length, 1),
    };
  }

  /**
   * `POST /dashboards/:id/share-links`: the caller reads the dashboard (else
   * `404`) and may share (else `403`); a previous link of the dashboard is
   * revoked in the same transaction.
   */
  async createForDashboard(
    principal: Principal,
    dashboardId: Id<'dsh'>,
    input: CreateShareLinkRequest,
    meta: RequestMeta,
  ): Promise<CreatedShareLinkDto> {
    const { base, dashboard } = await this.locateShareableDashboard(principal, dashboardId);
    await this.dashboardAccessOrDeny(base, dashboard);
    if (
      input.audience === 'public' &&
      input.enabled &&
      !this.publicAllowed(base.org, 'dashboard')
    ) {
      throw publicSharingDisabled();
    }
    return this.createLink(principal, base, input, meta, {
      targetType: 'dashboard',
      targetId: dashboard.id,
      tableId: null,
    });
  }

  private async createLink(
    principal: Principal,
    base: BaseAccess,
    input: CreateShareLinkRequest,
    meta: RequestMeta,
    target: {
      readonly targetType: ShareLinkRow['target_type'];
      readonly targetId: string;
      readonly tableId: Id<'tbl'> | null;
    },
  ): Promise<CreatedShareLinkDto> {
    const { targetType, targetId } = target;
    const merged = mergeSettings(storedSettingsOf({}), input.settings);
    assertAvailable(merged, targetType);
    const settings = checkedEmbed(
      merged,
      { audience: input.audience, hasPassword: input.password != null },
      this.allowLocalHttp(),
    );
    assertFuture(input.expires_at, new Date());
    const passwordHash = input.password == null ? null : await this.hasher.hash(input.password);
    const context = mutationContextOf(meta, principal.userId);
    const token = generateShareToken();

    const row = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.links.lockTarget(scope, targetType, targetId);
      const previous = await this.links.liveIdsForTarget(scope, targetType, targetId);
      await this.revokeIn(tx, scope, base.org, previous, principal.userId, context, 'replaced');
      const created = await this.links.insert(scope, {
        id: newId('shl'),
        baseId: base.base.id,
        tableId: target.tableId,
        targetType,
        targetId,
        audience: input.audience,
        tokenPrefix: token.prefix,
        tokenHash: token.hash,
        passwordHash,
        expiresAt: input.expires_at == null ? null : new Date(input.expires_at),
        settings,
        enabled: input.enabled,
        createdBy: principal.userId,
      });
      await this.record(tx, base.org, created, 'share_link.created', context, {
        after: snapshotOf(created),
        data: previous.length > 0 ? { replaced: previous } : {},
      });
      return this.reload(scope, created.id);
    });
    return this.withToken(this.dtoOf(base.org, row), token.token);
  }

  // --- One link ---------------------------------------------------------------------

  async get(principal: Principal, linkId: Id<'shl'>): Promise<ShareLinkDto> {
    const { base, link } = await this.locateLink(principal, linkId, { allowMissingTarget: true });
    return this.dtoOf(base.org, link);
  }

  async update(
    principal: Principal,
    linkId: Id<'shl'>,
    input: UpdateShareLinkRequest,
    meta: RequestMeta,
  ): Promise<ShareLinkDto> {
    const { base, link } = await this.locateLink(principal, linkId, { allowMissingTarget: false });
    const merged = mergeSettings(storedSettingsOf(link.settings), input.settings);
    if (input.settings !== undefined) assertAvailable(merged, link.target_type);
    // Embedding stays valid whatever changes: audience, password or settings.
    const settings = checkedEmbed(
      merged,
      {
        audience: input.audience ?? link.audience,
        hasPassword:
          input.password === undefined ? link.password_hash !== null : input.password !== null,
      },
      this.allowLocalHttp(),
    );
    assertFuture(input.expires_at, new Date());
    const audience = input.audience ?? link.audience;
    const enabled = input.enabled ?? link.enabled;
    const activatesPublic =
      audience === 'public' &&
      enabled &&
      (input.audience === 'public' || input.enabled === true) &&
      !this.publicAllowed(base.org, link.target_type);
    if (activatesPublic) throw publicSharingDisabled();
    const passwordHash =
      input.password === undefined
        ? undefined
        : input.password === null
          ? null
          : await this.hasher.hash(input.password);
    const context = mutationContextOf(meta, principal.userId);

    const row = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const current = await this.links.lockLive(scope, linkId);
      if (current === undefined) throw notFound();
      const updated = await this.links.update(scope, linkId, {
        ...(input.audience === undefined ? {} : { audience: input.audience }),
        ...(passwordHash === undefined ? {} : { passwordHash }),
        ...(input.expires_at === undefined
          ? {}
          : { expiresAt: input.expires_at === null ? null : new Date(input.expires_at) }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.settings === undefined ? {} : { settings }),
      });
      if (updated === undefined) throw notFound();
      const before = snapshotOf(current);
      const after = snapshotOf(updated);
      const keys = Object.keys(after).filter((key) => !sameJson(before[key], after[key]));
      // A new password never shows in the snapshot: note that it changed
      // (`password` itself is a forbidden audit key).
      if (
        passwordHash != null &&
        current.password_hash !== null &&
        !keys.includes('has_password')
      ) {
        keys.push('password_changed');
        before['password_changed'] = false;
        after['password_changed'] = true;
      }
      if (keys.length > 0) {
        await this.record(tx, base.org, updated, 'share_link.updated', context, {
          before: Object.fromEntries(keys.map((key) => [key, before[key] ?? null])),
          after: Object.fromEntries(keys.map((key) => [key, after[key] ?? null])),
          data: { changed: keys },
        });
      }
      return this.reload(scope, linkId);
    });
    return this.dtoOf(base.org, row);
  }

  async regenerate(
    principal: Principal,
    linkId: Id<'shl'>,
    meta: RequestMeta,
  ): Promise<CreatedShareLinkDto> {
    const { base, link, view, dashboard } = await this.locateLink(principal, linkId, {
      allowMissingTarget: false,
    });
    if (dashboard !== undefined) await this.dashboardAccessOrDeny(base, dashboard);
    else if (view === undefined) throw notFound();
    else this.linkAccessOrDeny(base.resolved, view);
    if (
      link.audience === 'public' &&
      link.enabled &&
      !this.publicAllowed(base.org, link.target_type)
    ) {
      throw publicSharingDisabled();
    }
    const context = mutationContextOf(meta, principal.userId);
    const token = generateShareToken();

    const row = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.links.lockTarget(scope, link.target_type, link.target_id);
      const current = await this.links.lockLive(scope, linkId);
      if (current === undefined) throw notFound();
      await this.revokeIn(tx, scope, base.org, [linkId], principal.userId, context, 'regenerated');
      const created = await this.links.insert(scope, {
        id: newId('shl'),
        baseId: current.base_id,
        tableId: current.table_id,
        targetType: current.target_type,
        targetId: current.target_id,
        audience: current.audience,
        tokenPrefix: token.prefix,
        tokenHash: token.hash,
        passwordHash: current.password_hash,
        expiresAt: current.expires_at,
        settings: current.settings as JsonObject,
        enabled: current.enabled,
        createdBy: principal.userId,
      });
      await this.record(tx, base.org, created, 'share_link.created', context, {
        after: snapshotOf(created),
        data: { regenerated_from: linkId },
      });
      return this.reload(scope, created.id);
    });
    return this.withToken(this.dtoOf(base.org, row), token.token);
  }

  async revoke(principal: Principal, linkId: Id<'shl'>, meta: RequestMeta): Promise<void> {
    const { base } = await this.locateLink(principal, linkId, { allowMissingTarget: true });
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const revoked = await this.revokeIn(
        tx,
        scope,
        base.org,
        [linkId],
        principal.userId,
        context,
        'revoked',
      );
      if (revoked.length === 0) throw notFound();
    });
  }

  // --- Administration -----------------------------------------------------------------

  async listForBase(
    principal: Principal,
    baseId: Id<'bse'>,
    query: ShareLinkListQuery,
  ): Promise<ShareLinkList> {
    const base = await this.access.requireBase(principal, baseId, 'admin');
    return this.list(base.org, { ...query, baseId });
  }

  async revokeForBase(
    principal: Principal,
    baseId: Id<'bse'>,
    input: RevokeShareLinksRequest,
    meta: RequestMeta,
  ): Promise<RevokeShareLinksResponse> {
    const base = await this.access.requireBase(principal, baseId, 'admin');
    return this.bulkRevoke(principal, base.org, input, meta, baseId);
  }

  async listForOrg(
    principal: Principal,
    organizationId: Id<'org'>,
    query: OrgShareLinkListQuery,
  ): Promise<ShareLinkList> {
    const org = await this.requireOrgAdmin(principal, organizationId);
    return this.list(org, {
      ...query,
      ...(query.base_id === undefined ? {} : { baseId: query.base_id }),
    });
  }

  async revokeForOrg(
    principal: Principal,
    organizationId: Id<'org'>,
    input: RevokeShareLinksRequest,
    meta: RequestMeta,
  ): Promise<RevokeShareLinksResponse> {
    const org = await this.requireOrgAdmin(principal, organizationId);
    return this.bulkRevoke(principal, org, input, meta);
  }

  // ---------------------------------------------------------------------------

  /** Organization owner/admin; anyone else, members included, gets `404` (CONTRACTS §16). */
  private async requireOrgAdmin(
    principal: Principal,
    organizationId: Id<'org'>,
  ): Promise<OrgAccess> {
    const org = await this.access.findOrg(principal, organizationId);
    if (org?.isAdmin !== true) throw notFound();
    return org;
  }

  private async list(
    org: OrgAccess,
    query: ShareLinkListQuery & { readonly baseId?: Id<'bse'> },
  ): Promise<ShareLinkList> {
    const page = await this.links.listPage(
      org.scope,
      {
        ...(query.baseId === undefined ? {} : { baseId: query.baseId }),
        ...(query.audience === undefined ? {} : { audience: query.audience }),
        ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
        ...(query.target_type === undefined ? {} : { targetType: query.target_type }),
        ...(query.created_by === undefined ? {} : { createdBy: query.created_by }),
      },
      { offset: query.offset, limit: query.limit },
    );
    return {
      items: page.items.map((row) => this.dtoOf(org, row)),
      total: page.total,
      offset: query.offset,
      limit: query.limit,
    };
  }

  private async bulkRevoke(
    principal: Principal,
    org: OrgAccess,
    input: RevokeShareLinksRequest,
    meta: RequestMeta,
    baseId?: Id<'bse'>,
  ): Promise<RevokeShareLinksResponse> {
    const context = mutationContextOf(meta, principal.userId);
    const revoked = await this.db.withTx(async (tx) =>
      this.revokeIn(
        tx,
        withTxScope(org.scope, tx),
        org,
        [...new Set(input.ids)],
        principal.userId,
        context,
        'bulk',
        baseId,
      ),
    );
    return { revoked: revoked.map((row) => row.id) };
  }

  /** Revokes links (not yet revoked) with one `share_link.revoked` + audit each. */
  private async revokeIn(
    tx: Tx,
    scope: OrgScope,
    org: OrgAccess,
    ids: readonly Id<'shl'>[],
    userId: Id<'usr'>,
    context: AuditContext,
    reason: RevokeReason,
    baseId?: Id<'bse'>,
  ): Promise<ShareLinkRow[]> {
    const rows = await this.links.revoke(
      scope,
      ids,
      userId,
      baseId === undefined ? {} : { baseId },
    );
    for (const row of rows) {
      await this.record(tx, org, row, 'share_link.revoked', context, {
        before: snapshotOf(row),
        data: { reason },
      });
    }
    return rows;
  }

  /**
   * A view the caller sees (else `404`) and may share (else `403`). Personal
   * views cannot be shared (`422 PERSONAL_VIEW`).
   */
  private async locateShareableView(principal: Principal, viewId: Id<'viw'>): Promise<LocatedView> {
    const found = await this.locateView(principal, viewId);
    if (found === undefined) throw notFound();
    if (!canShareLinks(found.base.access)) throw cannotShare();
    if (found.view.is_personal) {
      throw validationFailed('Personal views cannot be shared.', {
        path: 'view_id',
        code: PERSONAL_VIEW,
      });
    }
    return found;
  }

  /** A view the caller can see (T301 rules), or `undefined`. */
  private async locateView(
    principal: Principal,
    viewId: Id<'viw'>,
  ): Promise<LocatedView | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const view = await this.views.getById(orgScope(membership.organizationId), viewId);
      if (view === undefined) continue;
      return this.visibleView(principal, view);
    }
    return undefined;
  }

  private async visibleView(principal: Principal, view: ViewRow): Promise<LocatedView | undefined> {
    const base = await this.baseOfTable(principal, view.organization_id, view.table_id);
    const tableAccess = base?.access.tables[view.table_id];
    if (base === undefined || tableAccess === undefined) return undefined;
    const visible = view.is_personal
      ? view.owner_id === principal.userId
      : isViewVisible(tableAccess, view.id);
    return visible ? { base, tableAccess, view } : undefined;
  }

  /** The caller's access to the base of a table outside the trash, or `undefined`. */
  private async baseOfTable(
    principal: Principal,
    organizationId: Id<'org'>,
    tableId: Id<'tbl'>,
  ): Promise<BaseAccess | undefined> {
    const table = await this.tables.getById(orgScope(organizationId), tableId);
    return table === undefined ? undefined : this.access.findBase(principal, table.base_id);
  }

  /**
   * A dashboard the caller reads (else `404`, as `GET /dashboards/:id`) and
   * may share (else `403`).
   */
  private async locateShareableDashboard(
    principal: Principal,
    dashboardId: Id<'dsh'>,
  ): Promise<LocatedDashboard> {
    const found = await this.locateDashboard(principal, dashboardId);
    if (found === undefined) throw notFound();
    if (!canShareLinks(found.base.access)) throw cannotShare();
    return found;
  }

  /** A dashboard outside the trash the caller reads (SPEC §10), or `undefined`. */
  private async locateDashboard(
    principal: Principal,
    dashboardId: Id<'dsh'>,
  ): Promise<LocatedDashboard | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const dashboard = await this.dashboards.getById(
        orgScope(membership.organizationId),
        dashboardId,
      );
      if (dashboard === undefined) continue;
      const base = await this.access.findBase(principal, dashboard.base_id);
      if (base === undefined || !canReadDashboard(base.access, dashboard.id)) return undefined;
      return { base, dashboard };
    }
    return undefined;
  }

  /** The access a dashboard link of the caller would have now; `403` when none. */
  private async dashboardAccessOrDeny(
    base: BaseAccess,
    dashboard: DashboardRow,
  ): Promise<ResolvedBaseAccess> {
    const widgets = await this.widgets.listByDashboard(base.org.scope, dashboard.id);
    const access = resolveShareLinkAccess(base.resolved, dashboardShareScopeOf(dashboard, widgets));
    if (access === null) throw permissionDenied('This dashboard cannot be shared by the caller.');
    return access;
  }

  /** `http://localhost` origins may embed links outside production (S7 decision 16). */
  private allowLocalHttp(): boolean {
    return this.config.nodeEnv !== 'production';
  }

  /**
   * A link that is not revoked and that the caller may manage: its base
   * readable (else `404`); base admins always; others need to see the
   * target view or read the target dashboard (else `404`) and to share
   * (else `403`).
   */
  private async locateLink(
    principal: Principal,
    linkId: Id<'shl'>,
    options: { readonly allowMissingTarget: boolean },
  ): Promise<LocatedLink> {
    for (const membership of await this.access.memberships(principal)) {
      const scope = orgScope(membership.organizationId);
      const link = await this.links.getLive(scope, linkId);
      if (link === undefined) continue;
      const base = await this.access.findBase(principal, link.base_id);
      if (base === undefined) throw notFound();
      if (link.target_type === 'dashboard') {
        const located = await this.locateDashboard(principal, link.target_id as Id<'dsh'>);
        const dashboard = located?.base.base.id === base.base.id ? located.dashboard : undefined;
        if (dashboard === undefined) {
          // Deleted target: only base admins may still read or revoke.
          if (!(base.access.is_admin && options.allowMissingTarget)) throw notFound();
        } else if (!canShareLinks(base.access)) {
          throw cannotShare();
        }
        return { base, link, view: undefined, dashboard };
      }
      const viewRow = await this.views.getById(scope, link.target_id as Id<'viw'>);
      const view = viewRow === undefined ? undefined : await this.visibleView(principal, viewRow);
      if (view === undefined) {
        // Deleted (or made personal) target: only base admins may still read or revoke.
        if (!(base.access.is_admin && options.allowMissingTarget)) {
          throw notFound();
        }
      } else if (!canShareLinks(base.access)) {
        throw cannotShare();
      }
      return { base, link, view: view?.view, dashboard: undefined };
    }
    throw notFound();
  }

  /** The access the link would have now; `403` when it could not work at all. */
  private linkAccessOrDeny(creator: ResolvedBaseAccess, view: ViewRow): ResolvedBaseAccess {
    const access = resolveShareLinkAccess(creator, shareLinkScopeOf(view));
    if (access === null) {
      throw permissionDenied(
        view.type === 'form'
          ? 'Sharing a form needs the right to add records to its table.'
          : 'This view cannot be shared by the caller.',
      );
    }
    return access;
  }

  private publicAllowed(org: OrgAccess, targetType: ShareLinkRow['target_type']): boolean {
    return publicSharingAllows(publicSharingPolicyOf(org.membership.settings), targetType);
  }

  private async reload(scope: OrgScope, id: Id<'shl'>): Promise<ShareLinkListRow> {
    const row = await this.links.getLive(scope, id);
    if (row === undefined) throw notFound();
    return row;
  }

  private statusOf(org: OrgAccess, link: ShareLinkRow): ShareLinkStatus {
    const state = shareLinkState(
      { enabled: link.enabled, expiresAt: link.expires_at, revokedAt: link.revoked_at },
      new Date(),
    );
    if (state === 'revoked') return 'disabled';
    if (state !== 'active') return state;
    return link.audience === 'public' && !this.publicAllowed(org, link.target_type)
      ? 'blocked'
      : 'active';
  }

  private dtoOf(org: OrgAccess, link: ShareLinkListRow): ShareLinkDto {
    return {
      id: link.id,
      base_id: link.base_id,
      table_id: link.table_id,
      target_type: link.target_type,
      target_id: link.target_id,
      target_name: link.target_name,
      audience: link.audience,
      status: this.statusOf(org, link),
      token_prefix: link.token_prefix,
      has_password: link.password_hash !== null,
      expires_at: isoOrNull(link.expires_at),
      enabled: link.enabled,
      settings: storedSettingsOf(link.settings),
      created_by: { id: link.created_by, name: link.creator_name },
      last_accessed_at: isoOrNull(link.last_accessed_at),
      access_count: Number(link.access_count),
      created_at: iso(link.created_at),
      updated_at: iso(link.updated_at),
    };
  }

  private withToken(dto: ShareLinkDto, token: string): CreatedShareLinkDto {
    return { ...dto, token, url: `${this.config.publicUrl.replace(/\/+$/u, '')}/s/${token}` };
  }

  private async record(
    tx: Tx,
    org: OrgAccess,
    link: ShareLinkRow,
    type: 'share_link.created' | 'share_link.updated' | 'share_link.revoked',
    context: AuditContext,
    change: {
      readonly before?: JsonObject;
      readonly after?: JsonObject;
      readonly data?: JsonObject;
    },
  ): Promise<void> {
    await recordChange(tx, {
      type,
      organizationId: org.organizationId,
      baseId: link.base_id,
      tableId: link.table_id,
      entityType: 'share_link',
      entityId: link.id,
      context,
      before: change.before ?? null,
      after: change.after ?? null,
      data: {
        target_type: link.target_type,
        target_id: link.target_id,
        audience: link.audience,
        ...(change.data ?? {}),
      },
    });
  }
}
