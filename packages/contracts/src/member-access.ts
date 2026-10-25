import { z } from 'zod';

import { effectiveAccessSchema } from './access.js';
import { booleanQueryParam } from './common.js';
import { idOf } from './ids.js';
import { principalIdSchema, principalTypeSchema } from './orgs.js';
import { cursorListSchema, cursorQuerySchema } from './pagination.js';

/**
 * Read-only API behind the permissions UI (BACKLOG T711, Quyết định S6 #12;
 * CONTRACTS §5A, §14): the effective access of one member of the base's
 * organization with where it comes from, and the principals a base admin can
 * give a role to.
 */

/**
 * Where a member's access to a base comes from, in the resolution order of
 * SPEC §14.1: organization owner/admin, base owner, workspace admin, a role
 * given to the user directly, the roles of the user's groups, or nothing.
 */
export const ACCESS_SOURCE_KINDS = [
  'org_admin',
  'base_owner',
  'workspace_admin',
  'direct_role',
  'group_roles',
  'none',
] as const;
export const accessSourceKindSchema = z.enum(ACCESS_SOURCE_KINDS).meta({ id: 'AccessSourceKind' });
export type AccessSourceKind = z.infer<typeof accessSourceKindSchema>;

/** Most visible tables `counts` covers (the first ones, in table order). */
export const MEMBER_ACCESS_MAX_COUNTED_TABLES = 20;

export const accessSourceSchema = z
  .object({
    kind: accessSourceKindSchema,
    role_ids: z.array(idOf('rol')).meta({
      description:
        'Roles the access is resolved from (`direct_role`: the direct role; `group_roles`: ' +
        'every role of the groups, in role order); `[]` for the other kinds',
    }),
    group_ids: z.array(idOf('grp')).meta({
      description:
        '`group_roles`: the groups of the user that give one of `role_ids`; `[]` otherwise ' +
        '(a direct role wins over group roles)',
    }),
  })
  .meta({ id: 'AccessSource' });
export type AccessSourceDto = z.infer<typeof accessSourceSchema>;

export const tableRecordCountsSchema = z
  .object({
    readable: z.int().min(0).meta({ description: 'Live records the member can read' }),
    editable: z.int().min(0).meta({ description: 'Of those, records the member can edit' }),
  })
  .nullable()
  .meta({
    id: 'TableRecordCounts',
    description: '`null` when counting this table took longer than the statement timeout (10 s)',
  });

/** `?counts=true|false` (default `false`). */
export const memberAccessQuerySchema = z.object({
  counts: booleanQueryParam
    .default(false)
    .meta({ description: 'Also count the records the member can read and edit per table' }),
});
export type MemberAccessQuery = z.infer<typeof memberAccessQuerySchema>;

/** `GET /api/v1/bases/:id/members/:userId/access`. */
export const memberAccessSchema = z
  .object({
    user: z.object({ id: idOf('usr'), display_name: z.string() }),
    access: effectiveAccessSchema.nullable().meta({
      description:
        'Exactly the `access` the member gets from `GET /bases/:id`; `null` when the member ' +
        'cannot open the base (`source.kind = none`)',
    }),
    source: accessSourceSchema,
    counts: z
      .record(idOf('tbl'), tableRecordCountsSchema)
      .nullable()
      .meta({
        description:
          `With \`counts=true\` and access: the first ${String(MEMBER_ACCESS_MAX_COUNTED_TABLES)} ` +
          'visible tables (table order), counted with the member’s permissions; else `null`',
      }),
  })
  .meta({ id: 'MemberAccess' });
export type MemberAccessDto = z.infer<typeof memberAccessSchema>;

export const PRINCIPAL_SEARCH_MAX_LENGTH = 100;

/** (T713) Sources of full access a principal row can carry: the first three of {@link ACCESS_SOURCE_KINDS}. */
export const FULL_ACCESS_KINDS = ['org_admin', 'base_owner', 'workspace_admin'] as const;
export const fullAccessKindSchema = z.enum(FULL_ACCESS_KINDS).meta({ id: 'FullAccessKind' });
export type FullAccessKind = z.infer<typeof fullAccessKindSchema>;

/** `GET /api/v1/bases/:id/principals?q=&cursor=&limit=`. */
export const principalListQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().min(1).max(PRINCIPAL_SEARCH_MAX_LENGTH).optional().meta({
    description:
      'Case-insensitive substring of the display name or email (users) or of the name (groups)',
  }),
});
export type PrincipalListQuery = z.infer<typeof principalListQuerySchema>;

export const basePrincipalSchema = z
  .object({
    principal_type: principalTypeSchema,
    principal_id: principalIdSchema,
    name: z.string().meta({ description: 'User display name or group name' }),
    email: z.string().nullable().meta({ description: "The user's email; `null` for groups" }),
    role_id: idOf('rol')
      .nullable()
      .meta({ description: 'Role of the principal in this base; `null` when it has none' }),
    full_access: fullAccessKindSchema.nullable().meta({
      description:
        '(T713) Why the principal has full access to the base whatever its role here ' +
        '(SPEC §14.1 step 1): `org_admin` (organization owner/admin), `base_owner`, ' +
        '`workspace_admin` (of the base’s workspace, directly or through a group; a group row ' +
        'is `workspace_admin` when the group itself is). `null` otherwise',
    }),
  })
  .meta({ id: 'BasePrincipal' });
export type BasePrincipalDto = z.infer<typeof basePrincipalSchema>;

export const basePrincipalListSchema = cursorListSchema(basePrincipalSchema).meta({
  id: 'BasePrincipalList',
});
export type BasePrincipalList = z.infer<typeof basePrincipalListSchema>;
