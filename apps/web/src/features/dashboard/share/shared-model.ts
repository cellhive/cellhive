import type {
  DashboardDto,
  FieldDto,
  SharedDashboardDto,
  WidgetDataDto,
  WidgetDto,
  WidgetOptionsDto,
} from '@cellhive/contracts';

/**
 * (T814) A dashboard read through a share link (`GET /shares/:token/dashboard`,
 * CONTRACTS §16A) in the shape the dashboard components draw: no base,
 * creator or version (nothing about the organization comes through the
 * link), widgets whose table or field the link cannot read keep an empty
 * config — their numbers are answered `no_permission` without a request.
 */
export function sharedDashboardDto(shared: SharedDashboardDto): DashboardDto {
  const { dashboard } = shared;
  return {
    id: dashboard.id,
    base_id: '' as DashboardDto['base_id'],
    name: dashboard.name,
    icon: dashboard.icon,
    description: dashboard.description,
    theme: dashboard.theme,
    global_filters: dashboard.global_filters,
    position: 0,
    version: 1,
    // Nothing about the creator comes through a link.
    created_by: null,
    widgets: shared.widgets.map((widget): WidgetDto => ({
      id: widget.id,
      dashboard_id: dashboard.id,
      type: widget.type,
      title: widget.title,
      config: widget.config ?? {},
      layout: widget.layout,
      status: widget.status === 'broken' ? 'broken' : 'ok',
      broken_reason: null,
      created_at: '',
      updated_at: '',
    })),
    created_at: '',
    updated_at: '',
  };
}

/** Widgets the link cannot read (`no_permission`): drawn as such, never requested. */
export function unreadableWidgets(shared: SharedDashboardDto): ReadonlySet<string> {
  return new Set(
    shared.widgets.filter((widget) => widget.status === 'no_permission').map((widget) => widget.id),
  );
}

/** Fields of the link by table, as the dashboard components read fields (labels, options). */
export function sharedFieldsByTable(
  shared: SharedDashboardDto,
): ReadonlyMap<string, readonly FieldDto[]> {
  const byTable = new Map<string, FieldDto[]>();
  shared.fields.forEach((field, position) => {
    const list = byTable.get(field.table_id) ?? [];
    list.push({
      id: field.id,
      table_id: field.table_id,
      name: field.name,
      type: field.type,
      options: field.options,
      ...(field.result_type === undefined ? {} : { result_type: field.result_type }),
      is_primary: false,
      required: false,
      unique_values: false,
      description: null,
      position,
      created_at: '',
      updated_at: '',
    });
    byTable.set(field.table_id, list);
  });
  return byTable;
}

/** The numbers of a widget the link cannot read: none (CONTRACTS §28.3 `no_permission`). */
export const NO_PERMISSION_DATA: WidgetDataDto = {
  status: 'no_permission',
  columns: [],
  rows: [],
  computed_at: new Date(0).toISOString(),
  cache: 'miss',
  ignored_filters: [],
};

/** The values of a filter control the link cannot read. */
export const NO_PERMISSION_OPTIONS: WidgetOptionsDto = {
  status: 'no_permission',
  items: [],
  has_more: false,
  ignored_filters: [],
};
