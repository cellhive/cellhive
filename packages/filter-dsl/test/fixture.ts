import type { FilterFieldMeta, FilterTableMeta } from '../src/index.js';
import type { Id, IdPrefix } from '@cellhive/contracts';

/** Deterministic, readable IDs: `fld_title00000000000`. */
export function fixedId<P extends IdPrefix>(prefix: P, name: string): Id<P> {
  return `${prefix}_${name.padEnd(16, '0').slice(0, 16)}`;
}

export const fld = {
  title: fixedId('fld', 'title'),
  code: fixedId('fld', 'code'),
  amount: fixedId('fld', 'amount'),
  due: fixedId('fld', 'due'),
  dueAt: fixedId('fld', 'dueAt'),
  created: fixedId('fld', 'created'),
  done: fixedId('fld', 'done'),
  status: fixedId('fld', 'status'),
  tags: fixedId('fld', 'tags'),
  owner: fixedId('fld', 'owner'),
  creator: fixedId('fld', 'creator'),
  customer: fixedId('fld', 'customer'),
  parent: fixedId('fld', 'parent'),
  files: fixedId('fld', 'files'),
  total: fixedId('fld', 'total'),
  tagNames: fixedId('fld', 'tagNames'),
  broken: fixedId('fld', 'broken'),
  secret: fixedId('fld', 'secret'),
} as const;

export const opt = {
  new: fixedId('opt', 'new'),
  progress: fixedId('opt', 'progress'),
  done: fixedId('opt', 'done'),
  a: fixedId('opt', 'a'),
  b: fixedId('opt', 'b'),
} as const;

export const usr = {
  an: fixedId('usr', 'an'),
  binh: fixedId('usr', 'binh'),
  chi: fixedId('usr', 'chi'),
} as const;
export const rec = { r1: fixedId('rec', 'r1'), r2: fixedId('rec', 'r2') } as const;

const statusOptions = {
  multiple: false,
  options: [
    { id: opt.new, name: 'Mới' },
    { id: opt.progress, name: 'Đang xử lý' },
    { id: opt.done, name: 'Done' },
  ],
};

const tagOptions = {
  multiple: true,
  options: [
    { id: opt.a, name: 'A' },
    { id: opt.b, name: 'B' },
  ],
};

const fields: FilterFieldMeta[] = [
  { id: fld.title, name: 'Tiêu đề', type: 'text' },
  { id: fld.code, name: 'Mã', type: 'auto_number' },
  { id: fld.amount, name: 'Số tiền', type: 'number' },
  { id: fld.due, name: 'Hạn', type: 'datetime' },
  {
    id: fld.dueAt,
    name: 'Hẹn lúc',
    type: 'datetime',
    options: { style: { format: 'dd/MM/yyyy HH:mm' } },
  },
  { id: fld.created, name: 'Ngày tạo', type: 'created_at' },
  { id: fld.done, name: 'Xong', type: 'checkbox' },
  { id: fld.status, name: 'Trạng thái', type: 'select', options: statusOptions },
  { id: fld.tags, name: 'Nhãn', type: 'select', options: tagOptions },
  { id: fld.owner, name: 'Phụ trách', type: 'user' },
  { id: fld.creator, name: 'Người tạo', type: 'created_by' },
  { id: fld.customer, name: 'Khách hàng', type: 'link' },
  { id: fld.parent, name: 'Cha', type: 'parent' },
  { id: fld.files, name: 'Tệp', type: 'attachment' },
  { id: fld.total, name: 'Tổng', type: 'formula', resultType: 'number' },
  {
    id: fld.tagNames,
    name: 'Nhãn KH',
    type: 'lookup',
    resultType: 'select',
    resultOptions: tagOptions,
    resultIsList: true,
  },
  { id: fld.broken, name: 'Lỗi', type: 'formula' },
  { id: fld.secret, name: 'Giá vốn', type: 'text' },
];

export const table: FilterTableMeta = { fields };

/** Every field except `secret` (hidden from the caller). */
export const visible: string[] = fields.map((field) => field.id).filter((id) => id !== fld.secret);
