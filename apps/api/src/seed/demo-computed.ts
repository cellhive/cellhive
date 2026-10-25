import { FieldsRepository, type AuditContext, type Db, type OrgScope } from '@cellhive/server-core';

import { DB } from '../common/tokens.js';

import { SeedComputedFields } from './computed-seeding.js';

import type { Id } from '@cellhive/contracts';
import type { INestApplicationContext } from '@nestjs/common';

/** Style of the money results (like `amount`, `Đơn giá`). */
const VND = { type: 'currency', currency_code: 'VND' } as const;

/**
 * Names of the S4b computed fields of the demo (BACKLOG T464, CONTRACTS §9).
 * `total_formula` keeps its CONTRACTS §5 name (P27, P36).
 */
export const DEMO_COMPUTED_FIELDS = {
  orders: {
    margin: 'total_formula',
    linesTotal: 'Tổng tiền hàng',
  },
  orderLines: {
    lineTotal: 'Thành tiền',
  },
  customers: {
    doneTotal: 'Tổng tiền đơn đã hoàn thành',
    orderCount: 'Số đơn',
    suggestedTier: 'Hạng đề xuất',
    revenueFormula: 'Doanh thu đơn hoàn thành (công thức)',
  },
  tickets: {
    overdue: 'Quá hạn',
    customerName: 'Tên khách hàng',
  },
} as const;

/** Thresholds of "Hạng đề xuất" (VND of completed orders). */
export const DEMO_TIER_THRESHOLDS = {
  diamond: 150_000_000,
  gold: 110_000_000,
  silver: 80_000_000,
} as const;

interface DemoTables {
  readonly customers: Id<'tbl'>;
  readonly tickets: Id<'tbl'>;
  readonly orders: Id<'tbl'>;
  readonly orderLines: Id<'tbl'>;
}

/**
 * The formula and lookup fields of `pnpm seed:demo` (BACKLOG T464), added
 * once every record exists and computed at once (`SeedComputedFields`):
 *
 * - Orders `total_formula` = `[amount] - [cost]` (stored; CONTRACTS §5 —
 *   reads `cost`, `no_perm` for Sales: P36);
 * - Chi tiết đơn hàng "Thành tiền" = `[Số lượng] * [Đơn giá]` (stored);
 * - Orders "Tổng tiền hàng": lookup `sum` of "Thành tiền" through the
 *   two-way link, VND;
 * - Customers "Tổng tiền đơn đã hoàn thành": lookup `sum` of Orders
 *   `amount` through `customer` with `status` = Xong (SPEC §5.8 example),
 *   VND; "Số đơn": lookup `counta`; "Hạng đề xuất": a `LET` formula over the
 *   first; "Doanh thu đơn hoàn thành (công thức)": the cross-table `FILTER`
 *   of the S4b milestone (compares the linked customer by title);
 * - Tickets "Quá hạn": `TODAY()` (virtual); "Tên khách hàng": a
 *   cross-table `FILTER` on Customers by code, without any link (stored).
 */
export async function seedDemoComputed(
  app: INestApplicationContext,
  scope: OrgScope,
  tables: DemoTables,
  input: { readonly context: AuditContext; readonly timeZone: string },
): Promise<void> {
  const fields = new FieldsRepository(app.get<Db>(DB));
  const fieldOf = async (tableId: Id<'tbl'>, name: string) => {
    const field = (await fields.listByTable(scope, tableId)).find((item) => item.name === name);
    if (field === undefined) throw new Error(`demo field ${name} is missing`);
    return field;
  };
  const computed = new SeedComputedFields(app, { scope, ...input });
  const names = DEMO_COMPUTED_FIELDS;

  // Orders: margin (same row).
  await computed.add(tables.orders, {
    name: names.orders.margin,
    type: 'formula',
    options: { expression: '[amount] - [cost]' },
    description: 'Lãi gộp của đơn: amount − cost.',
  });

  // Order lines: line total, then its sum on Orders through the two-way link.
  await computed.add(tables.orderLines, {
    name: names.orderLines.lineTotal,
    type: 'formula',
    options: { expression: '[Số lượng] * [Đơn giá]' },
  });
  const lineTotal = await fieldOf(tables.orderLines, names.orderLines.lineTotal);
  const lineOrder = await fieldOf(tables.orderLines, 'Đơn hàng');
  await computed.add(tables.orders, {
    name: names.orders.linesTotal,
    type: 'lookup',
    options: {
      from: tables.orderLines,
      select: lineTotal.id,
      where: { field: lineOrder.id, operator: 'intersects', value: { field_ref: '__id' } },
      aggregate: 'sum',
      style: VND,
    },
  });

  // Customers: lookups over Orders through the one-way `customer` link.
  const amount = await fieldOf(tables.orders, 'amount');
  const status = await fieldOf(tables.orders, 'status');
  const orderTitle = (await fields.listByTable(scope, tables.orders)).find(
    (field) => field.is_primary,
  );
  if (orderTitle === undefined) throw new Error('Orders has no primary field');
  const customer = (await fields.listByTable(scope, tables.orders)).find(
    (field) => field.type === 'link' && linkTable(field.options) === tables.customers,
  );
  if (customer === undefined) throw new Error('Orders has no link to Customers');
  const done = optionId(status.options, 'Xong');
  const viaCustomer = {
    field: customer.id,
    operator: 'intersects',
    value: { field_ref: '__id' },
  };
  await computed.add(tables.customers, {
    name: names.customers.doneTotal,
    type: 'lookup',
    options: {
      from: tables.orders,
      select: amount.id,
      where: {
        op: 'and',
        items: [viaCustomer, { field: status.id, operator: 'is', value: done }],
      },
      aggregate: 'sum',
      style: VND,
    },
  });
  await computed.add(tables.customers, {
    name: names.customers.orderCount,
    type: 'lookup',
    options: {
      from: tables.orders,
      select: orderTitle.id,
      where: viaCustomer,
      aggregate: 'counta',
    },
  });
  const tiers = DEMO_TIER_THRESHOLDS;
  await computed.add(tables.customers, {
    name: names.customers.suggestedTier,
    type: 'formula',
    options: {
      expression:
        `LET(total, [${names.customers.doneTotal}], ` +
        `IF(total >= ${String(tiers.diamond)}, "Kim cương", ` +
        `IF(total >= ${String(tiers.gold)}, "Vàng", ` +
        `IF(total >= ${String(tiers.silver)}, "Bạc", "Thường"))))`,
    },
    description: 'Hạng gợi ý theo tổng tiền đơn đã hoàn thành.',
  });
  await computed.add(tables.customers, {
    name: names.customers.revenueFormula,
    type: 'formula',
    options: {
      expression:
        '[Orders].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên]) && ' +
        'CurrentValue.[status] = "Xong").[amount].SUM()',
      style: VND,
    },
  });

  // Tickets: a virtual TODAY() formula and a FILTER on Customers without a link.
  await computed.add(tables.tickets, {
    name: names.tickets.overdue,
    type: 'formula',
    options: { expression: 'AND([Hạn] < TODAY(), [Trạng thái] != "Đã xong")' },
  });
  await computed.add(tables.tickets, {
    name: names.tickets.customerName,
    type: 'formula',
    options: {
      expression:
        '[Customers].FILTER(CurrentValue.[Mã khách hàng] = [Mã khách hàng]).[Tên].FIRST()',
    },
  });
}

function linkTable(options: unknown): string | undefined {
  const value = (options as { link_table?: unknown } | null)?.link_table;
  return typeof value === 'string' ? value : undefined;
}

function optionId(options: unknown, name: string): string {
  const list = (options as { options?: { id: string; name: string }[] } | null)?.options ?? [];
  const found = list.find((option) => option.name === name);
  if (found === undefined) throw new Error(`select option ${name} is missing`);
  return found.id;
}
