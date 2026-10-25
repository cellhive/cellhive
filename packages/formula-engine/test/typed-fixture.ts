import { fixedId, fld as baseFld, tables as baseTables, tbl } from './fixture.js';

import type { SchemaSnapshot, SnapshotField, SnapshotTable } from '../src/index.js';

/** Fields added for the typecheck (T452). */
export const fld = {
  ...baseFld,
  paid: fixedId('fld', 'paid'),
  files: fixedId('fld', 'files'),
  deadline: fixedId('fld', 'deadline'),
  vat: fixedId('fld', 'vat'),
  ageVirtual: fixedId('fld', 'ageVirtual'),
  createdAt: fixedId('fld', 'createdAt'),
  createdBy: fixedId('fld', 'createdBy'),
  code: fixedId('fld', 'code'),
  rate: fixedId('fld', 'rate'),
  untyped: fixedId('fld', 'untyped'),
  ticketCustomer: fixedId('fld', 'ticketCust'),
  customerSince: fixedId('fld', 'custSince'),
} as const;

export { tbl };

const CURRENCY = { type: 'currency', precision: 0, currency_code: 'VND' };
const DATE_ONLY = { format: 'dd/MM/yyyy' };

export const STATUS_OPTIONS = [
  { id: 'opt_new0000000000000', name: 'Mới' },
  { id: 'opt_done000000000000', name: 'Xong' },
  { id: 'opt_shipped00000000', name: 'Đã giao' },
];
export const TAG_OPTIONS = [
  { id: 'opt_vip0000000000000', name: 'VIP' },
  { id: 'opt_internal00000000', name: 'Nội bộ' },
];

/** Type and options per field ID; link fields keep `linkTableId` from the base fixture. */
const TYPES: Record<string, Partial<SnapshotField>> = {
  [fld.orderTitle]: { type: 'text' },
  [fld.amount]: { type: 'number', options: { style: CURRENCY } },
  [fld.cost]: { type: 'number', options: { style: { type: 'plain', precision: 2 } } },
  [fld.status]: { type: 'select', options: { multiple: false, options: STATUS_OPTIONS } },
  [fld.customer]: { type: 'link' },
  [fld.tags]: { type: 'select', options: { multiple: true, options: TAG_OPTIONS } },
  [fld.received]: { type: 'datetime', options: { style: DATE_ONLY } },
  [fld.product]: { type: 'link' },
  [fld.odd]: { type: 'text' },
  [fld.staffLink]: { type: 'link' },
  [fld.customerName]: { type: 'text' },
  [fld.tier]: { type: 'select', options: { multiple: false, options: [] } },
  [fld.employee]: { type: 'user', options: { multiple: false } },
  [fld.customerOrders]: { type: 'link' },
  [fld.assignee]: { type: 'user' },
  [fld.due]: { type: 'datetime', options: { style: DATE_ONLY } },
  [fld.productName]: { type: 'text' },
  [fld.supplier]: { type: 'link' },
  [fld.supplierName]: { type: 'text' },
  [fld.country]: { type: 'link' },
  [fld.countryName]: { type: 'text' },
  [fld.continent]: { type: 'link' },
  [fld.continentName]: { type: 'text' },
  [fld.staffName]: { type: 'text' },
  [fld.manager]: { type: 'link' },
};

const EXTRA: Record<string, SnapshotField[]> = {
  [tbl.orders]: [
    { id: fld.paid, name: 'Đã trả', type: 'checkbox' },
    { id: fld.files, name: 'Tệp', type: 'attachment' },
    {
      id: fld.deadline,
      name: 'Hạn chót',
      type: 'datetime',
      options: { style: { format: 'dd/MM/yyyy HH:mm' } },
    },
    {
      id: fld.vat,
      name: 'VAT',
      type: 'formula',
      options: { style: CURRENCY },
      resultType: { kind: 'number' },
      computeMode: 'stored',
    },
    {
      id: fld.ageVirtual,
      name: 'Tuổi đơn',
      type: 'formula',
      resultType: { kind: 'number' },
      computeMode: 'virtual',
    },
    { id: fld.createdAt, name: 'Ngày tạo', type: 'created_at' },
    { id: fld.createdBy, name: 'Người tạo', type: 'created_by' },
    { id: fld.code, name: 'Mã', type: 'auto_number' },
    {
      id: fld.rate,
      name: 'Tỉ lệ',
      type: 'number',
      options: { style: { type: 'plain', percentage: true } },
    },
    { id: fld.untyped, name: 'Không rõ' },
  ],
  [tbl.tickets]: [
    { id: fld.ticketCustomer, name: 'Khách', type: 'link', linkTableId: tbl.customers },
  ],
  [tbl.customers]: [
    { id: fld.customerSince, name: 'Khách từ', type: 'datetime', options: { style: DATE_ONLY } },
  ],
};

export const typedTables: SnapshotTable[] = baseTables.map((table) => ({
  ...table,
  fields: [
    ...table.fields.map((field) => ({ ...field, ...TYPES[field.id] })),
    ...(EXTRA[table.id] ?? []),
  ],
}));

export function typedSnapshot(tableId: string): SchemaSnapshot {
  return { tableId, tables: typedTables };
}

export const orders = typedSnapshot(tbl.orders);
export const customers = typedSnapshot(tbl.customers);
export const tickets = typedSnapshot(tbl.tickets);
export const products = typedSnapshot(tbl.products);
export const staff = typedSnapshot(tbl.staff);
