import { collectFieldIds, forEachCondition, type FilterNode } from '@cellhive/filter-dsl';
import {
  COMPUTED_FIELD_TYPES,
  modeDefaultFieldPerm,
  roleConfigSchema,
  systemTableRule,
  tablePermCeiling,
  type DashboardPerm,
  type FieldPerm,
  type FieldRuleMode,
  type RoleConfig,
  type TablePerm,
  type TableRule,
} from '@cellhive/permissions';

import type { FieldDto, RoleAdjustmentDto, RoleKind } from '@cellhive/contracts';

/**
 * Pure model of the role editor (T713, FRONTEND §17.4): the stored config
 * as a full draft (every live table, defaults filled in), what each level
 * and field permission means under the role's ceiling, the config sent back
 * (`PATCH` replaces it whole), and where the server's adjustments belong.
 */

export const TABLE_LEVELS = [
  'manage',
  'edit',
  'read_only',
  'no_perm',
] as const satisfies readonly TablePerm[];
export const FIELD_LEVELS = [
  'edit',
  'create',
  'read',
  'no_perm',
] as const satisfies readonly FieldPerm[];
export const FIELD_MODES = [
  'all_edit',
  'all_read',
  'specify',
  'no_perm',
] as const satisfies readonly FieldRuleMode[];

/** (T815) The two levels of a dashboard, as the table levels: read it, or not at all. */
export const DASHBOARD_LEVELS = [
  'read_only',
  'no_perm',
] as const satisfies readonly DashboardPerm[];

const TABLE_RANK: Record<TablePerm, number> = { no_perm: 0, read_only: 1, edit: 2, manage: 3 };
const FIELD_RANK: Record<FieldPerm, number> = { no_perm: 0, read: 1, create: 2, edit: 3 };

/** A live table of the base with its live fields (the editor never names others). */
export interface EditorTable {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly Pick<FieldDto, 'id' | 'name' | 'type' | 'options' | 'is_primary'>[];
}

/** The deny-all rule of a table a custom role does not list (SPEC §14.1: deny by default). */
export function emptyTableRule(): TableRule {
  return {
    perm: 'no_perm',
    view_rule: { allow_edit: false, visible_views: null },
    record_rule: { operations: [], edit_filter: null, read_scope: 'all', read_filter: null },
    field_rule: { mode: 'all_edit', fields: {}, option_edit_fields: [], file_download_fields: [] },
  };
}

function systemKind(kind: RoleKind): Exclude<RoleKind, 'custom'> | null {
  return kind === 'custom' ? null : kind;
}

/**
 * The editor's draft of a stored config: parsed with the server's schema
 * (defaults filled in), one rule per live table — a table a custom role does
 * not list is `no_perm`; a system role falls back to its preset for tables
 * created after it (SPEC §14.1). Tables no longer live are dropped (saving
 * them back would be `UNKNOWN_TABLE`).
 */
export function draftOf(
  config: unknown,
  kind: RoleKind,
  tables: readonly EditorTable[],
): RoleConfig {
  const parsed = roleConfigSchema.safeParse(config);
  const source: RoleConfig = parsed.success
    ? parsed.data
    : {
        base_rule: { copy: false, download: false, share_link: false },
        tables: {},
        dashboards: {},
      };
  const system = systemKind(kind);
  const draft: RoleConfig = {
    base_rule: { ...source.base_rule },
    tables: {},
    dashboards: { ...source.dashboards },
  };
  for (const table of tables) {
    const id = table.id as keyof RoleConfig['tables'];
    const stored = source.tables[id];
    const rule =
      stored ??
      (system === null
        ? emptyTableRule()
        : systemTableRule(system, {
            id: table.id as never,
            fields: table.fields.map((field) => ({ id: field.id, type: field.type })),
          }));
    draft.tables[id] = pruneRule(rule, table);
  }
  return draft;
}

/** The rule without fields that are no longer live (saving them would be `UNKNOWN_FIELD`). */
function pruneRule(rule: TableRule, table: EditorTable): TableRule {
  const live = new Set<string>(table.fields.map((field) => field.id));
  const keep = (ids: readonly string[]) =>
    ids.filter((id) => live.has(id)) as TableRule['field_rule']['option_edit_fields'];
  const fields: TableRule['field_rule']['fields'] = {};
  for (const [id, perm] of Object.entries(rule.field_rule.fields)) {
    if (live.has(id)) fields[id as keyof typeof fields] = perm;
  }
  return {
    perm: rule.perm,
    view_rule: {
      allow_edit: rule.view_rule.allow_edit,
      visible_views:
        rule.view_rule.visible_views === null ? null : [...rule.view_rule.visible_views],
    },
    record_rule: {
      operations: [...rule.record_rule.operations],
      edit_filter: rule.record_rule.edit_filter,
      read_scope: rule.record_rule.read_scope,
      read_filter: rule.record_rule.read_filter,
    },
    field_rule: {
      mode: rule.field_rule.mode,
      fields,
      option_edit_fields: keep(rule.field_rule.option_edit_fields),
      file_download_fields: keep(rule.field_rule.file_download_fields),
    },
  };
}

/**
 * The config sent with `PATCH` (it replaces the stored one whole): a custom
 * role lists only the tables and dashboards it can open (others are denied
 * by default); a system role lists every table, since an unlisted one would
 * take the preset. Dashboards the editor does not list (in the base trash)
 * are sent back as stored: restoring one keeps the grant (T815).
 */
export function configToSave(draft: RoleConfig, kind: RoleKind): RoleConfig {
  const tables: RoleConfig['tables'] = {};
  for (const [id, rule] of Object.entries(draft.tables) as [
    keyof RoleConfig['tables'],
    TableRule,
  ][]) {
    if (kind === 'custom' && rule.perm === 'no_perm') continue;
    tables[id] = rule;
  }
  const dashboards: RoleConfig['dashboards'] = {};
  for (const [id, perm] of Object.entries(draft.dashboards) as [
    keyof RoleConfig['dashboards'],
    DashboardPerm,
  ][]) {
    if (kind === 'custom' && perm === 'no_perm') continue;
    dashboards[id] = perm;
  }
  return { base_rule: draft.base_rule, tables, dashboards };
}

// ---------------------------------------------------------------------------
// Dashboards (T815)

/** A dashboard of the base (outside the trash), as the editor lists it. */
export interface EditorDashboard {
  readonly id: string;
  readonly name: string;
}

/**
 * The level of the role on a dashboard, as the server resolves it (SPEC
 * §14.1, CONTRACTS §28): the admin role reads every dashboard; the system
 * editor and reader read every dashboard their config does not deny,
 * including ones created later; a custom role reads only the dashboards
 * its config lists as `read_only` — a new dashboard is not added (deny by
 * default).
 */
export function dashboardPermOf(draft: RoleConfig, kind: RoleKind, id: string): DashboardPerm {
  if (kind === 'system_admin') return 'read_only';
  const stored = (draft.dashboards as Record<string, DashboardPerm | undefined>)[id];
  return stored ?? (kind === 'custom' ? 'no_perm' : 'read_only');
}

/** Whether the dashboard levels can change: custom roles only (system roles read every dashboard). */
export function canEditDashboards(kind: RoleKind): boolean {
  return kind === 'custom';
}

/** The draft with `perm` on each of `ids` ("Read all" sets every listed dashboard). */
export function withDashboards(
  draft: RoleConfig,
  ids: readonly string[],
  perm: DashboardPerm,
): RoleConfig {
  const dashboards: RoleConfig['dashboards'] = { ...draft.dashboards };
  for (const id of ids) dashboards[id as keyof RoleConfig['dashboards']] = perm;
  return { ...draft, dashboards };
}

/** JSON with object keys sorted: two drafts are the same config when these match. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
  });
}

export function sameConfig(a: RoleConfig, b: RoleConfig, kind: RoleKind): boolean {
  return canonical(configToSave(a, kind)) === canonical(configToSave(b, kind));
}

// ---------------------------------------------------------------------------
// Ceilings and what each choice allows

/** Why a choice is off; the UI translates it. */
export type BlockReason =
  'admin_read_only' | 'editor_ceiling' | 'reader_ceiling' | 'table_read_only' | 'table_no_access';

/** The system `admin` role cannot be changed (CONTRACTS §14). */
export function isReadOnlyRole(kind: RoleKind): boolean {
  return kind === 'system_admin';
}

/** Why a table level is not offered to this role kind, or `null`. */
export function tableLevelBlock(kind: RoleKind, level: TablePerm): BlockReason | null {
  if (isReadOnlyRole(kind)) return 'admin_read_only';
  if (TABLE_RANK[level] <= TABLE_RANK[tablePermCeiling(kind)]) return null;
  return kind === 'system_reader' ? 'reader_ceiling' : 'editor_ceiling';
}

/** Why `add`/`delete` cannot be given on a table at `perm`, or `null`. */
export function operationsBlock(kind: RoleKind, perm: TablePerm): BlockReason | null {
  if (isReadOnlyRole(kind)) return 'admin_read_only';
  if (kind === 'system_reader') return 'reader_ceiling';
  if (perm === 'no_perm') return 'table_no_access';
  if (TABLE_RANK[perm] < TABLE_RANK.edit) return 'table_read_only';
  return null;
}

/** Why a field level is not offered on a table at `perm`, or `null`. */
export function fieldLevelBlock(
  kind: RoleKind,
  perm: TablePerm,
  level: FieldPerm,
): BlockReason | null {
  if (isReadOnlyRole(kind)) return 'admin_read_only';
  if (perm === 'no_perm') return 'table_no_access';
  if (FIELD_RANK[level] <= FIELD_RANK.read) return null;
  if (kind === 'system_reader') return 'reader_ceiling';
  if (perm === 'read_only') return 'table_read_only';
  return null;
}

/** Formula, lookup, button, auto number, created/updated: at most `read` (SPEC §14.1). */
export function isComputed(field: Pick<FieldDto, 'type'>): boolean {
  return COMPUTED_FIELD_TYPES.has(field.type);
}

/**
 * The permission a field ends up with under the table rule, as the server
 * resolves it: the override or the mode's default, at most `read` for a
 * computed field or a read-only table, `create` without `add` reads.
 */
export function effectiveFieldPerm(
  rule: TableRule,
  field: Pick<FieldDto, 'id' | 'type'>,
): FieldPerm {
  if (rule.perm === 'no_perm') return 'no_perm';
  const set = (rule.field_rule.fields as Record<string, FieldPerm | undefined>)[field.id];
  let perm = set ?? modeDefaultFieldPerm(rule.field_rule.mode);
  if ((isComputed(field) || rule.perm === 'read_only') && FIELD_RANK[perm] > FIELD_RANK.read) {
    perm = 'read';
  }
  if (perm === 'create' && !rule.record_rule.operations.includes('add')) perm = 'read';
  return perm;
}

/** The value a field's control shows: the override, else the mode's default (computed: at most Read). */
export function chosenFieldPerm(rule: TableRule, field: Pick<FieldDto, 'id' | 'type'>): FieldPerm {
  const set = (rule.field_rule.fields as Record<string, FieldPerm | undefined>)[field.id];
  // A computed field without a choice of its own reads (the mode default cannot widen it).
  return set ?? capComputed(field, modeDefaultFieldPerm(rule.field_rule.mode));
}

// ---------------------------------------------------------------------------
// Edits (immutable)

export function withTable(draft: RoleConfig, tableId: string, rule: TableRule): RoleConfig {
  return { ...draft, tables: { ...draft.tables, [tableId]: rule } };
}

/** Another field mode: "choose per field" starts from what each field shows now; the others drop the choices. */
export function withFieldMode(rule: TableRule, mode: FieldRuleMode, table: EditorTable): TableRule {
  if (mode === rule.field_rule.mode) return rule;
  const fields: TableRule['field_rule']['fields'] = {};
  if (mode === 'specify') {
    for (const field of table.fields) {
      fields[field.id] = capComputed(field, chosenFieldPerm(rule, field));
    }
  }
  return { ...rule, field_rule: { ...rule.field_rule, mode, fields } };
}

export function withFieldPerm(rule: TableRule, fieldId: string, perm: FieldPerm): TableRule {
  return {
    ...rule,
    field_rule: { ...rule.field_rule, fields: { ...rule.field_rule.fields, [fieldId]: perm } },
  };
}

/** A computed field's choice at most `read` (what the server would save). */
function capComputed(field: Pick<FieldDto, 'type'>, perm: FieldPerm): FieldPerm {
  return isComputed(field) && FIELD_RANK[perm] > FIELD_RANK.read ? 'read' : perm;
}

/** "Every field: <level>" of the field grid (computed fields at most Read). */
export function withAllFields(rule: TableRule, table: EditorTable, perm: FieldPerm): TableRule {
  const fields: TableRule['field_rule']['fields'] = {};
  for (const field of table.fields) fields[field.id] = capComputed(field, perm);
  return { ...rule, field_rule: { ...rule.field_rule, mode: 'specify', fields } };
}

export function toggled<T extends string>(list: readonly T[], item: T, on: boolean): T[] {
  const rest = list.filter((value) => value !== item);
  return on ? [...rest, item] : rest;
}

// ---------------------------------------------------------------------------
// Record conditions

/** Fields a table's record filters name (they are raised to `read`/`create` when saved). */
export function filterFieldIds(rule: TableRule): ReadonlySet<string> {
  return new Set<string>([
    ...collectFieldIds(rule.record_rule.edit_filter),
    ...collectFieldIds(rule.record_rule.read_filter),
  ]);
}

const NEGATIVE_LINK_OPERATORS = new Set(['has_none_of', 'is_empty']);

/**
 * Whether a record filter uses a negative condition on a link field (T710):
 * those count live linked records only, so trashing or deleting a linked
 * record changes who can read or edit (the editor warns).
 */
export function hasNegativeLinkCondition(
  filter: FilterNode | null,
  fields: readonly Pick<FieldDto, 'id' | 'type'>[],
): boolean {
  if (filter === null) return false;
  const links = new Set<string>(
    fields.filter((field) => field.type === 'link').map((field) => field.id),
  );
  let found = false;
  forEachCondition(filter, (condition) => {
    if (links.has(condition.field) && NEGATIVE_LINK_OPERATORS.has(condition.operator)) found = true;
  });
  return found;
}

/** Why the draft cannot be saved yet, per table (the editor shows it there). */
export type DraftIssue = 'filter_invalid' | 'filter_incomplete' | 'read_filter_missing';

export interface FilterState {
  readonly valid: boolean;
  readonly incomplete: number;
}

/** Issues of the draft: a filter being edited is invalid or incomplete, `read_scope = filter` without one. */
export function draftIssues(
  draft: RoleConfig,
  filters: ReadonlyMap<string, FilterState>,
): Map<string, DraftIssue[]> {
  const issues = new Map<string, DraftIssue[]>();
  const add = (tableId: string, issue: DraftIssue) => {
    issues.set(tableId, [...(issues.get(tableId) ?? []), issue]);
  };
  for (const [tableId, rule] of Object.entries(draft.tables) as [string, TableRule][]) {
    if (rule.perm === 'no_perm') continue;
    for (const key of ['edit_filter', 'read_filter'] as const) {
      const state = filters.get(`${tableId}:${key}`);
      if (state === undefined) continue;
      if (!state.valid) add(tableId, 'filter_invalid');
      else if (state.incomplete > 0) add(tableId, 'filter_incomplete');
    }
    if (rule.record_rule.read_scope === 'filter' && rule.record_rule.read_filter === null) {
      add(tableId, 'read_filter_missing');
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Adjustments of the last save

export interface PlacedAdjustments {
  /** Table-level adjustments (ceilings, operations), by table. */
  readonly tables: ReadonlyMap<string, readonly RoleAdjustmentDto[]>;
  /** Field adjustments, by `tableId:fieldId`. */
  readonly fields: ReadonlyMap<string, readonly RoleAdjustmentDto[]>;
  /** Field adjustments, counted by table (the matrix row says how many). */
  readonly fieldCounts: ReadonlyMap<string, number>;
}

/** Where each adjustment of a save is shown: beside its table, or beside its field. */
export function placeAdjustments(adjustments: readonly RoleAdjustmentDto[]): PlacedAdjustments {
  const tables = new Map<string, RoleAdjustmentDto[]>();
  const fields = new Map<string, RoleAdjustmentDto[]>();
  const fieldCounts = new Map<string, number>();
  for (const item of adjustments) {
    if (item.field_id === null) {
      tables.set(item.table_id, [...(tables.get(item.table_id) ?? []), item]);
      continue;
    }
    const key = `${item.table_id}:${item.field_id}`;
    fields.set(key, [...(fields.get(key) ?? []), item]);
    fieldCounts.set(item.table_id, (fieldCounts.get(item.table_id) ?? 0) + 1);
  }
  return { tables, fields, fieldCounts };
}

/** The visible views a rule lists (`null` = every view). */
export function visibleViewsOf(rule: TableRule): readonly string[] | null {
  return rule.view_rule.visible_views;
}
