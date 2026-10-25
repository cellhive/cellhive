import { validateFilter, type FilterFieldMeta, type FilterIssue } from '@cellhive/filter-dsl';

import { normalizeRoleConfig, type RoleAdjustment } from './normalize.js';
import { roleConfigSchema, type RoleConfig, type RoleKind, type TableRule } from './role-config.js';

import type { FieldMeta, SchemaMeta } from './schema-meta.js';
import type { Id, TableAccess } from '@cellhive/contracts';
import type { z } from 'zod';

/** A field as role validation needs it: permission meta plus what filters check. */
export interface RoleFieldMeta extends FieldMeta {
  readonly name: string;
  readonly type: FilterFieldMeta['type'];
  /** Raw `meta.fields.options` (select options for filter values). */
  readonly options?: unknown;
}

export interface RoleTableMeta {
  readonly id: Id<'tbl'>;
  readonly fields: readonly RoleFieldMeta[];
  /**
   * Shared views of the table: `view_rule.visible_views` may only name
   * these (BACKLOG T301). Unchecked when omitted.
   */
  readonly views?: readonly Id<'viw'>[];
}

/** The base's active tables and fields a role config is validated against. */
export interface RoleSchemaMeta extends SchemaMeta {
  readonly tables: readonly RoleTableMeta[];
  /**
   * Ids among the `visible_views` entries that name an existing view
   * (shared or personal, of any table). Entries outside `views` of their
   * table and outside this set name a deleted or never existing view and
   * are dropped silently (roles saved before T301 may hold them); other
   * wrong entries are `UNKNOWN_VIEW`. When omitted every wrong entry is
   * `UNKNOWN_VIEW`.
   */
  readonly existingViews?: ReadonlySet<string>;
}

/** Detail codes (`errors[].code` of `422 VALIDATION_FAILED`) for role configs. */
export const ROLE_CONFIG_ISSUE_CODES = ['UNKNOWN_TABLE', 'UNKNOWN_FIELD', 'UNKNOWN_VIEW'] as const;
export type RoleConfigIssueCode = (typeof ROLE_CONFIG_ISSUE_CODES)[number];

export interface RoleConfigIssue {
  path: string;
  code: RoleConfigIssueCode;
  message: string;
}

export type PrepareRoleConfigResult =
  | { readonly ok: true; readonly config: RoleConfig; readonly adjustments: RoleAdjustment[] }
  /** The config does not match `roleConfigSchema`; zod issues, paths under the root. */
  | { readonly ok: false; readonly error: 'schema'; readonly issues: readonly z.core.$ZodIssue[] }
  /** A table or field ID is not part of the base (`VALIDATION_FAILED`). */
  | { readonly ok: false; readonly error: 'reference'; readonly issues: RoleConfigIssue[] }
  /** A record filter does not validate against its table (`INVALID_FILTER`). */
  | { readonly ok: false; readonly error: 'filter'; readonly issues: FilterIssue[] };

export interface PrepareRoleConfigOptions {
  /** Role kind: system `editor`/`reader` ceilings apply. */
  readonly kind: RoleKind;
  /** Prefix of every issue path. Default `config`. */
  readonly path?: string;
}

function join(base: string, key: string): string {
  if (key === '') return base;
  if (base === '') return key;
  return key.startsWith('[') ? `${base}${key}` : `${base}.${key}`;
}

function checkFieldRefs(
  tablePath: string,
  rule: TableRule,
  fieldIds: ReadonlySet<string>,
  issues: RoleConfigIssue[],
): void {
  const unknown = (path: string) => {
    issues.push({ path, code: 'UNKNOWN_FIELD', message: 'The field does not exist in the table' });
  };
  const fieldRule = rule.field_rule;
  for (const fieldId of Object.keys(fieldRule.fields)) {
    if (!fieldIds.has(fieldId)) unknown(`${tablePath}.field_rule.fields.${fieldId}`);
  }
  for (const key of ['option_edit_fields', 'file_download_fields'] as const) {
    fieldRule[key].forEach((fieldId, index) => {
      if (!fieldIds.has(fieldId)) unknown(`${tablePath}.field_rule.${key}[${String(index)}]`);
    });
  }
}

/**
 * Validates a role config sent by a client and prepares it for storage
 * (SPEC §14.1, BACKLOG T109):
 *
 * 1. shape and defaults by `roleConfigSchema`;
 * 2. every table is an active table of the base, every field of a field
 *    rule belongs to its table, and `visible_views` names shared views of
 *    the table when `schema` lists them (dashboards are not checked until
 *    they exist, S7);
 * 3. `edit_filter`/`read_filter` validate against the table like any
 *    filter (`validateFilter`: all fields of the table are visible to the
 *    admin saving the role, link fields included since T710 — by the id of
 *    linked records only) and are stored in their normalised form;
 * 4. `normalizeRoleConfig` applies the automatic adjustments, which are
 *    returned so the UI can show why.
 */
export function prepareRoleConfig(
  input: unknown,
  schema: RoleSchemaMeta,
  options: PrepareRoleConfigOptions,
): PrepareRoleConfigResult {
  const root = options.path ?? 'config';
  const parsed = roleConfigSchema.safeParse(input, { reportInput: true });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ ...issue, path: [root, ...issue.path] }));
    return { ok: false, error: 'schema', issues };
  }
  const config = parsed.data;

  const tablesById = new Map(schema.tables.map((table) => [table.id, table]));
  const referenceIssues: RoleConfigIssue[] = [];
  for (const [tableId, rule] of Object.entries(config.tables) as [Id<'tbl'>, TableRule][]) {
    const tablePath = `${root}.tables.${tableId}`;
    const table = tablesById.get(tableId);
    if (table === undefined) {
      referenceIssues.push({
        path: tablePath,
        code: 'UNKNOWN_TABLE',
        message: 'The table does not exist in the base',
      });
      continue;
    }
    checkFieldRefs(
      tablePath,
      rule,
      new Set(table.fields.map((field) => field.id)),
      referenceIssues,
    );
    const visibleViews = rule.view_rule.visible_views;
    if (table.views !== undefined && visibleViews !== null) {
      const views = new Set<string>(table.views);
      const existing = schema.existingViews;
      const gone = (viewId: string) =>
        existing !== undefined && !views.has(viewId) && !existing.has(viewId);
      visibleViews.forEach((viewId, index) => {
        if (views.has(viewId) || gone(viewId)) return;
        referenceIssues.push({
          path: `${tablePath}.view_rule.visible_views[${String(index)}]`,
          code: 'UNKNOWN_VIEW',
          message: 'The view is not a shared view of the table',
        });
      });
      rule.view_rule.visible_views = visibleViews.filter((viewId) => !gone(viewId));
    }
  }
  if (referenceIssues.length > 0) return { ok: false, error: 'reference', issues: referenceIssues };

  const filterIssues: FilterIssue[] = [];
  for (const [tableId, rule] of Object.entries(config.tables) as [Id<'tbl'>, TableRule][]) {
    const table = tablesById.get(tableId);
    if (table === undefined) continue;
    // Link fields count (T710, CONTRACTS §14): link operators by record id
    // (`$var` and text operators on a link are `INVALID_FILTER`).
    const meta = { fields: table.fields };
    const allFields = table.fields.map((field) => field.id);
    for (const key of ['edit_filter', 'read_filter'] as const) {
      const filter = rule.record_rule[key];
      if (filter === null) continue;
      const result = validateFilter(filter, meta, allFields);
      if (result.ok) {
        rule.record_rule[key] = result.ast;
        continue;
      }
      const prefix = `${root}.tables.${tableId}.record_rule.${key}`;
      for (const issue of result.errors) {
        filterIssues.push({ ...issue, path: join(prefix, issue.path) });
      }
    }
  }
  if (filterIssues.length > 0) return { ok: false, error: 'filter', issues: filterIssues };

  const normalized = normalizeRoleConfig(config, schema, { kind: options.kind });
  return { ok: true, config: normalized.config, adjustments: normalized.adjustments };
}

/**
 * Whether a view may be queried under `view_rule.visible_views` (SPEC §14.1,
 * CONTRACTS §5 P16): `null` = every view. A hidden view is answered exactly
 * like a missing one (`404`).
 */
export function isViewVisible(access: Pick<TableAccess, 'view_rule'>, viewId: string): boolean {
  const visible = access.view_rule.visible_views;
  return visible === null || (visible as readonly string[]).includes(viewId);
}
