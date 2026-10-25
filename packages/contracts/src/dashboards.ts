import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import {
  colorSchema,
  filterControlKindSchema,
  widgetLayoutSchema,
  widgetSchema,
} from './dashboard-widgets.js';
import { idOf } from './ids.js';

/**
 * Dashboards (SPEC §10, CONTRACTS §28.1, BACKLOG T805; ADR-38). A base has
 * up to 50 dashboards; base owners and admins create and change them,
 * system editors/readers see every dashboard and custom roles the ones
 * marked `read_only` in `dashboards` (deny by default — "Quyết định S7" #4).
 */

// --- Limits (CONTRACTS §28.7) ------------------------------------------------------------

export const MAX_DASHBOARDS_PER_BASE = 50;
export const MAX_DASHBOARD_NAME_LENGTH = 100;
export const MAX_DASHBOARD_DESCRIPTION_LENGTH = 2000;
export const MAX_DASHBOARD_ICON_LENGTH = 64;
/** Days a deleted dashboard stays in the base trash (like tables). */
export const DASHBOARD_TRASH_RETENTION_DAYS = 30;
/** Global filters of one dashboard, and tables each one applies to. */
export const MAX_GLOBAL_FILTERS = 10;
export const MAX_GLOBAL_FILTER_TARGETS = 20;
/** Palette colors of a theme. */
export const MAX_THEME_PALETTE = 12;

/** `VALIDATION_FAILED` detail code: the base already has `MAX_DASHBOARDS_PER_BASE` dashboards. */
export const DASHBOARD_LIMIT_EXCEEDED = 'DASHBOARD_LIMIT_EXCEEDED';

// --- Building blocks ---------------------------------------------------------------------

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DASHBOARD_NAME_LENGTH)
  .meta({ description: 'Unique in the base, ignoring case (1–100 characters)' });
const iconSchema = z.string().trim().min(1).max(MAX_DASHBOARD_ICON_LENGTH);
const descriptionSchema = z.string().max(MAX_DASHBOARD_DESCRIPTION_LENGTH);
const versionSchema = z.int().min(1);

/** Look of a dashboard (SPEC §10.1). Unset keys use the app defaults. */
export const dashboardThemeSchema = z
  .strictObject({
    mode: z.enum(['light', 'dark', 'system']).optional(),
    background: colorSchema.nullable().optional(),
    palette: z.array(colorSchema).min(1).max(MAX_THEME_PALETTE).nullable().optional(),
    density: z.enum(['compact', 'comfortable']).optional(),
  })
  .meta({ id: 'DashboardTheme' });
export type DashboardTheme = z.infer<typeof dashboardThemeSchema>;

/**
 * A filter of the whole dashboard (SPEC §10.3): the viewer picks a value and
 * every widget on one of `targets`' tables is filtered on that field
 * (applied from T808).
 */
export const dashboardGlobalFilterSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/u)
      .meta({ description: 'Unique in the dashboard' }),
    label: z.string().trim().max(100).nullable().default(null),
    kind: filterControlKindSchema,
    targets: z
      .array(z.strictObject({ table_id: idOf('tbl'), field: idOf('fld') }))
      .min(1)
      .max(MAX_GLOBAL_FILTER_TARGETS)
      .meta({ description: 'One field per table; the field must fit `kind`' }),
  })
  .meta({ id: 'DashboardGlobalFilter' });
export type DashboardGlobalFilter = z.infer<typeof dashboardGlobalFilterSchema>;

export const dashboardGlobalFiltersSchema = z
  .array(dashboardGlobalFilterSchema)
  .max(MAX_GLOBAL_FILTERS)
  .superRefine((filters, context) => {
    const seen = new Set<string>();
    for (const [index, filter] of filters.entries()) {
      if (seen.has(filter.id)) {
        context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate id' });
      }
      seen.add(filter.id);
      const tables = new Set<string>();
      for (const [target, item] of filter.targets.entries()) {
        if (tables.has(item.table_id)) {
          context.addIssue({
            code: 'custom',
            path: [index, 'targets', target, 'table_id'],
            message: 'One target per table',
          });
        }
        tables.add(item.table_id);
      }
    }
  });

const personSchema = z.strictObject({ id: idOf('usr'), name: z.string() }).nullable();

// --- DTOs --------------------------------------------------------------------------------

/** A dashboard in a list (no widgets). */
export const dashboardSummarySchema = z
  .strictObject({
    id: idOf('dsh'),
    base_id: idOf('bse'),
    name: z.string(),
    icon: z.string().nullable(),
    description: z.string().nullable(),
    position: z.int().min(0),
    version: versionSchema,
    widget_count: z.int().min(0),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'DashboardSummary' });
export type DashboardSummaryDto = z.infer<typeof dashboardSummarySchema>;

/** `GET /dashboards/:dashboardId`: the dashboard and its widgets. */
export const dashboardSchema = z
  .strictObject({
    id: idOf('dsh'),
    base_id: idOf('bse'),
    name: z.string(),
    icon: z.string().nullable(),
    description: z.string().nullable(),
    theme: dashboardThemeSchema,
    global_filters: z.array(dashboardGlobalFilterSchema),
    position: z.int().min(0),
    version: versionSchema.meta({
      description:
        'Bumped by every change of the dashboard, its layout or its widgets; send it back ' +
        '(`If-Match` or `version`) to avoid lost updates',
    }),
    created_by: personSchema,
    widgets: z.array(widgetSchema).meta({ description: 'In reading order (row, then column)' }),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'Dashboard' });
export type DashboardDto = z.infer<typeof dashboardSchema>;

export const dashboardListSchema = z
  .strictObject({ items: z.array(dashboardSummarySchema) })
  .meta({ id: 'DashboardList', description: 'The dashboards the caller can see, by position' });
export type DashboardList = z.infer<typeof dashboardListSchema>;

/** A dashboard in the base trash. */
export const trashedDashboardSchema = z
  .strictObject({
    id: idOf('dsh'),
    base_id: idOf('bse'),
    name: z.string(),
    icon: z.string().nullable(),
    widget_count: z.int().min(0),
    deleted_at: isoDateTimeSchema,
    deleted_by: personSchema,
    purge_at: isoDateTimeSchema.meta({
      description: 'When it is deleted for good (30 days after `deleted_at`)',
    }),
  })
  .meta({ id: 'TrashedDashboard' });
export type TrashedDashboardDto = z.infer<typeof trashedDashboardSchema>;

export const dashboardTrashSchema = z
  .strictObject({ items: z.array(trashedDashboardSchema) })
  .meta({ id: 'DashboardTrash', description: 'Most recently deleted first' });
export type DashboardTrash = z.infer<typeof dashboardTrashSchema>;

// --- Requests ----------------------------------------------------------------------------

export const createDashboardRequestSchema = z
  .strictObject({
    name: nameSchema,
    icon: iconSchema.nullable().default(null),
    description: descriptionSchema.nullable().default(null),
    theme: dashboardThemeSchema.default({}),
    global_filters: dashboardGlobalFiltersSchema.default([]),
  })
  .meta({ id: 'CreateDashboardRequest' });
export type CreateDashboardRequest = z.infer<typeof createDashboardRequestSchema>;

export const updateDashboardRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    icon: iconSchema.nullable().optional(),
    description: descriptionSchema.nullable().optional(),
    theme: dashboardThemeSchema.optional().meta({ description: 'The whole new theme' }),
    global_filters: dashboardGlobalFiltersSchema.optional(),
    position: z
      .int()
      .min(0)
      .optional()
      .meta({ description: 'New index in the base list (clamped)' }),
    version: versionSchema.optional().meta({
      description: 'Expected current version (same as `If-Match`); a mismatch is `409`',
    }),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.icon !== undefined ||
      body.description !== undefined ||
      body.theme !== undefined ||
      body.global_filters !== undefined ||
      body.position !== undefined,
    { message: 'Send at least one setting', path: [] },
  )
  .meta({ id: 'UpdateDashboardRequest' });
export type UpdateDashboardRequest = z.infer<typeof updateDashboardRequestSchema>;

export const duplicateDashboardRequestSchema = z
  .strictObject({
    name: nameSchema.optional().meta({
      description:
        'Default: the source name followed by ` (copy)` / ` (bản sao)` in the caller’s ' +
        'language (then ` 2`, ` 3`… while taken)',
    }),
  })
  .meta({ id: 'DuplicateDashboardRequest' });
export type DuplicateDashboardRequest = z.infer<typeof duplicateDashboardRequestSchema>;

/** `PUT /dashboards/:dashboardId/layout`: the place of every widget, in one write. */
export const updateDashboardLayoutRequestSchema = z
  .strictObject({
    layout: z
      .record(idOf('wgt'), widgetLayoutSchema)
      .meta({ description: 'Every widget of the dashboard → its place' }),
    version: versionSchema.optional(),
  })
  .meta({ id: 'UpdateDashboardLayoutRequest' });
export type UpdateDashboardLayoutRequest = z.infer<typeof updateDashboardLayoutRequestSchema>;

/** Optional `If-Match` of the mutating dashboard and widget routes. */
export const dashboardIfMatchHeaderSchema = z.object({
  'if-match': z
    .string()
    .regex(/^(?:W\/)?"?\d{1,10}"?$/u, { message: 'Expected the dashboard version' })
    .optional()
    .meta({
      description: 'Expected dashboard `version`, e.g. `"3"`; a mismatch is `409 VERSION_CONFLICT`',
    }),
});
