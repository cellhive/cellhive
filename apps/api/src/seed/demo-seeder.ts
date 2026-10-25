import { newId, type CreateRoleRequest, type Id } from '@cellhive/contracts';
import {
  AuditWriter,
  BaseRoleMembersRepository,
  BaseRolesRepository,
  BasesRepository,
  FieldsRepository,
  GroupsRepository,
  OrganizationsRepository,
  OrgMembersRepository,
  orgScope,
  settleEventsWithoutAutomations,
  systemAuditContext,
  TablesRepository,
  UsersRepository,
  WorkspacesRepository,
  type Db,
  type User,
} from '@cellhive/server-core';

import { AccessService, type BaseAccess } from '../common/access/access.service.js';
import { PasswordHasher } from '../common/auth/password/password-hasher.js';
import { assertPasswordPolicy } from '../common/auth/password/password-policy.js';
import { SessionService } from '../common/auth/session.service.js';
import { DB } from '../common/tokens.js';
import { BaseService } from '../modules/base/base.service.js';
import { GroupService } from '../modules/group/group.service.js';
import { InvitationService } from '../modules/invitation/invitation.service.js';
import { RoleService } from '../modules/role/role.service.js';
import { lockSetup, OrganizationProvisioner } from '../modules/setup/org-provisioning.js';
import { WorkspaceService } from '../modules/workspace/workspace.service.js';

import { seedDemoAutomations, type DemoAutomationsResult } from './demo-automations.js';
import {
  DEFAULT_DEMO_PROFILE,
  DEMO_BASE,
  DEMO_GROUP_NAME,
  DEMO_ORG,
  DEMO_SALES_ROLE_NAME,
  DEMO_WORKSPACE_NAME,
  demoUsersOf,
  type DemoBaseRole,
  type DemoProfile,
  type DemoUser,
  type DemoUserKey,
} from './demo-fixture.js';
import { seedDemoNotifications, type DemoNotificationsResult } from './demo-notifications.js';
import { seedDemoS6, type DemoS6Result } from './demo-s6.js';
import { seedDemoS7, type DemoS7Result } from './demo-s7.js';
import { DEMO_TABLE_NAMES, seedDemoTables, type DemoTablesInput } from './demo-tables.js';
import { seedDemoViews, type DemoShareLink } from './demo-views.js';
import {
  seedDemoWebhookAutomations,
  seedDemoWebhookSources,
  type DemoWebhooksResult,
} from './demo-webhooks.js';
import { SeedError } from './seed-error.js';

import type { Principal } from '../common/auth/principal.js';
import type { RequestMeta } from '../common/auth/request-meta.js';
import type { INestApplicationContext } from '@nestjs/common';

/** What the seed found or created. */
export interface DemoSeedResult {
  readonly organizationId: Id<'org'>;
  readonly workspaceId: Id<'wsp'>;
  readonly baseId: Id<'bse'>;
  readonly groupId: Id<'grp'>;
  readonly salesRoleId: Id<'rol'>;
  /** Changes `normalizeRoleConfig` made to the Sales role config (0: stored as given). */
  readonly salesRoleAdjustments: number;
  readonly tables: Readonly<Record<keyof typeof DEMO_TABLE_NAMES, Id<'tbl'>>>;
  readonly users: Readonly<Record<DemoUserKey, Id<'usr'>>>;
  /**
   * Share links made by this run, with their token in `url` (shown once);
   * `null` when the data already existed (tokens are never stored).
   */
  readonly shareLinks: readonly DemoShareLink[] | null;
  /**
   * S5 sample data made by this run (BACKLOG T519); `null` when the data
   * already existed.
   */
  readonly s5: (DemoAutomationsResult & { readonly settledEvents: number }) | null;
  /**
   * S5b sample data made by this run (BACKLOG T557); `null` when the data
   * already existed.
   */
  readonly s5b: DemoNotificationsResult | null;
  /**
   * S5c sample data made by this run (BACKLOG T615), with the Bearer token of
   * the sample webhook (shown once); `null` when the data already existed.
   */
  readonly s5c: DemoWebhooksResult | null;
  /**
   * S6 sample data made by this run (BACKLOG T719), with the value of the
   * sample API token (shown once); `null` when the data already existed.
   */
  readonly s6: DemoS6Result | null;
  /**
   * S7 sample data made by this run (BACKLOG T818): the dashboard, its
   * public link (token in the URL, shown once) and the color rule; `null`
   * when the data already existed.
   */
  readonly s7: DemoS7Result | null;
}

export interface DemoSeedOptions {
  /** Smaller tables (tests); default CONTRACTS §9 (200 / 2 000 / 5 000). */
  readonly tableCounts?: DemoTablesInput['counts'];
  readonly onProgress?: (message: string) => void;
  /** Create the sample share links (development only; default `true`). */
  readonly shareLinks?: boolean;
}

/**
 * State of the database before seeding:
 * - `empty`: no demo user exists, the seed can run;
 * - `complete`: an earlier run finished, nothing to do;
 * - `partial`: some demo data exists but not all of it (an interrupted run,
 *   or demo emails used elsewhere); the seed refuses to guess.
 */
export type DemoSeedState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'complete'; readonly result: DemoSeedResult }
  | { readonly kind: 'partial'; readonly reason: string };

const SEED_USER_AGENT = 'cellhive-seed';

/** Request facts of one seed step: its own request ID groups the step's audit entries. */
function stepMeta(): RequestMeta {
  return { requestId: newId('req'), ip: null, userAgent: SEED_USER_AGENT };
}

/** The token at the end of an invitation link (`…/invite/<token>`). */
function tokenOf(inviteUrl: string): string {
  const token = new URL(inviteUrl).pathname.split('/').pop();
  if (token === undefined || token === '') throw new SeedError('invitation link without a token');
  return token;
}

/**
 * Creates the demo data through the API's own services, as the demo admin
 * would through the web UI, so every step writes the same events, audit
 * entries and permission version bumps as a real request:
 *
 * 1. `u_admin` and the organization (like `POST /setup` / `cellhive org
 *    create`: `OrganizationProvisioner`, actor `system`);
 * 2. as `u_admin` (a short-lived session, removed at the end): the
 *    workspace, one invitation per other user, accepted with the password
 *    like the invitation page does; the `Sales` group and its members; the
 *    base with its three system roles and the editor/reader assignments
 *    (`RoleService`); the tables and records (`seedDemoTables`:
 *    `SchemaService`, `RecordMutationService`); the saved views, a personal
 *    view of `u_editor` and the sample share links (`seedDemoViews`:
 *    `ViewService`, `ShareLinkService`); the S5b samples — `notify_on_assign`
 *    on the assignee fields, the due-date reminder of Tickets and a few
 *    follows (`seedDemoNotifications`, BACKLOG T557); the events of all
 *    that sample data marked dispatched (no automation exists yet, BACKLOG
 *    T519), so nothing is ever notified about it; the S5
 *    samples — sender identities, a Telegram bot, a button field and
 *    automations (`seedDemoAutomations`); last, the custom role `Sales` of
 *    CONTRACTS §5 given to the group (`RoleService`).
 */
export class DemoSeeder {
  private readonly db: Db;
  private readonly users: UsersRepository;
  private readonly organizations: OrganizationsRepository;
  private readonly orgMembers: OrgMembersRepository;
  private readonly groups: GroupsRepository;
  private readonly workspaces: WorkspacesRepository;
  private readonly bases: BasesRepository;
  private readonly baseRoles: BaseRolesRepository;
  private readonly roleMembers: BaseRoleMembersRepository;
  private readonly tables: TablesRepository;
  private readonly fields: FieldsRepository;
  private readonly hasher: PasswordHasher;
  private readonly sessions: SessionService;
  private readonly access: AccessService;
  private readonly workspaceService: WorkspaceService;
  private readonly invitationService: InvitationService;
  private readonly groupService: GroupService;
  private readonly baseService: BaseService;
  private readonly roleService: RoleService;
  private readonly audit = new AuditWriter();
  private readonly demoUsers: readonly DemoUser[];

  constructor(
    private readonly app: INestApplicationContext,
    private readonly profile: DemoProfile = DEFAULT_DEMO_PROFILE,
  ) {
    this.demoUsers = demoUsersOf(profile);
    this.db = app.get<Db>(DB);
    this.tables = app.get(TablesRepository);
    this.fields = app.get(FieldsRepository);
    this.roleService = app.get(RoleService);
    this.users = app.get(UsersRepository);
    this.organizations = app.get(OrganizationsRepository);
    this.orgMembers = app.get(OrgMembersRepository);
    this.groups = app.get(GroupsRepository);
    this.workspaces = app.get(WorkspacesRepository);
    this.bases = app.get(BasesRepository);
    this.baseRoles = app.get(BaseRolesRepository);
    this.roleMembers = app.get(BaseRoleMembersRepository);
    this.hasher = app.get(PasswordHasher);
    this.sessions = app.get(SessionService);
    this.access = app.get(AccessService);
    this.workspaceService = app.get(WorkspaceService);
    this.invitationService = app.get(InvitationService);
    this.groupService = app.get(GroupService);
    this.baseService = app.get(BaseService);
  }

  /** Whether the demo data is absent, complete or half there. */
  async detect(): Promise<DemoSeedState> {
    const found = new Map<DemoUserKey, User>();
    for (const demo of this.demoUsers) {
      const user = await this.users.findByEmail(demo.email);
      if (user !== undefined) found.set(demo.key, user);
    }
    if (found.size === 0) return { kind: 'empty' };

    const partial = (reason: string): DemoSeedState => ({ kind: 'partial', reason });
    const admin = found.get('u_admin');
    if (admin === undefined) return partial('the demo admin user is missing');
    const membership = (await this.organizations.listMembershipsOfUser(admin.id)).find(
      (item) => item.name === this.profile.orgName && item.role === 'owner',
    );
    if (membership === undefined)
      return partial(`organization "${this.profile.orgName}" is missing`);
    const scope = orgScope(membership.organizationId);

    const users = {} as Record<DemoUserKey, Id<'usr'>>;
    for (const demo of this.demoUsers) {
      const user = found.get(demo.key);
      if (user === undefined || (await this.orgMembers.get(scope, user.id)) === undefined) {
        return partial(`${demo.email} is not a member of "${this.profile.orgName}"`);
      }
      users[demo.key] = user.id;
    }
    const group = await this.groups.findByName(scope, DEMO_GROUP_NAME);
    if (group === undefined) return partial(`group "${DEMO_GROUP_NAME}" is missing`);

    const workspaces = await this.workspaces.list(scope, { offset: 0, limit: 100 });
    for (const workspace of workspaces.items.filter((item) => item.name === DEMO_WORKSPACE_NAME)) {
      const base = (await this.bases.listByWorkspace(scope, workspace.id)).find(
        (item) => item.name === DEMO_BASE.name,
      );
      if (base === undefined) continue;
      // The group's Sales role is the last step: when it is there, every
      // earlier step (tables and records included) finished.
      const sales = await this.baseRoles.findByName(scope, base.id, DEMO_SALES_ROLE_NAME);
      const assignment = await this.roleMembers.getForPrincipal(scope, base.id, 'group', group.id);
      if (sales === undefined || assignment?.role_id !== sales.id) {
        return partial(`the base has no role "${DEMO_SALES_ROLE_NAME}" given to the group`);
      }
      const tableRows = await this.tables.listByBase(scope, base.id);
      const tableId = (name: string): Id<'tbl'> | undefined =>
        tableRows.find((table) => table.name === name)?.id;
      const customers = tableId(DEMO_TABLE_NAMES.customers);
      const tickets = tableId(DEMO_TABLE_NAMES.tickets);
      const orders = tableId(DEMO_TABLE_NAMES.orders);
      const orderLines = tableId(DEMO_TABLE_NAMES.orderLines);
      if (
        customers === undefined ||
        tickets === undefined ||
        orders === undefined ||
        orderLines === undefined
      ) {
        return partial('a demo table is missing');
      }
      return {
        kind: 'complete',
        result: {
          organizationId: membership.organizationId,
          workspaceId: workspace.id,
          baseId: base.id,
          groupId: group.id,
          salesRoleId: sales.id,
          salesRoleAdjustments: 0,
          tables: { customers, tickets, orders, orderLines },
          users,
          shareLinks: null,
          s5: null,
          s5b: null,
          s5c: null,
          s6: null,
          s7: null,
        },
      };
    }
    return partial(`base "${DEMO_BASE.name}" is missing`);
  }

  /**
   * Creates everything. Each step commits on its own (as separate API
   * requests would); call only when `detect()` said `empty`.
   */
  async seed(
    passwords: ReadonlyMap<DemoUserKey, string>,
    options: DemoSeedOptions = {},
  ): Promise<DemoSeedResult> {
    const passwordOf = (demo: DemoUser): string => {
      const password = passwords.get(demo.key);
      if (password === undefined) throw new SeedError(`no password for ${demo.key}`);
      assertPasswordPolicy(password);
      return password;
    };
    const adminDemo = this.demoUser('u_admin');
    const { admin, organizationId } = await this.createAdminAndOrganization(
      adminDemo,
      await this.hasher.hash(passwordOf(adminDemo)),
    );

    const { session } = await this.sessions.create(admin.id, stepMeta());
    const principal: Principal = { kind: 'session', userId: admin.id, user: admin, session };
    try {
      const users = { u_admin: admin.id } as Record<DemoUserKey, Id<'usr'>>;
      const workspace = await this.workspaceService.create(
        principal,
        organizationId,
        { name: DEMO_WORKSPACE_NAME },
        stepMeta(),
      );

      for (const demo of this.demoUsers) {
        if (demo.key === 'u_admin') continue;
        users[demo.key] = await this.inviteAndAccept(
          principal,
          organizationId,
          demo,
          demo.workspaceMember ? workspace.id : undefined,
          passwordOf(demo),
        );
      }

      const group = await this.groupService.create(
        principal,
        organizationId,
        { name: DEMO_GROUP_NAME },
        stepMeta(),
      );
      for (const demo of this.demoUsers.filter((item) => item.inSalesGroup)) {
        await this.groupService.addMember(
          principal,
          group.id,
          { user_id: users[demo.key] },
          stepMeta(),
        );
      }
      await this.workspaceService.addMember(
        principal,
        workspace.id,
        { principal_id: group.id, role: 'member' },
        stepMeta(),
      );

      const base = await this.baseService.create(
        principal,
        workspace.id,
        { name: DEMO_BASE.name, icon: DEMO_BASE.icon, description: DEMO_BASE.description },
        stepMeta(),
      );
      for (const demo of this.demoUsers) {
        if (demo.baseRole !== null) {
          const role = await this.systemRole(organizationId, base.id, demo.baseRole);
          await this.roleService.assign(
            principal,
            await this.baseAdminAccess(principal, base.id),
            { role_id: role, principal_type: 'user', principal_id: users[demo.key] },
            stepMeta(),
          );
        }
      }

      const tables = await seedDemoTables(this.app, {
        organizationId,
        baseId: base.id,
        ownerId: admin.id,
        assigneeIds: this.demoUsers.filter((demo) => demo.assignee).map((demo) => users[demo.key]),
        timeZone: DEMO_ORG.settings.timezone,
        locale: DEMO_ORG.settings.locale,
        ...(options.tableCounts === undefined ? {} : { counts: options.tableCounts }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });

      options.onProgress?.('Views and share links');
      const views = await this.withSession(users.u_editor, (editor) =>
        seedDemoViews(this.app, {
          organizationId,
          tables: tables.tables,
          admin: principal,
          editor,
          shareLinks: options.shareLinks ?? true,
          meta: stepMeta,
        }),
      );

      // BACKLOG T557: assignment notifications, the due-date reminder and a
      // few follows — before the settlement below, so that nothing is ever
      // notified about sample data (the reminder is armed now).
      options.onProgress?.('Assignment notifications, due-date reminder and sample follows');
      const s5b = await seedDemoNotifications(this.app, {
        organizationId,
        tables: tables.tables,
        admin: principal,
        as: (user, step) =>
          user === 'u_admin' ? step(principal) : this.withSession(users[user], step),
        meta: stepMeta,
      });

      // BACKLOG T615: the sample incoming webhook and allowlist entry, before
      // the settlement too (their events start nothing). No network call.
      options.onProgress?.('Incoming webhook "Đơn từ website" and an HTTP allowlist entry');
      const s5cSources = await seedDemoWebhookSources(this.app, {
        organizationId,
        baseId: base.id,
        admin: principal,
        meta: stepMeta,
      });

      // BACKLOG T719: API tokens (one revoked), an HTTP secret bound to its
      // host and the role "Kho" — before the settlement too. No network call.
      options.onProgress?.('API tokens, an HTTP secret with allowed hosts and the role "Kho"');
      const s6 = await seedDemoS6(this.app, {
        organizationId,
        baseId: base.id,
        tables: tables.tables,
        admin: principal,
        meta: stepMeta,
      });

      // BACKLOG T818: the Orders date and region, the dashboard "Tổng quan
      // đơn hàng" with its public link, the color rule of the Tickets grid —
      // before the settlement too. No network call.
      options.onProgress?.('Dashboard "Tổng quan đơn hàng", its public link and a color rule');
      const s7 = await seedDemoS7(this.app, {
        organizationId,
        baseId: base.id,
        tables: tables.tables,
        admin: principal,
        timeZone: DEMO_ORG.settings.timezone,
        shareLinks: options.shareLinks ?? true,
        meta: stepMeta,
      });

      // BACKLOG T519: no automation exists yet, so the events of the sample
      // data can start nothing. Settle them now instead of leaving ~27 000
      // `events.dispatch` jobs queued in front of real work on a fresh database.
      const settled = await settleEventsWithoutAutomations(this.db, orgScope(organizationId));

      options.onProgress?.(
        `Events of the sample data marked dispatched: ${String(settled.events)}`,
      );
      // The seed sends no email: each identity stays pending (logged as information).
      options.onProgress?.(
        'Sender identities (not verified), Telegram bot, button and automations',
      );
      const s5 = await seedDemoAutomations(this.app, {
        organizationId,
        baseId: base.id,
        tables: tables.tables,
        admin: principal,
        adminEmail: adminDemo.email,
        meta: stepMeta,
      });

      // BACKLOG T615: the webhook and HTTP sample automations (both off).
      options.onProgress?.('Webhook and HTTP request sample automations (off)');
      const s5cAutomations = await seedDemoWebhookAutomations(this.app, {
        organizationId,
        baseId: base.id,
        tables: tables.tables,
        hookId: s5cSources.hookId,
        admin: principal,
        meta: stepMeta,
      });

      // Last step: its assignment marks the seed as complete (see `detect`).
      const sales = await this.roleService.create(
        principal,
        await this.baseAdminAccess(principal, base.id),
        {
          name: DEMO_SALES_ROLE_NAME,
          config: await this.salesRoleConfig(
            organizationId,
            tables.tables.orders,
            views.salesViews,
            s7.dashboardId,
          ),
        },
        stepMeta(),
      );
      await this.roleService.assign(
        principal,
        await this.baseAdminAccess(principal, base.id),
        { role_id: sales.id, principal_type: 'group', principal_id: group.id },
        stepMeta(),
      );

      return {
        organizationId,
        workspaceId: workspace.id,
        baseId: base.id,
        groupId: group.id,
        salesRoleId: sales.id,
        salesRoleAdjustments: sales.adjustments.length,
        tables: tables.tables,
        users,
        shareLinks: views.shareLinks,
        s5: { ...s5, settledEvents: settled.events },
        s5b,
        s5c: { ...s5cSources, automations: s5cAutomations },
        s6,
        s7,
      };
    } finally {
      await this.sessions.revoke(session);
      this.access.invalidate(principal);
    }
  }

  /** Runs `step` as `userId` through a short-lived session, removed afterwards. */
  private async withSession<T>(
    userId: Id<'usr'>,
    step: (principal: Principal) => Promise<T>,
  ): Promise<T> {
    const user = await this.users.findById(userId);
    if (user === undefined) throw new SeedError(`user ${userId} is missing`);
    const { session } = await this.sessions.create(user.id, stepMeta());
    const principal: Principal = { kind: 'session', userId: user.id, user, session };
    try {
      return await step(principal);
    } finally {
      await this.sessions.revoke(session);
      this.access.invalidate(principal);
    }
  }

  private demoUser(key: DemoUserKey): DemoUser {
    const demo = this.demoUsers.find((item) => item.key === key);
    if (demo === undefined) throw new SeedError(`unknown demo user ${key}`);
    return demo;
  }

  /**
   * `u_admin` with the organization it owns, in one transaction like
   * `POST /setup`. On an instance without any user this completes the
   * first-time setup (audited as `setup.completed`, `via: seed`), so the
   * setup page no longer shows.
   */
  private async createAdminAndOrganization(
    demo: DemoUser,
    passwordHash: string,
  ): Promise<{ admin: User; organizationId: Id<'org'> }> {
    return this.db.withTx(async (tx) => {
      await lockSetup(tx);
      const firstUser = !(await this.users.hasAny(tx));
      const admin = await this.users.create(
        {
          email: demo.email,
          displayName: demo.displayName,
          passwordHash,
          locale: DEMO_ORG.settings.locale,
          timezone: DEMO_ORG.settings.timezone,
        },
        tx,
      );
      const context = systemAuditContext();
      const organization = await new OrganizationProvisioner(
        this.organizations,
        this.orgMembers,
        this.audit,
      ).create(tx, {
        name: this.profile.orgName,
        ownerId: admin.id,
        settings: { ...DEMO_ORG.settings },
        context,
      });
      if (firstUser) {
        await this.audit.write(tx, {
          action: 'setup.completed',
          organizationId: organization.id,
          entityType: 'org',
          entityId: organization.id,
          after: {
            user_id: admin.id,
            email: admin.email,
            org_name: organization.name,
            via: 'seed',
          },
          context,
        });
      }
      return { admin, organizationId: organization.id };
    });
  }

  /** Invites `demo` and accepts on their behalf, creating the account with `password`. */
  private async inviteAndAccept(
    principal: Principal,
    organizationId: Id<'org'>,
    demo: DemoUser,
    workspaceId: Id<'wsp'> | undefined,
    password: string,
  ): Promise<Id<'usr'>> {
    if (demo.orgRole === 'owner') throw new SeedError('owners are not invited');
    const invitation = await this.invitationService.create(
      principal,
      organizationId,
      {
        email: demo.email,
        role: demo.orgRole,
        ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
      },
      stepMeta(),
    );
    const accepted = await this.invitationService.accept(
      tokenOf(invitation.invite_url),
      {
        display_name: demo.displayName,
        password,
        locale: DEMO_ORG.settings.locale,
        timezone: DEMO_ORG.settings.timezone,
      },
      undefined,
      stepMeta(),
    );
    this.access.invalidate(principal);
    return accepted.user.id;
  }

  /** ID of a system role (`system_editor`, …) of the base. */
  private async systemRole(
    organizationId: Id<'org'>,
    baseId: Id<'bse'>,
    preset: DemoBaseRole,
  ): Promise<Id<'rol'>> {
    const role = (await this.baseRoles.listByBase(orgScope(organizationId), baseId)).find(
      (item) => item.kind === `system_${preset}`,
    );
    if (role === undefined) throw new SeedError(`base ${baseId} has no system_${preset} role`);
    return role.id;
  }

  /** The admin's access to the base, as `@RequireBase('admin')` resolves it for a request. */
  private async baseAdminAccess(principal: Principal, baseId: Id<'bse'>): Promise<BaseAccess> {
    return this.access.requireBase(principal, baseId, 'admin');
  }

  /**
   * The custom role `Sales` of CONTRACTS §5, keyed by IDs (SPEC §6.1).
   * `visible_views` lists the Sales views of Orders ("Đơn của tôi" — the
   * fixture's `viw_sales` — and "Đơn giá vốn cao"), not "Tất cả đơn hàng"
   * (`viw_all`). It reads the sample dashboard (BACKLOG T818).
   */
  private async salesRoleConfig(
    organizationId: Id<'org'>,
    ordersId: Id<'tbl'>,
    salesViews: readonly Id<'viw'>[],
    dashboardId: Id<'dsh'>,
  ): Promise<NonNullable<CreateRoleRequest['config']>> {
    const fields = await this.fields.listByTable(orgScope(organizationId), ordersId);
    const fieldId = (name: string): Id<'fld'> => {
      const field = fields.find((item) => item.name === name);
      if (field === undefined) throw new SeedError(`Orders has no field ${name}`);
      return field.id;
    };
    return {
      base_rule: { copy: false, download: false, share_link: false },
      tables: {
        [ordersId]: {
          perm: 'edit',
          view_rule: { allow_edit: false, visible_views: [...salesViews] },
          record_rule: {
            operations: ['add'],
            edit_filter: {
              op: 'and',
              items: [
                {
                  field: fieldId('owner'),
                  operator: 'has_any_of',
                  value: [{ $var: 'current_user' }],
                },
              ],
            },
            read_scope: 'editable',
            read_filter: null,
          },
          field_rule: {
            mode: 'specify',
            fields: { [fieldId('cost')]: 'no_perm', [fieldId('status')]: 'read' },
            option_edit_fields: [],
            file_download_fields: [],
          },
        },
      },
      dashboards: { [dashboardId]: 'read_only' },
    };
  }
}
