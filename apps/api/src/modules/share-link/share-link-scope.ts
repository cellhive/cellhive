import {
  DEFAULT_SHARE_LINK_SETTINGS,
  shareLinkSettingsSchema,
  type Id,
  type ShareLinkSettings,
  type ShareLinkTargetType,
} from '@cellhive/contracts';
import {
  storedViewConfigOf,
  widgetReferencesOf,
  type DashboardRow,
  type DashboardWidgetRow,
  type JsonValue,
  type ViewRow,
} from '@cellhive/server-core';

import type { FilterNode, ShareLinkScope } from '@cellhive/permissions';

/** `target_type` of a link to this view: forms are `form`, grid/kanban views `view`. */
export function targetTypeOf(
  view: Pick<ViewRow, 'type'>,
): Exclude<ShareLinkTargetType, 'dashboard'> {
  return view.type === 'form' ? 'form' : 'view';
}

/** What a link to `view` may reach, from the view's current config (SPEC §15A.2). */
export function shareLinkScopeOf(view: ViewRow): ShareLinkScope {
  const config = storedViewConfigOf(view.type, view.config);
  if (view.type === 'form') {
    return {
      kind: 'form',
      tableId: view.table_id,
      viewId: view.id,
      formFields: (config.form?.fields ?? []).map((item) => item.field as Id<'fld'>),
    };
  }
  return {
    kind: 'view',
    tableId: view.table_id,
    viewId: view.id,
    // Validated as a filter DSL when the view was saved (T301).
    filter: config.filter as FilterNode | null,
    hiddenFields: config.hidden_fields as Id<'fld'>[],
  };
}

/**
 * What a link to a dashboard may reach (SPEC §15A.2, BACKLOG T809): the
 * tables its data widgets and filter controls read and those its global
 * filters target. Fields and record rules are the creator's
 * (`resolveShareLinkAccess`); only the widgets of the dashboard ever run.
 */
export function dashboardShareScopeOf(
  dashboard: Pick<DashboardRow, 'id' | 'global_filters'>,
  widgets: readonly Pick<DashboardWidgetRow, 'type' | 'config'>[],
): ShareLinkScope {
  const tableIds = new Set<Id<'tbl'>>();
  for (const widget of widgets) {
    const { tableId } = widgetReferencesOf(widget.type, widget.config);
    if (tableId !== null) tableIds.add(tableId as Id<'tbl'>);
  }
  for (const target of globalFilterTargetsOf(dashboard.global_filters)) {
    tableIds.add(target.table_id);
  }
  return { kind: 'dashboard', dashboardId: dashboard.id, tableIds: [...tableIds].sort() };
}

/** `{ table_id, field }` of each target of the stored global filters (malformed ones left out). */
export function globalFilterTargetsOf(
  json: JsonValue,
): { readonly table_id: Id<'tbl'>; readonly field: Id<'fld'> }[] {
  if (!Array.isArray(json)) return [];
  const out: { table_id: Id<'tbl'>; field: Id<'fld'> }[] = [];
  for (const filter of json) {
    const targets = objectOf(filter)['targets'];
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
      const { table_id: tableId, field } = objectOf(target);
      if (typeof tableId === 'string' && typeof field === 'string') {
        out.push({ table_id: tableId as Id<'tbl'>, field: field as Id<'fld'> });
      }
    }
  }
  return out;
}

/** Stored settings completed with the defaults (older or partial rows never break a read). */
export function storedSettingsOf(json: JsonValue): ShareLinkSettings {
  const value = typeof json === 'object' && json !== null && !Array.isArray(json) ? json : {};
  const merged = {
    ...DEFAULT_SHARE_LINK_SETTINGS,
    ...value,
    embed: { ...DEFAULT_SHARE_LINK_SETTINGS.embed, ...objectOf(value['embed']) },
    dashboard: { ...DEFAULT_SHARE_LINK_SETTINGS.dashboard, ...objectOf(value['dashboard']) },
  };
  const parsed = shareLinkSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SHARE_LINK_SETTINGS);
}

function objectOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
