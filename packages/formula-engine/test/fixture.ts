import type { Expr, SchemaSnapshot, SnapshotField, SnapshotTable } from '../src/index.js';

/** Deterministic, readable IDs: `fld_amount0000000000`. */
export function fixedId(prefix: 'fld' | 'tbl', name: string): string {
  return `${prefix}_${name.padEnd(16, '0').slice(0, 16)}`;
}

export const tbl = {
  orders: fixedId('tbl', 'orders'),
  customers: fixedId('tbl', 'customers'),
  tickets: fixedId('tbl', 'tickets'),
  products: fixedId('tbl', 'products'),
  suppliers: fixedId('tbl', 'suppliers'),
  countries: fixedId('tbl', 'countries'),
  continents: fixedId('tbl', 'continents'),
  staff: fixedId('tbl', 'staff'),
} as const;

export const fld = {
  // Đơn hàng (orders)
  orderTitle: fixedId('fld', 'orderTitle'),
  amount: fixedId('fld', 'amount'),
  cost: fixedId('fld', 'cost'),
  status: fixedId('fld', 'status'),
  customer: fixedId('fld', 'customer'),
  tags: fixedId('fld', 'tags'),
  received: fixedId('fld', 'received'),
  product: fixedId('fld', 'product'),
  odd: fixedId('fld', 'odd'),
  staffLink: fixedId('fld', 'staffLink'),
  // Khách hàng (customers)
  customerName: fixedId('fld', 'customerName'),
  tier: fixedId('fld', 'tier'),
  employee: fixedId('fld', 'employee'),
  customerOrders: fixedId('fld', 'customerOrders'),
  // Tickets
  assignee: fixedId('fld', 'assignee'),
  due: fixedId('fld', 'due'),
  // Sản phẩm → Nhà cung cấp → Quốc gia → Châu lục
  productName: fixedId('fld', 'productName'),
  supplier: fixedId('fld', 'supplier'),
  supplierName: fixedId('fld', 'supplierName'),
  country: fixedId('fld', 'country'),
  countryName: fixedId('fld', 'countryName'),
  continent: fixedId('fld', 'continent'),
  continentName: fixedId('fld', 'continentName'),
  // Nhân viên (staff), a self-link
  staffName: fixedId('fld', 'staffName'),
  manager: fixedId('fld', 'manager'),
} as const;

const field = (id: string, name: string, linkTableId?: string): SnapshotField =>
  linkTableId === undefined ? { id, name } : { id, name, linkTableId };

export const tables: SnapshotTable[] = [
  {
    id: tbl.orders,
    name: 'Đơn hàng',
    fields: [
      field(fld.orderTitle, 'Tiêu đề'),
      field(fld.amount, 'Số tiền'),
      field(fld.cost, 'Chi phí'),
      field(fld.status, 'Trạng thái'),
      // Same name as the table `Khách hàng`: the field wins inside `Đơn hàng`.
      field(fld.customer, 'Khách hàng', tbl.customers),
      field(fld.tags, 'Tags'),
      field(fld.received, 'Ngày nhận'),
      field(fld.product, 'Sản phẩm', tbl.products),
      field(fld.odd, 'a]b\\c "q"'),
      field(fld.staffLink, 'Người bán', tbl.staff),
    ],
  },
  {
    id: tbl.customers,
    name: 'Khách hàng',
    fields: [
      field(fld.customerName, 'Tên'),
      field(fld.tier, 'Hạng'),
      field(fld.employee, 'Nhân viên'),
      field(fld.customerOrders, 'Các đơn', tbl.orders),
    ],
  },
  {
    id: tbl.tickets,
    name: 'Tickets',
    fields: [field(fld.assignee, 'Người phụ trách'), field(fld.due, 'Hạn')],
  },
  {
    id: tbl.products,
    name: 'Sản phẩm',
    fields: [field(fld.productName, 'Tên'), field(fld.supplier, 'Nhà cung cấp', tbl.suppliers)],
  },
  {
    id: tbl.suppliers,
    name: 'Nhà cung cấp',
    fields: [field(fld.supplierName, 'Tên'), field(fld.country, 'Quốc gia', tbl.countries)],
  },
  {
    id: tbl.countries,
    name: 'Quốc gia',
    fields: [field(fld.countryName, 'Tên'), field(fld.continent, 'Châu lục', tbl.continents)],
  },
  {
    id: tbl.continents,
    name: 'Châu lục',
    fields: [field(fld.continentName, 'Tên')],
  },
  {
    id: tbl.staff,
    name: 'Nhân viên',
    fields: [field(fld.staffName, 'Tên'), field(fld.manager, 'Quản lý', tbl.staff)],
  },
];

/** Snapshot for a formula field of `tableId`. */
export function snapshotFor(tableId: string, only: SnapshotTable[] = tables): SchemaSnapshot {
  return { tableId, tables: only };
}

export const inOrders = snapshotFor(tbl.orders);
export const inCustomers = snapshotFor(tbl.customers);

/** The snapshot without one field (deleted, or no read access). */
export function withoutField(snapshot: SchemaSnapshot, fieldId: string): SchemaSnapshot {
  return {
    ...snapshot,
    tables: snapshot.tables.map((table) => ({
      ...table,
      fields: table.fields.filter((item) => item.id !== fieldId),
    })),
  };
}

/** The snapshot without one table. */
export function withoutTable(snapshot: SchemaSnapshot, tableId: string): SchemaSnapshot {
  return { ...snapshot, tables: snapshot.tables.filter((table) => table.id !== tableId) };
}

/** Fully parenthesised, name-only rendering of an AST, to assert precedence and shape. */
export function shape(node: Expr): string {
  switch (node.type) {
    case 'number':
      return node.value;
    case 'string':
      return JSON.stringify(node.value);
    case 'boolean':
      return node.value ? 'TRUE' : 'FALSE';
    case 'reference':
      return `[${node.name ?? `#${node.id ?? ''}`}]`;
    case 'current_value':
      return 'CV';
    case 'variable':
      return `$${node.name}`;
    case 'member':
      return `${shape(node.object)}.${shape(node.property)}`;
    case 'call':
      return `${node.chained ? '~' : ''}${node.name}(${node.args.map(shape).join(', ')})`;
    case 'let':
      return `LET(${node.bindings.map((binding) => `${binding.name}=${shape(binding.value)}`).join(', ')}; ${shape(node.body)})`;
    case 'unary':
      return `(${node.operator}${shape(node.operand)})`;
    case 'binary':
      return `(${shape(node.left)} ${node.operator} ${shape(node.right)})`;
  }
}

/** Every node of the tree, parents before children. */
export function nodes(node: Expr): Expr[] {
  const out: Expr[] = [node];
  switch (node.type) {
    case 'member':
      out.push(...nodes(node.object), ...nodes(node.property));
      break;
    case 'call':
      for (const arg of node.args) out.push(...nodes(arg));
      break;
    case 'let':
      for (const binding of node.bindings) out.push(...nodes(binding.value));
      out.push(...nodes(node.body));
      break;
    case 'unary':
      out.push(...nodes(node.operand));
      break;
    case 'binary':
      out.push(...nodes(node.left), ...nodes(node.right));
      break;
    default:
      break;
  }
  return out;
}
