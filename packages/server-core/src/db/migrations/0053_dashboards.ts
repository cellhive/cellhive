import { sql, type Kysely } from 'kysely';

/**
 * Migration 0053 (BACKLOG T805; ADR-38, SPEC §5.10, §10, CONTRACTS §28.1–28.2):
 * dashboards and their widgets — the only migration of S7.
 *
 * `meta.dashboards` holds one dashboard of a base:
 *
 * - `name` is unique in its base ignoring case among dashboards outside the
 *   trash (`dashboards_base_name_key`); `position` orders the list;
 * - `theme` and `global_filters` are JSON documents checked by the API
 *   (zod, CONTRACTS §28.1);
 * - `version` grows with every change of the dashboard, its layout or its
 *   widgets (`If-Match` / `version`, `409 VERSION_CONFLICT`);
 * - `deleted_at` / `deleted_by`: the trash of the base (30 days, then
 *   `maintenance.cleanup` deletes the row and its widgets).
 *
 * `meta.dashboard_widgets` holds the widgets of a dashboard. The layout is
 * on the widget (`layout {x, y, w, h}` of a 12-column grid, BACKLOG
 * "Quyết định S7" #5), never on the dashboard: deleting a widget leaves no
 * layout entry behind. Widgets go with their dashboard (`ON DELETE
 * CASCADE`), dashboards with their base.
 *
 * Tenant references are composite with `organization_id` (SPEC §5.10, T501
 * catalog test). Self-contained: no object of another migration than
 * 0001/0003 is used. Forward-only (AGENTS.md rule 9); this file is locked
 * by `migrations.lock.json` once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.dashboards (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     base_id text NOT NULL,
     name text NOT NULL,
     icon text,
     description text,
     theme jsonb NOT NULL DEFAULT '{}'::jsonb,
     global_filters jsonb NOT NULL DEFAULT '[]'::jsonb,
     position integer NOT NULL DEFAULT 0,
     version integer NOT NULL DEFAULT 1,
     created_by text NOT NULL,
     deleted_at timestamptz,
     deleted_by text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT dashboards_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT dashboards_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT dashboards_created_by_fkey FOREIGN KEY (created_by) REFERENCES meta.users (id),
     CONSTRAINT dashboards_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES meta.users (id),
     CONSTRAINT dashboards_id_check CHECK (id LIKE 'dsh\\_%'),
     CONSTRAINT dashboards_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
     CONSTRAINT dashboards_icon_check CHECK (icon IS NULL OR char_length(icon) BETWEEN 1 AND 64),
     CONSTRAINT dashboards_description_check
       CHECK (description IS NULL OR char_length(description) <= 2000),
     CONSTRAINT dashboards_theme_check CHECK (jsonb_typeof(theme) = 'object'),
     CONSTRAINT dashboards_global_filters_check CHECK (jsonb_typeof(global_filters) = 'array'),
     CONSTRAINT dashboards_version_check CHECK (version >= 1),
     CONSTRAINT dashboards_deleted_check
       CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL)
   )`,
  `CREATE UNIQUE INDEX dashboards_base_name_key
     ON meta.dashboards (organization_id, base_id, lower(name)) WHERE deleted_at IS NULL`,
  `CREATE INDEX dashboards_base_position_idx
     ON meta.dashboards (organization_id, base_id, position) WHERE deleted_at IS NULL`,
  // The trash of a base and the 30-day purge.
  `CREATE INDEX dashboards_trash_idx
     ON meta.dashboards (deleted_at) WHERE deleted_at IS NOT NULL`,
  `CREATE TRIGGER dashboards_set_updated_at BEFORE UPDATE ON meta.dashboards
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,

  `CREATE TABLE meta.dashboard_widgets (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     dashboard_id text NOT NULL,
     type text NOT NULL,
     title text NOT NULL DEFAULT '',
     config jsonb NOT NULL DEFAULT '{}'::jsonb,
     layout jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT dashboard_widgets_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT dashboard_widgets_dashboard_fkey FOREIGN KEY (organization_id, dashboard_id)
       REFERENCES meta.dashboards (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT dashboard_widgets_id_check CHECK (id LIKE 'wgt\\_%'),
     CONSTRAINT dashboard_widgets_type_check CHECK (
       type IN ('kpi', 'bar', 'line', 'pie', 'combo', 'table', 'text', 'filter_control')),
     CONSTRAINT dashboard_widgets_title_check CHECK (char_length(title) <= 200),
     CONSTRAINT dashboard_widgets_config_check CHECK (jsonb_typeof(config) = 'object'),
     CONSTRAINT dashboard_widgets_layout_check CHECK (jsonb_typeof(layout) = 'object')
   )`,
  `CREATE INDEX dashboard_widgets_dashboard_idx
     ON meta.dashboard_widgets (organization_id, dashboard_id)`,
  `CREATE TRIGGER dashboard_widgets_set_updated_at BEFORE UPDATE ON meta.dashboard_widgets
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
