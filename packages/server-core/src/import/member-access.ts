import { canonicalTimeZone } from '@cellhive/contracts';
import {
  resolveBaseAccess,
  roleConfigSchema,
  type BaseRoleDef,
  type FieldMeta,
  type RoleAssignment,
  type SchemaMeta,
} from '@cellhive/permissions';

import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
} from '../db/repositories/base-roles.repository.js';
import { BasesRepository } from '../db/repositories/bases.repository.js';
import { GroupMembersRepository } from '../db/repositories/groups.repository.js';
import { OrgMembersRepository } from '../db/repositories/org-members.repository.js';
import { OrganizationsRepository } from '../db/repositories/organizations.repository.js';
import { UsersRepository } from '../db/repositories/users.repository.js';
import { WorkspaceMembersRepository } from '../db/repositories/workspaces.repository.js';
import { FieldsRepository } from '../schema/fields.repository.js';
import { TablesRepository } from '../schema/tables.repository.js';

import type { Db } from '../db/create-db.js';
import type { OrgScope } from '../db/repository.js';
import type { Base, JsonValue, Organization } from '../db/schema.js';
import type { RecordAccessContext } from '../records/types.js';
import type { Id } from '@cellhive/contracts';

/** Instance defaults (`DEFAULT_TIMEZONE`, `DEFAULT_LOCALE`). */
export interface AccessDefaults {
  readonly timeZone: string;
  readonly locale: string;
}

function settingOf(settings: JsonValue, key: 'locale' | 'timezone'): unknown {
  return typeof settings === 'object' && settings !== null && !Array.isArray(settings)
    ? settings[key]
    : undefined;
}

/** The first zone the runtime knows, by the IANA primary name PostgreSQL knows (T819). */
function firstTimeZone(zones: readonly unknown[], fallback: string): string {
  for (const zone of zones) {
    const name = canonicalTimeZone(zone);
    if (name !== null) return name;
  }
  return canonicalTimeZone(fallback) ?? fallback;
}

const isLocale = (locale: unknown): locale is string => typeof locale === 'string' && locale !== '';

/** `userId`'s access to a base, as a worker resolves it for a job run on the user's behalf. */
export interface MemberBaseAccess {
  readonly record: RecordAccessContext;
  /** Organization owner/admin, base owner, workspace admin or role `admin`. */
  readonly isAdmin: boolean;
}

/**
 * What resolving anyone's access to one base needs, read once: the
 * organization, the base (outside the trash), its roles, assignments and
 * schema. Shared by many members, e.g. a notification fan-out (T511).
 */
export interface MemberAccessBase {
  readonly organization: Organization;
  readonly base: Base;
  readonly roles: readonly BaseRoleDef[];
  readonly assignments: readonly RoleAssignment[];
  readonly schema: SchemaMeta;
}

/** Loads {@link MemberAccessBase}; `undefined` when the organization or base is gone. */
export async function loadMemberAccessBase(
  db: Db,
  scope: OrgScope,
  baseId: Id<'bse'>,
): Promise<MemberAccessBase | undefined> {
  const [organization, base] = await Promise.all([
    new OrganizationsRepository(db).findById(scope.organizationId),
    new BasesRepository(db).getById(scope, baseId),
  ]);
  if (organization === undefined || base === undefined) return undefined;
  const [roleRows, assignmentRows, tables, fields] = await Promise.all([
    new BaseRolesRepository(db).listByBase(scope, baseId),
    new BaseRoleMembersRepository(db).listByBase(scope, baseId),
    new TablesRepository(db).listByBase(scope, baseId),
    new FieldsRepository(db).listActiveByBase(scope, baseId),
  ]);
  const byTable = new Map<Id<'tbl'>, FieldMeta[]>(tables.map((table) => [table.id, []]));
  for (const field of fields) {
    byTable.get(field.table_id)?.push({
      id: field.id,
      type: field.type,
      ...(field.compute_mode === null ? {} : { computed: true }),
    });
  }
  const schema: SchemaMeta = {
    tables: tables.map((table) => ({ id: table.id, fields: byTable.get(table.id) ?? [] })),
    dashboards: [],
  };
  const roles: BaseRoleDef[] = [];
  for (const row of roleRows) {
    const config = roleConfigSchema.safeParse(row.config);
    // Deny by default: a role whose config cannot be read grants nothing.
    if (config.success)
      roles.push({ id: row.id, kind: row.kind, name: row.name, config: config.data });
  }
  const assignments = assignmentRows.map(
    (row) =>
      ({
        roleId: row.role_id,
        principalType: row.principal_type,
        principalId: row.principal_id,
      }) as RoleAssignment,
  );
  return { organization, base, roles, assignments, schema };
}

/**
 * The **current** access of an organization member to one of its bases
 * (outside the trash), resolved like a request of that user (SPEC §14.1,
 * the api's `AccessService.findBaseForUser`): active user and member, group
 * and workspace roles, base roles and their assignments, the base schema.
 * `undefined` when the user lost access. Jobs that act for a user (import,
 * T308) call it when they start, so a permission removed after the job was
 * queued still applies. Role configs that cannot be read grant nothing.
 * `loaded`: the base part, already read by {@link loadMemberAccessBase}
 * (resolving many members of one base).
 */
export async function resolveMemberBaseAccess(
  db: Db,
  scope: OrgScope,
  input: { readonly userId: Id<'usr'>; readonly baseId: Id<'bse'> },
  defaults: AccessDefaults,
  loaded?: MemberAccessBase,
): Promise<MemberBaseAccess | undefined> {
  const { userId, baseId } = input;
  const [user, member, shared] = await Promise.all([
    new UsersRepository(db).findById(userId),
    new OrgMembersRepository(db).get(scope, userId),
    loaded ?? loadMemberAccessBase(db, scope, baseId),
  ]);
  if (user?.status !== 'active' || member === undefined || shared?.base.id !== baseId) {
    return undefined;
  }
  const { organization, base } = shared;
  const groupMembers = new GroupMembersRepository(db);
  const groupIds = await groupMembers.groupIdsOfUser(scope, userId);
  const workspaceRoles = await new WorkspaceMembersRepository(db).rolesOf(scope, {
    userId,
    groupIds,
  });
  const resolved = resolveBaseAccess({
    principal: {
      userId,
      groupIds,
      orgRole: member.role,
      workspaceRole: workspaceRoles.get(base.workspace_id) ?? null,
      isBaseOwner: base.owner_id === userId,
    },
    roles: [...shared.roles],
    assignments: [...shared.assignments],
    schema: shared.schema,
  });
  if (resolved === null) return undefined;
  const orgSettings = organization.settings;
  return {
    isAdmin: resolved.access.is_admin,
    record: {
      baseId,
      resolved,
      userId,
      groupMemberUserIds: await groupMembers.userIdsOfGroups(scope, groupIds),
      timeZone: firstTimeZone(
        [user.timezone, settingOf(orgSettings, 'timezone')],
        defaults.timeZone,
      ),
      locale: [user.locale, settingOf(orgSettings, 'locale')].find(isLocale) ?? defaults.locale,
      // CONTRACTS §2: typecast follows the base's locale, never the writer's.
      typecastLocale:
        [settingOf(base.settings, 'locale'), settingOf(orgSettings, 'locale')].find(isLocale) ??
        defaults.locale,
    },
  };
}
