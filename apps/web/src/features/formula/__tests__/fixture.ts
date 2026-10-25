import type { FormulaSchema, FormulaSchemaField } from '../model/schema';

/** Ids of the fixture: `fld_`/`tbl_` + 16 characters. */
export const id = (prefix: 'fld' | 'tbl' | 'opt' | 'rec', name: string) =>
  `${prefix}_${name.padEnd(16, '0').slice(0, 16)}`;

export const CUSTOMERS = id('tbl', 'Customers');
export const ORDERS = id('tbl', 'Orders');
export const RETURNS = id('tbl', 'Returns');
export const DONE = id('opt', 'Done');
export const OPEN = id('opt', 'Open');

function field(
  name: string,
  key: string,
  type: string,
  extra: Partial<FormulaSchemaField> = {},
): FormulaSchemaField {
  return {
    id: id('fld', key),
    name,
    type,
    options: {},
    isPrimary: false,
    linkTableId: null,
    resultType: null,
    computeMode: null,
    ...extra,
  };
}

/** Customers (the formula's table), Orders linking to it, Returns. */
export const SCHEMA: FormulaSchema = {
  tableId: CUSTOMERS,
  tables: [
    {
      id: CUSTOMERS,
      name: 'Khách hàng',
      fields: [
        field('Tên khách hàng', 'CustName', 'text', { isPrimary: true }),
        field('Trạng thái', 'CustStatus', 'select', {
          options: {
            multiple: false,
            options: [
              { id: DONE, name: 'Xong', color: 1 },
              { id: OPEN, name: 'Mở', color: 2 },
            ],
          },
        }),
        field('Trưởng nhóm', 'CustLead', 'user'),
        field('Ngày trở lại', 'CustBack', 'datetime', {
          options: { style: { format: 'dd/MM/yyyy' } },
        }),
        field('Số đơn', 'CustCount', 'number'),
        field('Doanh thu', 'CustRevenue', 'number', {
          options: { style: { type: 'currency', currency_code: 'VND' } },
        }),
      ],
    },
    {
      id: ORDERS,
      name: 'Đơn hàng',
      fields: [
        field('Mã đơn', 'OrdCode', 'text', { isPrimary: true }),
        field('Khách hàng', 'OrdCustomer', 'link', {
          linkTableId: CUSTOMERS,
          options: { link_table: CUSTOMERS },
        }),
        field('Trạng thái', 'OrdStatus', 'text'),
        field('Tổng tiền', 'OrdTotal', 'number', {
          options: { style: { type: 'currency', currency_code: 'VND' } },
        }),
        field('Ngày đặt', 'OrdDate', 'datetime', { options: { style: { format: 'dd/MM/yyyy' } } }),
      ],
    },
    {
      id: RETURNS,
      name: 'Trả hàng',
      fields: [field('Mã trả', 'RetCode', 'text', { isPrimary: true })],
    },
  ],
};
