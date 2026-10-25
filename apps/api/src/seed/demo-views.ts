import {
  type CreateViewRequest,
  type Id,
  type ShareLinkAudience,
  type ViewDto,
} from '@cellhive/contracts';
import { FieldsRepository, orgScope } from '@cellhive/server-core';

import { ShareLinkService } from '../modules/share-link/share-link.service.js';
import { ViewService } from '../modules/view/view.service.js';

import { DEMO_TABLE_NAMES } from './demo-tables.js';
import { SeedError } from './seed-error.js';

import type { Principal } from '../common/auth/principal.js';
import type { RequestMeta } from '../common/auth/request-meta.js';
import type { INestApplicationContext } from '@nestjs/common';

type DemoTableKey = keyof typeof DEMO_TABLE_NAMES;

/** Names of the demo views (CONTRACTS §9). The first of each table is its default grid, renamed. */
export const DEMO_VIEW_NAMES = {
  customers: { all: 'Tất cả khách hàng', byTier: 'Theo hạng', vip: 'Khách VIP' },
  tickets: {
    all: 'Tất cả phiếu',
    mine: 'Phiếu của tôi',
    open: 'Đang mở',
    byStatus: 'Theo trạng thái',
    kanban: 'Kanban trạng thái',
    form: 'Gửi yêu cầu hỗ trợ',
    /** Personal view of `u_editor`. */
    editorUrgent: 'Việc gấp của tôi',
  },
  orders: { all: 'Tất cả đơn hàng', mine: 'Đơn của tôi', highCost: 'Đơn giá vốn cao' },
  /** T421b: no English "Grid view" left in the demo. */
  orderLines: { all: 'Tất cả dòng đơn hàng' },
} as const;

/** A share link made by the seed; `url` holds the token, printed once. */
export interface DemoShareLink {
  readonly viewName: string;
  readonly audience: ShareLinkAudience;
  readonly url: string;
}

export interface DemoViewsInput {
  readonly organizationId: Id<'org'>;
  readonly tables: Readonly<Record<DemoTableKey, Id<'tbl'>>>;
  /** Base owner (`u_admin`): creates the shared views and the share links. */
  readonly admin: Principal;
  /** `u_editor`: owns a personal view. */
  readonly editor: Principal;
  /** Share links are for development only (BACKLOG T309). */
  readonly shareLinks: boolean;
  readonly meta: () => RequestMeta;
}

export interface DemoViewsResult {
  /** Views of Orders the Sales role lists in `visible_views`, "Đơn của tôi" first. */
  readonly salesViews: readonly Id<'viw'>[];
  readonly shareLinks: readonly DemoShareLink[];
}

/** The `current_user` condition on a user field (SPEC §6). */
function mine(fieldId: Id<'fld'>) {
  return { field: fieldId, operator: 'has_any_of', value: [{ $var: 'current_user' }] };
}

/**
 * The saved views of `pnpm seed:demo` (CONTRACTS §9), created through
 * `ViewService` like the web UI does (events, audit, `schema.changed`):
 * each table's default grid renamed "Tất cả …", filtered, grouped, Kanban
 * and form views, one personal view of `u_editor`, and — in development —
 * a public link to the support form and an organization link to the open
 * tickets (`ShareLinkService`). Returns the Orders views of the Sales role.
 */
export async function seedDemoViews(
  app: INestApplicationContext,
  input: DemoViewsInput,
): Promise<DemoViewsResult> {
  const views = app.get(ViewService);
  const scope = orgScope(input.organizationId);
  const fieldsRepository = app.get(FieldsRepository);

  const fieldsOf = async (table: DemoTableKey) => {
    const rows = await fieldsRepository.listByTable(scope, input.tables[table]);
    return (name: string): Id<'fld'> => {
      const field = rows.find((item) => item.name === name);
      if (field === undefined)
        throw new SeedError(`${DEMO_TABLE_NAMES[table]} has no field ${name}`);
      return field.id;
    };
  };
  const renameDefault = async (table: DemoTableKey, name: string): Promise<ViewDto> => {
    const list = await views.list(input.admin, input.tables[table], { offset: 0, limit: 10 });
    const first = list.items.find((view) => !view.is_personal);
    if (first === undefined) throw new SeedError(`${DEMO_TABLE_NAMES[table]} has no default view`);
    return views.update(input.admin, first.id, { name }, input.meta());
  };
  const create = (
    table: DemoTableKey,
    body: Omit<CreateViewRequest, 'is_personal'> & { is_personal?: boolean },
    by: Principal = input.admin,
  ): Promise<ViewDto> =>
    views.create(by, input.tables[table], { is_personal: false, ...body }, input.meta());

  // Customers
  const customer = await fieldsOf('customers');
  await renameDefault('customers', DEMO_VIEW_NAMES.customers.all);
  await create('customers', {
    name: DEMO_VIEW_NAMES.customers.byTier,
    type: 'grid',
    config: {
      group: [{ field: customer('Hạng'), direction: 'asc' }],
      sort: [{ field: customer('Tên'), direction: 'asc' }],
    },
  });
  await create('customers', {
    name: DEMO_VIEW_NAMES.customers.vip,
    type: 'grid',
    config: {
      filter: {
        op: 'and',
        items: [{ field: customer('Hạng'), operator: 'is_any_of', value: ['Vàng', 'Kim cương'] }],
      },
      sort: [{ field: customer('Ngày tham gia'), direction: 'desc' }],
    },
  });

  // Tickets
  const ticket = await fieldsOf('tickets');
  await renameDefault('tickets', DEMO_VIEW_NAMES.tickets.all);
  await create('tickets', {
    name: DEMO_VIEW_NAMES.tickets.mine,
    type: 'grid',
    config: {
      filter: { op: 'and', items: [mine(ticket('Phụ trách'))] },
      sort: [{ field: ticket('Hạn'), direction: 'asc' }],
    },
  });
  const open = await create('tickets', {
    name: DEMO_VIEW_NAMES.tickets.open,
    type: 'grid',
    config: {
      filter: {
        op: 'and',
        items: [{ field: ticket('Trạng thái'), operator: 'is_not', value: 'Đã xong' }],
      },
      sort: [{ field: ticket('Hạn'), direction: 'asc' }],
      hidden_fields: [ticket('Mô tả')],
    },
  });
  await create('tickets', {
    name: DEMO_VIEW_NAMES.tickets.byStatus,
    type: 'grid',
    config: {
      group: [{ field: ticket('Trạng thái'), direction: 'asc' }],
      sort: [{ field: ticket('Hạn'), direction: 'asc' }],
    },
  });
  await create('tickets', {
    name: DEMO_VIEW_NAMES.tickets.kanban,
    type: 'kanban',
    config: {
      kanban: {
        group_field: ticket('Trạng thái'),
        card_fields: [ticket('Mã ticket'), ticket('Ưu tiên'), ticket('Phụ trách'), ticket('Hạn')],
        // BACKLOG T412: the attachment field as the card cover.
        cover_field: ticket('Tệp đính kèm'),
      },
    },
  });
  const form = await create('tickets', {
    name: DEMO_VIEW_NAMES.tickets.form,
    type: 'form',
    config: {
      form: {
        title: 'Gửi yêu cầu hỗ trợ',
        description: 'Mô tả sự cố thiết bị, bộ phận hỗ trợ sẽ liên hệ lại trong ngày làm việc.',
        fields: [
          { field: ticket('Tiêu đề'), required: true, label: 'Vấn đề gặp phải', help: null },
          { field: ticket('Ưu tiên'), required: false, label: null, help: null },
          {
            field: ticket('Mô tả'),
            required: false,
            label: 'Chi tiết',
            help: 'Thiết bị, thời điểm, thông báo lỗi (nếu có).',
          },
        ],
        success_message: 'Cảm ơn bạn! Yêu cầu đã được ghi nhận.',
        allow_multiple_submissions: true,
        require_login: false,
      },
    },
  });
  await create(
    'tickets',
    {
      name: DEMO_VIEW_NAMES.tickets.editorUrgent,
      type: 'grid',
      is_personal: true,
      config: {
        filter: {
          op: 'and',
          items: [
            mine(ticket('Phụ trách')),
            { field: ticket('Ưu tiên'), operator: 'is_any_of', value: ['Cao', 'Khẩn cấp'] },
          ],
        },
        sort: [{ field: ticket('Hạn'), direction: 'asc' }],
      },
    },
    input.editor,
  );

  // Orders: "Tất cả đơn hàng" is `viw_all` of the CONTRACTS §5 fixture; the
  // Sales views are `viw_sales` ("Đơn của tôi") and one filtered by `cost`,
  // a field Sales cannot read: the condition applies but is never shown.
  const order = await fieldsOf('orders');
  const orderLine = await fieldsOf('orderLines');
  const ordersAll = await renameDefault('orders', DEMO_VIEW_NAMES.orders.all);
  await renameDefault('orderLines', DEMO_VIEW_NAMES.orderLines.all);
  // BACKLOG T412: the embedded sub-table of "Chi tiết đơn hàng" (T402
  // `record_detail.link_columns`), on the reverse link field Orders got
  // when that table was linked to it (same name, bidirectional).
  await views.update(
    input.admin,
    ordersAll.id,
    {
      config: {
        record_detail: {
          link_columns: {
            [order(DEMO_TABLE_NAMES.orderLines)]: [
              orderLine('Sản phẩm'),
              orderLine('Số lượng'),
              orderLine('Đơn giá'),
            ],
          },
        },
      },
    },
    input.meta(),
  );
  const myOrders = await create('orders', {
    name: DEMO_VIEW_NAMES.orders.mine,
    type: 'grid',
    config: {
      filter: { op: 'and', items: [mine(order('owner'))] },
    },
  });
  const highCost = await create('orders', {
    name: DEMO_VIEW_NAMES.orders.highCost,
    type: 'grid',
    config: {
      filter: { op: 'and', items: [{ field: order('cost'), operator: 'gte', value: 3_000_000 }] },
      sort: [{ field: order('amount'), direction: 'desc' }],
    },
  });

  const shareLinks: DemoShareLink[] = [];
  if (input.shareLinks) {
    const links = app.get(ShareLinkService);
    const share = async (view: ViewDto, audience: ShareLinkAudience) => {
      const created = await links.create(
        input.admin,
        view.id,
        { audience, enabled: true },
        input.meta(),
      );
      shareLinks.push({ viewName: view.name, audience, url: created.url });
    };
    await share(form, 'public');
    await share(open, 'org');
  }

  return { salesViews: [myOrders.id, highCost.id], shareLinks };
}
