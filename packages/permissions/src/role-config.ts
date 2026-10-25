import {
  baseRuleSchema,
  FIELD_PERMS,
  fieldPermSchema,
  idOf,
  readScopeSchema,
  recordOperationSchema,
  TABLE_PERMS,
  tablePermSchema,
  type FieldPerm,
  type TablePerm,
} from '@cellhive/contracts';
import { z } from 'zod';

import { filterNodeSchema } from './filter.js';

// The permission vocabulary lives in `@cellhive/contracts` (API response
// schemas need it); re-exported so this package stays the one entry point.
export {
  baseRuleSchema,
  FIELD_PERMS,
  fieldPermSchema,
  RECORD_OPERATIONS,
  readScopeSchema,
  recordOperationSchema,
  ROLE_KINDS,
  roleKindSchema,
  TABLE_PERMS,
  tablePermSchema,
  type BaseRule,
  type FieldPerm,
  type ReadScope,
  type RecordOperation,
  type RoleKind,
  type TablePerm,
} from '@cellhive/contracts';

export const fieldRuleModeSchema = z.enum(['all_edit', 'all_read', 'specify', 'no_perm']);
export type FieldRuleMode = z.infer<typeof fieldRuleModeSchema>;

export const DASHBOARD_PERMS = ['no_perm', 'read_only'] as const;
export const dashboardPermSchema = z.enum(DASHBOARD_PERMS);
export type DashboardPerm = z.infer<typeof dashboardPermSchema>;

export const viewRuleSchema = z.strictObject({
  allow_edit: z.boolean().default(false),
  /** `null` = every view; an array = only these views are visible and queryable. */
  visible_views: z.array(idOf('viw')).nullable().default(null),
});
export type ViewRule = z.infer<typeof viewRuleSchema>;

export const recordRuleSchema = z
  .strictObject({
    operations: z.array(recordOperationSchema).default([]),
    /** `null` = every record is editable. */
    edit_filter: filterNodeSchema.nullable().default(null),
    read_scope: readScopeSchema.default('all'),
    read_filter: filterNodeSchema.nullable().default(null),
  })
  .superRefine((rule, ctx) => {
    if (rule.read_scope === 'filter' && rule.read_filter === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['read_filter'],
        message: 'read_filter is required when read_scope is "filter"',
      });
    }
  });
export type RecordRule = z.infer<typeof recordRuleSchema>;

export const fieldRuleSchema = z.strictObject({
  mode: fieldRuleModeSchema.default('all_edit'),
  /** Per-field overrides of the mode default. */
  fields: z.record(idOf('fld'), fieldPermSchema).default({}),
  option_edit_fields: z.array(idOf('fld')).default([]),
  file_download_fields: z.array(idOf('fld')).default([]),
});
export type FieldRule = z.infer<typeof fieldRuleSchema>;

export const tableRuleSchema = z.strictObject({
  perm: tablePermSchema,
  view_rule: viewRuleSchema.default({ allow_edit: false, visible_views: null }),
  record_rule: recordRuleSchema.default({
    operations: [],
    edit_filter: null,
    read_scope: 'all',
    read_filter: null,
  }),
  field_rule: fieldRuleSchema.default({
    mode: 'all_edit',
    fields: {},
    option_edit_fields: [],
    file_download_fields: [],
  }),
});
export type TableRule = z.infer<typeof tableRuleSchema>;

/**
 * `meta.base_roles.config` (SPEC §14.1). Keyed by IDs, never names. Omitted
 * sections take their deny-by-default values.
 */
export const roleConfigSchema = z.strictObject({
  base_rule: baseRuleSchema.default({ copy: false, download: false, share_link: false }),
  tables: z.record(idOf('tbl'), tableRuleSchema).default({}),
  dashboards: z.record(idOf('dsh'), dashboardPermSchema).default({}),
});
/** Parsed (fully defaulted) role config. */
export type RoleConfig = z.infer<typeof roleConfigSchema>;
/** Role config as accepted from clients, before defaults are applied. */
export type RoleConfigInput = z.input<typeof roleConfigSchema>;

function rankOf<T extends string>(order: readonly T[], value: T): number {
  return order.indexOf(value);
}

export function maxTablePerm(a: TablePerm, b: TablePerm): TablePerm {
  return rankOf(TABLE_PERMS, a) >= rankOf(TABLE_PERMS, b) ? a : b;
}

export function maxFieldPerm(a: FieldPerm, b: FieldPerm): FieldPerm {
  return rankOf(FIELD_PERMS, a) >= rankOf(FIELD_PERMS, b) ? a : b;
}

export function minFieldPerm(a: FieldPerm, b: FieldPerm): FieldPerm {
  return rankOf(FIELD_PERMS, a) <= rankOf(FIELD_PERMS, b) ? a : b;
}

export function fieldPermAtLeast(value: FieldPerm, floor: FieldPerm): boolean {
  return rankOf(FIELD_PERMS, value) >= rankOf(FIELD_PERMS, floor);
}

export function tablePermAtLeast(value: TablePerm, floor: TablePerm): boolean {
  return rankOf(TABLE_PERMS, value) >= rankOf(TABLE_PERMS, floor);
}
