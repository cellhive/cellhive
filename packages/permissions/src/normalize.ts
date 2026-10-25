import { collectFieldIds } from './filter.js';
import {
  fieldPermAtLeast,
  tablePermAtLeast,
  type FieldPerm,
  type FieldRuleMode,
  type RecordOperation,
  type RoleConfig,
  type RoleKind,
  type TablePerm,
  type TableRule,
} from './role-config.js';
import { isComputedField, type SchemaMeta, type TableMeta } from './schema-meta.js';

import type { Id } from '@cellhive/contracts';

/** Stable reason codes; the UI translates them (SPEC §14.1 "UI shows the reason"). */
export const ADJUSTMENT_REASONS = [
  /** Computed fields (formula, lookup, auto_number, created_*, updated_*) are at most `read`. */
  'computed_field_max_read',
  /** A field referenced by `edit_filter`/`read_filter` must be at least `read`. */
  'filter_field_min_read',
  /** With `add`, a field referenced by a record filter must be at least `create`. */
  'filter_field_min_create',
  /** `operations` only apply when the table perm is `edit` or `manage`. */
  'operations_require_edit',
  /** The system `reader` role never goes above `read_only`. */
  'reader_ceiling',
  /** The system `editor` role never goes above `edit` (no schema changes). */
  'editor_ceiling',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export type RoleAdjustment =
  | {
      table_id: Id<'tbl'>;
      field_id: Id<'fld'>;
      from: FieldPerm;
      to: FieldPerm;
      reason: 'computed_field_max_read' | 'filter_field_min_read' | 'filter_field_min_create';
    }
  | {
      table_id: Id<'tbl'>;
      field_id: null;
      from: TablePerm;
      to: TablePerm;
      reason: 'reader_ceiling' | 'editor_ceiling';
    }
  | {
      table_id: Id<'tbl'>;
      field_id: null;
      from: RecordOperation[];
      to: RecordOperation[];
      reason: 'operations_require_edit';
    };

export interface NormalizeOptions {
  /** Role kind; system `editor`/`reader` ceilings apply when given. */
  kind?: RoleKind;
}

export interface NormalizeResult {
  config: RoleConfig;
  adjustments: RoleAdjustment[];
}

/** Field perm implied by the field rule mode for fields without an override. */
export function modeDefaultFieldPerm(mode: FieldRuleMode): FieldPerm {
  switch (mode) {
    case 'all_edit':
    case 'specify':
      return 'edit';
    case 'all_read':
      return 'read';
    case 'no_perm':
      return 'no_perm';
  }
}

/** Highest table perm a role kind may hold. */
export function tablePermCeiling(kind: RoleKind | undefined): TablePerm {
  if (kind === 'system_reader') return 'read_only';
  if (kind === 'system_editor') return 'edit';
  return 'manage';
}

function cloneTableRule(rule: TableRule): TableRule {
  return {
    perm: rule.perm,
    view_rule: {
      allow_edit: rule.view_rule.allow_edit,
      visible_views:
        rule.view_rule.visible_views === null ? null : [...rule.view_rule.visible_views],
    },
    record_rule: { ...rule.record_rule, operations: [...rule.record_rule.operations] },
    field_rule: {
      mode: rule.field_rule.mode,
      fields: { ...rule.field_rule.fields },
      option_edit_fields: [...rule.field_rule.option_edit_fields],
      file_download_fields: [...rule.field_rule.file_download_fields],
    },
  };
}

/**
 * Normalises one table rule in place and reports every change. Exported for
 * the resolver, which applies the same rules to stored configs so that
 * schema changes after the role was saved cannot widen access.
 */
export function normalizeTableRule(
  tableId: Id<'tbl'>,
  rule: TableRule,
  table: TableMeta,
  kind: RoleKind | undefined,
  adjustments: RoleAdjustment[],
): void {
  const ceiling = tablePermCeiling(kind);
  if (!tablePermAtLeast(ceiling, rule.perm)) {
    adjustments.push({
      table_id: tableId,
      field_id: null,
      from: rule.perm,
      to: ceiling,
      reason: kind === 'system_reader' ? 'reader_ceiling' : 'editor_ceiling',
    });
    rule.perm = ceiling;
  }

  const recordRule = rule.record_rule;
  if (!tablePermAtLeast(rule.perm, 'edit') && recordRule.operations.length > 0) {
    adjustments.push({
      table_id: tableId,
      field_id: null,
      from: [...recordRule.operations],
      to: [],
      reason: 'operations_require_edit',
    });
    recordRule.operations = [];
  }
  if (rule.perm === 'no_perm') return;

  const fieldRule = rule.field_rule;
  const filterFields = new Set([
    ...collectFieldIds(recordRule.edit_filter),
    ...collectFieldIds(recordRule.read_filter),
  ]);
  const canAdd = recordRule.operations.includes('add');

  for (const field of table.fields) {
    const computed = isComputedField(field);
    const override = fieldRule.fields[field.id];
    if (computed && override !== undefined && fieldPermAtLeast(override, 'create')) {
      adjustments.push({
        table_id: tableId,
        field_id: field.id,
        from: override,
        to: 'read',
        reason: 'computed_field_max_read',
      });
      fieldRule.fields[field.id] = 'read';
    }
    if (!filterFields.has(field.id)) continue;
    const current = fieldRule.fields[field.id] ?? modeDefaultFieldPerm(fieldRule.mode);
    const floor: FieldPerm = canAdd && !computed ? 'create' : 'read';
    if (!fieldPermAtLeast(current, floor)) {
      adjustments.push({
        table_id: tableId,
        field_id: field.id,
        from: current,
        to: floor,
        reason: floor === 'create' ? 'filter_field_min_create' : 'filter_field_min_read',
      });
      fieldRule.fields[field.id] = floor;
    }
  }
}

/**
 * Applies the automatic role rules of SPEC §14.1 when a role is saved:
 * computed fields capped at `read`; fields used in record filters raised to
 * `read` (or `create` when the role can add records); `operations` cleared
 * unless the table perm is `edit`/`manage`; system role ceilings.
 *
 * Pure: the input config is not modified. Tables missing from `schema` are
 * kept unchanged.
 */
export function normalizeRoleConfig(
  config: RoleConfig,
  schema: SchemaMeta,
  options: NormalizeOptions = {},
): NormalizeResult {
  const adjustments: RoleAdjustment[] = [];
  const tablesById = new Map(schema.tables.map((table) => [table.id, table]));
  const tables: RoleConfig['tables'] = {};
  for (const [tableId, source] of Object.entries(config.tables) as [Id<'tbl'>, TableRule][]) {
    const rule = cloneTableRule(source);
    const table = tablesById.get(tableId);
    if (table !== undefined) normalizeTableRule(tableId, rule, table, options.kind, adjustments);
    tables[tableId] = rule;
  }
  return {
    config: {
      base_rule: { ...config.base_rule },
      tables,
      dashboards: { ...config.dashboards },
    },
    adjustments,
  };
}
