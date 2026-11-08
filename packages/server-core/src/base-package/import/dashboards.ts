import {
  checkLayout,
  createDashboardRequestSchema,
  MAX_DASHBOARDS_PER_BASE,
  MAX_WIDGET_TITLE_LENGTH,
  MAX_WIDGETS_PER_DASHBOARD,
  WIDGET_CONFIG_SCHEMAS,
  widgetLayoutSchema,
  type GridItem,
  type Id,
  type WidgetType,
} from '@cellhive/contracts';

import { isComputedRow } from '../../computed/definition/definition.js';
import {
  buildWidgetConfig,
  checkGlobalFilters,
  widgetBrokenReasonOf,
  type SiblingWidget,
  type WidgetTableMeta,
} from '../../dashboards/widget-config.js';
import { AppError } from '../../errors/app-error.js';
import { SCHEMA_ENTRIES } from '../entries.js';
import { packageProblem } from '../errors.js';
import { packageDashboardSchema, type PackageDashboard } from '../manifest.js';
import { PackageLocation } from '../references.js';

import { mentionsAny } from './phantoms.js';
import { asDefinition, checkDefinition } from './pipeline.js';

import type { BaseImportContext } from './pipeline.js';
import type { ImportDashboardInput } from './target.js';
import type { BaseSchemaRows } from '../../computed/definition/schema-rows.js';
import type { JsonObject } from '../../db/schema.js';

/**
 * Dashboards of a `.chbase` import (T1019): every dashboard of the package
 * is a shared one. Each is checked as when it is saved — name (unique per
 * base, case-insensitive), icon, description, theme, global filters
 * against the tables and fields of the new base, at most
 * `MAX_DASHBOARDS_PER_BASE` — and so is each widget (at most
 * `MAX_WIDGETS_PER_DASHBOARD`, the layout on the 12-column grid without
 * overlaps, the config by type against the base, `filter_bindings` naming
 * filter controls of the same dashboard: `buildWidgetConfig`). A widget
 * naming a table or field the new base does not have (an id of
 * `missing_ids`) is kept `broken` as at the source, its config checked for
 * its shape only; a global filter target naming one is left out.
 */

/** The active tables of the new base and their active fields, as widget checks read them. */
export function widgetTablesOf(rows: BaseSchemaRows): Map<string, WidgetTableMeta> {
  const tables = new Map<string, WidgetTableMeta>();
  for (const table of rows.tables) {
    tables.set(table.id, {
      id: table.id,
      fields: rows.fields
        .filter((field) => field.table_id === table.id && field.deleted_at === null)
        .map((field) => ({
          id: field.id,
          name: field.name,
          type: field.type,
          options: field.options,
          ...(isComputedRow(field) ? { result_type: field.result_type } : {}),
        })),
    });
  }
  return tables;
}

/** Global filters without the targets naming a phantom; filters left without a target go. */
function withoutPhantomTargets(filters: readonly unknown[], phantoms: ReadonlySet<string>) {
  if (phantoms.size === 0) return filters;
  return filters.flatMap((filter) => {
    if (typeof filter !== 'object' || filter === null) return [filter];
    const targets = (filter as { targets?: unknown }).targets;
    if (!Array.isArray(targets)) return [filter];
    const kept = targets.filter((item: unknown) => !mentionsAny(item, phantoms));
    return kept.length === 0 ? [] : [{ ...filter, targets: kept }];
  });
}

/** The checked input of one dashboard of the package (`index` in `schema/dashboards.json`). */
export function importedDashboard(
  dashboard: PackageDashboard,
  rank: number,
  at: PackageLocation,
  tables: ReadonlyMap<string, WidgetTableMeta>,
  phantoms: ReadonlySet<string>,
): ImportDashboardInput {
  const parsed = checkDefinition(at.toString(), () => {
    const result = createDashboardRequestSchema.safeParse({
      name: dashboard.name,
      icon: dashboard.icon,
      description: dashboard.description,
      theme: dashboard.theme,
      global_filters: withoutPhantomTargets(dashboard.global_filters, phantoms),
    });
    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', { detail: 'The dashboard is not valid.' });
    }
    return result.data;
  });
  const globalFilters = checkDefinition(at.at('global_filters').toString(), () =>
    checkGlobalFilters(parsed.global_filters, tables),
  );
  if (dashboard.widgets.length > MAX_WIDGETS_PER_DASHBOARD) {
    throw packageProblem(
      'INVALID_DEFINITION',
      at.at('widgets').toString(),
      'A dashboard has more widgets than this instance allows.',
      { limit: MAX_WIDGETS_PER_DASHBOARD },
    );
  }
  const items: GridItem[] = [];
  const widgets = dashboard.widgets.map((widget, index) => {
    const widgetAt = at.at('widgets', index);
    const layout = widgetLayoutSchema.safeParse(widget.layout);
    if (!layout.success) {
      throw packageProblem(
        'INVALID_DEFINITION',
        widgetAt.at('layout').toString(),
        'The layout of a widget is not valid.',
      );
    }
    items.push({ id: widget.id, ...layout.data });
    if (widget.title.trim().length > MAX_WIDGET_TITLE_LENGTH) {
      throw packageProblem(
        'INVALID_DEFINITION',
        widgetAt.at('title').toString(),
        'The title of a widget is too long.',
      );
    }
    const siblings = new Map<string, SiblingWidget>(
      dashboard.widgets
        .filter((other) => other.id !== widget.id)
        .map((other) => [other.id, { type: other.type, config: other.config }]),
    );
    const type: WidgetType = widget.type;
    const config = checkDefinition(widgetAt.at('config').toString(), () => {
      // A widget the source already had broken stays broken: its shape only.
      if (widgetBrokenReasonOf(type, widget.config, tables) !== null) {
        const shape = WIDGET_CONFIG_SCHEMAS[type].safeParse(widget.config);
        if (!shape.success) {
          throw new AppError('VALIDATION_FAILED', { detail: 'The widget config is not valid.' });
        }
        return shape.data;
      }
      return buildWidgetConfig(type, widget.config, { tables, siblings, widgetId: widget.id });
    });
    return {
      id: widget.id,
      type,
      title: widget.title.trim(),
      config: config as unknown as JsonObject,
      layout: { ...layout.data },
    };
  });
  if (checkLayout(items).length > 0) {
    throw packageProblem(
      'INVALID_DEFINITION',
      at.at('widgets').toString(),
      'Widgets of a dashboard overlap or leave the grid.',
    );
  }
  return {
    id: dashboard.id,
    name: parsed.name,
    icon: parsed.icon,
    description: parsed.description,
    theme: parsed.theme as JsonObject,
    globalFilters: globalFilters,
    position: rank,
    widgets,
  };
}

/** Creates the dashboards of the package; returns their ids (new base). */
export async function importDashboards(
  context: BaseImportContext,
  rows: BaseSchemaRows,
  phantoms: ReadonlySet<string>,
  tick: () => Promise<void>,
): Promise<Id<'dsh'>[]> {
  const { plan, baseId, target, report } = context;
  const root = PackageLocation.of(SCHEMA_ENTRIES.dashboards).at('dashboards');
  const dashboards = plan.deferred.dashboards.map((value, index) => {
    const parsed = packageDashboardSchema.safeParse(value);
    if (!parsed.success) {
      throw packageProblem(
        'INVALID_DEFINITION',
        root.at(index).toString(),
        'A dashboard is malformed.',
      );
    }
    return { dashboard: parsed.data, index };
  });
  if (dashboards.length > MAX_DASHBOARDS_PER_BASE) {
    throw packageProblem(
      'INVALID_DEFINITION',
      root.toString(),
      'The package has more dashboards than a base may have.',
      { limit: MAX_DASHBOARDS_PER_BASE },
    );
  }
  dashboards.sort((a, b) => a.dashboard.position - b.dashboard.position || a.index - b.index);
  const tables = widgetTablesOf(rows);
  const names = new Set<string>();
  const created: Id<'dsh'>[] = [];
  for (const [rank, { dashboard, index }] of dashboards.entries()) {
    const at = root.at(index);
    const input = importedDashboard(dashboard, rank, at, tables, phantoms);
    if (names.has(input.name.toLowerCase())) {
      throw packageProblem(
        'INVALID_DEFINITION',
        at.at('name').toString(),
        'Two dashboards of the package have one name.',
      );
    }
    names.add(input.name.toLowerCase());
    await target.checkpoint();
    await asDefinition(at.toString(), () => target.createDashboard(baseId, input));
    created.push(input.id);
    report.dashboards += 1;
    report.widgets += input.widgets.length;
    await tick();
  }
  return created;
}
