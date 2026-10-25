import { z } from 'zod';

import { idOf } from './ids.js';

/**
 * Permission vocabulary shared by the role config (`@cellhive/permissions`)
 * and the effective access returned to clients (CONTRACTS §5A). Defined here
 * so that API response schemas can use them; `@cellhive/permissions`
 * re-exports every name.
 */

/** Table permission levels, lowest first (SPEC §14.1). */
export const TABLE_PERMS = ['no_perm', 'read_only', 'edit', 'manage'] as const;
export const tablePermSchema = z.enum(TABLE_PERMS);
export type TablePerm = z.infer<typeof tablePermSchema>;

/** Field permission levels, lowest first: `create` = write on create + read; `edit` = add + edit + read. */
export const FIELD_PERMS = ['no_perm', 'read', 'create', 'edit'] as const;
export const fieldPermSchema = z.enum(FIELD_PERMS);
export type FieldPerm = z.infer<typeof fieldPermSchema>;

export const RECORD_OPERATIONS = ['add', 'delete'] as const;
export const recordOperationSchema = z.enum(RECORD_OPERATIONS);
export type RecordOperation = z.infer<typeof recordOperationSchema>;

export const readScopeSchema = z.enum(['all', 'editable', 'filter']);
export type ReadScope = z.infer<typeof readScopeSchema>;

/** Role kinds as stored in `meta.base_roles.kind` (SPEC §5.10). */
export const ROLE_KINDS = ['system_admin', 'system_editor', 'system_reader', 'custom'] as const;
export const roleKindSchema = z.enum(ROLE_KINDS);
export type RoleKind = z.infer<typeof roleKindSchema>;

export const baseRuleSchema = z.strictObject({
  copy: z.boolean().default(false),
  download: z.boolean().default(false),
  share_link: z.boolean().default(false),
});
export type BaseRule = z.infer<typeof baseRuleSchema>;

/**
 * Per-table access returned to clients (CONTRACTS §5A). Never contains
 * `edit_filter`/`read_filter`, and only lists fields the caller can see.
 */
export const tableAccessSchema = z
  .strictObject({
    perm: tablePermSchema.exclude(['no_perm']),
    operations: z.array(recordOperationSchema),
    view_rule: z.strictObject({
      allow_edit: z.boolean(),
      visible_views: z.array(idOf('viw')).nullable(),
    }),
    read_scope: readScopeSchema,
    fields: z.record(idOf('fld'), fieldPermSchema.exclude(['no_perm'])),
    option_edit_fields: z.array(idOf('fld')),
    file_download_fields: z.array(idOf('fld')),
  })
  .meta({ id: 'TableAccess' });
export type TableAccess = z.infer<typeof tableAccessSchema>;

/** `access` in `GET /api/v1/bases/:id` (CONTRACTS §5A). */
export const effectiveAccessSchema = z
  .strictObject({
    /**
     * The role the access comes from. `null` when access is implied (org
     * owner/admin, base owner, workspace admin) or is the union of several
     * group roles.
     */
    role: z.strictObject({ id: idOf('rol'), kind: roleKindSchema, name: z.string() }).nullable(),
    is_admin: z.boolean(),
    base_rule: baseRuleSchema,
    tables: z.record(idOf('tbl'), tableAccessSchema),
    dashboards: z.record(idOf('dsh'), z.literal('read_only')),
  })
  .meta({
    id: 'EffectiveAccess',
    description:
      'What the caller may do in the base (CONTRACTS §5A). Lists only what the caller can see.',
  });
export type EffectiveAccess = z.infer<typeof effectiveAccessSchema>;
