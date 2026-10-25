import {
  createDashboardRequestSchema,
  createFieldRequestSchema,
  createShareLinkRequestSchema,
  createWidgetRequestSchema,
  newId,
  recordQueryRequestSchema,
  recordReadParamsSchema,
  recordWriteParamsSchema,
  updateRecordsRequestSchema,
  type Id,
  type WidgetDto,
} from '@cellhive/contracts';
import { FieldsRepository, orgScope } from '@cellhive/server-core';

import { AccessService } from '../common/access/access.service.js';
import { DashboardService } from '../modules/dashboard/dashboard.service.js';
import { FieldService } from '../modules/field/field.service.js';
import { RecordService } from '../modules/record/record.service.js';
import { ShareLinkService } from '../modules/share-link/share-link.service.js';
import { ViewService } from '../modules/view/view.service.js';

import { DEMO_ORDER_FIELDS, DEMO_TABLE_NAMES } from './demo-tables.js';
import { DEMO_VIEW_NAMES } from './demo-views.js';
import { SeedError } from './seed-error.js';

import type { Principal } from '../common/auth/principal.js';
import type { RequestMeta } from '../common/auth/request-meta.js';
import type { INestApplicationContext } from '@nestjs/common';

type DemoTableKey = keyof typeof DEMO_TABLE_NAMES;

const DAY_MS = 86_400_000;
/** Orders spread over the last 180 days: this month, last month and a few before. */
const ORDER_DATE_SPAN_DAYS = 180;
/** Pages of the Orders fill-in (one transaction each, the mutation maximum). */
const PAGE = 1000;

/** The two Orders fields the sample dashboard groups by (BACKLOG T818). */
export const DEMO_S7_FIELDS = {
  orderDate: 'Ngày đặt',
  region: 'Khu vực',
} as const;

export const DEMO_REGIONS = ['Miền Bắc', 'Miền Trung', 'Miền Nam'] as const;

/** The sample dashboard of `seed:demo` (CONTRACTS §9, BACKLOG T818). */
export const DEMO_DASHBOARD = {
  name: 'Tổng quan đơn hàng',
  icon: '📊',
  description: 'Doanh thu, trạng thái và khu vực của đơn hàng — dữ liệu mẫu.',
  widgets: {
    dateControl: 'Ngày đặt',
    statusControl: 'Trạng thái',
    kpi: 'Doanh thu tháng này',
    stacked: 'Đơn theo trạng thái và khu vực',
    weekly: 'Đơn theo tuần',
    byOwner: 'Doanh thu theo người phụ trách',
    top: 'Top 10 đơn giá trị cao',
    text: 'Giới thiệu',
  },
} as const;

/** The color rule of the main Tickets grid (BACKLOG T818, CONTRACTS §15). */
export const DEMO_COLOR_RULE = {
  view: DEMO_VIEW_NAMES.tickets.all,
  field: 'Quá hạn',
  color: 'red',
} as const;

const TEXT_WIDGET = [
  '**Tổng quan đơn hàng** — dữ liệu mẫu của Cellhive.',
  '',
  '- Số liệu tính theo quyền của **người xem**: nhóm Sales chỉ thấy đơn của mình.',
  '- Bấm một cột để lọc các biểu đồ cùng nguồn; chọn ngày và trạng thái ở thanh lọc.',
].join('\n');

export interface DemoS7Input {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly tables: Readonly<Record<DemoTableKey, Id<'tbl'>>>;
  /** `u_admin`: organization owner and base owner. */
  readonly admin: Principal;
  /** Org time zone: order dates are calendar days counted back from today there. */
  readonly timeZone: string;
  /** The public dashboard link is for development only (like the view links, T309). */
  readonly shareLinks: boolean;
  readonly meta: () => RequestMeta;
}

/** The S7 samples of the run, for the summary (BACKLOG T818). */
export interface DemoS7Result {
  readonly dashboardId: Id<'dsh'>;
  readonly dashboardName: string;
  readonly widgetCount: number;
  /** Public link of the dashboard (embedding off), with its token; `null` in production. */
  readonly shareUrl: string | null;
  readonly colorRuleView: string;
}

/** `YYYY-MM-DD` of `days` days before today in `timeZone`. */
function daysAgo(timeZone: string, now: Date, days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The S7 samples of `pnpm seed:demo` (CONTRACTS §9, BACKLOG T818), made by
 * `u_admin` through the API's own services like the web UI (validation,
 * events, audit), before the events of the sample data are settled — no
 * job is left behind, no network call:
 *
 * 1. Orders gets "Ngày đặt" (date) and "Khu vực" (select), filled on every
 *    order (`RecordService.updateRecords`, 1 000 a transaction): a
 *    deterministic day of the last 180 days and region per order;
 * 2. the dashboard "Tổng quan đơn hàng" (`DashboardService`): date and
 *    status controls, a KPI (revenue this month vs last month), a stacked
 *    bar (status × region), a weekly line, a pie by owner, the top 10
 *    orders and a text widget — every data widget follows both controls;
 * 3. in development, a public link to it (`ShareLinkService`, embedding off);
 * 4. the color rule "Quá hạn" (red row) on the main Tickets grid (`ViewService`).
 *
 * The Sales role (the last step of the seed) reads the dashboard
 * (`dashboards = { D: read_only }`).
 */
export async function seedDemoS7(
  app: INestApplicationContext,
  input: DemoS7Input,
): Promise<DemoS7Result> {
  const scope = orgScope(input.organizationId);
  const fieldsRepository = app.get(FieldsRepository);
  const fieldService = app.get(FieldService);
  const recordService = app.get(RecordService);

  // 1. The date and region of every order.
  const orderDate = await fieldService.create(
    input.admin,
    input.tables.orders,
    createFieldRequestSchema.parse({
      name: DEMO_S7_FIELDS.orderDate,
      type: 'datetime',
      options: { style: { format: 'dd/MM/yyyy' } },
    }),
    input.meta(),
  );
  const region = await fieldService.create(
    input.admin,
    input.tables.orders,
    createFieldRequestSchema.parse({
      name: DEMO_S7_FIELDS.region,
      type: 'select',
      options: { options: DEMO_REGIONS.map((name) => ({ id: newId('opt'), name })) },
    }),
    input.meta(),
  );
  // The admin's cached access predates the two fields (a new request would resolve it again).
  app.get(AccessService).invalidate(input.admin);
  const now = new Date();
  for (let offset = 0; ; offset += PAGE) {
    const page = await recordService.queryRecords(
      input.admin,
      input.tables.orders,
      recordReadParamsSchema.parse({ field_key_type: 'id' }),
      recordQueryRequestSchema.parse({
        fields: [orderDate.id],
        offset,
        limit: PAGE,
        include_total: false,
      }),
    );
    if (page.records.length === 0) break;
    await recordService.updateRecords(
      input.admin,
      input.tables.orders,
      recordWriteParamsSchema.parse({ field_key_type: 'name', typecast: 'true' }),
      updateRecordsRequestSchema.parse({
        records: page.records.map((record, index) => {
          const n = offset + index;
          return {
            id: record.id,
            fields: {
              // A fixed walk over the span (7 919 is prime): every week gets orders.
              [DEMO_S7_FIELDS.orderDate]: daysAgo(
                input.timeZone,
                now,
                (n * 7919) % ORDER_DATE_SPAN_DAYS,
              ),
              [DEMO_S7_FIELDS.region]: DEMO_REGIONS[(n * 5 + Math.floor(n / 7)) % 3],
            },
          };
        }),
      }),
      input.meta(),
    );
    if (page.records.length < PAGE) break;
  }

  // 2. The dashboard.
  const fields = await fieldsRepository.listByTable(scope, input.tables.orders);
  const field = (name: string): Id<'fld'> => {
    const found = fields.find((item) => item.name === name);
    if (found === undefined) throw new SeedError(`${DEMO_TABLE_NAMES.orders} has no field ${name}`);
    return found.id;
  };
  const dashboards = app.get(DashboardService);
  const dashboard = await dashboards.create(
    input.admin,
    input.baseId,
    createDashboardRequestSchema.parse({
      name: DEMO_DASHBOARD.name,
      icon: DEMO_DASHBOARD.icon,
      description: DEMO_DASHBOARD.description,
    }),
    input.meta(),
  );
  const widget = (body: unknown): Promise<WidgetDto> =>
    dashboards.createWidget(
      input.admin,
      dashboard.id,
      createWidgetRequestSchema.parse(body),
      undefined,
      input.meta(),
    );
  const orders = input.tables.orders;
  const titles = DEMO_DASHBOARD.widgets;
  const dateControl = await widget({
    type: 'filter_control',
    title: titles.dateControl,
    config: { table_id: orders, field: orderDate.id, control: 'date_range' },
    layout: { x: 0, y: 0, w: 6, h: 2 },
  });
  const statusControl = await widget({
    type: 'filter_control',
    title: titles.statusControl,
    config: { table_id: orders, field: field('status'), control: 'select' },
    layout: { x: 6, y: 0, w: 6, h: 2 },
  });
  const bindings = [dateControl.id, statusControl.id];
  const count = [{ id: 'm1', aggregation: 'count', label: 'Số đơn' }];
  const revenue = [{ id: 'm1', aggregation: 'sum', field: field('amount'), label: 'Doanh thu' }];
  const vnd = { style: 'currency', currency: 'VND', decimals: 0, compact: true };
  await widget({
    type: 'kpi',
    title: titles.kpi,
    config: {
      table_id: orders,
      // The period is the KPI's own: only the status control applies.
      filter_bindings: [statusControl.id],
      metrics: revenue,
      compare: { mode: 'previous_period', date_field: orderDate.id, range: 'month' },
      display: { number_format: vnd },
    },
    layout: { x: 0, y: 2, w: 4, h: 4 },
  });
  await widget({
    type: 'text',
    title: titles.text,
    config: { markdown: TEXT_WIDGET },
    layout: { x: 4, y: 2, w: 8, h: 4 },
  });
  await widget({
    type: 'bar',
    title: titles.stacked,
    config: {
      table_id: orders,
      filter_bindings: bindings,
      dimension: { field: field('status') },
      series_dimension: { field: region.id },
      metrics: count,
      sort: 'dimension_asc',
      display: { stack: 'stacked', show_legend: true },
    },
    layout: { x: 0, y: 6, w: 6, h: 8 },
  });
  await widget({
    type: 'pie',
    title: titles.byOwner,
    config: {
      table_id: orders,
      filter_bindings: bindings,
      dimension: { field: field('owner') },
      metrics: revenue,
      display: { number_format: vnd, donut: true },
    },
    layout: { x: 6, y: 6, w: 6, h: 8 },
  });
  await widget({
    type: 'line',
    title: titles.weekly,
    config: {
      table_id: orders,
      filter_bindings: bindings,
      dimension: { field: orderDate.id, date_bucket: 'week' },
      metrics: count,
      sort: 'dimension_asc',
      limit: 30,
      display: { smooth: true },
    },
    layout: { x: 0, y: 14, w: 12, h: 7 },
  });
  await widget({
    type: 'table',
    title: titles.top,
    config: {
      table_id: orders,
      filter_bindings: bindings,
      table: {
        mode: 'records',
        fields: [
          field(DEMO_ORDER_FIELDS.title),
          field('owner'),
          field('status'),
          orderDate.id,
          field('amount'),
        ],
        sort: { field: field('amount'), direction: 'desc' },
        limit: 10,
      },
    },
    layout: { x: 0, y: 21, w: 12, h: 8 },
  });

  // 3. A public link (development only), embedding off (the default).
  let shareUrl: string | null = null;
  if (input.shareLinks) {
    const link = await app
      .get(ShareLinkService)
      .createForDashboard(
        input.admin,
        dashboard.id,
        createShareLinkRequestSchema.parse({ audience: 'public', enabled: true }),
        input.meta(),
      );
    shareUrl = link.url;
  }

  // 4. "Quá hạn" in red on the main Tickets grid.
  const views = app.get(ViewService);
  const ticketViews = await views.list(input.admin, input.tables.tickets, {
    offset: 0,
    limit: 50,
  });
  const main = ticketViews.items.find((view) => view.name === DEMO_COLOR_RULE.view);
  if (main === undefined) throw new SeedError(`Tickets has no view ${DEMO_COLOR_RULE.view}`);
  const ticketFields = await fieldsRepository.listByTable(scope, input.tables.tickets);
  const overdue = ticketFields.find((item) => item.name === DEMO_COLOR_RULE.field);
  if (overdue === undefined) {
    throw new SeedError(`${DEMO_TABLE_NAMES.tickets} has no field ${DEMO_COLOR_RULE.field}`);
  }
  await views.update(
    input.admin,
    main.id,
    {
      config: {
        color_rules: [
          {
            id: newId('clr'),
            enabled: true,
            filter: { op: 'and', items: [{ field: overdue.id, operator: 'is', value: true }] },
            color: DEMO_COLOR_RULE.color,
            target: 'row',
            field_id: null,
          },
        ],
      },
    },
    input.meta(),
  );

  return {
    dashboardId: dashboard.id,
    dashboardName: dashboard.name,
    widgetCount: 8,
    shareUrl,
    colorRuleView: main.name,
  };
}
