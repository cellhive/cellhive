import { z } from 'zod';

import {
  fieldPermSchema,
  recordOperationSchema,
  roleKindSchema,
  tablePermSchema,
} from './access.js';
import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';
import { principalIdSchema, principalTypeSchema } from './orgs.js';
import { offsetListSchema } from './pagination.js';

/**
 * Base roles and role assignments (SPEC §13.1, §14.1; BACKLOG T109). The
 * role config itself is validated by `roleConfigSchema` of
 * `@cellhive/permissions` (which depends on this package and on the filter
 * DSL); here it is an object whose structure SPEC §14.1 defines.
 */

/** Detail code (`errors[].code` of `422 VALIDATION_FAILED`): system roles cannot be deleted, `admin`'s config cannot change. */
export const SYSTEM_ROLE = 'SYSTEM_ROLE';
/** Detail code: a custom role still has assignments; remove them first. */
export const ROLE_IN_USE = 'ROLE_IN_USE';
/** Detail code: `role_id` of an assignment is not a role of the base. */
export const UNKNOWN_ROLE = 'UNKNOWN_ROLE';
/**
 * Detail code: a role config names a dashboard (`dashboards.<id>`) that is
 * not a dashboard of the base, active or in its trash (BACKLOG T815).
 */
export const UNKNOWN_DASHBOARD = 'UNKNOWN_DASHBOARD';
/** Detail code: a role config names a table that is not an active table of the base. */
export const UNKNOWN_TABLE = 'UNKNOWN_TABLE';
/**
 * Detail code: a role config names a field that is not an active field of
 * the table (`field_rule.fields`, `option_edit_fields`, `file_download_fields`).
 * Filters report unknown fields under `INVALID_FILTER` instead.
 */
export const UNKNOWN_FIELD = 'UNKNOWN_FIELD';
const roleNameSchema = z.string().trim().min(1).max(100);

export const roleConfigObjectSchema = z.record(z.string(), z.unknown()).meta({
  id: 'RoleConfig',
  description:
    'Role config (SPEC §14.1): `{ base_rule, tables: { tbl_…: { perm, view_rule, record_rule, ' +
    'field_rule } }, dashboards }`, keyed by IDs. Omitted parts take their deny-by-default ' +
    'values; tables missing from a custom role are `no_perm`. Record filters use the filter ' +
    'DSL (SPEC §6) and are stored normalised (select option names become ids).',
});
export type RoleConfigObject = z.infer<typeof roleConfigObjectSchema>;

export const ROLE_ADJUSTMENT_REASONS = [
  'computed_field_max_read',
  'filter_field_min_read',
  'filter_field_min_create',
  'operations_require_edit',
  'reader_ceiling',
  'editor_ceiling',
] as const;

export const roleAdjustmentSchema = z
  .object({
    table_id: idOf('tbl'),
    field_id: idOf('fld').nullable().meta({ description: '`null` for table-level adjustments' }),
    from: z.union([fieldPermSchema, tablePermSchema, z.array(recordOperationSchema)]),
    to: z.union([fieldPermSchema, tablePermSchema, z.array(recordOperationSchema)]),
    reason: z.enum(ROLE_ADJUSTMENT_REASONS).meta({
      description:
        '`computed_field_max_read`: formula/lookup/auto_number/created_*/updated_* are at most ' +
        '`read`; `filter_field_min_read` / `filter_field_min_create`: a field used by a record ' +
        'filter is at least `read` (`create` when the role can add records); ' +
        '`operations_require_edit`: `add`/`delete` need table perm `edit` or `manage`; ' +
        '`reader_ceiling` / `editor_ceiling`: system role limits',
    }),
  })
  .meta({
    id: 'RoleAdjustment',
    description: 'A change the server applied when saving a role (SPEC §14.1)',
  });
export type RoleAdjustmentDto = z.infer<typeof roleAdjustmentSchema>;

/**
 * A user or group holding a role, with the name the admin UI shows. Users:
 * `display_name` and `email` (every org member may see the member list with
 * emails, SPEC §14.1); groups: the group name, `email: null`.
 */
export const roleAssigneeSchema = z
  .object({
    principal_type: principalTypeSchema,
    principal_id: principalIdSchema,
    name: z.string().meta({
      description:
        'User display name or group name; the principal ID when the principal no longer exists',
    }),
    email: z.string().nullable().meta({ description: "The user's email; `null` for groups" }),
  })
  .meta({ id: 'RoleAssignee' });
export type RoleAssigneeDto = z.infer<typeof roleAssigneeSchema>;

export const roleSchema = z
  .object({
    id: idOf('rol'),
    base_id: idOf('bse'),
    name: z.string(),
    kind: roleKindSchema,
    config: roleConfigObjectSchema,
    position: z.int().min(0),
    assignments: z.array(roleAssigneeSchema).meta({
      description: 'Users and groups that have this role in the base',
    }),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'Role' });
export type RoleDto = z.infer<typeof roleSchema>;

export const roleListSchema = offsetListSchema(roleSchema).meta({ id: 'RoleList' });
export type RoleList = z.infer<typeof roleListSchema>;

export const roleWithAdjustmentsSchema = roleSchema
  .extend({
    adjustments: z.array(roleAdjustmentSchema).meta({
      description: 'Automatic changes applied to the submitted config; empty when none',
    }),
  })
  .meta({ id: 'RoleWithAdjustments' });
export type RoleWithAdjustments = z.infer<typeof roleWithAdjustmentsSchema>;

export const createRoleRequestSchema = z
  .strictObject({
    name: roleNameSchema,
    config: roleConfigObjectSchema.optional().meta({ description: 'Defaults to deny-all' }),
  })
  .meta({ id: 'CreateRoleRequest' });
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z
  .strictObject({
    name: roleNameSchema.optional(),
    config: roleConfigObjectSchema
      .optional()
      .meta({ description: 'Replaces the whole config (not merged)' }),
  })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: 'At least one property is required',
  })
  .meta({ id: 'UpdateRoleRequest' });
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

function prefixMatchesType(value: { principal_type: string; principal_id: string }): boolean {
  return value.principal_id.startsWith(value.principal_type === 'user' ? 'usr_' : 'grp_');
}

const PREFIX_MISMATCH = {
  message: '`principal_id` must be a user ID for `user` and a group ID for `group`',
  path: ['principal_id'],
};

export const assignRoleRequestSchema = z
  .strictObject({
    principal_type: principalTypeSchema,
    principal_id: principalIdSchema,
    role_id: idOf('rol'),
  })
  .refine(prefixMatchesType, PREFIX_MISMATCH)
  .meta({ id: 'AssignRoleRequest' });
export type AssignRoleRequest = z.infer<typeof assignRoleRequestSchema>;

export const removeRoleAssignmentRequestSchema = z
  .strictObject({ principal_type: principalTypeSchema, principal_id: principalIdSchema })
  .refine(prefixMatchesType, PREFIX_MISMATCH)
  .meta({ id: 'RemoveRoleAssignmentRequest' });
export type RemoveRoleAssignmentRequest = z.infer<typeof removeRoleAssignmentRequestSchema>;

export const roleAssignmentSchema = z
  .object({
    base_id: idOf('bse'),
    role_id: idOf('rol'),
    principal_type: principalTypeSchema,
    principal_id: principalIdSchema,
    previous_role_id: idOf('rol')
      .nullable()
      .meta({ description: 'The role the principal had before; `null` when none' }),
  })
  .meta({ id: 'RoleAssignment' });
export type RoleAssignmentDto = z.infer<typeof roleAssignmentSchema>;
