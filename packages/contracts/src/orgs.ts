import { z } from 'zod';

import { effectiveAccessSchema } from './access.js';
import { organizationAiSchema } from './ai-settings.js';
import {
  apiTokenPolicySchema,
  DEFAULT_API_TOKEN_POLICY,
  updateApiTokenPolicySchema,
} from './api-tokens.js';
import {
  emailSchema,
  localeSchema,
  newPasswordSchema,
  organizationSummarySchema,
  orgRoleSchema,
  timeZoneSchema,
  userSummarySchema,
} from './auth.js';
import { booleanQueryParam, isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';
import { offsetListSchema, offsetQuerySchema } from './pagination.js';
import { publicSharingPolicySchema } from './share-links.js';

/**
 * Organizations, members, groups, workspaces, bases and invitations
 * (SPEC §13.1, §14.1; CONTRACTS §1.1, §5A).
 */

const nameSchema = z.string().trim().min(1).max(100);

function atLeastOneKey(value: object): boolean {
  return Object.values(value).some((item) => item !== undefined);
}

const AT_LEAST_ONE = { message: 'At least one property is required' } as const;

// --- Organizations -------------------------------------------------------------

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: 'Must be an ISO 4217 currency code' })
  .meta({ description: 'ISO 4217 currency code', example: 'VND' });

/** Default of `settings.automation_max_depth` (SPEC §11.6). */
export const DEFAULT_AUTOMATION_MAX_DEPTH = 3;
/** Highest `settings.automation_max_depth` an organization may choose (SPEC §11.6). */
export const MAX_AUTOMATION_MAX_DEPTH = 5;

/**
 * Loop guard of automations (SPEC §11.6, BACKLOG T503): an event whose
 * causation `depth` is at least this value starts no run.
 */
export const automationMaxDepthSchema = z
  .int()
  .min(1)
  .max(MAX_AUTOMATION_MAX_DEPTH)
  .meta({
    description:
      'Automation loop guard (SPEC §11.6): changes made this many automation steps away from ' +
      `a person's change start no run (default ${String(DEFAULT_AUTOMATION_MAX_DEPTH)})`,
  });

export const organizationSettingsSchema = z
  .object({
    locale: z.string(),
    timezone: z.string(),
    currency: z.string(),
    public_sharing: publicSharingPolicySchema,
    automation_max_depth: automationMaxDepthSchema.default(DEFAULT_AUTOMATION_MAX_DEPTH),
    api_tokens: apiTokenPolicySchema.default(DEFAULT_API_TOKEN_POLICY),
  })
  .meta({ id: 'OrganizationSettings', description: 'Defaults of the organization (SPEC §20)' });
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;

export const organizationSchema = z
  .object({
    id: idOf('org'),
    name: z.string(),
    slug: z.string(),
    settings: organizationSettingsSchema,
    role: orgRoleSchema.meta({ description: "The caller's role in the organization" }),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'Organization' });
export type OrganizationDto = z.infer<typeof organizationSchema>;

/** `GET /orgs/:id`: the organization and whether AI is available to members (T906, C§29.1). */
export const organizationDetailSchema = organizationSchema
  .extend({ ai: organizationAiSchema })
  .meta({ id: 'OrganizationDetail' });
export type OrganizationDetailDto = z.infer<typeof organizationDetailSchema>;

export const organizationListSchema = offsetListSchema(organizationSchema).meta({
  id: 'OrganizationList',
});
export type OrganizationList = z.infer<typeof organizationListSchema>;

export const createOrganizationRequestSchema = z
  .strictObject({
    name: nameSchema,
    locale: localeSchema.optional().meta({ description: 'Defaults to DEFAULT_LOCALE' }),
    timezone: timeZoneSchema.optional().meta({ description: 'Defaults to DEFAULT_TIMEZONE' }),
  })
  .meta({ id: 'CreateOrganizationRequest' });
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;

export const updateOrganizationRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    settings: z
      .strictObject({
        locale: localeSchema.optional(),
        timezone: timeZoneSchema.optional(),
        currency: currencySchema.optional(),
        public_sharing: publicSharingPolicySchema.optional(),
        automation_max_depth: automationMaxDepthSchema.optional(),
        api_tokens: updateApiTokenPolicySchema.optional().meta({
          description: 'API token policy (CONTRACTS §26.4); keys left out keep their value',
        }),
      })
      .refine(atLeastOneKey, AT_LEAST_ONE)
      .optional(),
  })
  .refine(atLeastOneKey, AT_LEAST_ONE)
  .meta({ id: 'UpdateOrganizationRequest' });
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;

// --- Organization members --------------------------------------------------------

export const orgMemberSchema = z
  .object({
    user: userSummarySchema,
    role: orgRoleSchema,
    joined_at: isoDateTimeSchema,
  })
  .meta({ id: 'OrgMember' });
export type OrgMemberDto = z.infer<typeof orgMemberSchema>;

export const orgMemberListSchema = offsetListSchema(orgMemberSchema).meta({
  id: 'OrgMemberList',
});
export type OrgMemberList = z.infer<typeof orgMemberListSchema>;

export const updateOrgMemberRequestSchema = z
  .strictObject({ role: orgRoleSchema })
  .meta({ id: 'UpdateOrgMemberRequest' });
export type UpdateOrgMemberRequest = z.infer<typeof updateOrgMemberRequestSchema>;

export const removeOrgMemberRequestSchema = z
  .strictObject({
    transfer_bases_to: idOf('usr')
      .optional()
      .meta({
        description:
          'Owner or admin of the organization who becomes the owner of every base (also in ' +
          'the trash) the removed member owns. Required when the member owns bases.',
      }),
  })
  .meta({ id: 'RemoveOrgMemberRequest' });
export type RemoveOrgMemberRequest = z.infer<typeof removeOrgMemberRequestSchema>;

/**
 * Detail code (`errors[].code` of `422 VALIDATION_FAILED`) when a change
 * would leave the organization without an owner.
 */
export const LAST_OWNER = 'LAST_OWNER';
/** Detail code: the user (or invited email) is already a member. */
export const ALREADY_MEMBER = 'ALREADY_MEMBER';
/** Detail code: the referenced user or group is not part of the organization. */
export const UNKNOWN_PRINCIPAL = 'UNKNOWN_PRINCIPAL';
/** Detail code: a workspace still contains bases (also in the trash). */
export const WORKSPACE_NOT_EMPTY = 'WORKSPACE_NOT_EMPTY';
/**
 * Detail code: the member to remove owns bases and no `transfer_bases_to`
 * was given; `errors[].params` = `{ base_ids, total }` (at most
 * `OWNED_BASE_IDS_LIMIT` IDs).
 */
export const OWNS_BASES = 'OWNS_BASES';
/** Most base IDs listed in `OWNS_BASES` params. */
export const OWNED_BASE_IDS_LIMIT = 50;

// --- Groups ------------------------------------------------------------------------

export const groupSchema = z
  .object({
    id: idOf('grp'),
    organization_id: idOf('org'),
    name: z.string(),
    member_count: z.int().min(0),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'Group' });
export type GroupDto = z.infer<typeof groupSchema>;

export const groupListSchema = offsetListSchema(groupSchema).meta({ id: 'GroupList' });
export type GroupList = z.infer<typeof groupListSchema>;

export const createGroupRequestSchema = z
  .strictObject({ name: nameSchema })
  .meta({ id: 'CreateGroupRequest' });
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

export const updateGroupRequestSchema = z
  .strictObject({ name: nameSchema })
  .meta({ id: 'UpdateGroupRequest' });
export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;

export const groupMemberSchema = z
  .object({ user: userSummarySchema, added_at: isoDateTimeSchema })
  .meta({ id: 'GroupMember' });
export type GroupMemberDto = z.infer<typeof groupMemberSchema>;

export const groupMemberListSchema = offsetListSchema(groupMemberSchema).meta({
  id: 'GroupMemberList',
});
export type GroupMemberList = z.infer<typeof groupMemberListSchema>;

export const addGroupMemberRequestSchema = z
  .strictObject({ user_id: idOf('usr') })
  .meta({ id: 'AddGroupMemberRequest' });
export type AddGroupMemberRequest = z.infer<typeof addGroupMemberRequestSchema>;

// --- Workspaces --------------------------------------------------------------------

export const workspaceRoleSchema = z
  .enum(['admin', 'member'])
  .meta({ id: 'WorkspaceRole', description: 'Role in a workspace' });
export type WorkspaceRoleName = z.infer<typeof workspaceRoleSchema>;

export const workspaceSchema = z
  .object({
    id: idOf('wsp'),
    organization_id: idOf('org'),
    name: z.string(),
    slug: z.string(),
    role: workspaceRoleSchema.nullable().meta({
      description:
        "The caller's role in the workspace (directly or through a group); `null` when the " +
        'caller sees it through an organization role or a base role only',
    }),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'Workspace' });
export type WorkspaceDto = z.infer<typeof workspaceSchema>;

export const workspaceListSchema = offsetListSchema(workspaceSchema).meta({
  id: 'WorkspaceList',
});
export type WorkspaceList = z.infer<typeof workspaceListSchema>;

export const createWorkspaceRequestSchema = z
  .strictObject({ name: nameSchema })
  .meta({ id: 'CreateWorkspaceRequest' });
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const updateWorkspaceRequestSchema = z
  .strictObject({ name: nameSchema })
  .meta({ id: 'UpdateWorkspaceRequest' });
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;

export const principalTypeSchema = z
  .enum(['user', 'group'])
  .meta({ id: 'PrincipalType', description: 'Kind of principal a membership or role is given to' });
export type PrincipalTypeName = z.infer<typeof principalTypeSchema>;

/** A user (`usr_…`) or group (`grp_…`) ID; the prefix tells the principal type. */
export const principalIdSchema = z.union([idOf('usr'), idOf('grp')]);
export type PrincipalId = z.infer<typeof principalIdSchema>;

export const workspaceMemberSchema = z
  .object({
    principal_type: principalTypeSchema,
    principal_id: principalIdSchema,
    name: z.string().meta({ description: "The user's display name or the group's name" }),
    email: z.string().nullable().meta({ description: 'Email of a user; `null` for a group' }),
    role: workspaceRoleSchema,
    added_at: isoDateTimeSchema,
  })
  .meta({ id: 'WorkspaceMember' });
export type WorkspaceMemberDto = z.infer<typeof workspaceMemberSchema>;

export const workspaceMemberListSchema = offsetListSchema(workspaceMemberSchema).meta({
  id: 'WorkspaceMemberList',
});
export type WorkspaceMemberList = z.infer<typeof workspaceMemberListSchema>;

export const addWorkspaceMemberRequestSchema = z
  .strictObject({
    principal_id: principalIdSchema,
    role: workspaceRoleSchema.default('member'),
  })
  .meta({ id: 'AddWorkspaceMemberRequest' });
export type AddWorkspaceMemberRequest = z.infer<typeof addWorkspaceMemberRequestSchema>;

export const updateWorkspaceMemberRequestSchema = z
  .strictObject({ role: workspaceRoleSchema })
  .meta({ id: 'UpdateWorkspaceMemberRequest' });
export type UpdateWorkspaceMemberRequest = z.infer<typeof updateWorkspaceMemberRequestSchema>;

// --- Bases -------------------------------------------------------------------------

const iconSchema = z.string().trim().min(1).max(64);
const descriptionSchema = z.string().max(2000);

/**
 * Settings of a base a base admin changes (CONTRACTS §5A, T457). Other keys
 * of `meta.bases.settings` (locale, collation, time zone) are not part of
 * this contract yet.
 */
export const baseSettingsSchema = z
  .strictObject({
    strict_computed_permissions: z.boolean().meta({
      description:
        'Formula/lookup values are hidden (`null`, field `locked`) from readers who cannot ' +
        'read a field of the **same** record the value is computed from (SPEC §9.5). Default ' +
        '`false`: like Lark, they see the result. Values computed from other tables are always ' +
        'hidden from readers who cannot read their sources',
    }),
  })
  .meta({ id: 'BaseSettings' });
export type BaseSettingsDto = z.infer<typeof baseSettingsSchema>;

export const baseSchema = z
  .object({
    id: idOf('bse'),
    organization_id: idOf('org'),
    workspace_id: idOf('wsp'),
    owner_id: idOf('usr'),
    name: z.string(),
    icon: z.string().nullable(),
    description: z.string().nullable(),
    permission_version: z.int().min(1).meta({
      description:
        'Increases whenever roles, role assignments or memberships affecting the base change',
    }),
    settings: baseSettingsSchema.default({ strict_computed_permissions: false }),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
    deleted_at: isoDateTimeSchema.nullable().meta({
      description: 'When the base was moved to the trash; `null` outside the trash',
    }),
  })
  .meta({ id: 'Base' });
export type BaseDto = z.infer<typeof baseSchema>;

/** `GET /api/v1/bases/:id` (CONTRACTS §5A). */
export const baseDetailSchema = baseSchema
  .extend({ access: effectiveAccessSchema })
  .meta({ id: 'BaseDetail' });
export type BaseDetail = z.infer<typeof baseDetailSchema>;

export const baseListSchema = offsetListSchema(baseSchema).meta({ id: 'BaseList' });

/** A person who can open a base (user pickers of the base, e.g. a form's user question). */
export const baseMemberSchema = z
  .object({
    id: idOf('usr'),
    display_name: z.string(),
    email: z.string(),
  })
  .meta({ id: 'BaseMember' });
export type BaseMemberDto = z.infer<typeof baseMemberSchema>;

/**
 * `GET /bases/:id/members` (T320): the active members of the organization
 * who can open the base, resolved like their own requests; oldest member
 * first. Not paged (an organization holds at most a few thousand members).
 */
export const baseMemberListSchema = z
  .object({ items: z.array(baseMemberSchema) })
  .meta({ id: 'BaseMemberList' });
export type BaseMemberList = z.infer<typeof baseMemberListSchema>;

/** `GET /workspaces/:id/bases`. */
export const baseListQuerySchema = offsetQuerySchema.extend({
  include_deleted: booleanQueryParam.default(false).meta({
    description:
      'Also list bases in the trash that the caller may restore: all of them for workspace ' +
      'admins and organization owners/admins, the ones they own for everyone else',
  }),
});
export type BaseListQuery = z.infer<typeof baseListQuerySchema>;
export type BaseList = z.infer<typeof baseListSchema>;

export const createBaseRequestSchema = z
  .strictObject({
    name: nameSchema,
    icon: iconSchema.nullable().optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .meta({ id: 'CreateBaseRequest' });
export type CreateBaseRequest = z.infer<typeof createBaseRequestSchema>;

export const updateBaseRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    icon: iconSchema.nullable().optional(),
    description: descriptionSchema.nullable().optional(),
    owner_id: idOf('usr')
      .optional()
      .meta({
        description:
          'Transfers ownership to another member of the organization. Only the current owner ' +
          'or an organization owner/admin.',
      }),
    settings: baseSettingsSchema
      .partial()
      .refine(atLeastOneKey, AT_LEAST_ONE)
      .optional()
      .meta({ description: 'Keys to change (base admins); keys left out keep their value' }),
  })
  .refine(atLeastOneKey, AT_LEAST_ONE)
  .meta({ id: 'UpdateBaseRequest' });
export type UpdateBaseRequest = z.infer<typeof updateBaseRequestSchema>;

// --- Invitations -------------------------------------------------------------------

/** Invitations are valid for 7 days (SPEC §5.10). */
export const INVITATION_TTL_DAYS = 7;

/** Invitation tokens: 32 random bytes, base64url without padding. */
export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const invitationRoleSchema = z
  .enum(['admin', 'member'])
  .meta({ id: 'InvitationRole', description: 'Organization role given on acceptance' });
export type InvitationRole = z.infer<typeof invitationRoleSchema>;

export const invitationStatusSchema = z
  .enum(['pending', 'accepted', 'revoked', 'expired'])
  .meta({ id: 'InvitationStatus' });
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationSchema = z
  .object({
    id: idOf('inv'),
    organization_id: idOf('org'),
    email: z.string(),
    role: invitationRoleSchema,
    workspace_id: idOf('wsp')
      .nullable()
      .meta({ description: 'Workspace joined as `member` on acceptance' }),
    inviter_id: idOf('usr'),
    status: invitationStatusSchema,
    expires_at: isoDateTimeSchema,
    accepted_at: isoDateTimeSchema.nullable(),
    revoked_at: isoDateTimeSchema.nullable(),
    created_at: isoDateTimeSchema,
  })
  .meta({ id: 'Invitation' });
export type InvitationDto = z.infer<typeof invitationSchema>;

export const createdInvitationSchema = invitationSchema
  .extend({
    invite_url: z.url().meta({
      description:
        'One-time link `<PUBLIC_URL>/invite/<token>`; returned only in this response ' +
        '(and in its replay for the same `Idempotency-Key`, whose stored copy is encrypted), ' +
        'never logged',
    }),
    email_sent: z
      .boolean()
      .meta({ description: 'Whether an email is being sent (SMTP configured)' }),
  })
  .meta({ id: 'CreatedInvitation' });
export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;

export const invitationListSchema = offsetListSchema(invitationSchema).meta({
  id: 'InvitationList',
});
export type InvitationList = z.infer<typeof invitationListSchema>;

export const invitationListQuerySchema = offsetQuerySchema.extend({
  status: invitationStatusSchema.optional(),
});
export type InvitationListQuery = z.infer<typeof invitationListQuerySchema>;

export const createInvitationRequestSchema = z
  .strictObject({
    email: emailSchema,
    role: invitationRoleSchema.default('member'),
    workspace_id: idOf('wsp').optional(),
  })
  .meta({ id: 'CreateInvitationRequest' });
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const invitationPreviewSchema = z
  .object({
    organization: z.object({ id: idOf('org'), name: z.string() }),
    email: z.string(),
    role: invitationRoleSchema,
    expires_at: isoDateTimeSchema,
    account_exists: z.boolean().meta({
      description:
        'True when an account with this email exists: sign in as that user to accept. ' +
        'Otherwise accept with `display_name` and `password`.',
    }),
  })
  .meta({ id: 'InvitationPreview' });
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

export const acceptInvitationRequestSchema = z
  .strictObject({
    display_name: z.string().trim().min(1).max(100).optional(),
    password: newPasswordSchema.optional(),
    locale: localeSchema.optional(),
    timezone: timeZoneSchema.optional(),
  })
  .meta({
    id: 'AcceptInvitationRequest',
    description:
      'Empty when signed in as the invited user. Without a session, `display_name` and ' +
      '`password` create the account.',
  });
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

export const acceptInvitationResponseSchema = z
  .object({
    organization: organizationSummarySchema,
    user: userSummarySchema,
    role: orgRoleSchema,
    workspace_id: idOf('wsp').nullable(),
  })
  .meta({ id: 'AcceptInvitationResult' });
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;
