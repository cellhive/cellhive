import type { BaseRule, RoleConfig, RoleKind, TablePerm, TableRule } from './role-config.js';
import type { SchemaMeta, TableMeta } from './schema-meta.js';
import type { Id } from '@cellhive/contracts';

export type SystemRoleKind = Exclude<RoleKind, 'custom'>;

/** Short preset names used when a base is created (SPEC §14.1). */
export const SYSTEM_ROLE_PRESETS = {
  admin: 'system_admin',
  editor: 'system_editor',
  reader: 'system_reader',
} as const satisfies Record<string, SystemRoleKind>;

export type SystemRolePresetName = keyof typeof SYSTEM_ROLE_PRESETS;

interface PresetShape {
  perm: TablePerm;
  operations: TableRule['record_rule']['operations'];
  allowViewEdit: boolean;
  fieldMode: TableRule['field_rule']['mode'];
  baseRule: BaseRule;
  optionEditAll: boolean;
}

const PRESETS: Record<SystemRoleKind, PresetShape> = {
  system_admin: {
    perm: 'manage',
    operations: ['add', 'delete'],
    allowViewEdit: true,
    fieldMode: 'all_edit',
    baseRule: { copy: true, download: true, share_link: true },
    optionEditAll: true,
  },
  system_editor: {
    perm: 'edit',
    operations: ['add', 'delete'],
    allowViewEdit: true,
    fieldMode: 'all_edit',
    baseRule: { copy: true, download: true, share_link: true },
    optionEditAll: false,
  },
  system_reader: {
    perm: 'read_only',
    operations: [],
    allowViewEdit: false,
    fieldMode: 'all_read',
    baseRule: { copy: true, download: true, share_link: false },
    optionEditAll: false,
  },
};

/** The preset table rule of a system role for one table. */
export function systemTableRule(kind: SystemRoleKind, table: TableMeta): TableRule {
  const preset = PRESETS[kind];
  return {
    perm: preset.perm,
    view_rule: { allow_edit: preset.allowViewEdit, visible_views: null },
    record_rule: {
      operations: [...preset.operations],
      edit_filter: null,
      read_scope: 'all',
      read_filter: null,
    },
    field_rule: {
      mode: preset.fieldMode,
      fields: {},
      option_edit_fields: preset.optionEditAll
        ? table.fields.filter((field) => field.type === 'select').map((field) => field.id)
        : [],
      file_download_fields: [],
    },
  };
}

/**
 * Builds the config of a system role (`admin`, `editor`, `reader`) for the
 * base's current tables and dashboards. Stored when a base is created;
 * tables added later fall back to the same preset at resolution time.
 */
export function systemRoleConfig(
  preset: SystemRolePresetName | SystemRoleKind,
  schema: SchemaMeta,
): RoleConfig {
  const kind: SystemRoleKind =
    preset in SYSTEM_ROLE_PRESETS
      ? SYSTEM_ROLE_PRESETS[preset as SystemRolePresetName]
      : (preset as SystemRoleKind);
  const tables: Record<Id<'tbl'>, TableRule> = {};
  for (const table of schema.tables) {
    tables[table.id] = systemTableRule(kind, table);
  }
  const dashboards: RoleConfig['dashboards'] = {};
  for (const dashboardId of schema.dashboards ?? []) {
    dashboards[dashboardId] = 'read_only';
  }
  return { base_rule: { ...PRESETS[kind].baseRule }, tables, dashboards };
}
